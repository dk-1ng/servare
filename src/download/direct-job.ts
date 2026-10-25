import type { DownloadError } from '../messaging/schemas';
import { QuotaError } from '../media/storage';

/** The subset of `OpfsWriter` the runner needs. */
export interface JobWriter {
  writeAt(position: number, data: Uint8Array): void;
  truncate(size: number): void;
  finish(): Promise<File>;
  remove(): Promise<void>;
}

export interface DirectJobDeps {
  fetch(
    url: string,
    init: { signal: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response>;
  openWriter(jobId: string): Promise<JobWriter>;
  ensureFreeSpace(requiredBytes: number): Promise<void>;
  /** Called as bytes arrive; `total` is unknown without a trustworthy length. */
  onProgress?(bytesWritten: number, total: number | undefined): void;
  /** Resolves after `ms`, or rejects when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Backoff settings: total tries, first delay and the cap for any single wait. */
  retry?: { attempts: number; baseMs: number; maxMs: number };
  /** Random source in [0, 1) for jitter. */
  random?: () => number;
}

const YIELD_INTERVAL_MS = 50;
const DEFAULT_RETRY = { attempts: 4, baseMs: 500, maxMs: 30_000 };

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new JobError({ kind: 'cancelled' }));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new JobError({ kind: 'cancelled' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` as seconds or an HTTP date, in ms; undefined when absent or unusable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (value.trim() !== '' && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Thrown inside an attempt for failures worth another try. */
class Transient extends Error {
  constructor(
    readonly reason: unknown,
    readonly waitMs?: number,
  ) {
    super('transient');
  }
}

/** A failure already mapped to the UI contract's error kinds. */
export class JobError extends Error {
  constructor(readonly detail: DownloadError) {
    super(`Download failed: ${detail.kind}`);
    this.name = 'JobError';
  }
}

export function toDownloadError(error: unknown): DownloadError {
  if (error instanceof JobError) return error.detail;
  if (error instanceof QuotaError) return { kind: 'quota' };
  // OPFS reports a full disk as QuotaExceededError.
  if (error instanceof Error && error.name === 'QuotaExceededError') return { kind: 'quota' };
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Runner for a single direct file (§4.1, §4.9): the response is streamed straight into OPFS,
 * never held in memory. Transient failures (network errors, 408/429/5xx, a body cut short) are
 * retried with exponential backoff and jitter, resuming with `Range` when the server allows it.
 * Cancelling through `signal` or any final failure removes the temporary file.
 */
export async function runDirectJob(
  job: { jobId: string; url: string },
  deps: DirectJobDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<File> {
  const retry = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? abortableSleep;
  const random = deps.random ?? ((): number => Math.random());
  let writer: JobWriter | undefined;
  let position = 0;
  let total: number | undefined;
  let validator: string | undefined;
  let lastYield = Date.now();

  const attempt = async (): Promise<File> => {
    if (position > 0 && !validator) {
      // Without a validator a changed file would be spliced onto the old bytes: start over.
      position = 0;
      writer?.truncate(0);
    }
    const resuming = position > 0;
    const headers: Record<string, string> = {};
    if (resuming) {
      headers['Range'] = `bytes=${String(position)}-`;
      if (validator) headers['If-Range'] = validator;
    }
    let response: Response;
    try {
      response = await deps.fetch(job.url, { signal, headers });
    } catch (error) {
      if (signal.aborted) throw new JobError({ kind: 'cancelled' });
      throw new Transient(error);
    }
    if (!response.ok) {
      if (isTransientStatus(response.status)) {
        throw new Transient(
          new JobError({ kind: 'http', status: response.status }),
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      throw new JobError({ kind: 'http', status: response.status });
    }
    if (!response.body) throw new Transient(new JobError({ kind: 'incomplete', ratio: 0 }));

    if (resuming) {
      const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
      const sizeKnown = range?.[2] !== undefined && range[2] !== '*';
      if (
        response.status !== 206 ||
        Number(range?.[1]) !== position ||
        (sizeKnown && total !== undefined && Number(range[2]) !== total)
      ) {
        // The server ignored the range or the file changed: start over.
        position = 0;
        writer?.truncate(0);
      }
    }
    if (position === 0) {
      const etag = response.headers.get('etag');
      validator =
        (etag !== null && !etag.startsWith('W/') ? etag : undefined) ??
        response.headers.get('last-modified') ??
        undefined;
      // A transfer encoding changes the byte count, so only trust the header without one.
      const declared = Number(response.headers.get('content-length'));
      total =
        Number.isFinite(declared) && declared > 0 && !response.headers.has('content-encoding')
          ? declared
          : undefined;
      if (total !== undefined) await deps.ensureFreeSpace(total);
    }
    writer ??= await deps.openWriter(job.jobId);

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.writeAt(position, value);
        position += value.byteLength;
        deps.onProgress?.(position, total);
        // A buffered fast stream resolves every read as a microtask and would starve the
        // worker's message queue (cancel requests): give the event loop a turn now and then.
        if (Date.now() - lastYield > YIELD_INTERVAL_MS) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          lastYield = Date.now();
        }
      }
    } catch (error) {
      if (signal.aborted) throw new JobError({ kind: 'cancelled' });
      // Writer failures (quota, short write) are final; only the network side is retried.
      if (
        error instanceof Error &&
        (error.name === 'QuotaExceededError' || error.message.startsWith('Short OPFS'))
      ) {
        throw error;
      }
      throw new Transient(error);
    }
    if (position === 0) throw new JobError({ kind: 'incomplete', ratio: 0 });
    if (total !== undefined && position < total) {
      throw new Transient(new JobError({ kind: 'incomplete', ratio: position / total }));
    }
    return writer.finish();
  };

  try {
    for (let tries = 1; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof Transient)) throw error;
        if (tries >= retry.attempts) throw error.reason;
        const backoff = Math.min(retry.maxMs, retry.baseMs * 2 ** (tries - 1));
        const wait = Math.min(retry.maxMs, error.waitMs ?? backoff * (0.5 + random() / 2));
        await sleep(wait, signal);
      }
    }
  } catch (error) {
    await writer?.remove().catch(() => {
      // The original failure is the useful one; host cleanup removes leftovers.
    });
    throw error;
  }
}
