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
