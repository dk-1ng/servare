import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { Delivery } from '@/src/download/delivery';
import { createWorkerHost } from '@/src/platform/worker-host';
import { platform } from '@/src/platform';
import { HeaderCache, type HeaderEntry } from '@/src/detection/header-cache';
import { createObserver, type DetectedMedia } from '@/src/detection/observer';
import { READ_PAGE_META, type PageMeta } from '@/src/detection/page-meta';
import { PageMetaSchema } from '@/src/detection/page-meta-schema';
import { TabMediaList, type ListState } from '@/src/detection/tab-list';
import { registerObserver } from '@/src/detection/register';
import { HeaderConflictError, HeaderReplay, type ReplayRecord } from '@/src/net/header-replay';
import {
  addPageInfoToLegacyJobs,
  DownloadHistory,
  historyEntryFor,
  jobPageInfo,
} from '@/src/history';
import { createStore, localArea, sessionArea } from '@/src/state';
import {
  DownloadErrorSchema,
  PortServer,
  requestOverRuntime,
  type DownloadError,
  type DownloadJob,
  type Handlers,
} from '@/src/messaging';
import { z } from 'zod';

const workerHost = createWorkerHost();

/** What `job/updated` needs about a job handed to the worker host (until #25 adds the queue). */
interface RunningJob {
  mediaId: string;
  outputName: string;
  title: string;
  pageUrl: string;
  /** Private-window jobs (or jobs whose tab is unknown) are never added to the history. */
  private: boolean;
}

/** Jobs handed to the worker host whose result has not reached `Delivery` yet. */
const runningStore = createStore({
  area: sessionArea,
  key: 'direct.running',
  schema: z.record(
    z.string(),
    z.object({
      mediaId: z.string(),
      outputName: z.string(),
      title: z.string(),
      pageUrl: z.string(),
      private: z.boolean(),
    }),
  ),
  version: 3,
  // Version 1 was a list of job IDs with nothing else known about them.
  migrations: {
    1: (data) =>
      Object.fromEntries(
        (data as string[]).map((id) => [id, { mediaId: id, outputName: '' }] as const),
      ),
    2: addPageInfoToLegacyJobs,
  },
  defaults: (): Record<string, RunningJob> => ({}),
});

/** Header replay rules per running job (design §4.1.1): ownership lives here, not in memory. */
const replayStore = createStore({
  area: sessionArea,
  key: 'download.replay',
  schema: z.record(z.string(), z.custom<ReplayRecord>()),
  version: 1,
  defaults: (): Record<string, ReplayRecord> => ({}),
});

const headerReplay = new HeaderReplay(
  browser.declarativeNetRequest,
  { read: () => replayStore.get(), update: (fn) => replayStore.update(fn) },
  new URL(browser.runtime.getURL('/')).host,
);

/**
 * TEMPORARY, until #11/#25 give jobs a real home: why a direct job failed, so a test can
 * read it from `storage.local` (key `direct.failures`). Newest last, capped.
 */
const failuresStore = createStore({
  area: localArea,
  key: 'direct.failures',
  schema: z.array(z.object({ jobId: z.string(), error: DownloadErrorSchema })),
  version: 1,
  defaults: (): { jobId: string; error: DownloadError }[] => [],
});

const history = new DownloadHistory(localArea);

/** Adds a finished job to the history and tells the UI; private jobs leave no trace (principle 4). */
async function recordHistory(
  jobId: string,
  job: RunningJob,
  outcome: 'done' | 'failed' | 'cancelled',
  bytes: number,
): Promise<void> {
  const entry = historyEntryFor(job, jobId, outcome, bytes, Date.now());
  if (!entry) return;
  server?.emit('history/updated', { entries: await history.record(entry) });
}

const headerStore = createStore({
  area: sessionArea,
  key: 'detection.headers',
  schema: z.array(z.custom<HeaderEntry>()),
  version: 1,
  defaults: (): HeaderEntry[] => [],
});

const headerCache = new HeaderCache({
  persist: (entries) => headerStore.set(entries),
  restore: () => headerStore.get(),
});

const listStore = createStore({
  area: sessionArea,
  key: 'detection.tabs',
  schema: z.custom<ListState>(),
  version: 1,
  defaults: (): ListState => ({}),
});

const tabList = new TabMediaList({ store: listStore });

/** The start-up sweep of orphaned header rules; a new job waits for it (see `start-direct`). */
let sweeping: Promise<unknown> = Promise.resolve();

/** Set in `main`; events are dropped while no UI is connected. */
let server: PortServer | undefined;

async function publish(tabId: number): Promise<void> {
  server?.emit('media/updated', { tabId, items: await tabList.items(tabId) });
}

function logFailure(what: string): (error: unknown) => void {
  return (error) => {
    console.error(`[servare] could not ${what}`, error);
  };
}

/** Title and thumbnail from the top frame's content script; absent on pages it cannot run in. */
async function readPageMeta(tabId: number): Promise<PageMeta> {
  try {
    const reply: unknown = await browser.tabs.sendMessage(
      tabId,
      { type: READ_PAGE_META },
      { frameId: 0 },
    );
    const parsed = PageMetaSchema.safeParse(reply);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

async function recordDetection(media: DetectedMedia): Promise<void> {
  const generation = tabList.generation(media.tabId);
  const tab = await browser.tabs.get(media.tabId);
  // The MediaItem contract only carries http(s) page URLs.
  if (!tab.url || !/^https?:/.test(tab.url)) return;
  const meta = await readPageMeta(media.tabId);
  await tabList.add(
    media,
    {
      pageUrl: tab.url,
      title: meta.title ?? tab.title,
      thumbnail: meta.thumbnail,
    },
    tab.incognito,
    generation,
  );
  await publish(media.tabId);
}

async function dropTab(tabId: number): Promise<void> {
  if (await tabList.clear(tabId)) await publish(tabId);
}

const observer = createObserver({
  ownOrigin: new URL(browser.runtime.getURL('/')).origin,
  headerCache,
  onDetect: (media) => {
    recordDetection(media).catch(logFailure('record a detection'));
  },
});

const delivery = new Delivery(
  browser.downloads,
  localArea,
  async (jobId, outcome) => {
    await requestOverRuntime(browser.runtime, 'delivery/release', { jobId, outcome });
  },
  // Runs after every release, success or not, once it is no longer in flight.
  () => closeHostWhenIdle(),
);

/**
 * Serializes host lifecycle steps ("add job + open + start" and "check idle + close"), so a
 * job that starts while the host is being closed cannot lose its host.
 */
let lifecycle: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(task, task);
  lifecycle = run.catch(() => undefined);
  return run;
}

/** The host stays open while a job runs or a blob URL is still being downloaded. */
function closeHostWhenIdle(): Promise<void> {
  return exclusive(async () => {
    // Another job's release is still on its way to the host: its own end will close it.
    if (delivery.releasesInFlight > 0) return;
    if (Object.keys(await runningStore.get()).length > 0 || (await delivery.hasPending())) return;
    await workerHost.close();
  });
}

/** A job left `running` (done, failed or cancelled): its rules and record go, the host may close. */
function settle(jobId: string): void {
  headerReplay
    .remove(jobId)
    .catch(logFailure('remove header rules'))
    .then(() =>
      runningStore.update((list) =>
        Object.fromEntries(Object.entries(list).filter(([id]) => id !== jobId)),
      ),
    )
    .then(() => closeHostWhenIdle())
    .catch((error: unknown) => {
      console.error('[servare] could not close the worker host', error);
    });
}

/** Records a terminal failure (or cancellation), tells the UI and releases the job's resources. */
async function failJob(jobId: string, error: DownloadError): Promise<void> {
  await failuresStore.update((list) => [...list, { jobId, error }].slice(-20));
  const job = (await runningStore.get())[jobId];
  if (job) {
    emitJob(jobId, job, { status: error.kind === 'cancelled' ? 'cancelled' : 'failed', error });
    await recordHistory(jobId, job, error.kind === 'cancelled' ? 'cancelled' : 'failed', 0).catch(
      logFailure('record the history'),
    );
  }
  settle(jobId);
}

/**
 * The host page went away under running jobs (Firefox: the user closed its tab, design §2.3).
 * Nothing will report them, so they fail here and their header rules go (§4.1.1).
 */
function failOrphanedJobs(): Promise<void> {
  return exclusive(async () => {
    if (await workerHost.exists()) return;
    for (const jobId of Object.keys(await runningStore.get())) {
      await failJob(jobId, { kind: 'unknown', message: 'The download worker was closed' });
    }
  });
}

function emitJob(jobId: string, job: RunningJob, patch: Partial<DownloadJob>): void {
  server?.emit('job/updated', {
    job: {
      id: jobId,
      mediaId: job.mediaId,
      audioTrackIds: [],
      subtitleIds: [],
      mode: 'video',
      status: 'running',
      progress: 'indeterminate',
      bytesWritten: 0,
      outputName: job.outputName,
      ...patch,
    },
  });
}

/** Header sets the player sent to `url`'s origin, from the tab that showed the media (§4.1.1). */
async function capturedHeaders(tabId: number | undefined, url: string): Promise<HeaderMap> {
  const origin = new URL(url).origin;
  // Always one entry, empty when nothing usable was captured: the empty set still owns a rule
  // that removes Referer/Origin/Cookie, and takes part in the conflict check, so this job can
  // never pick up the cookies of another running job's rule for the same origin (§4.1.1).
  const none: HeaderMap = { [origin]: {} };
  if (tabId === undefined) return none;
  await headerCache.restore();
  const entry = headerCache.get(tabId, origin);
  if (!entry) return none;
  // The values belong to one tab's cookie store: never replay them if the tab moved elsewhere.
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) return none;
  if (
    entry.cookieStoreId !== undefined &&
    (tab as { cookieStoreId?: string }).cookieStoreId !== entry.cookieStoreId
  ) {
    return none;
  }
  return { [origin]: entry.headers };
}

type HeaderMap = Parameters<HeaderReplay['apply']>[1];

const handlers: Partial<Handlers> = {
  'media/list': ({ tabId }) => tabList.items(tabId),
  // Temporary development/E2E trigger; see 'download/start-direct' in the protocol.
  'download/start-direct': async ({ url, filename, tabId }) => {
    const jobId = crypto.randomUUID();
    // Without a known tab there is no way to tell whether the page is private: record nothing.
    const tab =
      tabId === undefined ? undefined : await browser.tabs.get(tabId).catch(() => undefined);
    const job: RunningJob = {
      mediaId: jobId,
      outputName: filename,
      ...jobPageInfo(tab),
    };
    try {
      await exclusive(async () => {
        // The sweep removes rules no job owns: it must not run between this job's ownership
        // record and its rules.
        await sweeping;
        await runningStore.update((list) => ({ ...list, [jobId]: job }));
        try {
          await headerReplay.apply(jobId, await capturedHeaders(tabId, url));
        } catch (error) {
          // Until the queue (#25) can park a job, a header conflict refuses the download.
          if (error instanceof HeaderConflictError) {
            throw new Error(
              'Another download needs different headers for this site; try again later.',
              { cause: error },
            );
          }
          throw error;
        }
        await workerHost.ensure();
        // A host that was just created needs a moment before it listens.
        await requestOverRuntime(
          browser.runtime,
          'worker/start',
          { jobId, url, filename },
          { retries: 25, delay: 200 },
        );
      });
    } catch (error) {
      settle(jobId);
      throw error;
    }
    emitJob(jobId, job, {});
    return { jobId };
  },
  'history/list': ({ limit }) => history.list(limit),
  'history/remove': async ({ entryId }) => {
    server?.emit('history/updated', { entries: await history.remove(entryId) });
    return null;
  },
  'history/clear': async () => {
    await history.clear();
    server?.emit('history/updated', { entries: [] });
    return null;
  },
  'download/cancel': async ({ jobId }) => {
    const job = (await runningStore.get())[jobId];
    if (!job) return null;
    // Rules go first and unconditionally; the worker then drops its file and reports `cancelled`.
    try {
      await headerReplay.remove(jobId);
    } finally {
      // The user asked to stop: the worker hears it even if the rules could not be removed
      // (the job's `settle` retries the removal when the cancellation is reported).
      await requestOverRuntime(browser.runtime, 'worker/cancel', { jobId });
    }
    return null;
  },
  'worker/progress': async ({ jobId, bytesWritten, total }) => {
    const job = (await runningStore.get())[jobId];
    if (job) {
      emitJob(jobId, job, {
        bytesWritten,
        progress: total === undefined ? 'indeterminate' : Math.min(1, bytesWritten / total),
      });
    }
    return null;
  },
  'delivery/deliver': async (request) => {
    // On failure the host cleans up and reports `worker/failed`, which settles the job; closing
    // the host here could cut that cleanup short.
    const downloadId = await delivery.deliver(request);
    const job = (await runningStore.get())[request.jobId];
    if (job) {
      emitJob(request.jobId, job, {
        status: 'done',
        progress: 1,
        bytesWritten: request.bytes ?? 0,
      });
      await recordHistory(request.jobId, job, 'done', request.bytes ?? 0).catch(
        logFailure('record the history'),
      );
    }
    settle(request.jobId);
    return { downloadId };
  },
  'worker/failed': async ({ jobId, error }) => {
    await failJob(jobId, error);
    return null;
  },
};

export default defineBackground({
  type: 'module',
  main() {
    // Listeners are registered synchronously so a wake-up event is never missed.
    delivery.listen();
    browser.tabs.onRemoved.addListener(() => {
      failOrphanedJobs().catch(logFailure('fail jobs of a closed worker host'));
    });
    // Rules no running job owns (a crash, a restart) must not keep rewriting headers.
    sweeping = headerReplay.sweep().catch(logFailure('sweep header rules'));
    registerObserver(observer, (tabId) => {
      headerCache.clearTab(tabId);
      dropTab(tabId).catch(logFailure('clear the media list'));
    });
    // A new top-level navigation starts a new list (design §3.5).
    browser.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
      if (frameId === 0) dropTab(tabId).catch(logFailure('clear the media list'));
    });
    server = new PortServer(handlers, browser.runtime.getURL('/'));
    browser.runtime.onConnect.addListener((port) => {
      server?.accept(port);
    });
    browser.runtime.onInstalled.addListener(({ reason }) => {
      console.info(`[servare] ${reason} on ${platform.name}`);
    });
  },
});
