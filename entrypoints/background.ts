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
import { createStore, localArea, sessionArea } from '@/src/state';
import {
  DownloadErrorSchema,
  PortServer,
  requestOverRuntime,
  type DownloadError,
  type Handlers,
} from '@/src/messaging';
import { z } from 'zod';

const workerHost = createWorkerHost();

/** Jobs handed to the worker host whose result has not reached `Delivery` yet. */
const runningStore = createStore({
  area: sessionArea,
  key: 'direct.running',
  schema: z.array(z.string()),
  version: 1,
  defaults: (): string[] => [],
});

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

const delivery = new Delivery(browser.downloads, localArea, async (jobId, outcome) => {
  try {
    await requestOverRuntime(browser.runtime, 'delivery/release', { jobId, outcome });
  } finally {
    await closeHostWhenIdle();
  }
});

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
    if ((await runningStore.get()).length > 0 || (await delivery.hasPending())) return;
    await workerHost.close();
  });
}

function settle(jobId: string): void {
  runningStore
    .update((list) => list.filter((id) => id !== jobId))
    .then(closeHostWhenIdle)
    .catch((error: unknown) => {
      console.error('[servare] could not close the worker host', error);
    });
}

const handlers: Partial<Handlers> = {
  'media/list': ({ tabId }) => tabList.items(tabId),
  // Temporary development/E2E trigger; see 'download/start-direct' in the protocol.
  'download/start-direct': async ({ url, filename }) => {
    const jobId = crypto.randomUUID();
    try {
      await exclusive(async () => {
        await runningStore.update((list) => [...list, jobId]);
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
    return { jobId };
  },
  'delivery/deliver': async (request) => {
    // On failure the host cleans up and reports `worker/failed`, which settles the job; closing
    // the host here could cut that cleanup short.
    const downloadId = await delivery.deliver(request);
    settle(request.jobId);
    return { downloadId };
  },
  'worker/failed': async ({ jobId, error }) => {
    await failuresStore.update((list) => [...list, { jobId, error }].slice(-20));
    settle(jobId);
    return null;
  },
};

export default defineBackground({
  type: 'module',
  main() {
    // Listeners are registered synchronously so a wake-up event is never missed.
    delivery.listen();
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
