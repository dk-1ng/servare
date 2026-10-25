import { describe, expect, it } from 'vitest';
import {
  addPageInfoToLegacyJobs,
  DownloadHistory,
  HISTORY_LIMIT,
  historyEntryFor,
  jobPageInfo,
  type HistoryEntry,
} from './index';
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

describe('jobPageInfo', () => {
  it('keeps nothing for a private or unknown tab', () => {
    const priv = { incognito: true, title: 'secret', url: 'https://example.com/s' };
    expect(jobPageInfo(priv)).toEqual({ title: '', pageUrl: '', private: true });
    expect(jobPageInfo(undefined)).toEqual({ title: '', pageUrl: '', private: true });
  });

  it('keeps title and URL of a regular tab, dropping non-http and oversized URLs', () => {
    const tab = { incognito: false, title: 'T', url: 'https://example.com/a' };
    expect(jobPageInfo(tab)).toEqual({ title: 'T', pageUrl: tab.url, private: false });
    expect(jobPageInfo({ ...tab, url: 'about:blank' }).pageUrl).toBe('');
    expect(jobPageInfo({ ...tab, url: `https://e.com/${'a'.repeat(9000)}` }).pageUrl).toBe('');
  });
});

describe('historyEntryFor', () => {
  const job = { title: 'T', pageUrl: 'https://e.com/', private: false, outputName: 'a.mp4' };

  it('records done and failed jobs', () => {
    expect(historyEntryFor(job, 'j', 'done', 5, 9)).toMatchObject({
      id: 'j',
      status: 'done',
      bytes: 5,
      completedAt: 9,
      title: 'T',
    });
    expect(historyEntryFor(job, 'j', 'failed', 0, 9)?.status).toBe('failed');
  });

  it('falls back to the file name when there is no title', () => {
    expect(historyEntryFor({ ...job, title: '' }, 'j', 'done', 1, 1)?.title).toBe('a.mp4');
  });

  it('records nothing for private or cancelled jobs', () => {
    expect(historyEntryFor({ ...job, private: true }, 'j', 'done', 1, 1)).toBeUndefined();
    expect(historyEntryFor(job, 'j', 'cancelled', 0, 1)).toBeUndefined();
  });
});

describe('addPageInfoToLegacyJobs', () => {
  it('marks old jobs private', () => {
    expect(addPageInfoToLegacyJobs({ a: { mediaId: 'a', outputName: 'x' } })).toEqual({
      a: { mediaId: 'a', outputName: 'x', title: '', pageUrl: '', private: true },
    });
  });
});
