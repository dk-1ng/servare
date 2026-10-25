import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { parseRange } from './range.ts';
import { parseSize, syntheticChunks } from './synthetic.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

export const COOKIE_NAME = 'servare_session';
export const COOKIE_VALUE = 'ok';

const MIME: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
};

/** Fixture catalogue: what each test page offers and what it expects to be playable. */
export type CatalogEntry = {
  id: string;
  title: string;
  kind: 'native' | 'hls' | 'dash';
  /** Path relative to the server origin. */
  url: string;
};

export const CATALOG: readonly CatalogEntry[] = [
  { id: 'mp4', title: 'MP4 (H.264/AAC)', kind: 'native', url: '/media/sample.mp4' },
  { id: 'webm', title: 'WebM (VP9/Opus)', kind: 'native', url: '/media/sample.webm' },
  {
    id: 'hls-variants',
    title: 'HLS multi-variant',
    kind: 'hls',
    url: '/media/hls/variants/master.m3u8',
  },
  { id: 'hls-fmp4', title: 'HLS fMP4', kind: 'hls', url: '/media/hls/fmp4/index.m3u8' },
  {
    id: 'hls-aes-iv',
    title: 'HLS AES-128 with IV',
    kind: 'hls',
    url: '/media/hls/aes128-iv/index.m3u8',
  },
  {
    id: 'hls-aes-noiv',
    title: 'HLS AES-128 without IV',
    kind: 'hls',
    url: '/media/hls/aes128-noiv/index.m3u8',
  },
  {
    id: 'hls-alt',
    title: 'HLS alternate audio + WebVTT',
    kind: 'hls',
    url: '/media/hls/alt/master.m3u8',
  },
  { id: 'dash-h264', title: 'DASH H.264/AAC', kind: 'dash', url: '/media/dash/h264/manifest.mpd' },
  { id: 'dash-vp9', title: 'DASH VP9/Opus', kind: 'dash', url: '/media/dash/vp9/manifest.mpd' },
  { id: 'hls-live', title: 'HLS live (sliding window)', kind: 'hls', url: '/live/demo/index.m3u8' },
];

export type TestServerOptions = {
  port?: number;
  host?: string;
  fixturesDir?: string;
};

export type RequestRecord = {
  method: string;
  url: string;
  status: number;
  range: string | null;
  referer: string | null;
};

export type TestServer = {
  origin: string;
  port: number;
  /** Requests seen since start or the last reset. */
  requests: RequestRecord[];
  /** Clears request log, flaky counters and live playlist positions. */
  reset(): void;
  close(): Promise<void>;
};

type LiveState = { head: number; windowSize: number; total: number };

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const host = options.host ?? '127.0.0.1';
  const fixturesDir = options.fixturesDir ?? path.join(ROOT, 'test/fixtures/out');
  const pagesDir = path.join(ROOT, 'test/pages');
  const vendor: Record<string, string> = {
    '/vendor/hls.js': path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js'),
    '/vendor/dash.js': path.join(ROOT, 'node_modules/dashjs/dist/modern/umd/dash.all.min.js'),
  };

  const requests: RequestRecord[] = [];
  const flakyCounts = new Map<string, number>();
  const liveStates = new Map<string, LiveState>();
  let origin = '';

  const send = (
    res: ServerResponse,
    status: number,
    body = '',
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    res.end(body);
  };

  /** Resolves `rel` inside `base`, refusing traversal. */
  const safeJoin = (base: string, rel: string): string | null => {
    const full = path.resolve(base, '.' + path.sep + rel);
    return full === base || full.startsWith(base + path.sep) ? full : null;
  };

  async function serveFile(
    req: Pick<IncomingMessage, 'method' | 'headers'>,
    res: ServerResponse,
    file: string,
  ): Promise<void> {
    let info;
    try {
      info = await stat(file);
    } catch {
      send(res, 404, 'not found');
      return;
    }
    if (!info.isFile()) {
      send(res, 404, 'not found');
      return;
    }
    const range = parseRange(req.headers.range, info.size);
    const base = {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
    };
    if (range === 'unsatisfiable') {
      send(res, 416, '', { 'content-range': `bytes */${info.size}` });
      return;
    }
    const [start, end, status] = range ? [range.start, range.end, 206] : [0, info.size - 1, 200];
    const headers: Record<string, string> = {
      ...base,
      'content-length': String(info.size === 0 ? 0 : end - start + 1),
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || info.size === 0) {
      res.end();
      return;
    }
    await pipeline(createReadStream(file, { start, end }), res).catch(() => undefined);
  }

  /**
   * `/synthetic/<size>[.bin]` streams generated bytes; `?abortAfter=N` cuts the connection and
   * `?pace=MS` waits that long between chunks, so a test can act on a download in progress.
   */
  async function serveSynthetic(
    req: IncomingMessage,
    res: ServerResponse,
    sizeText: string,
    query: URLSearchParams,
  ): Promise<void> {
    const size = parseSize(sizeText.replace(/\.bin$/, ''));
    if (size === null || size === 0) {
      send(res, 400, 'bad size');
      return;
    }
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      send(res, 416, '', { 'content-range': `bytes */${size}` });
      return;
    }
    const [start, end, status] = range ? [range.start, range.end, 206] : [0, size - 1, 200];
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const abortAfter = Number(query.get('abortAfter') ?? '');
    const last =
      Number.isFinite(abortAfter) && abortAfter > 0 ? Math.min(end, start + abortAfter - 1) : end;
    const truncated = last < end;
    const pace = Math.min(1000, Math.max(0, Number(query.get('pace') ?? 0) || 0));
    async function* paced(): AsyncGenerator<Uint8Array> {
      for (const chunk of syntheticChunks(start, last)) {
        if (pace > 0) await new Promise((resolve) => setTimeout(resolve, pace));
        yield chunk;
      }
    }
    await pipeline(Readable.from(pace > 0 ? paced() : syntheticChunks(start, last)), res, {
      end: !truncated,
    }).catch(() => undefined);
    if (truncated) res.destroy(); // fewer bytes than Content-Length: the client sees a cut download
  }

  const isIntIn = (n: number, min: number, max: number): boolean =>
    Number.isInteger(n) && n >= min && n <= max;

  /** Live HLS: each playlist fetch advances the window by one segment (no wall clock). */
  async function serveLive(
    res: ServerResponse,
    name: string,
    file: string,
    query: URLSearchParams,
  ) {
    const source = await readFile(path.join(fixturesDir, 'hls/variants/hi.m3u8'), 'utf8').catch(
      () => null,
    );
    if (source === null) {
      send(res, 404, 'fixtures missing');
      return;
    }
    const lines = source.split('\n');
    const segments: { duration: number; uri: string }[] = [];
    lines.forEach((line, i) => {
      if (line.startsWith('#EXTINF:')) {
        segments.push({ duration: parseFloat(line.slice(8)), uri: lines[i + 1] ?? '' });
      }
    });
    const count = segments.length;
    // Options come from the first playlist request; segment URIs are bare, so state is per name.
    const windowSize = Number(query.get('window') ?? 3);
    const total = Number(query.get('total') ?? 0); // 0 = never ends
    const key = name;
    if (file === 'index.m3u8' && (!isIntIn(windowSize, 1, 100) || !isIntIn(total, 0, 1000))) {
      send(res, 400, 'window must be 1..100 and total 0..1000');
      return;
    }

    if (file === 'index.m3u8') {
      const state = liveStates.get(key) ?? { head: windowSize, windowSize, total };
      liveStates.set(key, state);
      const { windowSize: win, total: end } = state;
      const head = state.head; // exclusive: segments [first, head) are listed
      const first = Math.max(0, head - win);
      const ended = end > 0 && head >= end;
      let out = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments.map((s) => s.duration)))}\n`;
      out += `#EXT-X-MEDIA-SEQUENCE:${first}\n`;
      out += `#EXT-X-DISCONTINUITY-SEQUENCE:${first >= 1 ? Math.floor((first - 1) / count) : 0}\n`;
      for (let seq = first; seq < head; seq++) {
        if (seq > 0 && seq % count === 0) out += '#EXT-X-DISCONTINUITY\n';
        out += `#EXTINF:${(segments[seq % count]?.duration ?? 2).toFixed(3)},\nseg-${seq}.ts\n`;
      }
      if (ended) out += '#EXT-X-ENDLIST\n';
      else if (end === 0 || head < end) state.head = head + 1;
      send(res, 200, out, { 'content-type': MIME['.m3u8'] ?? '', 'cache-control': 'no-store' });
      return;
    }
    const match = /^seg-(\d+)\.ts$/.exec(file);
    if (!match) {
      send(res, 404, 'not found');
      return;
    }
    const seq = Number(match[1]);
    const state = liveStates.get(key);
    if (!state || seq >= state.head) {
      send(res, 404, 'segment not published yet');
      return;
    }
    // Segment URIs are relative to the playlist that the live window was built from.
    const uri = segments[seq % count]?.uri ?? '';
    await serveFile(
      { method: 'GET', headers: {} },
      res,
      path.join(fixturesDir, 'hls/variants', uri),
    );
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'range');
    res.setHeader('access-control-expose-headers', 'content-length, content-range, accept-ranges');
    if (req.method === 'OPTIONS') {
      send(res, 204);
      return;
    }
    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      !(req.method === 'POST' && p === '/__reset')
    ) {
      send(res, 405, 'method not allowed');
      return;
    }

    if (p === '/__reset') {
      reset();
      send(res, 200, 'reset');
      return;
    }
    if (p === '/__requests') {
      send(res, 200, JSON.stringify(requests), { 'content-type': MIME['.json'] ?? '' });
      return;
    }
    if (p === '/catalog.json') {
      send(res, 200, JSON.stringify(CATALOG), { 'content-type': MIME['.json'] ?? '' });
      return;
    }
    if (p === '/set-cookie') {
      send(res, 200, 'cookie set', {
        'set-cookie': `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; SameSite=Lax`,
      });
      return;
    }
    const vendorFile = vendor[p];
    if (vendorFile) return serveFile(req, res, vendorFile);

    if (p === '/' || p.startsWith('/pages/')) {
      const rel = p === '/' ? 'index.html' : p.slice('/pages/'.length);
      const file = safeJoin(pagesDir, rel);
      if (!file) return send(res, 400, 'bad path');
      return serveFile(req, res, file);
    }

    const status = /^\/status\/(\d{3})$/.exec(p);
    if (status) {
      send(res, Number(status[1]), `status ${status[1]}`, { 'retry-after': '0' });
      return;
    }

    let mediaPath = p;
    // /guarded/...: needs a same-origin Referer and the session cookie.
    if (mediaPath.startsWith('/guarded/')) {
      mediaPath = mediaPath.slice('/guarded'.length);
      const referer = req.headers.referer ?? '';
      if (referer !== origin + '/' && !referer.startsWith(origin + '/')) {
        send(res, 403, 'referer required');
        return;
      }
      const cookies = (req.headers.cookie ?? '').split(/;\s*/);
      if (!cookies.includes(`${COOKIE_NAME}=${COOKIE_VALUE}`)) {
        send(res, 401, 'cookie required');
        return;
      }
    }
    // /flaky/<n>/...: the first n requests for the same path answer 503, then it works.
    const flaky = /^\/flaky\/(\d+)(\/.*)$/.exec(mediaPath);
    if (flaky) {
      const seen = flakyCounts.get(mediaPath) ?? 0;
      flakyCounts.set(mediaPath, seen + 1);
      mediaPath = flaky[2] ?? '/';
      if (seen < Number(flaky[1])) {
        send(res, 503, 'injected failure', { 'retry-after': '0' });
        return;
      }
    }

    const synthetic = /^\/synthetic\/([^/]+)$/.exec(mediaPath);
    if (synthetic) return serveSynthetic(req, res, synthetic[1] ?? '', url.searchParams);

    const live = /^\/live\/([\w-]+)\/([\w.-]+)$/.exec(mediaPath);
    if (live) return serveLive(res, live[1] ?? '', live[2] ?? '', url.searchParams);

    if (mediaPath.startsWith('/media/')) {
      let rel: string;
      try {
        rel = decodeURIComponent(mediaPath.slice('/media/'.length));
      } catch {
        return send(res, 400, 'bad path');
      }
      const file = safeJoin(fixturesDir, rel);
      if (!file) return send(res, 400, 'bad path');
      return serveFile(req, res, file);
    }
    send(res, 404, 'not found');
  }

  function reset(): void {
    requests.length = 0;
    flakyCounts.clear();
    liveStates.clear();
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.on('finish', () => {
      if (!url.pathname.startsWith('/__')) {
        requests.push({
          method: req.method ?? 'GET',
          url: url.pathname + url.search,
          status: res.statusCode,
          range: req.headers.range ?? null,
          referer: req.headers.referer ?? null,
        });
      }
    });
    route(req, res, url).catch((error: unknown) => {
      console.error('test server error', error);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  origin = `http://${host}:${port}`;

  return {
    origin,
    port,
    requests,
    reset,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
