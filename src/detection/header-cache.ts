/** Headers the player sent that §4.1.1 may replay on the extension's own requests. */
export interface CapturedHeaders {
  referer?: string;
  origin?: string;
  cookie?: string;
}

export interface HeaderEntry {
  tabId: number;
  /** Exact origin of the request (scheme, host, port). */
  origin: string;
  headers: CapturedHeaders;
  /** Firefox container, recorded so a job never mixes cookie stores (design §4.1.1). */
  cookieStoreId?: string;
  incognito: boolean;
  capturedAt: number;
}

export interface HeaderCacheOptions {
  /** Entries older than this are dropped (default 30 minutes). */
  ttlMs?: number;
  /** Oldest entries go first beyond this many (default 500). */
  maxEntries?: number;
  now?: () => number;
  /** Called with the full contents after a change; the cache never waits for it. */
  persist?: (entries: HeaderEntry[]) => Promise<void>;
  /** Contents saved by a previous wake-up of the background. */
  restore?: () => Promise<HeaderEntry[]>;
}

const key = (tabId: number, origin: string): string => `${String(tabId)} ${origin}`;

/**
 * Latest player headers per (tab, exact origin), with a TTL (design §3.1, §4.1.1). Memory is
 * authoritative while the background is awake; `persist`/`restore` carry it across suspension.
 */
export class HeaderCache {
  private readonly entries = new Map<string, HeaderEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly options: HeaderCacheOptions;
  private restored: Promise<void> | undefined;
  private flushing = false;
  private dirty = false;

  constructor(options: HeaderCacheOptions = {}) {
    this.options = options;
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
  }

  record(entry: Omit<HeaderEntry, 'capturedAt'>): void {
    const k = key(entry.tabId, entry.origin);
    const previous = this.entries.get(k);
    this.entries.delete(k); // re-insert so Map order stays oldest-first
    this.entries.set(k, { ...entry, capturedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    if (!previous || !sameHeaders(previous, entry)) this.markDirty();
  }

  /** Most recent fresh capture for this tab and origin. */
  get(tabId: number, origin: string): HeaderEntry | undefined {
    const entry = this.entries.get(key(tabId, origin));
    if (!entry) return undefined;
    if (this.now() - entry.capturedAt > this.ttlMs) {
      this.entries.delete(key(tabId, origin));
      return undefined;
    }
    return entry;
  }

  clearTab(tabId: number): void {
    let changed = false;
    for (const [k, entry] of this.entries) {
      if (entry.tabId === tabId) {
        this.entries.delete(k);
        changed = true;
      }
    }
    if (changed) this.markDirty();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Merges what an earlier wake-up saved underneath what is already in memory. Idempotent. */
  restore(): Promise<void> {
    this.restored ??= (async () => {
      const saved = (await this.options.restore?.()) ?? [];
      const cutoff = this.now() - this.ttlMs;
      for (const entry of saved) {
        const k = key(entry.tabId, entry.origin);
        if (entry.capturedAt >= cutoff && !this.entries.has(k)) this.entries.set(k, entry);
      }
    })().catch(() => undefined);
    return this.restored;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushing || !this.options.persist) return;
    this.flushing = true;
    void this.flush();
  }

  private async flush(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.restore();
        await this.options.persist?.([...this.entries.values()]);
      }
    } catch {
      // Losing the saved copy only costs headers after a suspension; the next change retries.
    } finally {
      this.flushing = false;
    }
  }
}

function sameHeaders(
  a: Omit<HeaderEntry, 'capturedAt'>,
  b: Omit<HeaderEntry, 'capturedAt'>,
): boolean {
  return (
    a.headers.referer === b.headers.referer &&
    a.headers.origin === b.headers.origin &&
    a.headers.cookie === b.headers.cookie &&
    a.cookieStoreId === b.cookieStoreId &&
    a.incognito === b.incognito
  );
}
