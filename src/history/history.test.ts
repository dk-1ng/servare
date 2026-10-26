import { describe, expect, it, vi } from 'vitest';
import {
  addPageInfoToLegacyJobs,
  DownloadHistory,
  downloadFingerprint,
  type DownloadLookup,
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

const noDownloads: DownloadLookup = { search: async () => [] };

describe('DownloadHistory', () => {
  it('lists newest first and honors the limit', async () => {
    const history = new DownloadHistory(memoryArea(), noDownloads);
    await history.record(entry('a'));
    await history.record(entry('b'));
    await history.record(entry('c'));
    expect((await history.list()).map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect((await history.list(2)).map((e) => e.id)).toEqual(['c', 'b']);
  });

  it('replaces an entry with the same id', async () => {
    const history = new DownloadHistory(memoryArea(), noDownloads);
    await history.record(entry('a', { status: 'failed' }));
    await history.record(entry('a'));
    const list = await history.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('done');
  });

  it('drops the oldest entries past the limit', async () => {
    const history = new DownloadHistory(memoryArea(), noDownloads);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await history.record(entry(`e${String(i)}`));
    const list = await history.list();
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0]?.id).toBe(`e${String(HISTORY_LIMIT + 4)}`);
    expect(list.at(-1)?.id).toBe('e5');
  });

  it('removes one entry and clears all', async () => {
    const history = new DownloadHistory(memoryArea(), noDownloads);
    await history.record(entry('a'));
    await history.record(entry('b'));
    expect((await history.remove('a')).map((e) => e.id)).toEqual(['b']);
    await history.clear();
    expect(await history.list()).toEqual([]);
  });
});

describe('DownloadHistory downloadId', () => {
  type Item = Awaited<ReturnType<DownloadLookup['search']>>[number];
  const file = { filename: '/home/u/a.mp4', startTime: '2026-10-25T10:00:00.000Z' };
  const item = (patch: Partial<Item> = {}): Item => ({
    id: 5,
    state: 'complete',
    exists: true,
    ...file,
    ...patch,
  });

  async function setup(items: (id: number) => Item[] | Error, extra = true) {
    const area = memoryArea();
    const search = vi.fn(async ({ id }: { id: number }) => {
      const r = items(id);
      if (r instanceof Error) throw r;
      return r;
    });
    const history = new DownloadHistory(area, { search });
    await history.record(entry('a', { downloadId: 5 }));
    if (extra) await history.attachFingerprint('a', 5, await downloadFingerprint(file));
    return { history, area, search };
  }
  const idOf = async (h: DownloadHistory, id = 'a') =>
    (await h.list()).find((e) => e.id === id)?.downloadId;

  it('serves downloadId for a complete, existing, matching download', async () => {
    const { history } = await setup(() => [item()]);
    expect(await idOf(history)).toBe(5);
  });

  it.each([
    ['erased', () => []],
    ['a different start time', () => [item({ startTime: '2026-10-26T10:00:00.000Z' })]],
    ['a different file name', () => [item({ filename: '/home/u/b.mp4' })]],
    ['a missing file', () => [item({ exists: false })]],
    ['an unfinished download', () => [item({ state: 'in_progress' })]],
    ['a failed lookup', () => new Error('boom')],
  ])('leaves downloadId out for %s', async (_name, items) => {
    const { history } = await setup(items);
    expect(await idOf(history)).toBeUndefined();
  });

  it('leaves it out while no fingerprint is attached', async () => {
    const { history } = await setup(() => [item()], false);
    expect(await idOf(history)).toBeUndefined();
  });

  it('drops only the entry whose lookup failed', async () => {
    const { history } = await setup((id) => (id === 5 ? new Error('boom') : [item({ id })]));
    await history.record(entry('b', { downloadId: 6 }));
    await history.attachFingerprint('b', 6, await downloadFingerprint(file));
    const list = await history.list();
    expect(list.find((e) => e.id === 'a')?.downloadId).toBeUndefined();
    expect(list.find((e) => e.id === 'b')?.downloadId).toBe(6);
  });

  it('never keeps a downloadId on a failed entry', async () => {
    const { history, search } = await setup(() => [item()]);
    await history.record(entry('f', { status: 'failed', downloadId: 5 }));
    expect(await idOf(history, 'f')).toBeUndefined();
    expect(search).toHaveBeenCalled();
  });

  it('ignores a wrong id or an unknown entry and is idempotent', async () => {
    const { history } = await setup(() => [item()], false);
    const fp = await downloadFingerprint(file);
    expect(await history.attachFingerprint('a', 9, fp)).toBe(false);
    expect(await history.attachFingerprint('zzz', 5, fp)).toBe(false);
    expect(await history.attachFingerprint('a', 5, fp)).toBe(true);
    expect(await history.attachFingerprint('a', 5, fp)).toBe(false);
  });

  it('never exposes the stored download field', async () => {
    const { history } = await setup(() => [item()]);
    for (const e of [...(await history.list()), ...(await history.record(entry('c')))]) {
      expect(e).not.toHaveProperty('download');
    }
  });

  it('parses old stored entries without a download field', async () => {
    const area = memoryArea();
    const first = new DownloadHistory(area, noDownloads);
    await first.record(entry('old'));
    expect((await new DownloadHistory(area, noDownloads).list()).map((e) => e.id)).toEqual(['old']);
  });
});

describe('downloadFingerprint', () => {
  it('is a deterministic 64-character lowercase hex digest', async () => {
    const a = await downloadFingerprint({ filename: '/a', startTime: 't' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await downloadFingerprint({ filename: '/a', startTime: 't' })).toBe(a);
    expect(await downloadFingerprint({ filename: '/a', startTime: 'u' })).not.toBe(a);
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

  it('keeps downloadId only on done entries', () => {
    expect(historyEntryFor(job, 'j', 'done', 1, 1, 3)?.downloadId).toBe(3);
    expect(historyEntryFor(job, 'j', 'failed', 0, 1, 3)).not.toHaveProperty('downloadId');
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
