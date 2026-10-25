import type { DownloadError } from '../messaging/schemas';
import { QuotaError } from '../media/storage';

/** The subset of `OpfsWriter` the runner needs. */
export interface JobWriter {
  writeAt(position: number, data: Uint8Array): void;
  finish(): Promise<File>;
  remove(): Promise<void>;
}

export interface DirectJobDeps {
  fetch(url: string): Promise<Response>;
  openWriter(jobId: string): Promise<JobWriter>;
  ensureFreeSpace(requiredBytes: number): Promise<void>;
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
 * Minimal runner for a single direct file (§4.9): the response is streamed straight into
 * OPFS, never held in memory. Resume, HLS and the queue belong to later issues.
 * On failure the temporary file is removed and a `JobError`/`QuotaError`/other error is thrown.
 */
export async function runDirectJob(
  job: { jobId: string; url: string },
  deps: DirectJobDeps,
): Promise<File> {
  const response = await deps.fetch(job.url);
  if (!response.ok) throw new JobError({ kind: 'http', status: response.status });
  if (!response.body) throw new JobError({ kind: 'incomplete', ratio: 0 });

  // A transfer encoding changes the byte count, so only trust the header without one.
  const declared = Number(response.headers.get('content-length'));
  const expected =
    Number.isFinite(declared) && declared > 0 && !response.headers.has('content-encoding')
      ? declared
      : undefined;
  if (expected !== undefined) await deps.ensureFreeSpace(expected);

  const writer = await deps.openWriter(job.jobId);
  try {
    const reader = response.body.getReader();
    let position = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.writeAt(position, value);
      position += value.byteLength;
    }
    if (position === 0) throw new JobError({ kind: 'incomplete', ratio: 0 });
    if (expected !== undefined && position < expected) {
      throw new JobError({ kind: 'incomplete', ratio: position / expected });
    }
    return await writer.finish();
  } catch (error) {
    await writer.remove().catch(() => {
      // The original failure is the useful one; host cleanup removes leftovers.
    });
    throw error;
  }
}
