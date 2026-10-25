import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRange } from './range.ts';
import { COOKIE_NAME, COOKIE_VALUE, CATALOG, startTestServer, type TestServer } from './server.ts';
import { parseSize, syntheticByte } from './synthetic.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/fixtures/out');
const hasTool = (name: string): boolean =>
  spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfmpeg = hasTool('ffmpeg');
const hasFfprobe = hasTool('ffprobe');

let server: TestServer;
beforeAll(async () => {
  // Fixtures are generated on demand; without FFmpeg the fixture-backed suites are skipped.
  if (hasFfmpeg && !existsSync(path.join(OUT, 'hls/variants/master.m3u8'))) {
    execFileSync('bash', [path.join(ROOT, 'test/fixtures/make.sh')], { stdio: 'ignore' });
  }
  server = await startTestServer();
}, 120_000);
afterAll(async () => {
  await server.close();
});

const get = (p: string, init?: RequestInit) => fetch(server.origin + p, init);

describe('parseRange', () => {
  it('handles absent, open, closed, suffix and invalid ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('items=1-2', 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });
});

describe('synthetic bytes', () => {
  it('parses sizes', () => {
    expect(parseSize('2gb')).toBe(2 * 1024 ** 3);
    expect(parseSize('512MB')).toBe(512 * 1024 ** 2);
    expect(parseSize('42')).toBe(42);
    expect(parseSize('x')).toBeNull();
  });

  it('serves a 2 GiB file by header without storing it', async () => {
    const res = await get('/synthetic/2gb.bin', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(2 * 1024 ** 3));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('returns the same bytes for a range as for the matching full-body offset', async () => {
    const start = 2 * 1024 ** 3 - 10; // crosses the 32-bit boundary
    const res = await get('/synthetic/3gb.bin', {
      headers: { range: `bytes=${start}-${start + 19}` },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes ${start}-${start + 19}/${3 * 1024 ** 3}`);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(
      Array.from({ length: 20 }, (_, i) => syntheticByte(start + i)),
    );
  });

  it('streams a whole small file and answers 416 past the end', async () => {
    const res = await get('/synthetic/3000000');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(3_000_000);
    expect(body[2_999_999]).toBe(syntheticByte(2_999_999));
    const bad = await get('/synthetic/100', { headers: { range: 'bytes=100-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */100');
  });

  it('truncates the connection with ?abortAfter for resume tests', async () => {
    const res = await get('/synthetic/10mb?abortAfter=1000');
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
});

describe('fault injection and access control', () => {
  it('answers requested status codes', async () => {
    expect((await get('/status/503')).status).toBe(503);
    expect((await get('/status/404')).status).toBe(404);
  });

  it('fails the first N requests of a flaky path, then succeeds', async () => {
    server.reset();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await get('/flaky/2/synthetic/10')).status);
    expect(statuses).toEqual([503, 503, 200, 200]);
    server.reset();
    expect((await get('/flaky/2/synthetic/10')).status).toBe(503);
  });

  it('requires Referer and cookie on /guarded', async () => {
    const url = '/guarded/synthetic/10';
    const cookie = `${COOKIE_NAME}=${COOKIE_VALUE}`;
    expect((await get(url)).status).toBe(403);
    expect((await get(url, { headers: { referer: 'https://evil.example/', cookie } })).status).toBe(
      403,
    );
    expect((await get(url, { headers: { referer: server.origin + '/pages/x' } })).status).toBe(401);
    expect(
      (await get(url, { headers: { referer: server.origin + '/pages/x', cookie } })).status,
    ).toBe(200);
    const set = await get('/set-cookie');
    expect(set.headers.get('set-cookie')).toContain(`${COOKIE_NAME}=${COOKIE_VALUE}`);
  });

  it('refuses path traversal', async () => {
    const res = await get('/media/%2e%2e/%2e%2e/package.json');
    expect(res.status).not.toBe(200);
  });

  it('records requests', async () => {
    server.reset();
    await get('/synthetic/10', { headers: { range: 'bytes=0-1' } });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ status: 206, range: 'bytes=0-1' });
  });
});

describe('static pages and vendor scripts', () => {
  it('serves the index, player and players libraries locally', async () => {
    expect((await get('/')).headers.get('content-type')).toContain('text/html');
    expect((await get('/pages/player.html')).status).toBe(200);
    expect((await get('/vendor/hls.js')).status).toBe(200);
    expect((await get('/vendor/dash.js')).status).toBe(200);
    const catalog = (await (await get('/catalog.json')).json()) as unknown[];
    expect(catalog).toHaveLength(CATALOG.length);
  });
});

describe.skipIf(!hasFfmpeg)('fixture-backed routes', () => {
  it('serves every catalogued fixture except the live one', async () => {
    for (const entry of CATALOG.filter((e) => !e.url.startsWith('/live/'))) {
      const res = await get(entry.url);
      expect(res.status, entry.url).toBe(200);
      await res.arrayBuffer();
    }
  });

  it('supports Range on media files', async () => {
    const full = new Uint8Array(await (await get('/media/sample.mp4')).arrayBuffer());
    const res = await get('/media/sample.mp4', { headers: { range: 'bytes=4-11' } });
    expect(res.status).toBe(206);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(
      Array.from(full.slice(4, 12)),
    );
    expect(String.fromCharCode(...full.slice(4, 8))).toBe('ftyp');
  });

  it('keeps AES-128 playlists consistent with their IV semantics', async () => {
    const withIv = await (await get('/media/hls/aes128-iv/index.m3u8')).text();
    const noIv = await (await get('/media/hls/aes128-noiv/index.m3u8')).text();
    expect(withIv).toMatch(/#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x[0-9a-f]{32}/);
    expect(noIv).toMatch(/#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n/);
    expect(noIv).not.toContain('IV=');
    expect((await (await get('/media/hls/aes128-iv/key.bin')).arrayBuffer()).byteLength).toBe(16);
  });

  it('slides the live window one segment per playlist fetch and ends at total', async () => {
    server.reset();
    const sequences: number[] = [];
    let last = '';
    for (let i = 0; i < 6; i++) {
      last = await (await get('/live/t/index.m3u8?window=2&total=5')).text();
      sequences.push(Number(/MEDIA-SEQUENCE:(\d+)/.exec(last)?.[1]));
    }
    expect(sequences).toEqual([0, 1, 2, 3, 3, 3]);
    expect(last).toContain('#EXT-X-ENDLIST');
    // Segments inside the window are served; ones that were never published are not.
    expect((await get('/live/t/seg-4.ts?window=2&total=5')).status).toBe(200);
    expect((await get('/live/t/seg-9.ts?window=2&total=5')).status).toBe(404);
  });

  it('wraps the source segments with a discontinuity', async () => {
    server.reset();
    let playlist = '';
    for (let i = 0; i < 4; i++) playlist = await (await get('/live/w/index.m3u8')).text();
    expect(playlist).toContain('#EXT-X-DISCONTINUITY\n');
  });
});

describe.skipIf(!hasFfmpeg || !hasFfprobe)('generated fixtures', () => {
  const probe = (file: string): { codecs: string[]; duration: number } => {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', file],
      { encoding: 'utf8' },
    );
    const json = JSON.parse(out) as {
      streams: { codec_name: string }[];
      format: { duration: string };
    };
    return {
      codecs: json.streams.map((s) => s.codec_name).sort(),
      duration: Number(json.format.duration),
    };
  };

  it('has the expected codecs and duration', () => {
    const mp4 = probe(path.join(OUT, 'sample.mp4'));
    expect(mp4.codecs).toEqual(['aac', 'h264']);
    expect(mp4.duration).toBeCloseTo(6, 0);
    const webm = probe(path.join(OUT, 'sample.webm'));
    expect(webm.codecs).toEqual(['opus', 'vp9']);
  });
});
