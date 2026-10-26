import type { Playlist } from './hls';

/** Thrown when something asks to download an item flagged as protected (design §3.4). */
export class ProtectedContentError extends Error {
  constructor(message = 'Protected content is not supported') {
    super(message);
    this.name = 'ProtectedContentError';
  }
}

// Comments and CDATA could hide or fake an element, so they are removed before scanning.
const COMMENT_OR_CDATA = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
// Any namespace prefix: `<ContentProtection>`, `<cenc:ContentProtection>`, `<mpd:ContentProtection/>`.
const CONTENT_PROTECTION = /<\s*(?:[\w.-]+:)?ContentProtection[\s/>]/;

/**
 * True when a DASH MPD declares `ContentProtection` anywhere, whatever its `schemeIdUri`
 * (design §3.4). This is a textual scan, not a parse: the background has no `DOMParser` on
 * Chromium, and a scan can only err towards "protected".
 */
export function mpdIsProtected(mpd: string): boolean {
  return CONTENT_PROTECTION.test(mpd.replace(COMMENT_OR_CDATA, ''));
}

/** True when an HLS playlist carries a key Servare cannot handle (design §3.4). */
export function playlistIsProtected(playlist: Playlist): boolean {
  return playlist.protected;
}

/** Refuses a protected item before any request is made for it. */
export function assertDownloadable(item: { protected: boolean }): void {
  if (item.protected) throw new ProtectedContentError();
}
