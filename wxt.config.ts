import { defineConfig } from 'wxt';

// See docs/design.md §2 for the architecture behind these settings.
export default defineConfig({
  // Explicit imports only: every dependency is visible in the source.
  imports: false,
  targetBrowsers: ['chrome', 'firefox'],
  // Firefox defaults to MV2 in WXT; Servare targets MV3 everywhere.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'Servare',
    description:
      'Detects video and audio loaded by the page and saves it locally. No YouTube, no DRM.',
    permissions: [
      'tabs',
      'downloads',
      'webRequest',
      'webNavigation',
      'scripting',
      'declarativeNetRequest',
      'storage',
      'unlimitedStorage',
      'notifications',
      'contextMenus',
      ...(browser === 'chrome' ? ['offscreen'] : []),
    ],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      // libav.js (FFmpeg compiled to WebAssembly) needs wasm-unsafe-eval.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'servare@dk-1ng.github.io',
          // 140 is the first ESR with data_collection_permissions support.
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'] },
        },
        gecko_android: { strict_min_version: '142.0' },
      },
    }),
  }),
});
