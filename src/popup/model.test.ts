import { describe, expect, it } from 'vitest';
import type { DownloadJob, MediaItem } from '../messaging';
import { describeJob, formatBytes, outputNameFor, unavailableReason, urlExtension } from './model';

const item = (patch: Partial<MediaItem> = {}): MediaItem => ({
  id: 'm',
  tabId: 1,
  kind: 'direct',
  url: 'https://cdn.example.com/v/clip.mp4?token=1',
  pageUrl: 'https://example.com/',
  title: 'My clip',
  duration: 0,
  variants: [],
  audioTracks: [],
  subtitles: [],
  protected: false,
  detectedAt: 0,
  ...patch,
});

const job = (patch: Partial<DownloadJob> = {}): DownloadJob => ({
  id: 'j',
  mediaId: 'm',
  audioTrackIds: [],
  subtitleIds: [],
  mode: 'video',
  status: 'running',
  progress: 0.5,
  bytesWritten: 2048,
  outputName: 'x.mp4',
  ...patch,
});

describe('popup model', () => {
  it('reads the extension from the path, not the query', () => {
    expect(urlExtension('https://a.test/x/clip.mp4?x=.avi')).toBe('mp4');
    expect(urlExtension('https://a.test/x/clip')).toBe('');
  });

  it('names the output after the title, falling back to the host', () => {
    expect(outputNameFor(item())).toBe('My clip.mp4');
    expect(outputNameFor(item({ title: '' }))).toBe('cdn.example.com.mp4');
    expect(outputNameFor(item({ title: 'a/b:c' }))).not.toMatch(/[/:]/);
  });

  it('refuses protected and non-direct items', () => {
    expect(unavailableReason(item())).toBeUndefined();
    expect(unavailableReason(item({ protected: true }))).toMatch(/Protected/);
    expect(unavailableReason(item({ kind: 'hls' }))).toMatch(/HLS/);
  });

  it('formats sizes and job state', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(describeJob(job())).toBe('50% · 2.0 KB');
    expect(describeJob(job({ progress: 'indeterminate' }))).toBe('2.0 KB');
    expect(describeJob(job({ status: 'failed', error: { kind: 'http', status: 403 } }))).toBe(
      'The server answered 403',
    );
  });
});
