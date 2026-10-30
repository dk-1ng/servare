import { browser } from 'wxt/browser';
import { HostController } from '@/src/download/host-controller';
import { FromWorkerSchema } from '@/src/download/worker-protocol';
import { cleanupOrphans, removeJobFile } from '@/src/media/opfs-writer';
import { PortClient, respondToRuntimeMessage, type Handlers } from '@/src/messaging';

/**
 * The worker host (design §2.3): the one extension page that owns the download worker, so
 * the work survives the background being suspended. Opened and closed by the background.
 *
 * Offscreen documents only get `runtime` APIs: results go to the background over a port
 * (`delivery/deliver`, `worker/failed`), and the background reaches this page with
 * `runtime.sendMessage` (`worker/start`, `delivery/release`), which also works while no
 * port is connected.
 */
const origin = browser.runtime.getURL('/');
const client = new PortClient(() => browser.runtime.connect({ name: 'worker-host' }));

const controller = new HostController({
  deliver: (request) => client.request('delivery/deliver', { ...request, saveAs: false }),
  reportProgress: (jobId, bytesWritten, total) =>
    client.request('worker/progress', {
      jobId,
      bytesWritten,
      ...(total !== undefined && { total }),
    }),
  reportFailure: (jobId, error) => client.request('worker/failed', { jobId, error }),
  // An OPFS file has no type, and Chromium then sniffs the content and renames `.bin` to
  // `.txt`. `slice` re-types the file without reading it (it stays a reference).
  createObjectURL: (blob) =>
    URL.createObjectURL(blob.type ? blob : blob.slice(0, blob.size, 'application/octet-stream')),
  revokeObjectURL: (url) => {
    URL.revokeObjectURL(url);
  },
  removeJobFile: (jobId) => removeJobFile(jobId),
});

// Temporary files are owned by a host page. A freshly opened host runs nothing yet, and the
// blob URLs of a previous host died with it, so every file found now is a leftover. Jobs are
// only accepted once this is done, so it can never delete the file of a job started here.
const cleaned = cleanupOrphans(new Set())
  .then(({ removed, failed }) => {
    if (removed > 0 || failed.length > 0) {
      console.info(
        `[servare] removed ${String(removed)} leftover files, ${String(failed.length)} failed`,
      );
    }
  })
  .catch((error: unknown) => {
    console.error('[servare] orphan cleanup failed', error);
  });

const worker = new Worker(browser.runtime.getURL('/download-worker.js' as never), {
  type: 'module',
});
const running = new Set<string>();

worker.onmessage = (event: MessageEvent<unknown>) => {
  const parsed = FromWorkerSchema.safeParse(event.data);
  if (!parsed.success) return;
  if (parsed.data.type !== 'progress') running.delete(parsed.data.jobId);
  controller.onWorkerMessage(parsed.data).catch((error: unknown) => {
    console.error('[servare] worker result handling failed', error);
  });
};
worker.onerror = (event) => {
  // A crashed worker cannot say which job failed: fail every job it was running.
  const message = event.message || 'The download worker crashed';
  for (const jobId of running) {
    client
      .request('worker/failed', { jobId, error: { kind: 'unknown', message } })
      .catch(() => undefined);
  }
  running.clear();
};

const handlers: Partial<Handlers> = {
  'worker/start': async ({ jobId, url, filename, remux, hls }) => {
    await cleaned;
    running.add(jobId);
    worker.postMessage({
      type: 'start',
      jobId,
      url,
      filename,
      ...(remux && { remux }),
      ...(hls && { hls }),
    });
    return null;
  },
  'worker/cancel': ({ jobId }) => {
    // The worker removes its file and answers `failed: cancelled`.
    worker.postMessage({ type: 'cancel', jobId });
    return Promise.resolve(null);
  },
  'delivery/release': async ({ jobId }) => {
    await controller.release(jobId);
    return null;
  },
};

browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  // Content scripts can also reach extension pages; only the extension itself may drive jobs.
  if (!sender.url?.startsWith(origin)) return undefined;
  const response = respondToRuntimeMessage(raw, handlers);
  if (!response) return undefined;
  response.then(sendResponse, () => undefined);
  return true;
});
