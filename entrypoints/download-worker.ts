import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { OpfsWriter } from '@/src/media/opfs-writer';
import { ensureFreeSpace } from '@/src/media/storage';
import { runDirectJob, toDownloadError } from '@/src/download/direct-job';
import { runRemuxJob } from '@/src/download/remux-job';
import { loadLibav } from '@/src/media/libav/loader';
import { isToWorker, type FromWorker } from '@/src/download/worker-messages';

/** Progress messages are throttled: a fast download would otherwise flood the host. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * The download worker (module Web Worker, created by the worker host page; design §2.3).
 * For now it only knows direct files, optionally stream-copied into an MP4 (temporary, see
 * `runRemuxJob`): HLS, DASH and the queue arrive with #21 and #25.
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
    const { jobId, url, filename, remux } = message;
    const controller = new AbortController();
    controllers.set(jobId, controller);
    let lastReport = 0;
    // The player's cookies come from the header rules (design §4.1.1), never from the jar.
    const fetchOmit = (target: string, init: RequestInit): Promise<Response> =>
      fetch(target, { ...init, credentials: 'omit' });
    const common = {
      openWriter: (id: string) => OpfsWriter.open(id),
      ensureFreeSpace: (bytes: number) => ensureFreeSpace(bytes),
      onProgress: (bytesWritten: number, total: number | undefined) => {
        const now = Date.now();
        if (now - lastReport < PROGRESS_INTERVAL_MS && bytesWritten !== total) return;
        lastReport = now;
        scope.postMessage({ type: 'progress', jobId, bytesWritten, total });
      },
    };
    const run =
      remux === 'mp4'
        ? // One libav instance per job, created only when the job needs it (design §8).
          runRemuxJob({ jobId, url }, { ...common, fetch: fetchOmit, loadLibav }, controller.signal)
        : runDirectJob({ jobId, url }, { ...common, fetch: fetchOmit }, controller.signal);
    run
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
