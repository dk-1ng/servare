import { z } from 'zod';
import { createStore, type StorageAreaLike } from '../state/store';
import { MediaKindSchema } from '../messaging/schemas';

/** Entries kept; the oldest go first once a new one pushes the list past this. */
export const HISTORY_LIMIT = 200;

/** UI contract §4.3. Stored as-is, so every field is bounded. */
export const HistoryEntrySchema = z.object({
  id: z.string(),
  title: z.string().max(1024),
  pageUrl: z.string().max(8192),
  outputName: z.string().max(255),
  kind: MediaKindSchema,
  completedAt: z.number(),
  bytes: z.number().nonnegative(),
  status: z.enum(['done', 'failed']),
  /**
   * Browser download of a `done` entry. Never stored: it is resolved and checked on every read
   * (design §4.9.1), so a reused or erased id is not served.
   */
  downloadId: z.number().int().nonnegative().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/** What is persisted: the contract entry with a checked reference in place of `downloadId`. */
export const StoredHistoryEntrySchema = HistoryEntrySchema.omit({ downloadId: true }).extend({
  download: z
    .object({
      id: z.number().int().nonnegative(),
      /** Lowercase hex SHA-256 of the item's file name and start time; see `downloadFingerprint`. */
      fingerprint: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    })
    .optional(),
});
export type StoredHistoryEntry = z.infer<typeof StoredHistoryEntrySchema>;

/** The subset of `browser.downloads` the history needs to check a stored reference. */
export interface DownloadLookup {
  search(query: {
    id: number;
  }): Promise<
    { id: number; state?: string; exists?: boolean; filename?: string; startTime?: string }[]
  >;
}

/** Identifies one downloaded file without keeping its path (design §4.9.1). */
export async function downloadFingerprint(item: {
  filename: string;
  startTime: string;
}): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([item.filename, item.startTime]));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Past downloads, newest first, in `storage.local` (design principle 4: private jobs are
 * never passed to `record`, so nothing about them reaches the disk).
 */
export class DownloadHistory {
  private readonly store;

  constructor(
    area: StorageAreaLike,
    private readonly downloads: DownloadLookup,
  ) {
    this.store = createStore({
      area,
      key: 'history.entries',
      schema: z.array(StoredHistoryEntrySchema),
      version: 1,
      defaults: (): StoredHistoryEntry[] => [],
    });
  }

  /** Adds an entry (replacing one with the same ID). */
  async record(entry: HistoryEntry): Promise<void> {
    const { downloadId, ...rest } = entry;
    const stored: StoredHistoryEntry =
      downloadId === undefined || entry.status !== 'done'
        ? rest
        : { ...rest, download: { id: downloadId } };
    await this.store.update((all) =>
      [stored, ...all.filter((e) => e.id !== stored.id)].slice(0, HISTORY_LIMIT),
    );
  }

  async list(limit?: number): Promise<HistoryEntry[]> {
    const all = await this.store.get();
    return this.resolve(limit === undefined ? all : all.slice(0, limit));
  }

  async remove(entryId: string): Promise<void> {
    await this.store.update((list) => list.filter((e) => e.id !== entryId));
  }

  /**
   * Stores the fingerprint of the entry's download. A no-op when the entry is gone or refers to
   * another download, and when the same fingerprint is already there. Returns whether it changed.
   */
  async attachFingerprint(
    entryId: string,
    downloadId: number,
    fingerprint: string,
  ): Promise<boolean> {
    let changed = false;
    await this.store.update((list) =>
      list.map((e) => {
        if (e.id !== entryId || e.download?.id !== downloadId) return e;
        if (e.download.fingerprint === fingerprint) return e;
        changed = true;
        return { ...e, download: { id: downloadId, fingerprint } };
      }),
    );
    return changed;
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }

  private resolve(list: StoredHistoryEntry[]): Promise<HistoryEntry[]> {
    return Promise.all(
      list.map(async ({ download, ...entry }): Promise<HistoryEntry> => {
        const id = await this.checkedId(download);
        return id === undefined ? entry : { ...entry, downloadId: id };
      }),
    );
  }

  /** The stored id, only while it still names the very file that was delivered. */
  private async checkedId(download: StoredHistoryEntry['download']): Promise<number | undefined> {
    if (!download?.fingerprint) return undefined;
    try {
      const item = (await this.downloads.search({ id: download.id })).find(
        (i) => i.id === download.id,
      );
      if (item?.state !== 'complete' || item.exists === false) return undefined;
      if (item.filename === undefined || item.startTime === undefined) return undefined;
      const now = await downloadFingerprint({
        filename: item.filename,
        startTime: item.startTime,
      });
      return now === download.fingerprint ? download.id : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Sends the history to the UI through one promise chain. Each turn reads the list when it
 * starts, so slow lookups cannot reorder emissions: the last one always matches the final
 * state of the store. A failed turn does not stop the ones after it.
 */
export function createHistoryNotifier(
  list: () => Promise<HistoryEntry[]>,
  emit: (entries: HistoryEntry[]) => void,
): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    const turn = tail.then(async () => {
      emit(await list());
    });
    tail = turn.catch(() => undefined);
    return turn;
  };
}

/** What a job remembers about its page for the history. */
export interface JobPageInfo {
  title: string;
  pageUrl: string;
  /** Private jobs, and jobs whose tab is unknown, never reach the history. */
  private: boolean;
}

const MAX_URL_LENGTH = 8192;

/**
 * Page details for a job from its tab (`undefined` when there is no tab or it is gone: the
 * privacy of the page cannot be told, so nothing is kept). A private tab's title and URL are
 * dropped here, so they are not stored anywhere.
 */
export function jobPageInfo(
  tab: { incognito: boolean; title?: string | undefined; url?: string | undefined } | undefined,
): JobPageInfo {
  if (!tab || tab.incognito) return { title: '', pageUrl: '', private: true };
  const url = tab.url ?? '';
  return {
    title: tab.title ?? '',
    pageUrl: /^https?:/.test(url) && url.length <= MAX_URL_LENGTH ? url : '',
    private: false,
  };
}

/** The entry to record for a finished job, or `undefined` when none may be (private, cancelled). */
export function historyEntryFor(
  job: JobPageInfo & { outputName: string },
  jobId: string,
  outcome: 'done' | 'failed' | 'cancelled',
  bytes: number,
  now: number,
  downloadId?: number,
): HistoryEntry | undefined {
  if (job.private || outcome === 'cancelled') return undefined;
  return {
    id: jobId,
    title: job.title.slice(0, 1024) || job.outputName,
    pageUrl: job.pageUrl,
    outputName: job.outputName,
    kind: 'direct',
    completedAt: now,
    bytes,
    status: outcome,
    ...(outcome === 'done' && downloadId !== undefined ? { downloadId } : {}),
  };
}

/** `runningStore` v2 → v3: jobs from before the history are treated as private. */
export function addPageInfoToLegacyJobs(data: unknown): unknown {
  return Object.fromEntries(
    Object.entries(data as Record<string, object>).map(
      ([id, job]) => [id, { ...job, title: '', pageUrl: '', private: true }] as const,
    ),
  );
}
