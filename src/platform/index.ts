/**
 * Browser-specific facts. Every Firefox/Chromium divergence in the codebase
 * should be expressed through this module (see docs/design.md §2.2).
 */
export interface Platform {
  name: 'firefox' | 'chrome';
  /** Chromium MV3 cannot start workers from the service worker; it needs an offscreen document. */
  needsOffscreenDocument: boolean;
  /** Chromium hides Cookie/Referer from webRequest unless `extraHeaders` is requested. */
  needsExtraHeaders: boolean;
}

export function resolvePlatform(browserName: string): Platform {
  const isFirefox = browserName === 'firefox';
  return {
    name: isFirefox ? 'firefox' : 'chrome',
    needsOffscreenDocument: !isFirefox,
    needsExtraHeaders: !isFirefox,
  };
}

export const platform: Platform = resolvePlatform(import.meta.env.BROWSER);
