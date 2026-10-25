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
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/**
 * Past downloads, newest first, in `storage.local` (design principle 4: private jobs are
 * never passed to `record`, so nothing about them reaches the disk).
 */
export class DownloadHistory {
  private readonly store;

  constructor(area: StorageAreaLike) {
    this.store = createStore({
      area,
      key: 'history.entries',
      schema: z.array(HistoryEntrySchema),
      version: 1,
      defaults: (): HistoryEntry[] => [],
    });
  }

  /** Adds an entry (replacing one with the same ID) and returns the new list. */
  record(entry: HistoryEntry): Promise<HistoryEntry[]> {
    return this.store.update((list) =>
      [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, HISTORY_LIMIT),
    );
  }

  async list(limit?: number): Promise<HistoryEntry[]> {
    const all = await this.store.get();
    return limit === undefined ? all : all.slice(0, limit);
  }

  remove(entryId: string): Promise<HistoryEntry[]> {
    return this.store.update((list) => list.filter((e) => e.id !== entryId));
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }
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
