# End-to-end tests

Real browsers, real extension build, synthetic data from `test/server`. Not part of `pnpm test`
(unit) and not run in default CI: it needs the system `chromium` and `firefox`, and moves 2 GB.

```sh
pnpm test:e2e                          # builds, then runs Chromium and Firefox
node test/e2e/run.ts --browser=firefox # one browser (after `pnpm build`)
E2E_SIZE=64mb node test/e2e/run.ts     # shorter big-file step while debugging
E2E_KEEP=1 E2E_DUMPIO=1 ...            # keep the temp profile / show Firefox stderr
CHROMIUM_PATH=... FIREFOX_PATH=...     # other binaries (default /usr/bin/chromium, /usr/bin/firefox)
```

What it checks, per browser (issue #6):

1. A 2 GB file (`/synthetic/2gb.bin`) is saved with the requested name and the exact size.
2. After success, and after a failed job (`?abortAfter=N`), the worker host is closed and the
   OPFS directory `servare-tmp` is empty or absent; a failed job saves nothing.
3. Two concurrent jobs share one worker host (never more than one at a time) and it closes.

How it works: `puppeteer-core` (no bundled browser) drives Chromium over CDP and Firefox over
WebDriver BiDi, with isolated temporary profiles and download directories under the OS temp
dir, removed afterwards. A copy of the build gets a helper page (`page.js`) that triggers the
temporary `download/start-direct` request and reads OPFS, storage and downloads. The product
build is never modified. Firefox cannot be navigated to `moz-extension:` URLs over BiDi, so
the copy also gets a tiny background script that opens the helper tab; BiDi needs
`-remote-allow-system-access` to evaluate scripts in extension pages.
