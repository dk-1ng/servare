import type { StorageAreaLike } from '../state';

/** The subset of `browser.downloads` the delivery needs. */
export interface DownloadsApiLike {
  download(options: {
    url: string;
    filename: string;
    conflictAction: 'uniquify';
    saveAs: boolean;
  }): Promise<number>;
  onChanged: {
    addListener(cb: (delta: DownloadDelta) => void): void;
  };
  /** Chromium only; Firefox has no such event and honors `filename` directly. */
  onDeterminingFilename?: {
    addListener(
      cb: (
        item: { id: number; url: string },
        suggest: (s: { filename: string; conflictAction: 'uniquify' }) => void,
      ) => void,
    ): void;
  };
}

export interface DownloadDelta {
  id: number;
  state?: { current?: string };
}

export interface DeliveryRequest {
  jobId: string;
  blobUrl: string;
  filename: string;
  saveAs: boolean;
}

export type DeliveryOutcome = 'complete' | 'interrupted';

interface Pending {
  jobId: string;
  filename: string;
  blobUrl: string;
  /** Unknown until `downloads.download` resolves, which can be after the first events fire. */
  downloadId?: number;
}

const KEY = 'delivery.pending';

/**
 * Background side of §4.9. The blob URL lives in the worker host, so it must stay valid
 * until `downloads.onChanged` reports the end of the download. The background can be
 * suspended in between, hence the pending list lives in storage, not in memory.
 */
export class Delivery {
  constructor(
    private readonly downloads: DownloadsApiLike,
    private readonly area: StorageAreaLike,
    private readonly release: (jobId: string, outcome: DeliveryOutcome) => Promise<void>,
  ) {}

  /** Register listeners synchronously at startup so a wake-up event is not missed. */
  listen(): void {
    this.downloads.onChanged.addListener((delta) => {
      const state = delta.state?.current;
      if (state === 'complete' || state === 'interrupted') {
        void this.finish(delta.id, state);
      }
    });
    this.downloads.onDeterminingFilename?.addListener((item, suggest) => {
      // The id may not be recorded yet, so match on the blob URL, which is stored first.
      void this.pending().then((list) => {
        const entry = list.find((e) => e.blobUrl === item.url);
        if (entry) suggest({ filename: entry.filename, conflictAction: 'uniquify' });
      });
      // Keeps the suggest callback valid after this listener returns (async response).
      return true;
    });
  }

  async deliver(request: DeliveryRequest): Promise<number> {
    const entry: Pending = {
      jobId: request.jobId,
      filename: request.filename,
      blobUrl: request.blobUrl,
    };
    await this.save([...(await this.pending()), entry]);
    let downloadId: number;
    try {
      downloadId = await this.downloads.download({
        url: request.blobUrl,
        filename: request.filename,
        conflictAction: 'uniquify',
        saveAs: request.saveAs,
      });
    } catch (error) {
      await this.save((await this.pending()).filter((e) => e.blobUrl !== request.blobUrl));
      throw error;
    }
    entry.downloadId = downloadId;
    await this.save((await this.pending()).map((e) => (e.blobUrl === entry.blobUrl ? entry : e)));
    return downloadId;
  }

  private async pending(): Promise<Pending[]> {
    const stored = (await this.area.get(KEY))[KEY];
    return Array.isArray(stored) ? (stored as Pending[]) : [];
  }

  private save(list: Pending[]): Promise<void> {
    return this.area.set({ [KEY]: list });
  }

  private async finish(downloadId: number, outcome: DeliveryOutcome): Promise<void> {
    const list = await this.pending();
    const entry = list.find((e) => e.downloadId === downloadId);
    if (!entry) return;
    await this.save(list.filter((e) => e !== entry));
    await this.release(entry.jobId, outcome);
  }

  /** True while any delivery is awaiting `onChanged`; the host must stay open until false. */
  async hasPending(): Promise<boolean> {
    return (await this.pending()).length > 0;
  }
}
