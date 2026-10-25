import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DownloadJob,
  type Handlers,
  type MediaItem,
  type PortLike,
  DownloadErrorSchema,
  MediaItemSchema,
  MessagingError,
  PortClient,
  PortServer,
  handleRequest,
} from './index';

const ORIGIN = 'moz-extension://abc/';

const item: MediaItem = {
  id: 'm1',
  tabId: 1,
  kind: 'hls',
  url: 'https://example.test/a.m3u8',
  pageUrl: 'https://example.test/',
  title: 'Clip',
  duration: 'live',
  variants: [{ id: 'v1', height: 720, container: 'mp4' }],
  audioTracks: [],
  subtitles: [],
  protected: false,
  detectedAt: 1,
};

const job: DownloadJob = {
  id: 'j1',
  mediaId: 'm1',
  audioTrackIds: [],
  subtitleIds: [],
  mode: 'video',
  status: 'queued',
  progress: 'indeterminate',
  bytesWritten: 0,
  outputName: 'clip.mp4',
};

/** Creates two connected ends of a fake port. */
function portPair(url = ORIGIN + 'popup.html'): {
  client: PortLike;
  server: PortLike;
  drop: () => void;
} {
  type Ends = { msg: ((m: unknown) => void)[]; dis: (() => void)[] };
  const a: Ends = { msg: [], dis: [] };
  const b: Ends = { msg: [], dis: [] };
  let dead = false;
  const end = (self: Ends, other: Ends): PortLike => ({
    sender: { url },
    postMessage(m) {
      if (dead) throw new Error('Attempt to postMessage on disconnected port');
      queueMicrotask(() => {
        other.msg.forEach((l) => {
          l(structuredClone(m));
        });
      });
    },
    disconnect() {
      drop();
    },
    onMessage: { addListener: (l) => void self.msg.push(l) },
    onDisconnect: { addListener: (l) => void self.dis.push(l) },
  });
  const drop = () => {
    if (dead) return;
    dead = true;
    [...a.dis, ...b.dis].forEach((l) => {
      l();
    });
  };
  return { client: end(a, b), server: end(b, a), drop };
}

const handlers: Partial<Handlers> = {
  'media/list': ({ tabId }) => (tabId === 1 ? [item] : []),
  'download/enqueue': () => job,
  'download/cancel': () => null,
};

afterEach(() => {
  vi.useRealTimers();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

function pair<T>(items: T[], index: number): T {
  const found = items[index];
  if (found === undefined) throw new Error(`No item at ${String(index)}`);
  return found;
}

describe('schemas', () => {
  it('accepts a valid media item and rejects a bad kind', () => {
    expect(MediaItemSchema.safeParse(item).success).toBe(true);
    expect(MediaItemSchema.safeParse({ ...item, kind: 'rtmp' }).success).toBe(false);
  });

  it('discriminates download errors by kind', () => {
    expect(DownloadErrorSchema.safeParse({ kind: 'http', status: 403 }).success).toBe(true);
    expect(DownloadErrorSchema.safeParse({ kind: 'http' }).success).toBe(false);
    expect(DownloadErrorSchema.safeParse({ kind: 'incomplete', ratio: 2 }).success).toBe(false);
  });
});

describe('handleRequest', () => {
  const req = (name: string, payload: unknown) => ({ kind: 'request', id: 'r', name, payload });

  it('answers a valid request', async () => {
    const res = await handleRequest(req('media/list', { tabId: 1 }), handlers);
    expect(res).toEqual({ kind: 'response', id: 'r', ok: true, payload: [item] });
  });

  it('rejects an unknown request name', async () => {
    const res = await handleRequest(req('nope', {}), handlers);
    expect(res).toMatchObject({ ok: false, error: { code: 'unknown-request' } });
  });

  it('rejects an invalid payload without calling the handler', async () => {
    const spy = vi.fn(() => []);
    const res = await handleRequest(req('media/list', { tabId: 'x' }), { 'media/list': spy });
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a malformed envelope that carries an id', async () => {
    const res = await handleRequest({ kind: 'request', id: 'r' }, handlers);
    expect(res).toMatchObject({ id: 'r', ok: false, error: { code: 'invalid-message' } });
  });

  it('ignores garbage it cannot answer', async () => {
    expect(await handleRequest('hello', handlers)).toBeUndefined();
    expect(await handleRequest({ kind: 'event', name: 'x', payload: 1 }, handlers)).toBeUndefined();
  });

  it('reports handler exceptions and invalid responses', async () => {
    const boom = await handleRequest(req('download/cancel', { jobId: 'j' }), {
      'download/cancel': () => {
        throw new Error('boom');
      },
    });
    expect(boom).toMatchObject({ ok: false, error: { code: 'handler-failed', message: 'boom' } });
    const bad = await handleRequest(req('media/list', { tabId: 1 }), {
      'media/list': () => [{ id: 1 }] as never,
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
  });
});

describe('PortClient / PortServer', () => {
  function setup() {
    const server = new PortServer(handlers, ORIGIN);
    const pairs: ReturnType<typeof portPair>[] = [];
    const client = new PortClient(
      () => {
        const pair = portPair();
        pairs.push(pair);
        server.accept(pair.server);
        return pair.client;
      },
      { reconnectDelay: 100 },
    );
    return { server, client, pairs };
  }

  it('round-trips a request', async () => {
    const { client } = setup();
    await expect(client.request('media/list', { tabId: 1 })).resolves.toEqual([item]);
  });

  it('applies payload defaults on the handler side', async () => {
    const seen = vi.fn(() => job);
    const server = new PortServer({ 'download/enqueue': seen }, ORIGIN);
    const client = new PortClient(() => {
      const p = portPair();
      server.accept(p.server);
      return p.client;
    });
    await client.request('download/enqueue', { mediaId: 'm1' });
    expect(seen).toHaveBeenCalledWith({
      mediaId: 'm1',
      audioTrackIds: [],
      subtitleIds: [],
      mode: 'video',
    });
  });

  it('rejects an invalid outgoing payload with a typed error', async () => {
    const { client } = setup();
    const err = await rejection(client.request('media/list', { tabId: 'x' } as never));
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toMatchObject({ code: 'invalid-payload' });
  });

  it('surfaces handler failures as typed errors', async () => {
    const server = new PortServer(
      {
        'download/cancel': () => {
          throw new Error('nope');
        },
      },
      ORIGIN,
    );
    const client = new PortClient(() => {
      const p = portPair();
      server.accept(p.server);
      return p.client;
    });
    const err = await rejection(client.request('download/cancel', { jobId: 'j' }));
    expect(err).toMatchObject({ code: 'handler-failed', message: 'nope' });
  });

  it('delivers validated events to listeners', async () => {
    const { client, server } = setup();
    const got = vi.fn();
    client.on('job/updated', got);
    await Promise.resolve();
    server.emit('job/updated', { job });
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toHaveBeenCalledWith({ job });
  });

  it('drops events that fail validation', async () => {
    const { client, pairs } = setup();
    const got = vi.fn();
    client.on('job/updated', got);
    pair(pairs, 0).server.postMessage({ kind: 'event', name: 'job/updated', payload: { job: 1 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(got).not.toHaveBeenCalled();
  });

  it('fails in-flight requests on disconnect and reconnects on the next request', async () => {
    const server = new PortServer({ 'media/list': () => new Promise<never[]>(() => {}) }, ORIGIN);
    const pairs: ReturnType<typeof portPair>[] = [];
    const client = new PortClient(() => {
      const p = portPair();
      pairs.push(p);
      server.accept(p.server);
      return p.client;
    });
    const inflight = client.request('media/list', { tabId: 1 });
    await Promise.resolve();
    pair(pairs, 0).drop();
    await expect(inflight).rejects.toMatchObject({ code: 'disconnected' });

    const retry = client.request('media/list', { tabId: 1 });
    await Promise.resolve();
    expect(pairs).toHaveLength(2);
    client.close();
    await expect(retry).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('reconnects with backoff while listeners exist and notifies onReconnect', async () => {
    vi.useFakeTimers();
    const { client, pairs } = setup();
    const reconnected = vi.fn();
    client.onReconnect(reconnected);
    client.on('job/updated', () => {});
    expect(pairs).toHaveLength(1);

    pair(pairs, 0).drop();
    await vi.advanceTimersByTimeAsync(99);
    expect(pairs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pairs).toHaveLength(2);
    expect(reconnected).toHaveBeenCalledTimes(1);

    pair(pairs, 1).drop(); // no message arrived in between, so the delay doubles
    await vi.advanceTimersByTimeAsync(199);
    expect(pairs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(pairs).toHaveLength(3);
    client.close();
  });

  it('does not reconnect by itself without listeners', async () => {
    vi.useFakeTimers();
    const { client, pairs } = setup();
    await client.request('media/list', { tabId: 1 });
    pair(pairs, 0).drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pairs).toHaveLength(1);
  });

  it('refuses ports that do not come from an extension page', () => {
    const { server } = setup();
    const foreign = portPair('https://evil.test/page');
    const disconnected = vi.fn();
    foreign.server.onDisconnect.addListener(disconnected);
    expect(server.accept(foreign.server)).toBe(false);
    expect(disconnected).toHaveBeenCalled();
    expect(server.connectionCount).toBe(0);
  });

  it('keeps broadcasting when one port throws on postMessage', async () => {
    const server = new PortServer(handlers, ORIGIN);
    const dead = portPair();
    dead.server.postMessage = () => {
      throw new Error('Attempt to postMessage on disconnected port');
    };
    const live = portPair();
    server.accept(dead.server);
    server.accept(live.server);
    const got = vi.fn();
    live.client.onMessage.addListener(got);
    server.emit('job/updated', { job });
    await Promise.resolve();
    expect(got).toHaveBeenCalledTimes(1);
    expect(server.connectionCount).toBe(1);
  });

  it('throws a typed error when emitting an invalid event', () => {
    const { server } = setup();
    expect(() => {
      server.emit('job/updated', { job: 1 } as never);
    }).toThrow(MessagingError);
  });

  it('times out unanswered requests', async () => {
    vi.useFakeTimers();
    const server = new PortServer({ 'media/list': () => new Promise<never[]>(() => {}) }, ORIGIN);
    const client = new PortClient(
      () => {
        const p = portPair();
        server.accept(p.server);
        return p.client;
      },
      { requestTimeout: 1000 },
    );
    const outcome = rejection(client.request('media/list', { tabId: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toMatchObject({ code: 'timeout' });
  });

  it('keeps retrying when connect() throws and survives throwing listeners', async () => {
    vi.useFakeTimers();
    const server = new PortServer(handlers, ORIGIN);
    let failures = 2;
    const pairs: ReturnType<typeof portPair>[] = [];
    const client = new PortClient(
      () => {
        if (pairs.length === 0 || failures-- <= 0) {
          const p = portPair();
          pairs.push(p);
          server.accept(p.server);
          return p.client;
        }
        throw new Error('no receiver');
      },
      { reconnectDelay: 10 },
    );
    client.on('job/updated', () => {
      throw new Error('bad listener');
    });
    const good = vi.fn();
    client.on('job/updated', good);
    client.onReconnect(() => {
      throw new Error('bad reconnect listener');
    });
    pair(pairs, 0).drop();
    await vi.advanceTimersByTimeAsync(10 + 20 + 40);
    expect(pairs).toHaveLength(2);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server.emit('job/updated', { job });
    await vi.advanceTimersByTimeAsync(0);
    expect(good).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('rejects non-http URLs and oversized titles', () => {
    expect(MediaItemSchema.safeParse({ ...item, url: 'javascript:alert(1)' }).success).toBe(false);
    expect(MediaItemSchema.safeParse({ ...item, thumbnail: 'file:///etc/passwd' }).success).toBe(
      false,
    );
    expect(MediaItemSchema.safeParse({ ...item, title: 'x'.repeat(5000) }).success).toBe(false);
    expect(
      MediaItemSchema.safeParse({ ...item, thumbnail: 'data:image/png;base64,AAAA' }).success,
    ).toBe(true);
  });

  it('stops tracking ports that disconnect', async () => {
    const { client, server, pairs } = setup();
    await client.request('media/list', { tabId: 1 });
    expect(server.connectionCount).toBe(1);
    pair(pairs, 0).drop();
    expect(server.connectionCount).toBe(0);
  });
});
