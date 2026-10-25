import { describe, expect, it } from 'vitest';
import { classify, defaultClassifiers, parseContentRange, type ResponseInfo } from './classify';
import { HeaderCache, type HeaderEntry } from './header-cache';
import { createObserver, DEFAULT_MIN_DIRECT_SIZE, type DetectedMedia } from './observer';

const OWN = 'moz-extension://abc';
const MB = 1024 * 1024;

function response(
  over: Partial<ResponseInfo> & { headers?: Record<string, string> } = {},
): ResponseInfo {
  return {
    url: 'https://example.com/v/clip.mp4',
    type: 'media',
    status: 200,
    headers: {},
    ...over,
  };
}
const ctx = { minDirectSize: MB };

describe('classify', () => {
  it('accepts a media-type response above the minimum size', () => {
    expect(
      classify(
        response({
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(5 * MB),
            'accept-ranges': 'bytes',
          },
        }),
        ctx,
      ),
    ).toEqual({ kind: 'direct', mime: 'video/mp4', size: 5 * MB, resumable: true });
  });

  it('recognizes a table MIME type on a non-media request', () => {
    expect(
      classify(
        response({
          type: 'xmlhttprequest',
          headers: { 'content-type': 'Audio/MPEG; charset=x', 'content-length': String(2 * MB) },
        }),
        ctx,
      ),
    ).toMatchObject({ kind: 'direct', mime: 'audio/mpeg', resumable: false });
  });

  it('ignores small files, errors, fragments and unrelated types', () => {
    const big = { 'content-length': String(5 * MB) };
    expect(
      classify(
        response({ headers: { 'content-type': 'video/mp4', 'content-length': '1000' } }),
        ctx,
      ),
    ).toBeUndefined();
    expect(
      classify(response({ status: 404, headers: { 'content-type': 'video/mp4', ...big } }), ctx),
    ).toBeUndefined();
    expect(
      classify(response({ headers: { 'content-type': 'video/mp2t', ...big } }), ctx),
    ).toBeUndefined();
    for (const name of ['seg1.ts', 'a.m4s', 'a.aac']) {
      expect(
        classify(
          response({
            url: `https://example.com/${name}`,
            headers: { 'content-type': 'video/mp4', ...big },
          }),
          ctx,
        ),
      ).toBeUndefined();
    }
    expect(
      classify(
        response({
          type: 'xmlhttprequest',
          url: 'https://example.com/a.json',
          headers: { 'content-type': 'application/json', ...big },
        }),
        ctx,
      ),
    ).toBeUndefined();
  });

  it('reads the total from Content-Range on a 206 and skips seeks', () => {
    const start = response({
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': '100',
        'content-range': `bytes 0-99/${String(4 * MB)}`,
      },
    });
    expect(classify(start, ctx)).toMatchObject({ size: 4 * MB, resumable: true });
    const seek = response({
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-range': `bytes 500000-999999/${String(4 * MB)}`,
      },
    });
    expect(classify(seek, ctx)).toBeUndefined();
    const tiny = response({
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-99/1000' },
    });
    expect(classify(tiny, ctx)).toBeUndefined();
  });

  it('keeps a media response of unknown size', () => {
    expect(classify(response({ headers: { 'content-type': 'audio/ogg' } }), ctx)).toEqual({
      kind: 'direct',
      mime: 'audio/ogg',
      resumable: false,
    });
  });

  it('classifies HLS and DASH before direct files', () => {
    expect(
      classify(
        response({
          type: 'xmlhttprequest',
          url: 'https://e.com/a/master.m3u8',
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        }),
        ctx,
      )?.kind,
    ).toBe('hls');
    expect(
      classify(response({ type: 'xmlhttprequest', url: 'https://e.com/a/m.mpd' }), ctx)?.kind,
    ).toBe('dash');
  });

  it('runs custom classifiers in order', () => {
    const mine = () => ({ kind: 'dash' as const, resumable: false });
    expect(classify(response(), ctx, [mine, ...defaultClassifiers])?.kind).toBe('dash');
  });

  it('parses Content-Range', () => {
    expect(parseContentRange('bytes 0-9/100')).toEqual({ start: 0, total: 100 });
    expect(parseContentRange('bytes 5-9/*')).toEqual({ start: 5 });
    expect(parseContentRange('items 0-9/100')).toBeUndefined();
  });
});

describe('HeaderCache', () => {
  it('keeps the latest capture per tab and exact origin and expires by TTL', () => {
    let t = 0;
    const cache = new HeaderCache({ ttlMs: 1000, now: () => t });
    cache.record({
      tabId: 1,
      origin: 'https://a.com',
      headers: { cookie: 'x=1' },
    });
    cache.record({
      tabId: 1,
      origin: 'https://a.com',
      headers: { cookie: 'x=2' },
    });
    cache.record({
      tabId: 2,
      origin: 'https://a.com',
      headers: { cookie: 'other' },
      incognito: true,
    });
    expect(cache.get(1, 'https://a.com')?.headers.cookie).toBe('x=2');
    expect(cache.get(1, 'http://a.com')).toBeUndefined();
    t = 1001;
    expect(cache.get(1, 'https://a.com')).toBeUndefined();
  });

  it('evicts the oldest entries and clears a tab', () => {
    const cache = new HeaderCache({ maxEntries: 2 });
    for (const o of ['https://a', 'https://b', 'https://c'])
      cache.record({ tabId: 1, origin: o, headers: {} });
    expect(cache.get(1, 'https://a')).toBeUndefined();
    expect(cache.size).toBe(2);
    cache.clearTab(1);
    expect(cache.size).toBe(0);
  });

  it('persists changes and restores them without overriding newer memory', async () => {
    const saved: HeaderEntry[][] = [];
    const first = new HeaderCache({ persist: async (e) => void saved.push(e) });
    first.record({ tabId: 1, origin: 'https://a', headers: { referer: 'r' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(saved.at(-1)).toHaveLength(1);
    const second = new HeaderCache({ restore: async () => saved.at(-1) ?? [] });
    second.record({ tabId: 1, origin: 'https://a', headers: { referer: 'new' } });
    await second.restore();
    expect(second.get(1, 'https://a')?.headers.referer).toBe('new');
  });
});

describe('HeaderCache across suspension', () => {
  const entry = (tabId: number, origin: string, capturedAt = 0): HeaderEntry => ({
    tabId,
    origin,
    headers: { cookie: 'c' },
    capturedAt,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('does not bring a cleared tab back from the saved copy', async () => {
    let saved = [entry(5, 'https://a'), entry(5, 'https://b'), entry(6, 'https://a')];
    const cache = new HeaderCache({
      now: () => 0,
      restore: async () => saved,
      persist: async (e) => {
        saved = e;
      },
    });
    cache.record({ tabId: 5, origin: 'https://a', headers: { cookie: 'new' } });
    cache.clearTab(5);
    await tick();
    await cache.restore();
    expect(cache.get(5, 'https://a')).toBeUndefined();
    expect(cache.get(5, 'https://b')).toBeUndefined();
    expect(cache.get(6, 'https://a')).toBeDefined();
    expect(saved.map((e) => e.tabId)).toEqual([6]);
  });

  it('clears a saved tab even when nothing was in memory', async () => {
    let saved = [entry(5, 'https://a')];
    const cache = new HeaderCache({
      now: () => 0,
      restore: async () => saved,
      persist: async (e) => {
        saved = e;
      },
    });
    cache.clearTab(5);
    await tick();
    expect(saved).toEqual([]);
  });

  it('refreshes the saved copy so a steady stream does not expire after a suspension', async () => {
    let t = 0;
    let saved: HeaderEntry[] = [];
    const cache = new HeaderCache({
      ttlMs: 1000,
      now: () => t,
      persist: async (e) => {
        saved = e;
      },
    });
    const same = { tabId: 1, origin: 'https://a', headers: { cookie: 'c' } };
    cache.record(same);
    await tick();
    t = 600;
    cache.record(same);
    await tick();
    expect(saved[0]?.capturedAt).toBe(600);
  });

  it('prunes expired and excess entries on restore', async () => {
    const cache = new HeaderCache({
      ttlMs: 1000,
      maxEntries: 1,
      now: () => 1500,
      restore: async () => [
        entry(1, 'https://old', 100),
        entry(1, 'https://a', 1400),
        entry(1, 'https://b', 1450),
      ],
    });
    await cache.restore();
    expect(cache.size).toBe(1);
    expect(cache.get(1, 'https://b')).toBeDefined();
  });

  it('evicts the oldest entry on restore, not the capture that woke the background', async () => {
    const cache = new HeaderCache({
      maxEntries: 1,
      now: () => 500,
      restore: async () => [entry(1, 'https://old', 100)],
    });
    cache.record({ tabId: 1, origin: 'https://new', headers: { cookie: 'n' } });
    await cache.restore();
    expect(cache.get(1, 'https://new')).toBeDefined();
    expect(cache.get(1, 'https://old')).toBeUndefined();
  });

  it('leaves incognito unknown when the browser does not report it', () => {
    const cache = new HeaderCache();
    const observer = createObserver({
      ownOrigin: OWN,
      headerCache: cache,
      onDetect: () => undefined,
    });
    observer.onSendHeaders({ tabId: 1, frameId: 0, type: 'media', url: 'https://a.com/x' });
    expect(cache.get(1, 'https://a.com')?.incognito).toBeUndefined();
  });
});

describe('observer', () => {
  function setup(extra: Partial<Parameters<typeof createObserver>[0]> = {}) {
    const found: DetectedMedia[] = [];
    const cache = new HeaderCache();
    const observer = createObserver({
      ownOrigin: OWN,
      headerCache: cache,
      onDetect: (m) => found.push(m),
      now: () => 42,
      ...extra,
    });
    return { found, cache, observer };
  }
  const base = { tabId: 3, frameId: 0, type: 'media' };
  const mp4 = (extra = {}) => ({
    ...base,
    url: 'https://cdn.example.com/clip.mp4',
    statusCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: String(3 * MB) },
    ],
    ...extra,
  });

  it('yields exactly one item for a page that plays an MP4', () => {
    const { found, observer } = setup();
    // A page request, a small image, the video start, then the player seeking.
    observer.onResponseStarted({
      ...base,
      type: 'main_frame',
      url: 'https://example.com/',
      statusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
    });
    observer.onResponseStarted({
      ...base,
      type: 'image',
      url: 'https://example.com/a.png',
      statusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'image/png' }],
    });
    observer.onResponseStarted(
      mp4({
        statusCode: 206,
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Range', value: `bytes 0-1/${String(3 * MB)}` },
        ],
      }),
    );
    observer.onResponseStarted(
      mp4({
        statusCode: 206,
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Range', value: `bytes 900000-999999/${String(3 * MB)}` },
        ],
      }),
    );
    expect(found).toEqual([
      {
        tabId: 3,
        frameId: 0,
        url: 'https://cdn.example.com/clip.mp4',
        kind: 'direct',
        mime: 'video/mp4',
        size: 3 * MB,
        resumable: true,
        detectedAt: 42,
      },
    ]);
  });

  it('passes on the requesting document when the browser reports it', () => {
    const { found, observer } = setup();
    observer.onResponseStarted(mp4({ documentId: 'D1', parentDocumentId: 'P1' }));
    observer.onResponseStarted(mp4({ url: 'https://cdn.example.com/other.mp4' }));
    expect(found[0]).toMatchObject({ documentId: 'D1', parentDocumentId: 'P1' });
    expect(found[1]).not.toHaveProperty('documentId');
    expect(found[1]).not.toHaveProperty('parentDocumentId');
    expect(found[1]).not.toHaveProperty('navigation');
    observer.onResponseStarted(mp4({ type: 'main_frame', url: 'https://cdn.example.com/t.mp4' }));
    expect(found[2]).toMatchObject({ navigation: true });
  });

  it('skips own requests (by initiator), tabless requests and non-HTTP schemes', () => {
    const { found, observer, cache } = setup();
    observer.onResponseStarted(mp4({ initiator: OWN }));
    observer.onResponseStarted(mp4({ originUrl: `${OWN}/worker.js` }));
    observer.onResponseStarted(mp4({ tabId: -1 }));
    observer.onResponseStarted(mp4({ url: 'blob:https://example.com/xyz' }));
    observer.onSendHeaders({
      ...base,
      url: 'https://cdn.example.com/clip.mp4',
      initiator: OWN,
      requestHeaders: [{ name: 'Cookie', value: 'a=b' }],
    });
    expect(found).toEqual([]);
    expect(cache.size).toBe(0);
  });

  it('honors disabled domains and the configured minimum size', () => {
    const off = setup({ isDetectionEnabled: (h) => h !== 'cdn.example.com' });
    off.observer.onResponseStarted(mp4());
    expect(off.found).toEqual([]);
    const high = setup({ minDirectSize: () => 10 * MB });
    high.observer.onResponseStarted(mp4());
    expect(high.found).toEqual([]);
    expect(DEFAULT_MIN_DIRECT_SIZE).toBe(MB);
  });

  it('caches Referer, Origin and Cookie per tab and origin', () => {
    const { observer, cache } = setup();
    observer.onSendHeaders({
      ...base,
      url: 'https://cdn.example.com/clip.mp4',
      cookieStoreId: 'firefox-container-1',
      incognito: true,
      requestHeaders: [
        { name: 'Referer', value: 'https://example.com/' },
        { name: 'cookie', value: 'a=b' },
        { name: 'Accept', value: '*/*' },
      ],
    });
    expect(cache.get(3, 'https://cdn.example.com')).toMatchObject({
      headers: { referer: 'https://example.com/', cookie: 'a=b' },
      cookieStoreId: 'firefox-container-1',
      incognito: true,
    });
  });
});
