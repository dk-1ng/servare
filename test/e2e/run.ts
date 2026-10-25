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
  start(url: string, filename: string): Promise<{ jobId: string }>;
  failures(): Promise<{ jobId: string; error: { kind: string; message: string } }[]>;
  opfs(): Promise<string[] | null>;
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
  for (const file of ['page.html', 'page.js']) {
    await cp(path.join(ROOT, 'test/e2e', file), path.join(dest, `e2e-${file}`));
  }
  await cp(path.join(dest, 'e2e-page.html'), path.join(dest, 'e2e.html'));
  await writeFile(
    path.join(dest, 'e2e.html'),
    '<!doctype html><meta charset="utf-8"><title>Servare E2E</title><script src="e2e-page.js"></script>',
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
        `${what}: OPFS servare-tmp not empty: ${JSON.stringify(left)}`,
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
      `${origin}/synthetic/2gb.bin?abortAfter=50000000`,
      'servare-e2e-cut.bin',
    );
    const failure = await until(
      'failure recorded',
      120000,
      async () => (await call('failures')).find((f) => f.jobId === failedId),
      sampleHosts,
    );
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
