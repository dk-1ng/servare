import { browser } from 'wxt/browser';
import { PortClient, type DownloadJob, type MediaItem } from '@/src/messaging';
import { describeJob, isActive, outputNameFor, unavailableReason } from '@/src/popup/model';

/**
 * TEMPORARY popup (#16) for testing the flows before the final UI exists: no styling beyond
 * the basics, replaced later. It only uses the UI contract (docs/ui-contract.md), plus the
 * dev-only `download/start-direct` until `download/enqueue` is handled (#25).
 */
const client = new PortClient(() => browser.runtime.connect({ name: 'popup' }));
const mediaList = document.getElementById('media') as HTMLUListElement;
const jobList = document.getElementById('jobs') as HTMLUListElement;
const notice = document.getElementById('notice') as HTMLElement;

let tabId: number | undefined;
let items: MediaItem[] = [];
// `download/list` is not handled yet: jobs are the ones seen through `job/updated`.
const jobs = new Map<string, DownloadJob>();

function say(text: string): void {
  notice.textContent = text;
}

function failure(error: unknown): void {
  say(error instanceof Error ? error.message : String(error));
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function row(name: string, detail: string): [HTMLLIElement, HTMLElement] {
  const li = document.createElement('li');
  const title = document.createElement('div');
  title.className = 'name';
  title.textContent = name;
  const info = document.createElement('div');
  info.className = 'note';
  info.textContent = detail;
  li.append(title, info);
  return [li, info];
}

async function download(item: MediaItem): Promise<void> {
  say('');
  try {
    await client.request('download/start-direct', {
      url: item.url,
      filename: outputNameFor(item),
      tabId: item.tabId,
    });
  } catch (error) {
    failure(error);
  }
}

function renderMedia(): void {
  mediaList.replaceChildren();
  if (items.length === 0) {
    const [li] = row('Nothing detected yet', 'Play the media on the page.');
    mediaList.append(li);
    return;
  }
  for (const item of items) {
    const reason = unavailableReason(item);
    const [li] = row(item.title || item.url, reason ?? `${item.kind} · ${item.url}`);
    if (!reason) {
      li.append(
        button('Download', () => {
          void download(item);
        }),
      );
    }
    mediaList.append(li);
  }
}

function renderJobs(): void {
  jobList.replaceChildren();
  for (const job of [...jobs.values()].reverse()) {
    const [li] = row(job.outputName, describeJob(job));
    if (isActive(job)) {
      const bar = document.createElement('progress');
      bar.max = 1;
      if (job.progress !== 'indeterminate') bar.value = job.progress;
      li.append(
        bar,
        button('Cancel', () => {
          client.request('download/cancel', { jobId: job.id }).catch(failure);
        }),
      );
    }
    jobList.append(li);
  }
}

async function refresh(): Promise<void> {
  if (tabId === undefined) return;
  try {
    items = await client.request('media/list', { tabId });
    renderMedia();
  } catch (error) {
    failure(error);
  }
}

async function main(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  client.on('media/updated', (event) => {
    if (event.tabId !== tabId) return;
    items = event.items;
    renderMedia();
  });
  client.on('job/updated', ({ job }) => {
    jobs.set(job.id, job);
    renderJobs();
  });
  // Events sent while the background was suspended are lost: fetch again after a reconnect.
  client.onReconnect(() => {
    void refresh();
  });
  renderMedia();
  renderJobs();
  await refresh();
}

main().catch(failure);
