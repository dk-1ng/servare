/** Request the background sends to the content script of a tab's top frame. */
export const READ_PAGE_META = 'servare/read-page-meta';

/** The reply to `READ_PAGE_META`; validated by the background (`page-meta-schema.ts`). */
export interface PageMeta {
  title?: string | undefined;
  thumbnail?: string | undefined;
}

function attr(doc: Document, selector: string, name: string): string | undefined {
  const value = doc.querySelector(selector)?.getAttribute(name)?.trim();
  return value ? value : undefined;
}

/**
 * Reads the page's title, `og:image` and first `<video poster>`. Read-only: it never touches
 * the DOM. Relative URLs are resolved against the document, and only http(s) results are kept
 * since the page controls this text.
 */
export function readPageMeta(doc: Document): PageMeta {
  const title =
    attr(doc, 'meta[property="og:title"]', 'content') ?? (doc.title.trim() || undefined);
  const raw =
    attr(doc, 'meta[property="og:image"]', 'content') ?? attr(doc, 'video[poster]', 'poster');
  let thumbnail: string | undefined;
  if (raw !== undefined) {
    try {
      const url = new URL(raw, doc.baseURI);
      if (url.protocol === 'http:' || url.protocol === 'https:') thumbnail = url.href;
    } catch {
      // A malformed URL is simply not a thumbnail.
    }
  }
  return {
    ...(title !== undefined && { title: title.slice(0, 1024) }),
    ...(thumbnail !== undefined && { thumbnail }),
  };
}
