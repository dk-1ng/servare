import type { DownloadError } from '../messaging/schemas';
import { QuotaError } from '../media/storage';
import { abortableSleep, backoffDelay, DEFAULT_RETRY, type RetryPolicy } from '../net/fetcher';

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
  /**
   * Backoff for a body that fails midway. Failures of the request itself (network errors,
   * 408/429/5xx) are retried by the fetcher behind `fetch`, not here.
   */
  retry?: Pick<RetryPolicy, 'attempts' | 'baseMs' | 'maxMs'>;
  /** Random source in [0, 1) for jitter. */
  random?: () => number;
}

const YIELD_INTERVAL_MS = 50;
/** A sleep whose cancellation is reported the way the job reports it. */
async function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await abortableSleep(ms, signal);
  } catch {
    throw new JobError({ kind: 'cancelled' });
  }
}

/** The resumed range did not match: try again from byte 0 at once, without waiting. */
class Restart extends Error {}

/** Thrown inside an attempt for failures worth another try. */
class Transient extends Error {
  constructor(readonly reason: unknown) {
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
 * never held in memory. A body cut short is retried with exponential backoff and jitter, resuming with `Range`
 * when the server allows it; request-phase failures are the fetcher's job (`src/net/fetcher.ts`).
 * Cancelling through `signal` or any final failure removes the temporary file.
 */
export async function runDirectJob(
  job: { jobId: string; url: string },
  deps: DirectJobDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<File> {
  const retry = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? cancellableSleep;
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
      throw error;
    }
    // The fetcher holds a host slot until the body ends: whatever happens below, leave no body
    // half read, or later downloads from this host would wait for it forever.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let drained = false;
    try {
      if (!response.ok) throw new JobError({ kind: 'http', status: response.status });
      if (!response.body) throw new Transient(new JobError({ kind: 'incomplete', ratio: 0 }));

      if (resuming) {
        const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(
          response.headers.get('content-range') ?? '',
        );
        const sizeKnown = range?.[2] !== undefined && range[2] !== '*';
        if (
          response.status !== 206 ||
          Number(range?.[1]) !== position ||
          (sizeKnown && total !== undefined && Number(range[2]) !== total)
        ) {
          position = 0;
          writer?.truncate(0);
          if (response.status === 206) {
            // A partial body that does not continue our bytes is useless, and its length says
            // nothing about the whole file: drop it and ask again from the start, without Range.
            await response.body.cancel().catch(() => undefined);
            validator = undefined;
            total = undefined;
            throw new Restart();
          }
          // A plain 200 carries the whole file again: read this body from the start.
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

      reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            drained = true;
            break;
          }
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
      return await writer.finish();
    } finally {
      if (!drained) await (reader ?? response.body)?.cancel().catch(() => undefined);
    }
  };

  try {
    for (let tries = 1; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        if (error instanceof Restart) {
          tries--; // not a failure: it does not use up an attempt
          continue;
        }
        if (!(error instanceof Transient)) throw error;
        if (tries >= retry.attempts) throw error.reason;
        await sleep(backoffDelay(tries, retry, random), signal);
      }
    }
  } catch (error) {
    await writer?.remove().catch(() => {
      // The original failure is the useful one; host cleanup removes leftovers.
    });
    throw error;
  }
}
