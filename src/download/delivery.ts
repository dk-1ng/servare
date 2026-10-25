import { z } from 'zod';
import { createStore, type StorageAreaLike } from '../state';

/** The subset of `browser.downloads` the delivery needs. */
export interface DownloadsApiLike {
  download(options: {
    url: string;
    filename: string;
    conflictAction: 'uniquify';
    saveAs: boolean;
    /** Only sent where `DeliveryOptions.incognitoOption` is set: Chromium rejects it. */
    incognito?: boolean;
  }): Promise<number>;
  search(query: { id?: number; url?: string }): Promise<{ id: number; state?: string }[]>;
  /** Drops history entries only; the downloaded file stays on disk. */
  erase?(query: { id?: number }): Promise<number[]>;
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
  /**
   * The job came from a private window, or its tab is unknown. Its pending entry is kept in
   * `storage.session` only and, where supported, the download itself is made incognito.
   */
  private?: boolean;
  /**
   * The tab was actually seen as incognito. Firefox refuses `incognito: true` for an extension
   * without private-window access, so it is not sent for jobs that are merely of unknown origin.
   */
  incognito?: boolean;
}

export interface DeliveryAreas {
  /** Persisted: holds the pending deliveries of regular jobs. */
  local: StorageAreaLike;
  /** Cleared when the browser closes: the only place a private job's entry may live. */
  session: StorageAreaLike;
}

export interface DeliveryOptions {
  /** Firefox accepts `incognito` in `downloads.download`; Chromium rejects the unknown option. */
  incognitoOption?: boolean;
  /**
   * Chromium cannot make the download incognito and its background is a spanning one, so a
   * private job lands in the regular history. Erase that entry once the download ends.
   */
  erasePrivateHistory?: boolean;
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
 * suspended in between, hence the pending list lives in storage, not in memory. Private jobs
 * are listed in `storage.session` instead of `storage.local`, so no file name or URL of a
 * private download is ever written to disk (design principle 4).
 *
 * If `downloads.download` rejects (e.g. the user cancels Firefox's save-as dialog), `deliver`
 * throws and the caller owns releasing the blob URL and the OPFS file.
 *
 * If `release` fails (e.g. the host tab was closed) the entry is still dropped: the host's
 * `cleanupOrphans` at startup is the recovery path for the OPFS file.
 */
export class Delivery {
  private readonly localStore;
  private readonly sessionStore;
  private readonly stores;
  /** Blob URLs this context is still delivering; `recover` must not touch them. */
  private readonly inflight = new Set<string>();
  private releasing = 0;

  constructor(
    private readonly downloads: DownloadsApiLike,
    areas: DeliveryAreas,
    private readonly release: (jobId: string, outcome: DeliveryOutcome) => Promise<void>,
    /** Called after every release, once it no longer counts as in flight (success or not). */
    private readonly onReleased: () => Promise<void> = async () => {},
    private readonly options: DeliveryOptions = {},
  ) {
    const open = (area: StorageAreaLike) =>
      createStore({
        area,
        key: 'delivery.pending',
        schema: PendingSchema,
        version: 1,
        defaults: (): Pending[] => [],
      });
    this.localStore = open(areas.local);
    this.sessionStore = open(areas.session);
    this.stores = [this.localStore, this.sessionStore];
  }

  /** Applies `fn` to the pending list of each area. */
  private async updateAll(fn: (list: Pending[]) => Pending[]): Promise<void> {
    for (const store of this.stores) await store.update(fn);
  }

  /** Every pending entry, private or not. */
  private async getAll(): Promise<Pending[]> {
    return (await Promise.all(this.stores.map((store) => store.get()))).flat();
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
      this.updateAll((list) =>
        list.map((e) =>
          e.blobUrl === item.url && e.downloadId === undefined ? { ...e, downloadId: item.id } : e,
        ),
      ).catch((error: unknown) => {
        console.error('[servare] delivery id adoption failed', error);
      });
    });
    this.downloads.onDeterminingFilename?.addListener((item, suggest) => {
      // Fires for every download in the browser: always answer, or Chromium waits forever.
      // The id may not be recorded yet, so match on the blob URL, which is stored first.
      this.getAll()
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
    const isPrivate = request.private ?? false;
    const store = isPrivate ? this.sessionStore : this.localStore;
    this.inflight.add(blobUrl);
    try {
      await store.update((list) => [...list, { jobId, filename, blobUrl, createdAt: Date.now() }]);
      let downloadId: number;
      try {
        downloadId = await this.downloads.download({
          url: blobUrl,
          filename,
          conflictAction: 'uniquify',
          saveAs: request.saveAs,
          ...(request.incognito && this.options.incognitoOption ? { incognito: true } : {}),
        });
      } catch (error) {
        await store.update((list) => list.filter((e) => e.blobUrl !== blobUrl));
        throw error;
      }
      // The download already happened: a failure below must not turn into a failed delivery.
      // `onCreated` and `recover` fill in an id that could not be saved here.
      try {
        await store.update((list) =>
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
    const orphans = (await this.getAll()).filter(
      (e) => e.downloadId === undefined && !this.inflight.has(e.blobUrl),
    );
    for (const entry of orphans) {
      try {
        const [item] = await this.downloads.search({ url: entry.blobUrl });
        if (item) {
          await this.updateAll((list) =>
            list.map((e) => (e.blobUrl === entry.blobUrl ? { ...e, downloadId: item.id } : e)),
          );
          await this.catchUp(item.id);
        } else if (Date.now() - entry.createdAt > STALE_AFTER_MS) {
          // Counted before the entry leaves the store, as in `finish`.
          this.releasing++;
          try {
            await this.updateAll((list) => list.filter((e) => e.blobUrl !== entry.blobUrl));
          } catch (error) {
            this.releasing--;
            throw error;
          }
          await this.runRelease(entry.jobId, 'interrupted');
        }
      } catch (error) {
        console.error('[servare] delivery recovery failed for one entry', error);
      }
    }
  }

  private async finish(downloadId: number, outcome: DeliveryOutcome): Promise<void> {
    let entry: Pending | undefined;
    let wasPrivate = false as boolean;
    // Counted before the entry leaves the store: the host must not be closed in the gap
    // between the two, or the release would find no host and its OPFS file would be orphaned.
    this.releasing++;
    try {
      for (const store of this.stores) {
        await store.update((list) => {
          const found = list.find((e) => e.downloadId === downloadId);
          if (!found) return list;
          entry = found;
          wasPrivate = store === this.sessionStore;
          return list.filter((e) => e !== found);
        });
        if (entry) break;
      }
    } catch (error) {
      this.releasing--;
      throw error;
    }
    if (entry && wasPrivate && this.options.erasePrivateHistory) {
      await this.eraseFromHistory(downloadId);
    }
    if (entry) await this.runRelease(entry.jobId, outcome);
    else this.releasing--;
  }

  /** Best effort: a failure here must not keep the job's blob URL and OPFS file alive. */
  private async eraseFromHistory(downloadId: number): Promise<void> {
    try {
      await this.downloads.erase?.({ id: downloadId });
    } catch (error) {
      console.error('[servare] could not erase a private download from the history', error);
    }
  }

  /** Releases an entry already out of the store; the caller has raised `releasing`. */
  private async runRelease(jobId: string, outcome: DeliveryOutcome): Promise<void> {
    try {
      await this.release(jobId, outcome);
    } finally {
      this.releasing--;
      // After the decrement, so the last of several overlapping releases always sees zero.
      await this.onReleased().catch((error: unknown) => {
        console.error('[servare] post-release hook failed', error);
      });
    }
  }

  /**
   * Finishes between "entry removed from the store" and "release answered". The host must not
   * be closed in that gap, or the release would find no host and its OPFS file would be
   * orphaned.
   */
  get releasesInFlight(): number {
    return this.releasing;
  }

  /** True while any delivery is awaiting `onChanged`; the host must stay open until false. */
  async hasPending(): Promise<boolean> {
    return (await this.getAll()).length > 0;
  }
}
