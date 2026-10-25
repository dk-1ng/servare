import type { MediaItem } from '@/src/messaging';
import type { Store } from '@/src/state';
import type { DetectedKind } from './classify';
import type { DetectedMedia } from './observer';
import { normalizeUrl } from './normalize';

/** With a manifest in the tab, direct files smaller than this are probably fragments or ads. */
export const SMALL_DIRECT_SIZE = 10 * 1024 * 1024;
const MAX_ENTRIES_PER_TAB = 100;

/** What the tab says about itself, from `tabs.get` and the content script. */
export interface PageInfo {
  pageUrl: string;
  title?: string | undefined;
  thumbnail?: string | undefined;
}

export interface Entry {
  /** Normalized URL: the dedup key. */
  key: string;
  id: string;
  kind: DetectedKind;
  /** The latest URL seen for the key: its token is the freshest. */
  url: string;
  frameId: number;
  mime?: string | undefined;
  size?: number | undefined;
  resumable: boolean;
  detectedAt: number;
}

export interface TabState {
  page: PageInfo;
  entries: Entry[];
}

export type ListState = Record<string, TabState>;

export interface TabMediaListOptions {
  /** Backs non-private tabs, so the list survives background suspension (design §2.3). */
  store: Store<ListState>;
}

/** FNV-1a: a short, stable ID from the key. Not a security boundary. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

/** Hides what is probably a fragment while the tab has a manifest (design §3.5). */
export function visibleEntries(entries: readonly Entry[]): Entry[] {
  const hasManifest = entries.some((entry) => entry.kind !== 'direct');
  if (!hasManifest) return [...entries];
  return entries.filter(
    (entry) =>
      entry.kind !== 'direct' || entry.size === undefined || entry.size >= SMALL_DIRECT_SIZE,
  );
}

function toItem(tabId: number, state: TabState, entry: Entry): MediaItem {
  const { page } = state;
  return {
    id: entry.id,
    tabId,
    kind: entry.kind,
    url: entry.url,
    pageUrl: page.pageUrl,
    title: page.title || nameFromUrl(entry.url) || page.pageUrl,
    ...(page.thumbnail !== undefined && { thumbnail: page.thumbnail }),
    // Unknown for a direct file until a probe reads it; manifests fill it in (#18).
    duration: 0,
    variants: [],
    audioTracks: [],
    subtitles: [],
    protected: false,
    detectedAt: entry.detectedAt,
  };
}

/**
 * The per-tab media list. Regular tabs are mirrored to `storage.session`; private tabs live only
 * in memory and are lost when the background is suspended (design principle 4).
 */
export class TabMediaList {
  private readonly privateTabs = new Map<number, TabState>();
  private readonly store: Store<ListState>;

  constructor(options: TabMediaListOptions) {
    this.store = options.store;
  }

  /** Adds a detection, merging it into an existing entry with the same normalized URL. */
  async add(media: DetectedMedia, page: PageInfo, incognito: boolean): Promise<void> {
    const key = normalizeUrl(media.url);
    const apply = (state: TabState | undefined): TabState => {
      const entries = state?.entries ?? [];
      const existing = entries.find((entry) => entry.key === key);
      const next: Entry[] = existing
        ? entries.map((entry) =>
            entry === existing
              ? {
                  ...entry,
                  url: media.url,
                  mime: media.mime ?? entry.mime,
                  size: media.size ?? entry.size,
                  resumable: media.resumable || entry.resumable,
                }
              : entry,
          )
        : [
            ...entries,
            {
              key,
              id: `${String(media.tabId)}-${hash(key)}`,
              kind: media.kind,
              url: media.url,
              frameId: media.frameId,
              mime: media.mime,
              size: media.size,
              resumable: media.resumable,
              detectedAt: media.detectedAt,
            },
          ];
      return { page, entries: next.slice(-MAX_ENTRIES_PER_TAB) };
    };
    if (incognito) {
      this.privateTabs.set(media.tabId, apply(this.privateTabs.get(media.tabId)));
      return;
    }
    await this.store.update((all) => ({
      ...all,
      [String(media.tabId)]: apply(all[String(media.tabId)]),
    }));
  }

  /** Drops a tab's list (navigation or close). Returns whether anything was dropped. */
  async clear(tabId: number): Promise<boolean> {
    const hadPrivate = this.privateTabs.delete(tabId);
    let hadStored = false;
    await this.store.update((all) => {
      hadStored = String(tabId) in all;
      if (!hadStored) return all;
      return Object.fromEntries(Object.entries(all).filter(([id]) => id !== String(tabId)));
    });
    return hadPrivate || hadStored;
  }

  /** Items the UI should show for a tab, oldest first. */
  async items(tabId: number): Promise<MediaItem[]> {
    const state = this.privateTabs.get(tabId) ?? (await this.store.get())[String(tabId)];
    if (!state) return [];
    return visibleEntries(state.entries).map((entry) => toItem(tabId, state, entry));
  }

  /** Looks an item up for enqueueing, hidden or not. */
  async find(mediaId: string): Promise<{ item: MediaItem; entry: Entry } | undefined> {
    const tabs: [number, TabState][] = [
      ...this.privateTabs,
      ...Object.entries(await this.store.get()).map(([id, s]): [number, TabState] => [
        Number(id),
        s,
      ]),
    ];
    for (const [tabId, state] of tabs) {
      const entry = state.entries.find((e) => e.id === mediaId);
      if (entry) return { item: toItem(tabId, state, entry), entry };
    }
    return undefined;
  }
}
