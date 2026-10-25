import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { READ_PAGE_META, readPageMeta } from '@/src/detection/page-meta';

// Read-only and answers only the background, on demand (design §3.5).
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return false;
      if ((message as { type?: unknown } | null)?.type !== READ_PAGE_META) return false;
      sendResponse(readPageMeta(document));
      return false;
    });
  },
});
