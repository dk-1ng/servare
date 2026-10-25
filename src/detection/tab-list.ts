import { MediaItemSchema, type MediaItem } from '@/src/messaging';
import type { Store } from '@/src/state';
import type { DetectedKind } from './classify';
import type { DetectedMedia } from './observer';
import { normalizeUrl } from './normalize';

/** With a manifest in the tab, direct files smaller than this are probably fragments or ads. */
export const SMALL_DIRECT_SIZE = 10 * 1024 * 1024;
const MAX_ENTRIES_PER_TAB = 100;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 1024;
/** Frame documents remembered under the current top document; the oldest go first. */
const MAX_FRAME_DOCUMENTS = 64;
/**
 * Retired document IDs remembered per tab. One commit retires at most the frames, the top
 * document and two IDs per dropped entry, so it never pushes out its own retirements.
 */
const MAX_RETIRED_DOCUMENTS = MAX_FRAME_DOCUMENTS + 1 + 2 * MAX_ENTRIES_PER_TAB + 35;

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
  /** From the latest detection: which document asked for it (design §3.5). */
  documentId?: string | undefined;
  parentDocumentId?: string | undefined;
}

/** A top-frame `webNavigation.onCommitted`. */
export interface Commit {
  tabId: number;
  url: string;
  /** Absent on Firefox before 153. */
  documentId?: string | undefined;
}

/**
 * Documents seen in a tab, in memory only, so a suspension loses them. A commit therefore also
 * retires the documents of the stored entries it drops, which survive suspension; what is lost
 * is only a document that reported no media (design §3.5).
 */
interface TabDocuments {
  /** The current top document, once a commit has been seen. */
  top?: string | undefined;
  /** Frames committed under the top document, oldest first. */
  frames: Set<string>;
  /** Documents the tab has navigated away from, oldest first. */
  retired: string[];
  /** Top-frame commits seen, and the URL of the latest. */
  commits: number;
  url: string;
}

/** What `add` needs to know about the moment a detection started. */
export interface Snapshot {
  generation: number;
  commits: number;
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

const HTTP_URL = /^https?:/;

/**
 * The page URL to record for a detection, or `undefined` to skip it (the MediaItem contract
 * only carries http(s) page URLs). While a navigation is in flight Firefox can report the tab
 * as `about:blank`; a top-frame navigation response (no document yet) is then the page itself,
 * and the commit that follows records the final URL (design §3.5).
 */
export function pageUrlFor(tabUrl: string | undefined, media: DetectedMedia): string | undefined {
  if (tabUrl !== undefined && HTTP_URL.test(tabUrl)) return tabUrl;
  const navigation =
    media.frameId === 0 && media.documentId === undefined && media.parentDocumentId === undefined;
  return navigation && HTTP_URL.test(media.url) ? media.url : undefined;
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
    title: (page.title || nameFromUrl(entry.url) || page.pageUrl).slice(0, MAX_TITLE_LENGTH),
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
  /** Bumped by `clear`, so a detection that began before it cannot bring the old list back. */
  private readonly generations = new Map<number, number>();
  private readonly documents = new Map<number, TabDocuments>();

  constructor(options: TabMediaListOptions) {
    this.store = options.store;
  }

  private generation(tabId: number): number {
    return this.generations.get(tabId) ?? 0;
  }

  /** Read synchronously when a detection starts, before any `await`, and pass it to `add`. */
  snapshot(tabId: number): Snapshot {
    return {
      generation: this.generation(tabId),
      commits: this.documents.get(tabId)?.commits ?? 0,
    };
  }

  /** Whether a detection comes from a document the tab has navigated away from. */
  private isStale(media: DetectedMedia): boolean {
    const retired = this.documents.get(media.tabId)?.retired;
    if (!retired) return false;
    return [media.documentId, media.parentDocumentId].some(
      (id) => id !== undefined && retired.includes(id),
    );
  }

  /** Whether the tab was closed since the snapshot, or the detection is stale. */
  private isDropped(media: DetectedMedia, snapshot: Snapshot): boolean {
    return snapshot.generation !== this.generation(media.tabId) || this.isStale(media);
  }

  /**
   * The page info to record. If the top frame committed since the snapshot, what was read about
   * the page describes the previous one: only the committed URL is known.
   */
  private pageFor(tabId: number, page: PageInfo, snapshot: Snapshot): PageInfo | undefined {
    const docs = this.documents.get(tabId);
    if (!docs || docs.commits === snapshot.commits) return page;
    return /^https?:/.test(docs.url) ? { pageUrl: docs.url } : undefined;
  }

  /**
   * Adds a detection, merging it into an existing entry with the same normalized URL. Does
   * nothing if the tab was closed since the snapshot, if the detection comes from a document
   * the tab has left (design §3.5), or if a URL is oversized.
   */
  async add(
    media: DetectedMedia,
    pageRead: PageInfo,
    incognito: boolean,
    snapshot = this.snapshot(media.tabId),
  ): Promise<void> {
    if (this.isDropped(media, snapshot)) return;
    if (media.url.length > MAX_URL_LENGTH || pageRead.pageUrl.length > MAX_URL_LENGTH) return;
    const key = normalizeUrl(media.url);
    const apply = (state: TabState | undefined, page: PageInfo): TabState => {
      const entries = state?.entries ?? [];
      const existing = entries.find((entry) => entry.key === key);
      const next: Entry[] = existing
        ? entries.map((entry) =>
            entry === existing
              ? {
                  ...entry,
                  url: media.url,
                  frameId: media.frameId,
                  // The latest request decides which document the entry belongs to: the same
                  // media on the next page must survive that page's commit.
                  documentId: media.documentId,
                  parentDocumentId: media.parentDocumentId,
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
              documentId: media.documentId,
              parentDocumentId: media.parentDocumentId,
            },
          ];
      // A failed metadata read must not erase a thumbnail found earlier.
      const thumbnail = page.thumbnail ?? state?.page.thumbnail;
      return {
        page: { ...page, ...(thumbnail !== undefined && { thumbnail }) },
        entries: next.slice(-MAX_ENTRIES_PER_TAB),
      };
    };
    if (incognito) {
      const page = this.pageFor(media.tabId, pageRead, snapshot);
      if (page) this.privateTabs.set(media.tabId, apply(this.privateTabs.get(media.tabId), page));
      return;
    }
    await this.store.update((all) => {
      // Re-checked inside the serialized write: a `clear` or `commit` may have run meanwhile.
      const page = this.pageFor(media.tabId, pageRead, snapshot);
      if (!page || this.isDropped(media, snapshot)) return all;
      return { ...all, [String(media.tabId)]: apply(all[String(media.tabId)], page) };
    });
  }

  /** A frame below the top one committed a document: it belongs to the current page. */
  noteFrame(tabId: number, documentId: string | undefined): void {
    const docs = this.documents.get(tabId);
    if (documentId === undefined || !docs || documentId === docs.top) return;
    docs.frames.delete(documentId);
    docs.frames.add(documentId);
    // Only frames are capped: the top document is kept apart and always retired.
    for (const oldest of docs.frames) {
      if (docs.frames.size <= MAX_FRAME_DOCUMENTS) break;
      docs.frames.delete(oldest);
    }
  }

  /** Appends documents to the tab's retired list, never the current one. */
  private retire(docs: TabDocuments, ids: Iterable<string | undefined>, current?: string): void {
    for (const id of ids) {
      if (id === undefined || id === current) continue;
      const at = docs.retired.indexOf(id);
      if (at !== -1) docs.retired.splice(at, 1);
      docs.retired.push(id);
    }
    if (docs.retired.length > MAX_RETIRED_DOCUMENTS) {
      docs.retired.splice(0, docs.retired.length - MAX_RETIRED_DOCUMENTS);
    }
  }

  /**
   * The top frame committed a new document (design §3.5). Every document seen so far in the tab
   * is retired, so their late responses are ignored: the previous top document, its frames, and
   * the documents of the entries dropped here. The list keeps only what already belongs to the
   * new document: its own requests, its direct frames, and the navigation response itself (a
   * media file opened in the tab). Returns whether the list changed.
   */
  async commit({ tabId, url, documentId }: Commit): Promise<boolean> {
    const previous = this.documents.get(tabId);
    const docs: TabDocuments = {
      top: documentId,
      frames: new Set(),
      // Back/forward cache: a restored document is current again.
      retired: (previous?.retired ?? []).filter((id) => id !== documentId),
      commits: (previous?.commits ?? 0) + 1,
      url,
    };
    // The previous top document goes last, after its frames.
    this.retire(docs, [...(previous?.frames ?? []), previous?.top], documentId);
    this.documents.set(tabId, docs);
    /** Dropped entries come from storage too, so they still name the documents after a wake-up. */
    const retireDropped = (state: TabState, kept: readonly Entry[]): void => {
      // Runs inside the serialized write: a later commit or a close may have replaced `docs`.
      const current = this.documents.get(tabId);
      if (!current) return;
      const ids = state.entries
        .filter((entry) => !kept.includes(entry))
        .flatMap((entry) => [entry.documentId, entry.parentDocumentId])
        .filter((id) => id === undefined || !current.frames.has(id));
      this.retire(current, ids, current.top);
    };
    const key = normalizeUrl(url);
    const belongs = (entry: Entry): boolean => {
      // The MediaItem contract only carries http(s) page URLs.
      if (!/^https?:/.test(url)) return false;
      if (documentId !== undefined) {
        if (entry.documentId === documentId || entry.parentDocumentId === documentId) return true;
      }
      // A navigation response has no document yet; in the top frame it is the page itself.
      return (
        entry.documentId === undefined &&
        entry.parentDocumentId === undefined &&
        entry.frameId === 0 &&
        entry.key === key
      );
    };
    /** `undefined` when nothing is left; the same object when nothing changed. */
    const prune = (state: TabState): TabState | undefined => {
      const entries = state.entries.filter(belongs);
      retireDropped(state, entries);
      if (entries.length === 0) return undefined;
      if (entries.length === state.entries.length && state.page.pageUrl === url) return state;
      // Title and thumbnail were read from the previous page; the next detection refreshes them.
      return { page: { pageUrl: url }, entries };
    };
    let changed = false;
    const privateState = this.privateTabs.get(tabId);
    if (privateState) {
      const next = prune(privateState);
      changed = next !== privateState;
      if (next) this.privateTabs.set(tabId, next);
      else this.privateTabs.delete(tabId);
    }
    await this.store.update((all) => {
      const state = all[String(tabId)];
      if (!state) return all;
      const next = prune(state);
      if (next === state) return all;
      changed = true;
      const rest = Object.fromEntries(Object.entries(all).filter(([id]) => id !== String(tabId)));
      return next ? { ...rest, [String(tabId)]: next } : rest;
    });
    return changed;
  }

  /** Drops a closed tab's list. Returns whether anything was dropped. */
  async clear(tabId: number): Promise<boolean> {
    this.generations.set(tabId, this.generation(tabId) + 1);
    this.documents.delete(tabId);
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
    // One malformed entry must not hide the rest: the whole array is validated on the wire.
    return visibleEntries(state.entries)
      .map((entry) => toItem(tabId, state, entry))
      .filter((item) => MediaItemSchema.safeParse(item).success);
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
