import type { DownloadError } from '../messaging/schemas';

/**
 * Host ↔ worker message types. Free of runtime dependencies on purpose: the worker bundle
 * stays small and avoids zod's `new Function` probe (flagged by `web-ext lint`).
 * The host validates what comes back with `FromWorkerSchema` in `worker-protocol.ts`.
 */
export type ToWorker =
  | {
      type: 'start';
      jobId: string;
      url: string;
      filename: string;
      /** TEMPORARY (design §2.3): stream-copy the fetched file into an MP4. */
      remux?: 'mp4' | undefined;
    }
  | { type: 'cancel'; jobId: string };

export type FromWorker =
  | { type: 'done'; jobId: string; filename: string; file: Blob }
  | { type: 'failed'; jobId: string; error: DownloadError }
  | { type: 'progress'; jobId: string; bytesWritten: number; total?: number | undefined };

export function isToWorker(value: unknown): value is ToWorker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.jobId !== 'string') return false;
  if (v.type === 'cancel') return true;
  return (
    v.type === 'start' &&
    typeof v.url === 'string' &&
    typeof v.filename === 'string' &&
    (v.remux === undefined || v.remux === 'mp4')
  );
}
