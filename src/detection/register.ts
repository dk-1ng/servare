import { browser } from 'wxt/browser';
import { platform } from '@/src/platform';
import type { Observer } from './observer';

/**
 * Attaches the observer to `webRequest`. Call it synchronously from the background's `main`, so a
 * wake-up event is never missed (design §2.3).
 */
export function registerObserver(observer: Observer, onTabRemoved: (tabId: number) => void): void {
  const filter = { urls: ['<all_urls>'] };
  // Chromium hides Cookie/Referer from webRequest unless asked; Firefox rejects the unknown value.
  const sendHeaders: ('requestHeaders' | 'extraHeaders')[] = platform.needsExtraHeaders
    ? ['requestHeaders', 'extraHeaders']
    : ['requestHeaders'];
  browser.webRequest.onSendHeaders.addListener(
    (d) => {
      observer.onSendHeaders(d);
    },
    filter,
    sendHeaders,
  );
  browser.webRequest.onResponseStarted.addListener(
    (d) => {
      observer.onResponseStarted(d);
    },
    filter,
    ['responseHeaders'],
  );
  browser.tabs.onRemoved.addListener(onTabRemoved);
}
