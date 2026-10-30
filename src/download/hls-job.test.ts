import { describe, expect, it, vi } from 'vitest';
import type { Libav } from '../media/libav/types';
import {
  SegmentError,
  type PositionalWrite,
  type Remuxer,
  type RemuxerOptions,
  type RemuxResult,
} from '../media/remux';
import { toDownloadError, type JobWriter } from './direct-job';
import { runHlsJob, type HlsJobDeps } from './hls-job';

const BASE = 'https://cdn.test/v/';
const KEY = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

function playlist(count: number, extra: (i: number) => string = () => ''): string {
  let text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n';
  for (let i = 0; i < count; i++) text += `${extra(i)}#EXTINF:2.0,\ns${String(i)}.ts\n`;
  return text + '#EXT-X-ENDLIST\n';
}

const text = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** A body that delivers `chunks`, then fails when `fail` is set (a connection cut midway). */
function body(chunks: Uint8Array<ArrayBuffer>[], fail = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      if (fail) controller.error(new TypeError('network error'));
      else controller.close();
    },
  });
}

type Route = (init: { headers?: Record<string, string> }, attempt: number) => Response;

interface FakeRemuxer extends Remuxer {
  added: { data: string; discontinuity: boolean }[];
  skipped: number[];
  disposed: number;
}

function fakeRemuxer(refuse: (data: string) => SegmentError | undefined = () => undefined) {
  const remuxer: FakeRemuxer = {
    added: [],
    skipped: [],
    disposed: 0,
    container: undefined,
    async add({ data, discontinuity }) {
      const segment = decode(data);
      const error = refuse(segment);
      if (error) throw error;
      remuxer.added.push({ data: segment, discontinuity: discontinuity ?? false });
    },
    skip(seconds) {
      remuxer.skipped.push(seconds);
    },
    async finish(): Promise<RemuxResult> {
      const skippedSeconds = remuxer.skipped.reduce((a, b) => a + b, 0);
      return { size: 10, container: 'mp4', durationSeconds: 99, skippedSeconds };
    },
    async dispose() {
      remuxer.disposed++;
    },
  };
  return remuxer;
}

function setup(
  routes: Record<string, Route>,
  options: Partial<HlsJobDeps> = {},
  remuxer: FakeRemuxer = fakeRemuxer(),
) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const attempts = new Map<string, number>();
  const file = new File(['out'], 'out');
  const writer: JobWriter = {
    writeAt: vi.fn(),
    truncate: vi.fn(),
    finish: vi.fn(async () => file),
    remove: vi.fn(async () => {}),
  };
  const createRemuxer = vi.fn<(l: Libav, w: PositionalWrite, o: RemuxerOptions) => Remuxer>(
    () => remuxer,
  );
  const deps = {
    fetch: vi.fn(
      async (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => {
        calls.push({ url, ...(init.headers && { headers: init.headers }) });
        const attempt = (attempts.get(url) ?? 0) + 1;
        attempts.set(url, attempt);
        const route = routes[url.startsWith(BASE) ? url.slice(BASE.length) : url];
        if (!route) return new Response('missing', { status: 404 });
        // Let other prefetches start, as a real network would.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        return route(init, attempt);
      },
    ),
    openWriter: vi.fn(async () => writer),
    loadLibav: vi.fn(async () => ({}) as Libav),
    createRemuxer,
    concurrency: 3,
    retry: { attempts: 3, baseMs: 1, maxMs: 1 },
    sleep: vi.fn(async () => {}),
    onProgress: vi.fn(),
    ...options,
  } satisfies HlsJobDeps;
  return { deps, calls, writer, remuxer, file, createRemuxer };
}

const ok = (content: string | Uint8Array<ArrayBuffer>) => () =>
  new Response(typeof content === 'string' ? text(content) : content);

function segments(count: number): Record<string, Route> {
  const out: Record<string, Route> = {};
  for (let i = 0; i < count; i++) out[`s${String(i)}.ts`] = ok(`seg${String(i)}`);
  return out;
}

const job = { jobId: 'j1', url: `${BASE}index.m3u8` };

describe('runHlsJob', () => {
  it('feeds every segment in order while fetching ahead, and returns the file', async () => {
    let inFlight = 0;
    let peak = 0;
    const routes: Record<string, Route> = { 'index.m3u8': ok(playlist(6)) };
    for (let i = 0; i < 6; i++) {
      routes[`s${String(i)}.ts`] = () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Response(
          new ReadableStream({
            async pull(controller) {
              // Later segments answer sooner: the order must still hold.
              await new Promise((resolve) => setTimeout(resolve, 6 - i));
              controller.enqueue(text(`seg${String(i)}`));
              controller.close();
              inFlight--;
            },
          }),
        );
      };
    }
    const s = setup(routes);
    const result = await runHlsJob(job, s.deps);
    expect(result).toEqual({
      file: s.file,
      container: 'mp4',
      skippedSegments: 0,
      skippedSeconds: 0,
      durationSeconds: 99,
      expectedSeconds: 12,
    });
    expect(s.remuxer.added.map((a) => a.data)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `seg${String(i)}`),
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    const options = s.createRemuxer.mock.calls[0]?.[2];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.forwardJumpLimitSeconds).toBe(10);
    expect(s.remuxer.disposed).toBe(1);
    expect(s.deps.onProgress).toHaveBeenLastCalledWith(24, undefined);
  });

  it('fails with the error of the first segment', async () => {
    const s = setup({
      'index.m3u8': ok(playlist(3)),
      ...segments(3),
      's0.ts': () => new Response('', { status: 403 }),
    });
    const error = await runHlsJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'http', status: 403 });
    expect(s.writer.remove).toHaveBeenCalled();
    expect(s.remuxer.disposed).toBeGreaterThan(0);
  });

  it('skips one failed segment in ten and reports its duration', async () => {
    const s = setup({
      'index.m3u8': ok(playlist(10)),
      ...segments(10),
      's4.ts': () => new Response('', { status: 404 }),
    });
    const result = await runHlsJob(job, s.deps);
    expect(result.skippedSegments).toBe(1);
    expect(result.skippedSeconds).toBe(2);
    expect(s.remuxer.skipped).toEqual([2]);
    expect(s.remuxer.added).toHaveLength(9);
  });

  it('fails with the error of the segment that crosses the threshold', async () => {
    const s = setup({
      'index.m3u8': ok(playlist(10)),
      ...segments(10),
      's2.ts': () => new Response('', { status: 404 }),
      's5.ts': () => new Response('', { status: 410 }),
      's7.ts': () => new Response('', { status: 451 }),
    });
    const error = await runHlsJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'http', status: 451 });
    expect(s.remuxer.skipped).toEqual([2, 2]);
    expect(s.writer.remove).toHaveBeenCalled();
  });

  it('counts a segment the remuxer refuses as failed, without retrying it', async () => {
    const remuxer = fakeRemuxer((data) =>
      data === 'seg3' ? new SegmentError('incompatible', 'other codec') : undefined,
    );
    const s = setup({ 'index.m3u8': ok(playlist(10)), ...segments(10) }, {}, remuxer);
    const result = await runHlsJob(job, s.deps);
    expect(result.skippedSegments).toBe(1);
    expect(s.calls.filter((c) => c.url === `${BASE}s3.ts`)).toHaveLength(1);
  });

  it('carries a skipped discontinuity to the next segment', async () => {
    const s = setup({
      'index.m3u8': ok(playlist(10, (i) => (i === 4 ? '#EXT-X-DISCONTINUITY\n' : ''))),
      ...segments(10),
      's4.ts': () => new Response('', { status: 404 }),
    });
    await runHlsJob(job, s.deps);
    expect(s.remuxer.added.filter((a) => a.discontinuity).map((a) => a.data)).toEqual(['seg5']);
  });

  it('retries a body cut midway', async () => {
    const s = setup({
      'index.m3u8': ok(playlist(2)),
      ...segments(2),
      's1.ts': (_init, attempt) =>
        attempt === 1 ? new Response(body([text('se')], true)) : new Response(body([text('seg1')])),
    });
    await runHlsJob(job, s.deps);
    expect(s.remuxer.added.map((a) => a.data)).toEqual(['seg0', 'seg1']);
    expect(s.deps.sleep).toHaveBeenCalledTimes(1);
    expect(s.deps.onProgress).toHaveBeenLastCalledWith(8, undefined);
  });

  it('fetches byte ranges, from a 206 or sliced from a 200', async () => {
    const resource = text('0123456789abcdefghij');
    const list =
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n#EXT-X-BYTERANGE:4@2\nall.ts\n#EXTINF:2,\n#EXT-X-BYTERANGE:5\nall.ts\n#EXTINF:2,\n#EXT-X-BYTERANGE:3@0\nfull.ts\n#EXT-X-ENDLIST\n';
    const s = setup({
      'index.m3u8': ok(list),
      'all.ts': (init) => {
        const [, from = '', to = ''] =
          /^bytes=(\d+)-(\d+)$/.exec(init.headers?.['Range'] ?? '') ?? [];
        return new Response(resource.slice(Number(from), Number(to) + 1), {
          status: 206,
          headers: { 'content-range': `bytes ${from}-${to}/20` },
        });
      },
      // A server that ignores Range sends the whole resource.
      'full.ts': () => new Response(resource),
    });
    await runHlsJob(job, s.deps);
    expect(s.remuxer.added.map((a) => a.data)).toEqual(['2345', '6789a', '012']);
    expect(s.calls.slice(1).map((c) => c.headers?.['Range'])).toEqual([
      'bytes=2-5',
      'bytes=6-10',
      'bytes=0-2',
    ]);
  });

  it('fails a segment whose 206 starts elsewhere', async () => {
    const list =
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n#EXT-X-BYTERANGE:4@2\nall.ts\n#EXT-X-ENDLIST\n';
    const s = setup({
      'index.m3u8': ok(list),
      'all.ts': () =>
        new Response(text('0123'), { status: 206, headers: { 'content-range': 'bytes 0-3/20' } }),
    });
    const error = await runHlsJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toMatchObject({ kind: 'unknown' });
  });

  it('fetches an init section once and puts it in front of every segment', async () => {
    const list = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n${playlist(3)
      .split('\n')
      .slice(4)
      .join('\n')}`;
    const s = setup({ 'index.m3u8': ok(list), 'init.mp4': ok('INIT+'), ...segments(3) });
    await runHlsJob(job, s.deps);
    expect(s.remuxer.added.map((a) => a.data)).toEqual(['INIT+seg0', 'INIT+seg1', 'INIT+seg2']);
    expect(s.calls.filter((c) => c.url.endsWith('init.mp4'))).toHaveLength(1);
  });

  it('decrypts AES-128 segments with the key and the sequence number as IV', async () => {
    const key = await crypto.subtle.importKey('raw', KEY, 'AES-CBC', false, ['encrypt']);
    const routes: Record<string, Route> = {
      'index.m3u8': ok(
        playlist(2, (i) => (i === 0 ? '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n' : '')),
      ),
      'k.bin': () => new Response(KEY),
    };
    for (let i = 0; i < 2; i++) {
      const iv = new Uint8Array(16);
      iv[15] = i;
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, text(`seg${String(i)}`)),
      );
      routes[`s${String(i)}.ts`] = ok(sealed);
    }
    const s = setup(routes);
    await runHlsJob(job, s.deps);
    expect(s.remuxer.added.map((a) => a.data)).toEqual(['seg0', 'seg1']);
    expect(s.calls.filter((c) => c.url.endsWith('k.bin'))).toHaveLength(1);
  });

  it('reports decrypt when the key cannot be fetched', async () => {
    const s = setup({
      'index.m3u8': ok(
        playlist(2, (i) => (i === 0 ? '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n' : '')),
      ),
      'k.bin': () => new Response('', { status: 403 }),
      's0.ts': ok(new Uint8Array(16)),
      's1.ts': ok(new Uint8Array(16)),
    });
    const error = await runHlsJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'decrypt' });
  });

  it('refuses an encrypted init section without IV', async () => {
    const list =
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\ns0.m4s\n#EXT-X-ENDLIST\n';
    const s = setup({
      'index.m3u8': ok(list),
      'init.mp4': ok(new Uint8Array(16)),
      's0.m4s': ok(new Uint8Array(16)),
    });
    const error = await runHlsJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'decrypt' });
    expect(s.calls.filter((c) => c.url.endsWith('init.mp4'))).toHaveLength(0);
  });

  it.each([
    [
      'a master playlist',
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n',
      { kind: 'unknown', message: 'Expected a media playlist, got a master playlist' },
    ],
    [
      'a live playlist',
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ns0.ts\n',
      { kind: 'unknown', message: 'Live playlists are not supported yet' },
    ],
    [
      'protected content',
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:2,\ns0.ts\n#EXT-X-ENDLIST\n',
      { kind: 'protected' },
    ],
    ['an empty playlist', '#EXTM3U\n#EXT-X-ENDLIST\n', { kind: 'incomplete', ratio: 0 }],
    [
      'not a playlist',
      '<html>',
      { kind: 'unknown', message: 'Not an HLS playlist: missing #EXTM3U' },
    ],
  ])('refuses %s before opening a file', async (_what, list, expected) => {
    const s = setup({ 'index.m3u8': ok(list), ...segments(1) });
    const error = await runHlsJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual(expected);
    expect(s.deps.openWriter).not.toHaveBeenCalled();
    expect(s.deps.loadLibav).not.toHaveBeenCalled();
  });

  it('reports cancelled and removes the file when aborted', async () => {
    const controller = new AbortController();
    const s = setup({
      'index.m3u8': ok(playlist(5)),
      ...segments(5),
      's2.ts': () => {
        controller.abort();
        return new Response(text('seg2'));
      },
    });
    const error = await runHlsJob(job, s.deps, controller.signal).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'cancelled' });
    expect(s.writer.remove).toHaveBeenCalled();
    expect(s.remuxer.disposed).toBeGreaterThan(0);
  });

  it('treats a write failure in the remuxer as fatal', async () => {
    const remuxer = fakeRemuxer();
    remuxer.add = async ({ data }) => {
      if (decode(data) === 'seg3') throw new DOMException('full', 'QuotaExceededError');
    };
    const s = setup({ 'index.m3u8': ok(playlist(10)), ...segments(10) }, {}, remuxer);
    const error = await runHlsJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'quota' });
  });
});
