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
  /** `downloads.download` accepts `incognito` on Firefox; Chromium rejects the unknown option. */
  downloadsIncognitoOption: boolean;
  /** Chromium lists private-window downloads in the regular history, so they are erased from it. */
  erasePrivateDownloads: boolean;
}

export function resolvePlatform(browserName: string): Platform {
  const isFirefox = browserName === 'firefox';
  return {
    name: isFirefox ? 'firefox' : 'chrome',
    needsOffscreenDocument: !isFirefox,
    needsExtraHeaders: !isFirefox,
    downloadsIncognitoOption: isFirefox,
    erasePrivateDownloads: !isFirefox,
  };
}

export const platform: Platform = resolvePlatform(import.meta.env.BROWSER);
