import { z } from 'zod';
import { createStore, type StorageAreaLike } from '../state';

/** The subset of `browser.downloads` the delivery needs. */
export interface DownloadsApiLike {
  download(options: {
    url: string;
    filename: string;
    conflictAction: 'uniquify';
    saveAs: boolean;
  }): Promise<number>;
  search(query: { id?: number; url?: string }): Promise<{ id: number; state?: string }[]>;
  /** Fires with the id even if the context that called `download()` was suspended meanwhile. */
  onCreated?: {
    addListener(cb: (item: { id: number; url: string }) => void): void;
  };
  onChanged: {
    addListener(cb: (delta: DownloadDelta) => void): void;
  };
  /** Chromium only; Firefox has no such event and honors `filename` directly. */
  onDeterminingFilename?: {
    addListener(
      cb: (
        item: { id: number; url: string },
        suggest: (s?: { filename: string; conflictAction: 'uniquify' }) => void,
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

/** How long an id-less entry may wait (e.g. an open save-as dialog) before it is given up on. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type DeliveryOutcome = 'complete' | 'interrupted';

const PendingSchema = z.array(
  z.object({
    jobId: z.string(),
    filename: z.string(),
    blobUrl: z.string(),
    createdAt: z.number(),
    /** Unknown until `downloads.download` resolves, which can be after the first events fire. */
    downloadId: z.number().int().optional(),
  }),
);
type Pending = z.infer<typeof PendingSchema>[number];

/**
 * Background side of §4.9. The blob URL lives in the worker host, so it must stay valid
 * until `downloads.onChanged` reports the end of the download. The background can be
 * suspended in between, hence the pending list lives in storage, not in memory.
 *
 * If `release` fails (e.g. the host tab was closed) the entry is still dropped: the host's
 * `cleanupOrphans` at startup is the recovery path for the OPFS file.
 */
export class Delivery {
  private readonly store;
  /** Blob URLs this context is still delivering; `recover` must not touch them. */
  private readonly inflight = new Set<string>();

  constructor(
    private readonly downloads: DownloadsApiLike,
    area: StorageAreaLike,
    private readonly release: (jobId: string, outcome: DeliveryOutcome) => Promise<void>,
  ) {
    this.store = createStore({
      area,
      key: 'delivery.pending',
      schema: PendingSchema,
      version: 1,
      defaults: (): Pending[] => [],
    });
  }

  /** Register listeners synchronously at startup so a wake-up event is not missed. */
  listen(): void {
    this.recover().catch((error: unknown) => {
      console.error('[servare] delivery recovery failed', error);
    });
    this.downloads.onChanged.addListener((delta) => {
      const state = delta.state?.current;
      if (state === 'complete' || state === 'interrupted') {
        this.finish(delta.id, state).catch((error: unknown) => {
          console.error('[servare] delivery release failed', error);
        });
      }
    });
    this.downloads.onCreated?.addListener((item) => {
      this.store
        .update((list) =>
          list.map((e) =>
            e.blobUrl === item.url && e.downloadId === undefined
              ? { ...e, downloadId: item.id }
              : e,
          ),
        )
        .catch((error: unknown) => {
          console.error('[servare] delivery id adoption failed', error);
        });
    });
    this.downloads.onDeterminingFilename?.addListener((item, suggest) => {
      // Fires for every download in the browser: always answer, or Chromium waits forever.
      // The id may not be recorded yet, so match on the blob URL, which is stored first.
      this.store
        .get()
        .then((list) => {
          const entry = list.find((e) => e.blobUrl === item.url);
          if (entry) suggest({ filename: entry.filename, conflictAction: 'uniquify' });
          else suggest();
        })
        .catch(() => {
          suggest();
        });
      // Keeps the suggest callback valid after this listener returns (async response).
      return true;
    });
  }

  async deliver(request: DeliveryRequest): Promise<number> {
    const { jobId, blobUrl, filename } = request;
    this.inflight.add(blobUrl);
    try {
      await this.store.update((list) => [
        ...list,
        { jobId, filename, blobUrl, createdAt: Date.now() },
      ]);
      let downloadId: number;
      try {
        downloadId = await this.downloads.download({
          url: blobUrl,
          filename,
          conflictAction: 'uniquify',
          saveAs: request.saveAs,
        });
      } catch (error) {
        await this.store.update((list) => list.filter((e) => e.blobUrl !== blobUrl));
        throw error;
      }
      // The download already happened: a failure below must not turn into a failed delivery.
      // `onCreated` and `recover` fill in an id that could not be saved here.
      try {
        await this.store.update((list) =>
          list.map((e) => (e.blobUrl === blobUrl ? { ...e, downloadId } : e)),
        );
        await this.catchUp(downloadId);
      } catch (error) {
        console.error('[servare] delivery bookkeeping failed', error);
      }
      return downloadId;
    } finally {
      this.inflight.delete(blobUrl);
    }
  }

  /**
   * A small file or a cancelled save-as dialog can end before the id was recorded, and that
   * terminal event was then unmatched. Catch up from the download's current state.
   */
  private async catchUp(downloadId: number): Promise<void> {
    const [item] = await this.downloads.search({ id: downloadId });
    if (item?.state === 'complete' || item?.state === 'interrupted') {
      await this.finish(downloadId, item.state);
    }
  }

  /**
   * Resolves entries left without an id because the background was suspended or restarted
   * while `downloads.download` was pending (Firefox waits on the save-as dialog). Found by
   * blob URL: adopt the id and catch up. Not found is NOT final: Firefox creates the item
   * only after the dialog closes, so an entry is released as `interrupted` only once it is
   * older than `STALE_AFTER_MS`.
   */
  async recover(): Promise<void> {
    const orphans = (await this.store.get()).filter(
      (e) => e.downloadId === undefined && !this.inflight.has(e.blobUrl),
    );
    for (const entry of orphans) {
      try {
        const [item] = await this.downloads.search({ url: entry.blobUrl });
        if (item) {
          await this.store.update((list) =>
            list.map((e) => (e.blobUrl === entry.blobUrl ? { ...e, downloadId: item.id } : e)),
          );
          await this.catchUp(item.id);
        } else if (Date.now() - entry.createdAt > STALE_AFTER_MS) {
          await this.store.update((list) => list.filter((e) => e.blobUrl !== entry.blobUrl));
          await this.release(entry.jobId, 'interrupted');
        }
      } catch (error) {
        console.error('[servare] delivery recovery failed for one entry', error);
      }
    }
  }

  private async finish(downloadId: number, outcome: DeliveryOutcome): Promise<void> {
    let entry: Pending | undefined;
    await this.store.update((list) => {
      entry = list.find((e) => e.downloadId === downloadId);
      return entry ? list.filter((e) => e !== entry) : list;
    });
    if (entry) await this.release(entry.jobId, outcome);
  }

  /** True while any delivery is awaiting `onChanged`; the host must stay open until false. */
  async hasPending(): Promise<boolean> {
    return (await this.store.get()).length > 0;
  }
}
