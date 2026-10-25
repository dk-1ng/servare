import { z } from 'zod';
import { DownloadErrorSchema } from '../messaging/schemas';

export type { FromWorker, ToWorker } from './worker-messages';

/** Host side validation of what the worker sends (the worker itself is trusted code). */
export const FromWorkerSchema = z.discriminatedUnion('type', [
  /** The finished temporary file; the host turns it into a blob URL. */
  z.object({
    type: z.literal('done'),
    jobId: z.string(),
    filename: z.string(),
    file: z.instanceof(Blob),
  }),
  z.object({ type: z.literal('failed'), jobId: z.string(), error: DownloadErrorSchema }),
  z.object({
    type: z.literal('progress'),
    jobId: z.string(),
    bytesWritten: z.number().nonnegative(),
    total: z.number().positive().optional(),
  }),
]);
