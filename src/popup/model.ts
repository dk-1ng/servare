import { buildFileName, DEFAULT_TEMPLATE } from '../naming';
import type { DownloadError, DownloadJob, MediaItem } from '../messaging';

/** Temporary popup helpers (#16). Pure functions, so the popup script stays a thin DOM layer. */

/** Extension of the URL's last path segment, or empty when it has none. */
export function urlExtension(url: string): string {
  const last = new URL(url).pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1) : '';
}

/** Output name for a direct file: the page title (or URL host) plus the URL's extension. */
export function outputNameFor(item: MediaItem): string {
  const title = item.title === '' ? new URL(item.url).hostname : item.title;
  return buildFileName(DEFAULT_TEMPLATE, { title }, { extension: urlExtension(item.url) });
}

/** Why an item cannot be downloaded from this popup, or undefined when it can. */
export function unavailableReason(item: MediaItem): string | undefined {
  if (item.protected) return 'Protected content is not supported';
  if (item.kind !== 'direct') return `${item.kind.toUpperCase()} downloads are not available yet`;
  return undefined;
}

export function isActive(job: DownloadJob): boolean {
  return job.status === 'queued' || job.status === 'running' || job.status === 'paused';
}

export function describeError(error: DownloadError): string {
  switch (error.kind) {
    case 'cancelled':
      return 'Cancelled';
    case 'http':
      return `The server answered ${String(error.status)}`;
    case 'incomplete':
      return `Incomplete (${String(Math.round(error.ratio * 100))}%)`;
    case 'decrypt':
      return 'Decryption failed';
    case 'quota':
      return 'Not enough storage';
    case 'protected':
      return 'Protected content';
    case 'unknown':
      return error.message;
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

export function describeJob(job: DownloadJob): string {
  if (job.error) return describeError(job.error);
  if (job.status === 'running') {
    return job.progress === 'indeterminate'
      ? formatBytes(job.bytesWritten)
      : `${String(Math.round(job.progress * 100))}% · ${formatBytes(job.bytesWritten)}`;
  }
  return job.status;
}
