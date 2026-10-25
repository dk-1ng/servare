import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { OpfsWriter } from '@/src/media/opfs-writer';
import { ensureFreeSpace } from '@/src/media/storage';
import { runDirectJob, toDownloadError } from '@/src/download/direct-job';
import { isToWorker, type FromWorker } from '@/src/download/worker-messages';

/**
 * The download worker (module Web Worker, created by the worker host page; design §2.3).
 * For now it only knows direct files: HLS, DASH and the queue arrive with #21 and #25.
 */
export default defineUnlistedScript(() => {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage(message: FromWorker): void;
  };

  scope.onmessage = (event) => {
    if (!isToWorker(event.data)) return;
    const { jobId, url, filename } = event.data;
    runDirectJob(
      { jobId, url },
      {
        fetch: (target) => fetch(target, { credentials: 'include' }),
        openWriter: (id) => OpfsWriter.open(id),
        ensureFreeSpace: (bytes) => ensureFreeSpace(bytes),
      },
    )
      .then((file) => {
        scope.postMessage({ type: 'done', jobId, filename, file });
      })
      .catch((error: unknown) => {
        scope.postMessage({ type: 'failed', jobId, error: toDownloadError(error) });
      });
  };
});
