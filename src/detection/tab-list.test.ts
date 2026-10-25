import { describe, expect, it } from 'vitest';
import { createStore, type StorageAreaLike } from '@/src/state/store';
import { z } from 'zod';
import { MediaItemSchema } from '@/src/messaging';
import { normalizeUrl } from './normalize';
import type { DetectedMedia } from './observer';
import { readPageMeta } from './page-meta';
import { TabMediaList, type ListState } from './tab-list';

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

  it('finds an item by ID', async () => {
    const { list } = setup();
    await list.add(media(), page, false);
    const [item] = await list.items(1);
    expect((await list.find(item?.id ?? ''))?.entry.url).toBe(media().url);
    expect(await list.find('nope')).toBeUndefined();
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
