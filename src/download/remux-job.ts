import type { Libav } from '../media/libav/types';
import { remuxToMp4 } from '../media/remux';
import { JobError, type JobWriter } from './direct-job';

/**
 * Inputs above this size are refused: this runner holds the whole input in memory, which
 * is fine for a test file but not for real media (streaming input arrives with #22).
 */
export const REMUX_INPUT_LIMIT = 64 * 1024 ** 2;

const YIELD_INTERVAL_MS = 50;

export interface RemuxJobDeps {
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  openWriter(jobId: string): Promise<JobWriter>;
  ensureFreeSpace(requiredBytes: number): Promise<void>;
  /** Creates the job's own libav instance (design §8: never shared between jobs). */
  loadLibav(): Promise<Libav>;
  /** Replaceable for tests; defaults to `remuxToMp4`. */
  remux?: typeof remuxToMp4;
  /** Input bytes received so far; `total` is unknown without a trustworthy length. */
  onProgress?(bytesWritten: number, total: number | undefined): void;
}

function tooLarge(): JobError {
  return new JobError({
    kind: 'unknown',
    message: `The input is larger than ${String(REMUX_INPUT_LIMIT / 1024 ** 2)} MiB, the limit of the temporary remux`,
  });
}

async function fetchInput(
  url: string,
  deps: RemuxJobDeps,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await deps.fetch(url, { signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new JobError({ kind: 'http', status: response.status });
  }
  const declared = Number(response.headers.get('content-length'));
  const total =
    Number.isFinite(declared) && declared > 0 && !response.headers.has('content-encoding')
      ? declared
      : undefined;
  if (total !== undefined && total > REMUX_INPUT_LIMIT) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) throw new JobError({ kind: 'incomplete', ratio: 0 });

  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastYield = Date.now();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > REMUX_INPUT_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
    deps.onProgress?.(received, total);
    // Same reason as in the direct runner: let cancel requests through on a fast stream.
    if (Date.now() - lastYield > YIELD_INTERVAL_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYield = Date.now();
    }
  }
  if (received === 0) throw new JobError({ kind: 'incomplete', ratio: 0 });
  if (total !== undefined && received < total) {
    throw new JobError({ kind: 'incomplete', ratio: received / total });
  }
  const input = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return input;
}

/**
 * TEMPORARY runner behind `download/start-direct` with `remux: 'mp4'` (design §2.3), until the
 * remux pipeline (#22) and the real enqueue flow (#25) exist: fetches one whole media file,
 * stream-copies it into an MP4 written to OPFS and returns the file. The fetcher retries the
 * request; a body cut midway is not resumed. Cancelling
 * through `signal` or any failure removes the temporary file.
 */
export async function runRemuxJob(
  job: { jobId: string; url: string },
  deps: RemuxJobDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<File> {
  const remux = deps.remux ?? remuxToMp4;
  let writer: JobWriter | undefined;
  try {
    const input = await fetchInput(job.url, deps, signal);
    // A stream copy is about as large as its input.
    await deps.ensureFreeSpace(input.byteLength);
    const libav = await deps.loadLibav();
    if (signal.aborted) throw new JobError({ kind: 'cancelled' });
    const output = await deps.openWriter(job.jobId);
    writer = output;
    const size = await remux(
      libav,
      input,
      (position, data) => {
        output.writeAt(position, data);
      },
      signal,
    );
    if (size === 0) throw new JobError({ kind: 'incomplete', ratio: 0 });
    return await output.finish();
  } catch (error) {
    await writer?.remove().catch(() => {
      // The original failure is the useful one; host cleanup removes leftovers.
    });
    if (signal.aborted) throw new JobError({ kind: 'cancelled' });
    throw error;
  }
}
