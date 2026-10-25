import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { platform } from '@/src/platform';

export default defineBackground({
  type: 'module',
  main() {
    browser.runtime.onInstalled.addListener(({ reason }) => {
      console.info(`[servare] ${reason} on ${platform.name}`);
    });
  },
});
