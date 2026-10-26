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
4. A file protected by `Referer` + cookie is refused (`http 403`) without the player's headers and
   saved with them; no header rules are left afterwards (issue #11).
5. Cancelling a running protected download removes its header rules and the temporary file.
6. The temporary popup (issue #16) lists the file detected on a player tab, downloads it with one
   click, and its Cancel button stops a running job.
7. The per-tab list (issue #56): two tokenized URLs for the same media yield one item in
   `storage.session` (`detection.tabs`) holding the latest token; a `204` and a download link
   (`Content-Disposition: attachment`) leave the list alone; navigating the tab empties its
   list, and a media response the old page asked for just before leaving does not bring it
   back; a media file opened in the tab is listed; closing the tab removes its entry.
8. Remux (issue #17): `download/start-direct` with `remux: 'mp4'` on a fixture MPEG-TS segment
   makes the worker load libav.js from the package and stream-copy it into an MP4; `ffprobe`
   must report H.264 + AAC lasting 2 s, `ffmpeg -xerror` must decode it without errors, and
   OPFS `servare-tmp` must be empty afterwards. Needs `ffprobe`/`ffmpeg` and the fixtures
   (`pnpm fixtures`).

How it works: `puppeteer-core` (no bundled browser) drives Chromium over CDP and Firefox over
WebDriver BiDi, with isolated temporary profiles and download directories under the OS temp
dir, removed afterwards. A copy of the build gets a helper page (`page.js`) that triggers the
temporary `download/start-direct` request and reads OPFS, storage and downloads. The popup
runs from `e2e-popup.html`, a copy of `popup.html` plus `popup-shim.js`, which answers the popup's
"active tab" query with the player tab (`#tab=<id>`), since a popup opened as a tab would
otherwise see itself. The product build is never modified. Firefox cannot be navigated to `moz-extension:` URLs over BiDi, so
the copy also gets a tiny background script that opens the helper tab; BiDi needs
`-remote-allow-system-access` to evaluate scripts in extension pages.
