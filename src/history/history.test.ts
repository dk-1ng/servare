import { describe, expect, it } from 'vitest';
import { DownloadHistory, HISTORY_LIMIT, type HistoryEntry } from './index';
import type { StorageAreaLike } from '../state/store';

function memoryArea(): StorageAreaLike {
  const data: Record<string, unknown> = {};
  return {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
    remove: async (key) => void delete data[key],
  };
}

const entry = (id: string, patch: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  title: `title ${id}`,
  pageUrl: 'https://example.com/page',
  outputName: `${id}.mp4`,
  kind: 'direct',
  completedAt: 1,
  bytes: 10,
  status: 'done',
  ...patch,
});

describe('DownloadHistory', () => {
  it('lists newest first and honors the limit', async () => {
    const history = new DownloadHistory(memoryArea());
    await history.record(entry('a'));
    await history.record(entry('b'));
    await history.record(entry('c'));
    expect((await history.list()).map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect((await history.list(2)).map((e) => e.id)).toEqual(['c', 'b']);
  });

  it('replaces an entry with the same id', async () => {
    const history = new DownloadHistory(memoryArea());
    await history.record(entry('a', { status: 'failed' }));
    await history.record(entry('a'));
    const list = await history.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('done');
  });

  it('drops the oldest entries past the limit', async () => {
    const history = new DownloadHistory(memoryArea());
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await history.record(entry(`e${String(i)}`));
    const list = await history.list();
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0]?.id).toBe(`e${String(HISTORY_LIMIT + 4)}`);
    expect(list.at(-1)?.id).toBe('e5');
  });

  it('removes one entry and clears all', async () => {
    const history = new DownloadHistory(memoryArea());
    await history.record(entry('a'));
    await history.record(entry('b'));
    expect((await history.remove('a')).map((e) => e.id)).toEqual(['b']);
    await history.clear();
    expect(await history.list()).toEqual([]);
  });
});
