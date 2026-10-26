import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'wxt';

/** The libav.js build (design §8): exactly the files listed in its SHA256SUMS. */
const LIBAV_DIST = path.resolve(import.meta.dirname, 'vendor/libav/dist');
const libavFiles = (): string[] =>
  readFileSync(path.join(LIBAV_DIST, 'SHA256SUMS'), 'utf8')
    .split('\n')
    .map((line) => /^[0-9a-f]{64} [ *](.+)$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

// See docs/design.md §2 for the architecture behind these settings.
export default defineConfig({
  // Explicit imports only: every dependency is visible in the source.
  imports: false,
  targetBrowsers: ['chrome', 'firefox'],
  // Firefox defaults to MV2 in WXT; Servare targets MV3 everywhere.
  manifestVersion: 3,
  hooks: {
    // Package files reached only by extension pages and the worker: no web_accessible_resources.
    'build:publicAssets': (_wxt, files) => {
      for (const name of libavFiles()) {
        files.push({ absoluteSrc: path.join(LIBAV_DIST, name), relativeDest: `libav/${name}` });
      }
    },
  },
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
