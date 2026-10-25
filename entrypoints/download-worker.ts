import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { OpfsWriter } from '@/src/media/opfs-writer';
import { ensureFreeSpace } from '@/src/media/storage';
import { runDirectJob, toDownloadError } from '@/src/download/direct-job';
import { isToWorker, type FromWorker } from '@/src/download/worker-messages';

/** Progress messages are throttled: a fast download would otherwise flood the host. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * The download worker (module Web Worker, created by the worker host page; design §2.3).
 * For now it only knows direct files: HLS, DASH and the queue arrive with #21 and #25.
 */
export default defineUnlistedScript(() => {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage(message: FromWorker): void;
  };
  const controllers = new Map<string, AbortController>();

  scope.onmessage = (event) => {
    if (!isToWorker(event.data)) return;
    const message = event.data;
    if (message.type === 'cancel') {
      controllers.get(message.jobId)?.abort();
      return;
    }
    const { jobId, url, filename } = message;
    const controller = new AbortController();
    controllers.set(jobId, controller);
    let lastReport = 0;
    runDirectJob(
      { jobId, url },
      {
        // The player's cookies come from the header rules (design §4.1.1), never from the jar.
        fetch: (target, init) => fetch(target, { ...init, credentials: 'omit' }),
        openWriter: (id) => OpfsWriter.open(id),
        ensureFreeSpace: (bytes) => ensureFreeSpace(bytes),
        onProgress: (bytesWritten, total) => {
          const now = Date.now();
          if (now - lastReport < PROGRESS_INTERVAL_MS && bytesWritten !== total) return;
          lastReport = now;
          scope.postMessage({ type: 'progress', jobId, bytesWritten, total });
        },
      },
      controller.signal,
    )
      .then((file) => {
        scope.postMessage({ type: 'done', jobId, filename, file });
      })
      .catch((error: unknown) => {
        scope.postMessage({ type: 'failed', jobId, error: toDownloadError(error) });
      })
      .finally(() => {
        controllers.delete(jobId);
      });
  };
});
