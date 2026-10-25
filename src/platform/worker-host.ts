import { browser } from 'wxt/browser';
import { platform, type Platform } from './index';

/** What the manager needs from the browser; each browser implements its half. */
export interface WorkerHostApi {
  /** True when a worker host document (offscreen document or tab) is open. */
  exists(): Promise<boolean>;
  open(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens and closes the single worker host (design §2.3). `ensure` shares one in-flight
 * promise, so two events in the same wake cannot both create a host.
 */
export class WorkerHost {
  private opening: Promise<void> | undefined;

  constructor(private readonly api: WorkerHostApi) {}

  ensure(): Promise<void> {
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(): Promise<void> {
    if (await this.api.exists()) return;
    try {
      await this.api.open();
    } catch (error) {
      // Another context won the race (Chromium allows one offscreen document).
      if (!(await this.api.exists())) throw error;
    }
  }

  async close(): Promise<void> {
    // Wait for an open in progress, or the host would appear right after the close.
    await this.opening?.catch(() => {});
    if (await this.api.exists()) await this.api.close();
  }
}

const HOST_PATH = '/worker-host.html';

function hostUrl(): string {
  return browser.runtime.getURL(HOST_PATH);
}

async function hasContext(type: 'TAB' | 'OFFSCREEN_DOCUMENT'): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: [type],
    documentUrls: [hostUrl()],
  });
  return contexts.length > 0;
}

export function createChromiumHostApi(): WorkerHostApi {
  return {
    exists: () => hasContext('OFFSCREEN_DOCUMENT'),
    open: () =>
      browser.offscreen.createDocument({
        url: HOST_PATH,
        reasons: ['WORKERS'],
        justification: 'Runs the download worker, which must outlive the service worker.',
      }),
    close: () => browser.offscreen.closeDocument(),
  };
}

export function createFirefoxHostApi(): WorkerHostApi {
  return {
    exists: () => hasContext('TAB'),
    async open() {
      const tab = await browser.tabs.create({ url: hostUrl(), active: false });
      if (tab.id === undefined) return;
      // Keeps the tab from being unloaded under memory pressure; not every version honors it.
      await browser.tabs.update(tab.id, { autoDiscardable: false }).catch(() => undefined);
    },
    async close() {
      const tabs = await browser.tabs.query({ url: hostUrl() });
      const ids = tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
      if (ids.length > 0) await browser.tabs.remove(ids);
    },
  };
}

export function createWorkerHost(target: Platform = platform): WorkerHost {
  return new WorkerHost(
    target.needsOffscreenDocument ? createChromiumHostApi() : createFirefoxHostApi(),
  );
}
