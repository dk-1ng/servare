import { describe, expect, it, vi } from 'vitest';
import { Delivery, type DownloadDelta, type DownloadsApiLike } from './delivery';

function setup() {
  const store: Record<string, unknown> = {};
  const area = {
    get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
    set: async (items: Record<string, unknown>) => void Object.assign(store, items),
    remove: async (k: string) => void delete store[k],
  };
  let changed!: (d: DownloadDelta) => void;
  let determining!: (
    item: { id: number; url: string },
    suggest: (s?: { filename: string; conflictAction: 'uniquify' }) => void,
  ) => unknown;
  const downloads: DownloadsApiLike = {
    download: vi.fn(async () => 7),
    search: vi.fn(async () => [{ id: 7, state: 'in_progress' }]),
    onChanged: { addListener: (cb) => (changed = cb) },
    onDeterminingFilename: { addListener: (cb) => (determining = cb) },
  };
  const release = vi.fn(async () => {});
  const delivery = new Delivery(downloads, area, release);
  delivery.listen();
  return { delivery, downloads, release, fire: (d: DownloadDelta) => changed(d), determining };
}

const request = { jobId: 'j1', blobUrl: 'blob:x', filename: 'a.mp4', saveAs: false };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Delivery', () => {
  it('downloads with uniquify and keeps the blob until the download completes', async () => {
    const { delivery, downloads, release, fire } = setup();
    expect(await delivery.deliver(request)).toBe(7);
    expect(downloads.download).toHaveBeenCalledWith({
      url: 'blob:x',
      filename: 'a.mp4',
      conflictAction: 'uniquify',
      saveAs: false,
    });
    fire({ id: 7, state: { current: 'in_progress' } });
    await flush();
    expect(release).not.toHaveBeenCalled();
    expect(await delivery.hasPending()).toBe(true);
    fire({ id: 7, state: { current: 'complete' } });
    await flush();
    expect(release).toHaveBeenCalledWith('j1', 'complete');
    expect(await delivery.hasPending()).toBe(false);
  });

  it('releases on interruption and ignores unknown downloads', async () => {
    const { delivery, release, fire } = setup();
    await delivery.deliver(request);
    fire({ id: 99, state: { current: 'complete' } });
    fire({ id: 7, state: { current: 'interrupted' } });
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('j1', 'interrupted');
  });

  it('drops the pending entry when downloads.download rejects', async () => {
    const { delivery, downloads } = setup();
    vi.mocked(downloads.download).mockRejectedValueOnce(new Error('denied'));
    await expect(delivery.deliver(request)).rejects.toThrow('denied');
    expect(await delivery.hasPending()).toBe(false);
  });

  it('enforces the file name on Chromium by blob URL', async () => {
    const { delivery, determining } = setup();
    await delivery.deliver(request);
    const suggest = vi.fn();
    expect(determining({ id: 7, url: 'blob:x' }, suggest)).toBe(true);
    await flush();
    expect(suggest).toHaveBeenCalledWith({ filename: 'a.mp4', conflictAction: 'uniquify' });
    const other = vi.fn();
    determining({ id: 8, url: 'https://elsewhere/' }, other);
    await flush();
    expect(other).toHaveBeenCalledWith();
  });

  it('releases a download that already ended before its id was recorded', async () => {
    const { delivery, downloads, release } = setup();
    vi.mocked(downloads.search).mockResolvedValueOnce([{ id: 7, state: 'interrupted' }]);
    await delivery.deliver(request);
    expect(release).toHaveBeenCalledWith('j1', 'interrupted');
    expect(await delivery.hasPending()).toBe(false);
  });

  it('keeps both entries when two jobs are delivered at once', async () => {
    const { delivery, downloads } = setup();
    vi.mocked(downloads.download).mockResolvedValueOnce(7).mockResolvedValueOnce(8);
    await Promise.all([
      delivery.deliver(request),
      delivery.deliver({ ...request, jobId: 'j2', blobUrl: 'blob:y' }),
    ]);
    expect(await delivery.hasPending()).toBe(true);
  });
});
