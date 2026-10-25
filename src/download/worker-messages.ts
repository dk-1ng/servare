import type { DownloadError } from '../messaging/schemas';

/**
 * Host ↔ worker message types. Free of runtime dependencies on purpose: the worker bundle
 * stays small and avoids zod's `new Function` probe (flagged by `web-ext lint`).
 * The host validates what comes back with `FromWorkerSchema` in `worker-protocol.ts`.
 */
export interface ToWorker {
  type: 'start';
  jobId: string;
  url: string;
  filename: string;
}

export type FromWorker =
  | { type: 'done'; jobId: string; filename: string; file: Blob }
  | { type: 'failed'; jobId: string; error: DownloadError };

export function isToWorker(value: unknown): value is ToWorker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 'start' &&
    typeof v.jobId === 'string' &&
    typeof v.url === 'string' &&
    typeof v.filename === 'string'
  );
}
