import { describe, expect, it, vi } from 'vitest';
import type { SpeedProfile } from '../rules';
import {
  backoffDelay,
  CONNECTIONS_PER_PROFILE,
  createFetcher,
  parseRetryAfter,
  type RetryPolicy,
} from './fetcher';

const retry: RetryPolicy = { attempts: 4, baseMs: 100, maxMs: 1000, maxRetryAfterMs: 10_000 };

function body(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    },
  });
}

async function drain(response: Response): Promise<void> {
  await response.arrayBuffer();
}

function harness(
  responses: (Response | Error)[],
  options: { profile?: SpeedProfile; sleep?: (ms: number) => Promise<void> } = {},
) {
  const queue = [...responses];
  const waits: number[] = [];
  const clock = { now: 0 };
  const raw = vi.fn<(url: string, init: { signal: AbortSignal }) => Promise<Response>>(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response('x', { status: 500 });
  });
  const fetcher = createFetcher({
    fetch: raw,
    profileFor: () => options.profile ?? 'standard',
    // A fake clock that only moves when something sleeps keeps the tests instant and exact.
    sleep: async (ms: number) => {
      waits.push(ms);
      await options.sleep?.(ms);
      clock.now += ms;
    },
    random: () => 1,
    now: () => clock.now,
    retry,
  });
  const signal = new AbortController().signal;
  return { fetcher, raw, waits, clock, signal };
}

describe('retries', () => {
  it('retries 5xx with exponential backoff until it succeeds', async () => {
    const h = harness([
      new Response('', { status: 503 }),
      new Response('', { status: 500 }),
      new Response('ok'),
    ]);
    const response = await h.fetcher.fetch('http://a.test/x', { signal: h.signal });
    expect(response.status).toBe(200);
    expect(h.waits).toEqual([100, 200]);
    await drain(response);
  });

  it('retries network errors', async () => {
    const h = harness([new TypeError('network'), new Response('ok')]);
    const response = await h.fetcher.fetch('http://a.test/x', { signal: h.signal });
    expect(response.status).toBe(200);
    expect(h.raw).toHaveBeenCalledTimes(2);
    await drain(response);
  });

  it('rethrows the last network error when the tries run out', async () => {
    const h = harness(Array.from({ length: 4 }, () => new TypeError('down')));
    await expect(h.fetcher.fetch('http://a.test/x', { signal: h.signal })).rejects.toThrow('down');
    expect(h.raw).toHaveBeenCalledTimes(4);
  });

  it('returns the last transient status when the tries run out', async () => {
    const h = harness(Array.from({ length: 4 }, () => new Response('', { status: 502 })));
    const response = await h.fetcher.fetch('http://a.test/x', { signal: h.signal });
    expect(response.status).toBe(502);
    expect(h.raw).toHaveBeenCalledTimes(4);
    await drain(response);
  });

  it('does not retry a 403 or a 404', async () => {
    for (const status of [403, 404]) {
      const h = harness([new Response('', { status })]);
      const response = await h.fetcher.fetch('http://a.test/x', { signal: h.signal });
      expect(response.status).toBe(status);
      expect(h.raw).toHaveBeenCalledTimes(1);
      await drain(response);
    }
  });

  it('waits for Retry-After instead of the backoff', async () => {
    const h = harness([
      new Response('', { status: 429, headers: { 'retry-after': '5' } }),
      new Response('ok'),
    ]);
    await drain(await h.fetcher.fetch('http://a.test/x', { signal: h.signal }));
    expect(h.waits).toEqual([5000]);
  });

  it('does not retry when Retry-After asks for longer than the limit', async () => {
    const h = harness([
      new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
      new Response('ok'),
    ]);
    const response = await h.fetcher.fetch('http://a.test/x', { signal: h.signal });
    expect(response.status).toBe(429);
    expect(h.raw).toHaveBeenCalledTimes(1);
    expect(h.waits).toEqual([]);
    await drain(response);
  });

  it('keeps other requests to the host waiting after a 429', async () => {
    let finishFirstWait: () => void = () => undefined;
    const firstWait = new Promise<void>((resolve) => {
      finishFirstWait = resolve;
    });
    let sleeps = 0;
    const h = harness(
      [new Response('', { status: 429, headers: { 'retry-after': '5' } }), new Response('a')],
      { sleep: async () => (sleeps++ === 0 ? firstWait : undefined) },
    );
    const first = h.fetcher.fetch('http://a.test/x', { signal: h.signal });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // The first request is backing off. A request to the same host must wait out the same pause,
    // one to another host must not.
    h.raw.mockResolvedValueOnce(new Response('b'));
    const sameHost = h.fetcher.fetch('http://a.test/y', { signal: h.signal });
    h.raw.mockResolvedValueOnce(new Response('c'));
    const otherHost = h.fetcher.fetch('http://b.test/x', { signal: h.signal });
    await drain(await otherHost);
    // The backing-off request and the one to its host each sleep 5 s; the other host does not.
    expect(h.waits).toEqual([5000, 5000]);
    await drain(await sameHost);
    finishFirstWait();
    await drain(await first);
    expect(h.raw.mock.calls.map(([url]) => url)).toEqual([
      'http://a.test/x',
      'http://b.test/x',
      'http://a.test/y',
      'http://a.test/x',
    ]);
  });

  it('makes a request that was queued during a 429 wait out the cooldown too', async () => {
    let endFirstSleep: () => void = () => undefined;
    const firstSleep = new Promise<void>((resolve) => {
      endFirstSleep = resolve;
    });
    let sleeps = 0;
    const h = harness([], {
      profile: 'economy',
      sleep: async () => (sleeps++ === 0 ? firstSleep : undefined),
    });
    const sentAt: Record<string, number[]> = {};
    h.raw.mockImplementation(async (url) => {
      (sentAt[url] ??= []).push(h.clock.now);
      return url.endsWith('/a') && sentAt[url].length === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '1' } })
        : new Response('ok');
    });
    // Economy: /b is queued behind /a and gets the slot the moment /a gives up on its 429,
    // while /a is still backing off (its sleep is held open, so the clock stands still).
    const a = h.fetcher.fetch('http://a.test/a', { signal: h.signal });
    const b = h.fetcher.fetch('http://a.test/b', { signal: h.signal });
    await drain(await b);
    expect(sentAt['http://a.test/b']).toEqual([1000]);
    endFirstSleep();
    await drain(await a);
  });

  it('keeps a cooldown although the host went idle in the meantime', async () => {
    let closeB: () => void = () => undefined;
    let unblockSleep: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      unblockSleep = resolve;
    });
    let sleeps = 0;
    const h = harness([], { sleep: async () => (sleeps++ === 0 ? blocked : undefined) });
    const bodyB = new ReadableStream<Uint8Array>({
      start(controller) {
        closeB = () => controller.close();
      },
    });
    const sentAt: Record<string, number> = {};
    h.raw.mockImplementation(async (url) => {
      sentAt[url] ??= h.clock.now;
      if (url.endsWith('/a') && h.raw.mock.calls.filter(([u]) => u === url).length === 1) {
        return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      }
      return url.endsWith('/b') ? new Response(bodyB) : new Response('ok');
    });
    const b = await h.fetcher.fetch('http://a.test/b', { signal: h.signal });
    const a = h.fetcher.fetch('http://a.test/a', { signal: h.signal });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // /a is backing off (its sleep is blocked); /b was the host's other request and now ends,
    // which leaves the host idle while the cooldown still runs.
    closeB();
    await drain(b);
    const c = h.fetcher.fetch('http://a.test/c', { signal: h.signal });
    await drain(await c);
    expect(sentAt['http://a.test/c']).toBeGreaterThanOrEqual(2000);
    unblockSleep();
    await drain(await a);
  });

  it('stops retrying once aborted', async () => {
    const h = harness([new TypeError('network'), new Response('ok')]);
    const controller = new AbortController();
    h.raw.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(
      h.fetcher.fetch('http://a.test/x', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.raw).toHaveBeenCalledTimes(1);
  });
});

describe('per-host limit', () => {
  /** Responses whose bodies stay open until the test finishes them. */
  function openBodies() {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const next = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
          },
        }),
      );
    return { controllers, next };
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it.each(Object.entries(CONNECTIONS_PER_PROFILE) as [SpeedProfile, number][])(
    'allows %s %i connection(s) at once',
    async (profile, limit) => {
      const bodies = openBodies();
      const h = harness([], { profile });
      h.raw.mockImplementation(async () => bodies.next());
      for (let i = 0; i < limit + 2; i++) {
        void h.fetcher.fetch(`http://a.test/${String(i)}`, { signal: h.signal });
      }
      await flush();
      expect(h.raw).toHaveBeenCalledTimes(limit);
    },
  );

  it('starts the next queued request when a body ends', async () => {
    const bodies = openBodies();
    const h = harness([], { profile: 'economy' });
    h.raw.mockImplementation(async () => bodies.next());
    const first = await h.fetcher.fetch('http://a.test/1', { signal: h.signal });
    void h.fetcher.fetch('http://a.test/2', { signal: h.signal });
    await flush();
    expect(h.raw).toHaveBeenCalledTimes(1);
    bodies.controllers[0]?.close();
    await drain(first);
    await flush();
    expect(h.raw).toHaveBeenCalledTimes(2);
  });

  it('starts the next queued request when a body is cancelled', async () => {
    const bodies = openBodies();
    const h = harness([], { profile: 'economy' });
    h.raw.mockImplementation(async () => bodies.next());
    const first = await h.fetcher.fetch('http://a.test/1', { signal: h.signal });
    void h.fetcher.fetch('http://a.test/2', { signal: h.signal });
    await first.body?.cancel();
    await flush();
    expect(h.raw).toHaveBeenCalledTimes(2);
  });

  it('starts the next queued request when a body fails', async () => {
    const bodies = openBodies();
    const h = harness([], { profile: 'economy' });
    h.raw.mockImplementation(async () => bodies.next());
    const first = await h.fetcher.fetch('http://a.test/1', { signal: h.signal });
    void h.fetcher.fetch('http://a.test/2', { signal: h.signal });
    bodies.controllers[0]?.error(new Error('cut'));
    await expect(drain(first)).rejects.toThrow('cut');
    await flush();
    expect(h.raw).toHaveBeenCalledTimes(2);
  });

  it('releases the slot while backing off from a 5xx', async () => {
    const bodies = openBodies();
    const h = harness([], { profile: 'economy' });
    h.raw
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementation(async () => bodies.next());
    await h.fetcher.fetch('http://a.test/1', { signal: h.signal });
    expect(h.raw).toHaveBeenCalledTimes(2);
  });

  it('counts each host separately, ports included', async () => {
    const bodies = openBodies();
    const h = harness([], { profile: 'economy' });
    h.raw.mockImplementation(async () => bodies.next());
    for (const url of ['http://a.test/1', 'http://b.test/1', 'http://a.test:8080/1']) {
      void h.fetcher.fetch(url, { signal: h.signal });
    }
    await flush();
    expect(h.raw).toHaveBeenCalledTimes(3);
  });

  it('serves queued requests in arrival order', async () => {
    const bodies = openBodies();
    const h = harness([], { profile: 'economy' });
    h.raw.mockImplementation(async () => bodies.next());
    const first = await h.fetcher.fetch('http://a.test/0', { signal: h.signal });
    for (const n of [1, 2, 3])
      void h.fetcher.fetch(`http://a.test/${String(n)}`, { signal: h.signal });
    await flush();
    for (let i = 0; i < 3; i++) {
      bodies.controllers[i]?.close();
      if (i === 0) await drain(first);
      await flush();
    }
    expect(h.raw.mock.calls.map(([url]) => url)).toEqual([
      'http://a.test/0',
      'http://a.test/1',
      'http://a.test/2',
      'http://a.test/3',
    ]);
  });

  it('drops a queued request when its signal aborts, without taking a slot', async () => {
    const bodies = openBodies();
    const h = harness([], { profile: 'economy' });
    h.raw.mockImplementation(async () => bodies.next());
    const first = await h.fetcher.fetch('http://a.test/1', { signal: h.signal });
    const controller = new AbortController();
    const queued = h.fetcher.fetch('http://a.test/2', { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    bodies.controllers[0]?.close();
    await drain(first);
    await flush();
    expect(h.raw).toHaveBeenCalledTimes(1);
    // The slot is free again for a new request.
    await h.fetcher.fetch('http://a.test/3', { signal: h.signal });
    expect(h.raw).toHaveBeenCalledTimes(2);
  });

  it('frees the slot when the signal aborts mid-body', async () => {
    const bodies = openBodies();
    const h = harness([], { profile: 'economy' });
    h.raw.mockImplementation(async () => bodies.next());
    const controller = new AbortController();
    await h.fetcher.fetch('http://a.test/1', { signal: controller.signal });
    void h.fetcher.fetch('http://a.test/2', { signal: h.signal });
    controller.abort();
    await flush();
    expect(h.raw).toHaveBeenCalledTimes(2);
  });

  it('passes the response through intact', async () => {
    const h = harness([
      new Response(body([1, 2], [3]), { status: 206, headers: { 'content-range': 'bytes 0-2/3' } }),
    ]);
    const response = await h.fetcher.fetch('http://a.test/x', { signal: h.signal });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-2/3');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});

describe('helpers', () => {
  it('parses Retry-After as seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('backs off exponentially, capped, with 50-100% jitter', () => {
    const policy = { baseMs: 100, maxMs: 1000 };
    expect(backoffDelay(1, policy, () => 1)).toBe(100);
    expect(backoffDelay(3, policy, () => 1)).toBe(400);
    expect(backoffDelay(10, policy, () => 1)).toBe(1000);
    expect(backoffDelay(3, policy, () => 0)).toBe(200);
  });
});
