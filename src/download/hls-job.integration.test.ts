import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  codecsOf,
  decodeErrors,
  FIXTURES,
  hasFfprobe,
  memoryFile,
  newLibav,
  packetCount,
  probe,
  timing,
} from '../../test/media/probe';
import type { JobWriter } from './direct-job';
import { runHlsJob, type HlsJobDeps } from './hls-job';

const ORIGIN = 'https://fixtures.test/';
const have = (...rels: string[]): boolean => rels.every((r) => existsSync(path.join(FIXTURES, r)));

let work: string;
beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'servare-hls-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/**
 * Serves the fixture tree like a static server (with `Range`), plus extra playlists held in
 * memory. Paths in `failing` answer 503 every time, as a segment that outlasts the retries.
 */
function diskFetch(extra: Record<string, string> = {}, failing: ReadonlySet<string> = new Set()) {
  return async (
    url: string,
    init: { signal: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response> => {
    const rel = url.slice(ORIGIN.length);
    if (failing.has(rel)) return new Response('unavailable', { status: 503 });
    const text = extra[rel];
    if (text !== undefined) return new Response(text);
    const file = path.join(FIXTURES, rel);
    if (!rel || !existsSync(file)) return new Response('missing', { status: 404 });
    const bytes = new Uint8Array(readFileSync(file));
    const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.['Range'] ?? '');
    if (!range) return new Response(bytes);
    const [from, to] = [Number(range[1]), Number(range[2])];
    return new Response(bytes.slice(from, to + 1), {
      status: 206,
      headers: {
        'content-range': `bytes ${String(from)}-${String(to)}/${String(bytes.byteLength)}`,
      },
    });
  };
}

async function download(
  playlist: string,
  options: { extra?: Record<string, string>; failing?: string[]; failureThreshold?: number } = {},
) {
  const out = memoryFile();
  let removed = false;
  const writer: JobWriter = {
    writeAt: out.write,
    truncate: () => undefined,
    finish: async () => new File([out.bytes().slice()], 'out'),
    remove: async () => {
      removed = true;
    },
  };
  const deps: HlsJobDeps = {
    fetch: diskFetch(options.extra, new Set(options.failing)),
    openWriter: async () => writer,
    loadLibav: newLibav,
    concurrency: 4,
    retry: { attempts: 2, baseMs: 1, maxMs: 1 },
    ...(options.failureThreshold !== undefined && { failureThreshold: options.failureThreshold }),
  };
  const result = await runHlsJob({ jobId: 'j', url: ORIGIN + playlist }, deps);
  expect(removed).toBe(false);
  const file = path.join(work, `${playlist.replaceAll('/', '_')}.${result.container}`);
  writeFileSync(file, new Uint8Array(await result.file.arrayBuffer()));
  return { result, file };
}

/** The checks of the acceptance criterion: MP4, 6 s from 0, H.264 + AAC, no gaps, clean. */
function expectGaplessMp4(file: string): void {
  if (!hasFfprobe) return;
  const info = probe(file);
  expect(info.format.format_name).toContain('mp4');
  expect(Math.abs(Number(info.format.start_time))).toBeLessThanOrEqual(0.001);
  expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThanOrEqual(0.1);
  expect(codecsOf(info)).toEqual(['audio:aac', 'video:h264']);
  expect(packetCount(info, 'video')).toBe(90);
  for (const stream of timing(file).values()) expect(stream).toEqual({ gaps: [], monotonic: true });
  expect(decodeErrors(file)).toBe('');
}

describe('runHlsJob with libav', () => {
  it.each([
    ['hls/variants/hi.m3u8', 'hls/variants/hi_002.ts'],
    ['hls/fmp4/index.m3u8', 'hls/fmp4/seg_002.m4s'],
    ['hls/aes128-iv/index.m3u8', 'hls/aes128-iv/seg_002.ts'],
    ['hls/aes128-noiv/index.m3u8', 'hls/aes128-noiv/seg_002.ts'],
  ])(
    'turns %s into a gapless MP4',
    async (playlist, sentinel) => {
      if (!have(playlist, sentinel)) return;
      const { result, file } = await download(playlist);
      expect(result.container).toBe('mp4');
      expect(result.skippedSegments).toBe(0);
      expect(result.expectedSeconds).toBeCloseTo(6, 3);
      expect(result.durationSeconds).toBeCloseTo(6, 1);
      expectGaplessMp4(file);
    },
    60_000,
  );

  it.skipIf(!have('hls/variants/hi_002.ts'))(
    'keeps a 2 s gap where a segment failed',
    async () => {
      const { result, file } = await download('hls/variants/hi.m3u8', {
        failing: ['hls/variants/hi_001.ts'],
        failureThreshold: 0.5,
      });
      expect(result.skippedSegments).toBe(1);
      expect(result.skippedSeconds).toBe(2);
      // The covered duration (#24) is the output's minus the gap.
      expect(result.durationSeconds - result.skippedSeconds).toBeCloseTo(4, 1);
      if (!hasFfprobe) return;
      const info = probe(file);
      expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThanOrEqual(0.1);
      expect(packetCount(info, 'video')).toBe(60);
      for (const stream of timing(file).values()) {
        expect(stream.monotonic).toBe(true);
        expect(stream.gaps).toHaveLength(1);
        expect(Math.abs(stream.gaps[0]! - 2)).toBeLessThanOrEqual(0.1);
      }
      expect(decodeErrors(file)).toBe('');
    },
    60_000,
  );

  it.skipIf(!have('hls/variants/hi_001.ts'))(
    're-anchors after a discontinuity without overlap',
    async () => {
      const list = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:2',
        '#EXTINF:2.0,',
        'variants/hi_000.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:2.0,',
        'variants/hi_000.ts',
        '#EXTINF:2.0,',
        'variants/hi_001.ts',
        '#EXT-X-ENDLIST',
      ].join('\n');
      const { file } = await download('hls/discontinuity.m3u8', {
        extra: { 'hls/discontinuity.m3u8': list },
      });
      if (!hasFfprobe) return;
      const info = probe(file);
      expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThanOrEqual(0.1);
      expect(packetCount(info, 'video')).toBe(90);
      for (const stream of timing(file).values()) {
        expect(stream.monotonic).toBe(true);
        // The repeated segment starts with its own A/V lead (encoder delay, AAC priming), so
        // the stream that did not end last may get a short silence at the splice, never more.
        for (const gap of stream.gaps) expect(gap).toBeLessThan(0.2);
      }
      expect(decodeErrors(file)).toBe('');
    },
    60_000,
  );

  it.skipIf(!have('hls/id3/index.m3u8', 'hls/id3/seg_002.ts'))(
    'leaves a timed ID3 stream out of the MP4',
    async () => {
      const { result, file } = await download('hls/id3/index.m3u8');
      expect(result.container).toBe('mp4');
      expectGaplessMp4(file);
    },
    60_000,
  );
});
