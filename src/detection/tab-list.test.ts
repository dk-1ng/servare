import { describe, expect, it } from 'vitest';
import { createStore, type StorageAreaLike } from '@/src/state/store';
import { z } from 'zod';
import { MediaItemSchema } from '@/src/messaging';
import { normalizeUrl } from './normalize';
import type { DetectedMedia } from './observer';
import { readPageMeta } from './page-meta';
import { pageUrlFor, TabMediaList, type ListState } from './tab-list';

const MB = 1024 * 1024;

function memoryArea(): StorageAreaLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (key) => Promise.resolve(data.has(key) ? { [key]: data.get(key) } : {}),
    set: (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
      return Promise.resolve();
    },
    remove: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

function setup() {
  const area = memoryArea();
  const store = createStore({
    area,
    key: 'tabs',
    schema: z.custom<ListState>(),
    version: 1,
    defaults: (): ListState => ({}),
  });
  return { area, list: new TabMediaList({ store }) };
}

const page = { pageUrl: 'https://example.com/watch', title: 'A video' };

function media(over: Partial<DetectedMedia> = {}): DetectedMedia {
  return {
    tabId: 1,
    frameId: 0,
    url: 'https://cdn.example.com/v/clip.mp4',
    kind: 'direct',
    mime: 'video/mp4',
    size: 50 * MB,
    resumable: true,
    detectedAt: 1000,
    ...over,
  };
}

describe('normalizeUrl', () => {
  it('drops volatile parameters and fragments and sorts the rest', () => {
    expect(normalizeUrl('https://a.com/v.mp4?b=2&token=x&a=1&X-Amz-Signature=s#t=3')).toBe(
      'https://a.com/v.mp4?a=1&b=2',
    );
  });

  it('keeps parameters that identify the media', () => {
    expect(normalizeUrl('https://a.com/v?id=1')).not.toBe(normalizeUrl('https://a.com/v?id=2'));
  });

  it('returns invalid input unchanged', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('TabMediaList', () => {
  it('shows the same media with different tokens once, with the latest URL', async () => {
    const { list } = setup();
    await list.add(media({ url: 'https://c.com/v.mp4?token=old' }), page, false);
    await list.add(media({ url: 'https://c.com/v.mp4?token=new', detectedAt: 2000 }), page, false);
    const items = await list.items(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ url: 'https://c.com/v.mp4?token=new', detectedAt: 1000 });
    expect(MediaItemSchema.safeParse(items[0]).success).toBe(true);
  });

  it('keeps tabs apart and clears one tab', async () => {
    const { list } = setup();
    await list.add(media(), page, false);
    await list.add(media({ tabId: 2 }), page, false);
    expect(await list.clear(1)).toBe(true);
    expect(await list.items(1)).toEqual([]);
    expect(await list.items(2)).toHaveLength(1);
    expect(await list.clear(1)).toBe(false);
  });

  it('hides small direct files while a manifest exists', async () => {
    const { list } = setup();
    await list.add(media({ url: 'https://c.com/ad.mp4', size: 2 * MB }), page, false);
    expect(await list.items(1)).toHaveLength(1);
    await list.add(media({ url: 'https://c.com/m.m3u8', kind: 'hls', size: 100 }), page, false);
    const items = await list.items(1);
    expect(items.map((i) => i.kind)).toEqual(['hls']);
  });

  it('falls back to the file name when the page has no title', async () => {
    const { list } = setup();
    await list.add(media(), { pageUrl: page.pageUrl }, false);
    expect((await list.items(1))[0]?.title).toBe('clip.mp4');
  });

  it('persists nothing for private tabs', async () => {
    const { area, list } = setup();
    await list.add(media(), page, true);
    expect(await list.items(1)).toHaveLength(1);
    expect(JSON.stringify([...area.data])).not.toContain('clip.mp4');
    await list.clear(1);
    expect(await list.items(1)).toEqual([]);
  });

  it('survives a new instance over the same storage', async () => {
    const { area, list } = setup();
    await list.add(media(), page, false);
    const store = createStore({
      area,
      key: 'tabs',
      schema: z.custom<ListState>(),
      version: 1,
      defaults: (): ListState => ({}),
    });
    expect(await new TabMediaList({ store }).items(1)).toHaveLength(1);
  });

  it('ignores a detection that began before the tab was closed', async () => {
    const { list } = setup();
    const snapshot = list.snapshot(1);
    await list.clear(1);
    await list.add(media(), page, false, snapshot);
    expect(await list.items(1)).toEqual([]);
    await list.add(media(), page, false);
    expect(await list.items(1)).toHaveLength(1);
  });

  it('clamps long titles and drops oversized URLs without hiding other items', async () => {
    const { list } = setup();
    await list.add(media(), { pageUrl: page.pageUrl, title: 'x'.repeat(5000) }, false);
    await list.add(media({ url: `https://c.com/v.mp4?x=${'a'.repeat(9000)}` }), page, false);
    const items = await list.items(1);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toHaveLength(1024);
  });

  it('finds an item by ID', async () => {
    const { list } = setup();
    await list.add(media(), page, false);
    const [item] = await list.items(1);
    expect((await list.find(item?.id ?? ''))?.entry.url).toBe(media().url);
    expect(await list.find('nope')).toBeUndefined();
  });
});

describe('TabMediaList document tracking (design §3.5)', () => {
  const next = 'https://example.com/next';

  it('keeps the list when a navigation never commits (download link, 204)', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    await list.add(media({ documentId: 'A' }), page, false);
    // No commit follows: the list is untouched.
    expect(await list.items(1)).toHaveLength(1);
  });

  it('drops the previous document on commit, in regular and private tabs', async () => {
    for (const incognito of [false, true]) {
      const { list } = setup();
      await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
      await list.add(media({ documentId: 'A' }), page, incognito);
      await list.add(media({ url: 'https://c.com/old.mp4' }), page, incognito);
      expect(await list.commit({ tabId: 1, url: next, documentId: 'B' })).toBe(true);
      expect(await list.items(1)).toEqual([]);
      expect(await list.commit({ tabId: 1, url: next, documentId: 'B' })).toBe(false);
    }
  });

  it('ignores late responses from a document the tab has left, and from its frames', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    list.noteFrame(1, 'A-frame');
    await list.commit({ tabId: 1, url: next, documentId: 'B' });
    await list.add(media({ documentId: 'A' }), page, false);
    await list.add(media({ url: 'https://c.com/f.mp4', documentId: 'A-frame' }), page, false);
    await list.add(media({ url: 'https://c.com/g.mp4', parentDocumentId: 'A-frame' }), page, true);
    await list.add(media({ url: 'https://c.com/i.mp4', parentDocumentId: 'A' }), page, false);
    expect(await list.items(1)).toEqual([]);
    await list.add(media({ url: 'https://c.com/b.mp4', documentId: 'B' }), page, false);
    expect((await list.items(1)).map((i) => i.url)).toEqual(['https://c.com/b.mp4']);
  });

  it('drops a late response whose write was queued before the commit', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    const adding = list.add(media({ documentId: 'A' }), page, false);
    const committing = list.commit({ tabId: 1, url: next, documentId: 'B' });
    await Promise.all([adding, committing]);
    expect(await list.items(1)).toEqual([]);
  });

  it('keeps what the new document reported before its commit arrived', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    await list.add(media({ url: 'https://c.com/a.mp4', documentId: 'A' }), page, false);
    await list.add(media({ url: 'https://c.com/b.mp4', documentId: 'B' }), page, false);
    await list.add(media({ url: 'https://c.com/frame.mp4', parentDocumentId: 'B' }), page, false);
    await list.commit({ tabId: 1, url: next, documentId: 'B' });
    const items = await list.items(1);
    expect(items.map((i) => i.url)).toEqual(['https://c.com/b.mp4', 'https://c.com/frame.mp4']);
    // The title came from the previous page; only the committed URL is known now.
    expect(items[0]).toMatchObject({ pageUrl: next, title: 'b.mp4' });
  });

  it('moves media shared by both pages to the new document', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    await list.add(media({ documentId: 'A' }), page, false);
    await list.add(media({ documentId: 'B' }), page, false);
    await list.commit({ tabId: 1, url: next, documentId: 'B' });
    expect(await list.items(1)).toHaveLength(1);
  });

  it('keeps a media file opened in the tab, whatever the order of response and commit', async () => {
    const url = 'https://c.com/top.mp4?token=x';
    const navigation = media({ url });
    const before = setup();
    await before.list.add(navigation, page, false);
    await before.list.commit({ tabId: 1, url, documentId: 'M' });
    expect((await before.list.items(1)).map((i) => i.pageUrl)).toEqual([url]);
    const after = setup();
    await after.list.commit({ tabId: 1, url, documentId: 'M' });
    await after.list.add(navigation, { pageUrl: url }, false);
    expect(await after.list.items(1)).toHaveLength(1);
    // A navigation response elsewhere in the old page does not survive.
    await after.list.commit({ tabId: 1, url: next, documentId: 'N' });
    expect(await after.list.items(1)).toEqual([]);
  });

  it('records the committed URL when the page was read before the commit', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    const snapshot = list.snapshot(1);
    await list.commit({ tabId: 1, url: next, documentId: 'B' });
    await list.add(media({ documentId: 'B' }), page, false, snapshot);
    expect((await list.items(1))[0]).toMatchObject({ pageUrl: next, title: 'clip.mp4' });
    await list.commit({ tabId: 1, url: 'about:blank', documentId: 'C' });
    const blank = list.snapshot(1);
    await list.commit({ tabId: 1, url: 'about:blank', documentId: 'D' });
    await list.add(media({ documentId: 'D' }), page, false, blank);
    expect(await list.items(1)).toEqual([]);
  });

  it('brings a document back from the back/forward cache', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    await list.commit({ tabId: 1, url: next, documentId: 'B' });
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    await list.add(media({ documentId: 'A' }), page, false);
    expect(await list.items(1)).toHaveLength(1);
  });

  it('clears on commit without document IDs (Firefox before 153)', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl });
    await list.add(media(), page, false);
    await list.commit({ tabId: 1, url: next });
    expect(await list.items(1)).toEqual([]);
    await list.add(media(), { pageUrl: next }, false);
    expect(await list.items(1)).toHaveLength(1);
  });

  it('always retires the previous top document, however many frames it had', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    for (let i = 0; i < 80; i++) list.noteFrame(1, `A-frame-${String(i)}`);
    await list.commit({ tabId: 1, url: next, documentId: 'B' });
    await list.add(media({ documentId: 'A' }), page, false);
    await list.add(media({ url: 'https://c.com/f.mp4', documentId: 'A-frame-79' }), page, false);
    expect(await list.items(1)).toEqual([]);
  });

  it('retires the documents of stored entries after a suspension', async () => {
    const { area, list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    await list.add(media({ documentId: 'A' }), page, false);
    await list.add(media({ url: 'https://c.com/f.mp4', parentDocumentId: 'A' }), page, false);
    // A new background over the same storage knows nothing about the tab's documents.
    const store = createStore({
      area,
      key: 'tabs',
      schema: z.custom<ListState>(),
      version: 1,
      defaults: (): ListState => ({}),
    });
    const woken = new TabMediaList({ store });
    expect(await woken.commit({ tabId: 1, url: next, documentId: 'B' })).toBe(true);
    await woken.add(media({ url: 'https://c.com/late.mp4', documentId: 'A' }), page, false);
    expect(await woken.items(1)).toEqual([]);
    await woken.add(media({ url: 'https://c.com/b.mp4', documentId: 'B' }), page, false);
    expect(await woken.items(1)).toHaveLength(1);
  });

  it('uses a navigation response as the page while the tab reports about:blank', () => {
    const top = media({ url: 'https://c.com/top.mp4' });
    expect(pageUrlFor('https://example.com/a', top)).toBe('https://example.com/a');
    expect(pageUrlFor('about:blank', top)).toBe('https://c.com/top.mp4');
    expect(pageUrlFor(undefined, top)).toBe('https://c.com/top.mp4');
    expect(pageUrlFor('about:blank', media({ documentId: 'A' }))).toBeUndefined();
    expect(pageUrlFor('about:blank', media({ frameId: 5 }))).toBeUndefined();
    expect(pageUrlFor('about:blank', media({ parentDocumentId: 'A' }))).toBeUndefined();
  });

  it('forgets the documents of a closed tab', async () => {
    const { list } = setup();
    await list.commit({ tabId: 1, url: page.pageUrl, documentId: 'A' });
    await list.commit({ tabId: 1, url: next, documentId: 'B' });
    await list.clear(1);
    await list.add(media({ documentId: 'A' }), page, false);
    expect(await list.items(1)).toHaveLength(1);
  });
});

describe('readPageMeta', () => {
  function fakeDoc(title: string, attrs: Record<string, string>): Document {
    return {
      title,
      baseURI: 'https://example.com/a/',
      querySelector: (selector: string) => {
        const value = attrs[selector];
        return value === undefined ? null : { getAttribute: () => value };
      },
    } as unknown as Document;
  }

  it('falls back to the title and the video poster, resolving relative URLs', () => {
    expect(readPageMeta(fakeDoc(' Plain ', { 'video[poster]': '/p.jpg' }))).toEqual({
      title: 'Plain',
      thumbnail: 'https://example.com/p.jpg',
    });
  });

  it('prefers og tags and refuses non-http thumbnails', () => {
    const doc = fakeDoc('Plain', {
      'meta[property="og:title"]': 'Og',
      'meta[property="og:image"]': 'javascript:alert(1)',
    });
    expect(readPageMeta(doc)).toEqual({ title: 'Og' });
  });
});
