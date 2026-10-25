/**
 * End-to-end check of the direct-download pipeline on real browsers (issue #6):
 * a 2 GB synthetic file is saved with the right name and size, and OPFS is left clean after
 * success and after a failed job. Run with `pnpm test:e2e` (see test/e2e/README.md).
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { startTestServer } from '../server/server.ts';
import { parseSize } from '../server/synthetic.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** `E2E_SIZE=64mb` shortens the big-file step while debugging; the default is the 2 GB of the acceptance criteria. */
const SIZE = process.env['E2E_SIZE'] ?? '2gb';
const EXPECTED = parseSize(SIZE) ?? 0;
const FIREFOX_ID = 'servare@dk-1ng.github.io';
const FIREFOX_UUID = '5f0c1c0e-2b0a-4f5e-9d3e-0a1b2c3d4e5f';

type Target = 'chromium' | 'firefox';

interface E2eApi {
  start(url: string, filename: string, tabId?: number): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<null>;
  openPopup(tabId: number): Promise<void>;
  closeTabs(prefix: string): Promise<void>;
  rules(): Promise<number[]>;
  tabId(prefix: string): Promise<number | undefined>;
  failures(): Promise<{ jobId: string; error: { kind: string; message: string } }[]>;
  opfs(): Promise<string[] | null>;
  tabList(): Promise<Record<string, { entries: { url: string; key: string }[] }>>;
  hosts(): Promise<number>;
  estimate(): Promise<{ usage?: number; quota?: number }>;
  downloads(): Promise<{ filename: string; state: string; bytes: number; error?: string }[]>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined | false>,
  onTick?: () => Promise<void>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await onTick?.();
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms: ${what}`);
    await sleep(250);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** Copies the build and adds the helper page, so the product build stays free of test code. */
async function prepareExtension(target: Target, work: string): Promise<string> {
  const source = path.join(ROOT, '.output', target === 'firefox' ? 'firefox-mv3' : 'chrome-mv3');
  if (!existsSync(path.join(source, 'manifest.json'))) {
    throw new Error(`${source} is missing: run pnpm build first`);
  }
  const dest = path.join(work, `ext-${target}`);
  await cp(source, dest, { recursive: true });
  await cp(path.join(ROOT, 'test/e2e/page.js'), path.join(dest, 'e2e-page.js'));
  await writeFile(
    path.join(dest, 'e2e.html'),
    '<!doctype html><meta charset="utf-8"><title>Servare E2E</title><script src="e2e-page.js"></script>',
  );
  // The popup as a tab cannot ask for "the active tab": a shim answers with the tab in the hash.
  await cp(path.join(ROOT, 'test/e2e/popup-shim.js'), path.join(dest, 'e2e-popup-shim.js'));
  const popup = await readFile(path.join(dest, 'popup.html'), 'utf8');
  assert(popup.includes('</head>'), 'popup.html has no </head>');
  await writeFile(
    path.join(dest, 'e2e-popup.html'),
    popup.replace('</head>', '<script src="e2e-popup-shim.js"></script></head>'),
  );
  if (target === 'firefox') {
    // WebDriver BiDi may not navigate to moz-extension: URLs, so the extension opens the helper
    // page itself, from a second background script that exists only in this copy.
    await writeFile(
      path.join(dest, 'e2e-open.js'),
      "const url = browser.runtime.getURL('/e2e.html');\n" +
        'browser.tabs.query({ url }).then((tabs) => tabs.length > 0 || browser.tabs.create({ url }));\n',
    );
    const manifestPath = path.join(dest, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      background: { scripts: string[] };
    };
    manifest.background.scripts.unshift('e2e-open.js');
    await writeFile(manifestPath, JSON.stringify(manifest));
  }
  return dest;
}

/** Page URLs reported by BiDi can lag behind, so ask each page where it really is. */
async function findByHref(pages: Page[], href: string): Promise<Page | undefined> {
  for (const candidate of pages) {
    const actual = await candidate.evaluate(() => location.href).catch(() => '');
    if (actual === href) return candidate;
  }
  return undefined;
}

async function launch(
  target: Target,
  extension: string,
  profile: string,
  downloads: string,
): Promise<{ browser: Browser; pageUrl: string }> {
  if (target === 'chromium') {
    await mkdir(path.join(profile, 'Default'), { recursive: true });
    await writeFile(
      path.join(profile, 'Default', 'Preferences'),
      JSON.stringify({
        download: { default_directory: downloads, prompt_for_download: false },
        savefile: { default_directory: downloads },
      }),
    );
    const browser = await puppeteer.launch({
      browser: 'chrome',
      executablePath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium',
      headless: true,
      pipe: true,
      enableExtensions: [extension],
      userDataDir: profile,
      args: ['--no-sandbox', '--disable-gpu'],
    });
    const worker = await browser.waitForTarget((t) => (t.type() as string) === 'service_worker', {
      timeout: 20000,
    });
    const id = new URL(worker.url()).host;
    return { browser, pageUrl: `chrome-extension://${id}/e2e.html` };
  }
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: process.env['FIREFOX_PATH'] ?? '/usr/bin/firefox',
    headless: true,
    protocol: 'webDriverBiDi',
    dumpio: Boolean(process.env['E2E_DUMPIO']),
    // Evaluating scripts in moz-extension: pages needs system access over BiDi.
    args: ['-remote-allow-system-access'],
    userDataDir: profile,
    extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }),
      'browser.download.folderList': 2,
      'browser.download.dir': downloads,
      'browser.download.useDownloadDir': true,
      'browser.download.alwaysOpenPanel': false,
      'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream',
    },
  });
  browser.process()?.on('exit', (code, signal) => {
    console.info(
      `  [firefox exited code=${String(code)} signal=${String(signal)} at ${new Date().toISOString()}]`,
    );
  });
  await browser.installExtension(extension);
  return { browser, pageUrl: `moz-extension://${FIREFOX_UUID}/e2e.html` };
}

async function runTarget(target: Target, origin: string): Promise<void> {
  // Under the ignored output dir by default: Firefox derives its storage quota from the free
  // space of the profile's disk, so a small tmpfs makes a 2 GB file fail with `quota`.
  const base = process.env['E2E_TMPDIR'] ?? path.join(ROOT, 'test/fixtures/out');
  await mkdir(base, { recursive: true });
  const work = await mkdtemp(path.join(base, `e2e-${target}-`));
  const downloads = path.join(work, 'downloads');
  await mkdir(downloads);
  const extension = await prepareExtension(target, work);
  const { browser, pageUrl } = await launch(
    target,
    extension,
    path.join(work, 'profile'),
    downloads,
  );
  const log = {
    push(line: string): void {
      console.info(line);
    },
  };
  try {
    log.push(`${target} ${await browser.version()}`);
    let page: Page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') log.push(`  [page console] ${m.text()}`);
    });
    log.push('  page loading');
    if (target === 'firefox') {
      page = await until('helper tab opened by the extension', 30000, async () =>
        findByHref(await browser.pages(), pageUrl),
      );
    } else {
      await page.goto(pageUrl);
    }
    log.push('  page loaded');
    const call = async <K extends keyof E2eApi>(name: K, ...args: Parameters<E2eApi[K]>) => {
      const run = (): Promise<unknown> =>
        page.evaluate(
          (n, a) => {
            // Runs inside the page: it cannot use anything from this file.
            const api = (
              globalThis as unknown as { e2e: Record<string, (...x: unknown[]) => unknown> }
            ).e2e;
            const fn = api[n];
            if (!fn) throw new Error(`unknown helper ${n}`);
            return fn(...a);
          },
          name,
          args,
        );
      for (let attempt = 0; ; attempt++) {
        try {
          return (await run()) as Awaited<ReturnType<E2eApi[K]>>;
        } catch (error) {
          if (!String(error).includes('detached Frame') || attempt >= 20) throw error;
          // BiDi can swap the page object of a tab (seen on Firefox): find the helper tab again.
          await sleep(250);
          page = (await findByHref(await browser.pages(), pageUrl)) ?? page;
          log.push(`  [helper page re-attached, attempt ${attempt + 1}]`);
        }
      }
    };

    let maxHosts = 0;
    const sampleHosts = async (): Promise<void> => {
      maxHosts = Math.max(maxHosts, await call('hosts'));
    };
    const waitClosedAndClean = async (what: string): Promise<void> => {
      await until(
        `${what}: host closed`,
        30000,
        async () => (await call('hosts')) === 0 || undefined,
      );
      const left = await call('opfs');
      assert(
        left === null || left.length === 0,
        `${what}: OPFS servare-tmp not empty: ${JSON.stringify(left)} hosts=${await call('hosts')} failures=${JSON.stringify(await call('failures'))} downloads=${JSON.stringify(await call('downloads'))}`,
      );
    };

    log.push(`  storage estimate: ${JSON.stringify(await call('estimate'))}`);
    assert((await call('hosts')) === 0, 'no worker host before the first job');
    assert(((await call('opfs'))?.length ?? 0) === 0, 'OPFS clean before the first job');

    // 1. A 2 GB file is saved with the right name and exact size.
    const name = 'servare-e2e-2gb.bin';
    const started = Date.now();
    let lastTick = started;
    const { jobId } = await call('start', `${origin}/synthetic/${SIZE}.bin`, name);
    assert(jobId.length > 0, 'start-direct returned a jobId');
    const item = await until(
      '2 GB download complete',
      12 * 60000,
      async () => {
        if (Date.now() - lastTick > 10000) {
          lastTick = Date.now();
          log.push(
            `  ... ${Math.round((Date.now() - started) / 1000)}s hosts=${await call('hosts')} opfs=${JSON.stringify(await call('opfs'))} failures=${JSON.stringify(await call('failures'))}`,
          );
        }
        const found = (await call('downloads')).find((d) => d.filename.includes('servare-e2e-2gb'));
        if (found?.state === 'interrupted') throw new Error(`download interrupted: ${found.error}`);
        return found?.state === 'complete' ? found : undefined;
      },
      sampleHosts,
    );
    const seconds = Math.round((Date.now() - started) / 1000);
    const onDisk = await stat(path.join(downloads, name));
    assert(onDisk.size === EXPECTED, `file size on disk is ${onDisk.size}, expected ${EXPECTED}`);
    assert(item.bytes === EXPECTED || item.bytes <= 0, `downloads.search size ${item.bytes}`);
    assert(
      (await readdir(downloads)).every((f) => f === name),
      `unexpected files: ${(await readdir(downloads)).join(', ')}`,
    );
    log.push(`  ok   2 GB saved as ${name}, ${onDisk.size} bytes on disk (${seconds}s)`);
    await waitClosedAndClean('after success');
    log.push('  ok   host closed and OPFS servare-tmp empty after success');

    // 2. A truncated source fails the job and leaves nothing behind.
    const { jobId: failedId } = await call(
      'start',
      // Small enough to pass the quota check everywhere, so the cut itself is what fails.
      `${origin}/synthetic/64mb.bin?abortAfter=10000000`,
      'servare-e2e-cut.bin',
    );
    const failure = await until(
      'failure recorded',
      120000,
      async () => (await call('failures')).find((f) => f.jobId === failedId),
      sampleHosts,
    );
    assert(failure.error.kind !== 'quota', 'the truncated job failed on quota, not on the cut');
    await waitClosedAndClean('after failure');
    const files = await readdir(downloads);
    assert(
      !files.some((f) => f.includes('cut')),
      `a file was saved for the failed job: ${files.join(', ')}`,
    );
    log.push(
      `  ok   failed job reported (${failure.error.kind}), host closed, OPFS empty, nothing saved`,
    );

    // 3. Concurrent jobs share one host.
    const small = ['servare-e2e-a.bin', 'servare-e2e-b.bin'];
    await Promise.all(small.map((n) => call('start', `${origin}/synthetic/64mb.bin`, n)));
    await until(
      'both small downloads complete',
      120000,
      async () => {
        const done = (await call('downloads')).filter(
          (d) => small.some((n) => d.filename.endsWith(n)) && d.state === 'complete',
        );
        return done.length === small.length ? true : undefined;
      },
      sampleHosts,
    );
    for (const n of small) {
      assert(
        (await stat(path.join(downloads, n))).size === 64 * 1024 ** 2,
        `${n} has the wrong size`,
      );
    }
    await waitClosedAndClean('after concurrent jobs');
    assert(
      maxHosts === 1,
      `expected at most one worker host at a time and at least one, saw max ${maxHosts}`,
    );
    log.push(
      '  ok   two concurrent jobs completed; never more than one worker host; closed afterwards',
    );

    // 4. Header replay: a Referer + cookie protected file downloads only with the player's headers.
    const player = await browser.newPage();
    await player.goto(`${origin}/set-cookie`);
    await player.goto(`${origin}/pages/index.html`);
    // The player's own request is what the extension captures (Referer = this page, session cookie).
    const status = await player.evaluate(
      async () => (await fetch('/guarded/media/sample.mp4', { credentials: 'include' })).status,
    );
    assert(status === 200, `the player could not fetch the guarded file: ${status}`);
    const playerTab = await until('player tab id', 10000, async () =>
      call('tabId', `${origin}/pages/`),
    );
    const sampleSize = (await stat(path.join(ROOT, 'test/fixtures/out/sample.mp4'))).size;

    const { jobId: bareId } = await call(
      'start',
      `${origin}/guarded/media/sample.mp4`,
      'servare-bare.mp4',
    );
    const refused = await until('refused without headers', 60000, async () =>
      (await call('failures')).find((f) => f.jobId === bareId),
    );
    assert(
      JSON.stringify(refused.error) === JSON.stringify({ kind: 'http', status: 403 }),
      `expected http 403 without the player's headers, got ${JSON.stringify(refused.error)}`,
    );
    await waitClosedAndClean('after the refused guarded job');

    await call('start', `${origin}/guarded/media/sample.mp4`, 'servare-guarded.mp4', playerTab);
    await until(
      'guarded download complete',
      60000,
      async () =>
        (await call('downloads')).find(
          (d) => d.filename.endsWith('servare-guarded.mp4') && d.state === 'complete',
        ),
      sampleHosts,
    );
    assert(
      (await stat(path.join(downloads, 'servare-guarded.mp4'))).size === sampleSize,
      'guarded file has the wrong size',
    );
    await waitClosedAndClean('after the guarded job');
    assert((await call('rules')).length === 0, 'header rules left after the guarded job');
    log.push(
      '  ok   guarded MP4 refused without headers, saved with the player headers, rules gone',
    );

    // 5. Cancelling removes the rules and the temporary file.
    const { jobId: cancelId } = await call(
      'start',
      `${origin}/guarded/synthetic/2gb.bin?pace=10`,
      'servare-cancel.bin',
      playerTab,
    );
    await until('rules installed and bytes flowing', 60000, async () => {
      const left = await call('opfs');
      const rules = await call('rules');
      log.push(
        `  ... rules=${JSON.stringify(rules)} opfs=${JSON.stringify(left)} failures=${JSON.stringify(await call('failures'))}`,
      );
      return rules.length > 0 && (left?.length ?? 0) > 0 ? true : undefined;
    });
    await call('cancel', cancelId);
    const cancelled = await until('cancellation reported', 60000, async () =>
      (await call('failures')).find((f) => f.jobId === cancelId),
    );
    assert(cancelled.error.kind === 'cancelled', `expected cancelled, got ${cancelled.error.kind}`);
    assert((await call('rules')).length === 0, 'header rules left after cancelling');
    await waitClosedAndClean('after cancelling');
    assert(
      !(await readdir(downloads)).some((f) => f.includes('cancel')),
      'a file was saved for the cancelled job',
    );
    log.push('  ok   cancelled job: rules removed, OPFS empty, nothing saved');

    // 6. Popup (#16): a detected file is listed and downloads with one click.
    const popupBase = pageUrl.replace('e2e.html', 'e2e-popup.html');
    const openPopup = async (tab: number): Promise<Page> => {
      // Firefox sometimes never reports a new tab over BiDi: close it and open it again.
      const href = `${popupBase}#tab=${tab}`;
      let found: Page | undefined;
      for (let attempt = 1; !found; attempt++) {
        await call('openPopup', tab);
        found = await until('popup tab opened', 8000, async () =>
          findByHref(await browser.pages(), href),
        ).catch(async (error: unknown) => {
          if (attempt >= 4) throw error;
          log.push(`  [popup tab not reported, reopening (attempt ${attempt})]`);
          await call('closeTabs', popupBase);
          return undefined;
        });
      }
      found.on('console', (m) => {
        if (m.type() === 'error') log.push(`  [popup console] ${m.text()}`);
      });
      return found;
    };
    const clickIn = (popup: Page, label: string): Promise<boolean> =>
      popup.evaluate((text) => {
        const found = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
        found?.click();
        return found !== undefined;
      }, label);

    const media = await browser.newPage();
    await media.goto(`${origin}/pages/player.html?src=/synthetic/2mb.bin`);
    const mediaTab = await until('media tab id', 10000, async () =>
      call('tabId', `${origin}/pages/player.html`),
    );
    const popup = await openPopup(mediaTab);
    await until(
      'detected item listed with a Download button',
      30000,
      async () => (await clickIn(popup, 'Download')) || undefined,
    ).catch(async (error: unknown) => {
      const text = await popup.evaluate(() => document.body.innerText).catch(() => '');
      throw new Error(`${String(error)}; popup shows: ${text.replace(/\s+/g, ' ')}`);
    });
    const before = new Set(await readdir(downloads));
    const saved = await until('popup download saved', 60000, async () => {
      const added = (await readdir(downloads)).filter((f) => !before.has(f));
      return added.find((f) => f.endsWith('.bin')) ?? undefined;
    });
    await until('popup download complete', 30000, async () =>
      (await call('downloads')).find((d) => d.filename.endsWith(saved) && d.state === 'complete'),
    );
    assert(
      (await stat(path.join(downloads, saved))).size === 2 * 1024 ** 2,
      `popup download ${saved} has the wrong size`,
    );
    log.push(`  ok   popup listed the detected file and downloaded it as ${saved}`);
    await waitClosedAndClean('after the popup download');

    // Cancel from the popup: the job comes from the helper (the paced file is not detectable),
    // the popup shows it through job/updated.
    const { jobId: popupCancelId } = await call(
      'start',
      `${origin}/synthetic/2gb.bin?pace=10`,
      'servare-popup-cancel.bin',
    );
    await until(
      'Cancel button shown',
      30000,
      async () => (await clickIn(popup, 'Cancel')) || undefined,
    );
    const popupCancelled = await until('popup cancellation reported', 60000, async () =>
      (await call('failures')).find((f) => f.jobId === popupCancelId),
    );
    assert(
      popupCancelled.error.kind === 'cancelled',
      `expected cancelled, got ${popupCancelled.error.kind}`,
    );
    await waitClosedAndClean('after cancelling from the popup');
    assert(
      !(await readdir(downloads)).some((f) => f.includes('popup-cancel')),
      'a file was saved for the job cancelled from the popup',
    );
    log.push('  ok   Cancel in the popup stopped a running job; nothing saved');

    // 7. Per-tab list (#56): token deduplication, clearing on navigation and on close.
    const entriesOf = async (tab: number): Promise<{ url: string; key: string }[]> =>
      (await call('tabList'))[String(tab)]?.entries ?? [];
    const listPage = await browser.newPage();
    const playerPath = `${origin}/pages/player.html`;
    // The earlier popup step left its player tab open: find this one by its own URL.
    const listUrl = `${playerPath}?src=${encodeURIComponent('/synthetic/2mb.bin?token=aaa')}`;
    await listPage.goto(listUrl);
    const listTab = await until('list tab id', 10000, async () => call('tabId', listUrl));
    await until('first tokenized URL detected', 30000, async () =>
      (await entriesOf(listTab)).length === 1 ? true : undefined,
    );
    // The same media again with a fresh token, requested by the page's own <video>.
    await listPage.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.src = '/synthetic/2mb.bin?token=bbb';
    });
    await until('second token replaces the URL', 30000, async () =>
      (await entriesOf(listTab)).some((e) => e.url.includes('token=bbb')) ? true : undefined,
    );
    // Give a straggling duplicate time to show up before asserting there is only one.
    await sleep(1500);
    const deduped = await entriesOf(listTab);
    assert(
      deduped.length === 1 && deduped[0]?.url.includes('token=bbb'),
      `expected one deduplicated item with the latest token, got ${JSON.stringify(deduped)}`,
    );
    log.push('  ok   two tokenized URLs for the same media yield one item (latest token)');

    // A navigation that never replaces the page (204, download link) keeps the list.
    const navigateFrom = (target: Page, script: string): Promise<void> =>
      // The page may go away while the script runs: that is the point.
      target.evaluate(script).then(
        () => undefined,
        () => undefined,
      );
    await navigateFrom(listPage, "location.href = '/status/204'");
    await sleep(1500);
    assert((await entriesOf(listTab)).length === 1, 'a 204 navigation cleared the list');
    const attachment = 'servare-e2e-attachment.bin';
    const beforeLink = new Set(await readdir(downloads));
    await navigateFrom(
      listPage,
      `const a = document.createElement('a');
       a.href = '/synthetic/2mb.bin?attachment=${attachment}';
       document.body.append(a);
       a.click();`,
    );
    await until('attachment downloaded by the browser', 30000, async () =>
      (await readdir(downloads)).some(
        (f) => !beforeLink.has(f) && f.startsWith('servare-e2e-attachment'),
      )
        ? true
        : undefined,
    );
    assert((await entriesOf(listTab)).length === 1, 'a download link cleared the list');
    log.push('  ok   a 204 and a download link left the list alone');

    // Navigating the top frame empties the list, and a response the old page asked for just
    // before leaving does not bring it back.
    await navigateFrom(
      listPage,
      "void fetch('/synthetic/2mb.bin?as=video&delay=1000&late=1'); location.href = '/pages/index.html';",
    );
    await until('list emptied by navigation', 30000, async () =>
      (await entriesOf(listTab)).length === 0 ? true : undefined,
    );
    await sleep(2500);
    assert(
      !(String(listTab) in (await call('tabList'))),
      `the tab entry survived the navigation: ${JSON.stringify(await entriesOf(listTab))}`,
    );
    // Firefox may cancel the old page's fetch before sending it; Chromium lets it complete.
    const served = ((await (await fetch(`${origin}/__requests`)).json()) as { url: string }[]).some(
      (r) => r.url.includes('late=1'),
    );
    log.push(
      `  ok   navigating the tab emptied its list; late old-page response ${served ? 'served and ignored' : 'cancelled by the browser'}`,
    );

    // A media file opened in the tab is listed, whatever the order of its response and commit.
    const topMedia = `${origin}/synthetic/2mb.bin?as=video&top=1`;
    await navigateFrom(listPage, `location.href = ${JSON.stringify(topMedia)}`);
    await until('media file opened in the tab is listed', 30000, async () => {
      const entries = await entriesOf(listTab);
      return entries.length === 1 && entries[0]?.url === topMedia ? true : undefined;
    });
    await sleep(1500);
    assert(
      (await entriesOf(listTab)).length === 1,
      `the opened media file is not the only item: ${JSON.stringify(await entriesOf(listTab))}`,
    );
    log.push('  ok   a media file opened in the tab stays listed after its commit');

    // Closing the tab removes the entry.
    const closeTabPage = await browser.newPage();
    await closeTabPage.goto(
      `${playerPath}?src=${encodeURIComponent('/synthetic/2mb.bin?token=ccc')}`,
    );
    const closeTab = await until('close tab id', 10000, async () =>
      call('tabId', `${playerPath}?src=${encodeURIComponent('/synthetic/2mb.bin?token=ccc')}`),
    );
    await until('item detected in the tab to close', 30000, async () =>
      (await entriesOf(closeTab)).length === 1 ? true : undefined,
    );
    await closeTabPage.close();
    await until('entry removed by closing the tab', 30000, async () =>
      String(closeTab) in (await call('tabList')) ? undefined : true,
    );
    log.push('  ok   closing the tab removed its entry');
  } finally {
    await browser.close().catch(() => undefined);
    if (process.env['E2E_KEEP']) console.info(`  kept ${work}`);
    else await rm(work, { recursive: true, force: true });
  }
}

const arg = process.argv.find((a) => a.startsWith('--browser='))?.split('=')[1] ?? 'all';
const targets: Target[] = arg === 'all' ? ['chromium', 'firefox'] : [arg as Target];
const server = await startTestServer({ port: 0 });
let failed = false;
try {
  for (const target of targets) {
    try {
      await runTarget(target, server.origin);
      console.info(`PASS ${target}`);
    } catch (error) {
      failed = true;
      console.error(
        `FAIL ${target}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
