import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { OpfsWriter } from '@/src/media/opfs-writer';
import { ensureFreeSpace } from '@/src/media/storage';
import { runDirectJob, toDownloadError } from '@/src/download/direct-job';
import { runHlsJob } from '@/src/download/hls-job';
import { runRemuxJob } from '@/src/download/remux-job';
import { FILE_EXTENSION } from '@/src/media/container';
import { loadLibav } from '@/src/media/libav/loader';
import { CONNECTIONS_PER_PROFILE, createFetcher } from '@/src/net/fetcher';
import { withExtension } from '@/src/naming';
import { rulesFor } from '@/src/rules';
import { isToWorker, type FromWorker } from '@/src/download/worker-messages';

/** Progress messages are throttled: a fast download would otherwise flood the host. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * The download worker (module Web Worker, created by the worker host page; design §2.3).
 * It knows direct files, optionally stream-copied (temporary, see `runRemuxJob`), and HLS media
 * playlists (`runHlsJob`); DASH and the queue arrive with #26 and #25.
 */
export default defineUnlistedScript(() => {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage(message: FromWorker): void;
  };
  const controllers = new Map<string, AbortController>();
  // One fetcher for every job in this worker, so the per-host limit holds across jobs.
  // The player's cookies come from the header rules (design §4.1.1), never from the jar.
  // Only the built-in rules apply until the options page (#34) can store the user's own.
  const fetcher = createFetcher({
    fetch: (target, init) => fetch(target, { ...init, credentials: 'omit' }),
    profileFor: (url) => rulesFor(url.hostname).speedProfile,
  });

  scope.onmessage = (event) => {
    if (!isToWorker(event.data)) return;
    const message = event.data;
    if (message.type === 'cancel') {
      controllers.get(message.jobId)?.abort();
      return;
    }
    const { jobId, url, filename, remux, hls } = message;
    const controller = new AbortController();
    controllers.set(jobId, controller);
    let lastReport = 0;
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
    /** The finished file, and the name it is delivered under (the container's extension). */
    const run = async (): Promise<{ file: File; name: string }> => {
      if (hls) {
        // One libav instance per job, created only when the job needs it (design §8). Segments
        // are fetched as far ahead as the speed profile allows connections (§4.2).
        const profile = rulesFor(new URL(url).hostname).speedProfile;
        const result = await runHlsJob(
          { jobId, url },
          {
            onProgress: common.onProgress,
            openWriter: common.openWriter,
            fetch: fetcher.fetch,
            loadLibav,
            concurrency: CONNECTIONS_PER_PROFILE[profile],
          },
          controller.signal,
        );
        return {
          file: result.file,
          name: withExtension(filename, FILE_EXTENSION[result.container]),
        };
      }
      if (remux === 'mp4') {
        const result = await runRemuxJob(
          { jobId, url },
          { ...common, fetch: fetcher.fetch, loadLibav },
          controller.signal,
        );
        return {
          file: result.file,
          name: withExtension(filename, FILE_EXTENSION[result.container]),
        };
      }
      const file = await runDirectJob(
        { jobId, url },
        { ...common, fetch: fetcher.fetch },
        controller.signal,
      );
      return { file, name: filename };
    };
    run()
      .then(({ file, name }) => {
        scope.postMessage({ type: 'done', jobId, filename: name, file });
      })
      .catch((error: unknown) => {
        scope.postMessage({ type: 'failed', jobId, error: toDownloadError(error) });
      })
      .finally(() => {
        controllers.delete(jobId);
        // Safety net: frees any host slot a half-read body of this job might still hold.
        controller.abort();
      });
  };
});
