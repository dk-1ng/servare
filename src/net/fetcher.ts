import type { SpeedProfile } from '../rules';

/** Connections allowed at once to one host (design §4.2). */
export const CONNECTIONS_PER_PROFILE: Readonly<Record<SpeedProfile, number>> = {
  economy: 1,
  standard: 4,
  fast: 8,
};

export interface RetryPolicy {
  /** Total tries, the first one included. */
  attempts: number;
  /** Delay before the second try; doubles on each following one. */
  baseMs: number;
  /** Cap for a single backoff wait. */
  maxMs: number;
  /** Longest `Retry-After` still waited for; a server asking for more is not retried. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: Readonly<RetryPolicy> = {
  attempts: 4,
  baseMs: 500,
  maxMs: 30_000,
  maxRetryAfterMs: 120_000,
};

/** `Retry-After` as seconds or an HTTP date, in ms; undefined when absent or unusable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (value.trim() !== '' && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Exponential backoff with jitter: the wait after the `tries`-th failed try is
 * `baseMs * 2^(tries-1)`, capped at `maxMs`, then scaled to 50-100% so clients do not retry in step.
 * `random` yields values in [0, 1).
 */
export function backoffDelay(
  tries: number,
  policy: Pick<RetryPolicy, 'baseMs' | 'maxMs'>,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** (tries - 1));
  return exponential * (0.5 + random() / 2);
}

/** Resolves after `ms`, or rejects with an `AbortError` as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface HostState {
  active: number;
  waiters: { limit: number; grant: () => void }[];
  /** Wall-clock ms before which no new request goes out (a `429`/`503` with `Retry-After`). */
  cooldownUntil: number;
}

export interface FetcherDeps {
  /** The underlying `fetch`; the caller decides credentials and other defaults. */
  fetch(
    url: string,
    init: { signal: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response>;
  /** Speed profile for a URL, normally from the per-domain rules. */
  profileFor(url: URL): SpeedProfile;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Random source in [0, 1) for jitter. */
  random?: () => number;
  now?: () => number;
  retry?: RetryPolicy;
}

export interface Fetcher {
  /**
   * `fetch` with a per-host connection limit and retries of the request phase (network errors,
   * `408`, `429`, `5xx`). A host slot is held until the response body has been read to the end,
   * cancelled or failed, so the caller must consume or cancel every body it gets back.
   * A transient status that outlasts the retries is returned like any other response.
   */
  fetch: (
    url: string,
    init: { signal: AbortSignal; headers?: Record<string, string> },
  ) => Promise<Response>;
}

export function createFetcher(deps: FetcherDeps): Fetcher {
  const sleep = deps.sleep ?? abortableSleep;
  const random = deps.random ?? ((): number => Math.random());
  const now = deps.now ?? ((): number => Date.now());
  const retry = deps.retry ?? DEFAULT_RETRY;
  const hosts = new Map<string, HostState>();

  const stateOf = (key: string): HostState => {
    let state = hosts.get(key);
    if (!state) {
      state = { active: 0, waiters: [], cooldownUntil: 0 };
      hosts.set(key, state);
    }
    return state;
  };

  /** Takes one of the host's slots, queueing in arrival order; resolves to its release function. */
  const acquire = async (key: string, limit: number, signal: AbortSignal): Promise<() => void> => {
    const state = stateOf(key);
    const release = (): void => {
      state.active--;
      const next = state.waiters[0];
      if (next && state.active < next.limit) {
        state.waiters.shift();
        state.active++;
        next.grant();
      } else if (state.active === 0 && state.waiters.length === 0) {
        hosts.delete(key);
      }
    };
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (state.active < limit && state.waiters.length === 0) {
      state.active++;
      return release;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        limit,
        grant: (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        state.waiters.splice(state.waiters.indexOf(waiter), 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      state.waiters.push(waiter);
    });
    return release;
  };

  /** Hands the slot back when the body ends, however it ends. */
  const releasing = (response: Response, release: () => void, signal: AbortSignal): Response => {
    let released = false;
    const once = (): void => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', once);
      release();
    };
    if (!response.body) {
      once();
      return response;
    }
    signal.addEventListener('abort', once, { once: true });
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            once();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          once();
          controller.error(error);
        }
      },
      cancel(reason) {
        once();
        return reader.cancel(reason);
      },
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // The wrapper is a new object: keep what the caller reads to follow redirects.
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
    });
    return wrapped;
  };

  return {
    async fetch(url, init) {
      const target = new URL(url);
      const key = target.host;
      const limit = CONNECTIONS_PER_PROFILE[deps.profileFor(target)];
      const { signal } = init;

      for (let tries = 1; ; tries++) {
        // A host that asked us to slow down is left alone by every request, not just this one.
        for (
          let wait = stateOf(key).cooldownUntil - now();
          wait > 0;
          wait = stateOf(key).cooldownUntil - now()
        ) {
          await sleep(wait, signal);
        }
        const release = await acquire(key, limit, signal);

        let response: Response;
        try {
          response = await deps.fetch(url, init);
        } catch (error) {
          release();
          if (signal.aborted || tries >= retry.attempts) throw error;
          await sleep(backoffDelay(tries, retry, random), signal);
          continue;
        }

        if (!isTransientStatus(response.status) || tries >= retry.attempts) {
          return releasing(response, release, signal);
        }
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now());
        if (retryAfter !== undefined && retryAfter > retry.maxRetryAfterMs) {
          // The server wants a longer pause than we are willing to sit through: report it.
          return releasing(response, release, signal);
        }
        await response.body?.cancel().catch(() => undefined);
        release();
        const wait = retryAfter ?? backoffDelay(tries, retry, random);
        if (response.status === 429 || retryAfter !== undefined) {
          const state = stateOf(key);
          state.cooldownUntil = Math.max(state.cooldownUntil, now() + wait);
        }
        await sleep(wait, signal);
      }
    },
  };
}
