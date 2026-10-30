import { describe, expect, it, vi } from 'vitest';
import { DecryptError } from '../crypto/aes128';
import { ProtectedContentError } from '../manifest/protection';
import { SegmentError } from '../media/remux';
import { QuotaError } from '../media/storage';
import { UnsupportedMediaError } from '../media/streams';
import { JobError, runDirectJob, toDownloadError, type JobWriter } from './direct-job';

function body(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    },
  });
}

function setup(response: Response, ensure = vi.fn(async () => {})) {
  const writes: [number, number[]][] = [];
  const file = new File(['x'], 'f');
  const writer: JobWriter = {
    writeAt: (at, data) => void writes.push([at, [...data]]),
    truncate: vi.fn(),
    finish: vi.fn(async () => file),
    remove: vi.fn(async () => {}),
  };
  const deps = {
    fetch: vi.fn(async () => response),
    openWriter: vi.fn(async () => writer),
    ensureFreeSpace: ensure,
    retry: { attempts: 1, baseMs: 1, maxMs: 1 },
  };
  return { deps, writer, writes, file, ensure };
}

const job = { jobId: 'j1', url: 'http://x/a.bin' };

describe('runDirectJob', () => {
  it('streams chunks to consecutive positions and returns the file', async () => {
    const s = setup(new Response(body([1, 2], [3]), { headers: { 'content-length': '3' } }));
    expect(await runDirectJob(job, s.deps)).toBe(s.file);
    expect(s.writes).toEqual([
      [0, [1, 2]],
      [2, [3]],
    ]);
    expect(s.ensure).toHaveBeenCalledWith(3);
  });

  it('skips the space check without a content-length', async () => {
    const s = setup(new Response(body([1])));
    await runDirectJob(job, s.deps);
    expect(s.ensure).not.toHaveBeenCalled();
  });

  it('fails with http on a non-2xx response before opening a file', async () => {
    const s = setup(new Response('no', { status: 403 }));
    await expect(runDirectJob(job, s.deps)).rejects.toMatchObject({
      detail: { kind: 'http', status: 403 },
    });
    expect(s.deps.openWriter).not.toHaveBeenCalled();
  });

  it('maps a failed space check to quota without opening a file', async () => {
    const s = setup(
      new Response(body([1]), { headers: { 'content-length': '1' } }),
      vi.fn(async () => {
        throw new QuotaError(1, 0);
      }),
    );
    const error = await runDirectJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'quota' });
    expect(s.deps.openWriter).not.toHaveBeenCalled();
  });

  it('removes the file and reports incomplete on a short body', async () => {
    const s = setup(new Response(body([1]), { headers: { 'content-length': '4' } }));
    const error = await runDirectJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'incomplete', ratio: 0.25 });
    expect(s.writer.remove).toHaveBeenCalled();
  });

  it('treats an empty body as a failure', async () => {
    const s = setup(new Response(body()));
    await expect(runDirectJob(job, s.deps)).rejects.toBeInstanceOf(JobError);
    expect(s.writer.remove).toHaveBeenCalled();
  });

  it('removes the file when a write fails', async () => {
    const s = setup(new Response(body([1])));
    s.writer.writeAt = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    const error = await runDirectJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'quota' });
    expect(s.writer.remove).toHaveBeenCalled();
  });
});

describe('runDirectJob retries', () => {
  const retry = { attempts: 3, baseMs: 100, maxMs: 1000 };
  function harness(responses: (Response | Error)[]) {
    const s = setup(new Response());
    const calls: { headers?: Record<string, string> }[] = [];
    const waits: number[] = [];
    const queue = [...responses];
    const deps = {
      ...s.deps,
      retry,
      random: () => 1,
      sleep: vi.fn(async (ms: number) => void waits.push(ms)),
      fetch: vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
        calls.push(init);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ?? new Response('x', { status: 500 });
      }),
    };
    return { ...s, deps, calls, waits };
  }

  it('retries a cut body with exponential backoff and then succeeds', async () => {
    const h = harness([
      new Response(body([1]), { headers: { 'content-length': '3', etag: '"v1"' } }),
      new Response(body([2]), {
        status: 206,
        headers: { 'content-range': 'bytes 1-1/3', etag: '"v1"' },
      }),
      new Response(body([3]), { status: 206, headers: { 'content-range': 'bytes 2-2/3' } }),
    ]);
    expect(await runDirectJob(job, h.deps)).toBe(h.file);
    expect(h.waits).toEqual([100, 200]);
  });

  it('does not retry an error status itself: that is the fetcher job', async () => {
    const h = harness([new Response('', { status: 503 })]);
    await expect(runDirectJob(job, h.deps)).rejects.toMatchObject({
      detail: { kind: 'http', status: 503 },
    });
    expect(h.deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last attempt with the last failure', async () => {
    const h = harness([
      new Response(body([1]), { headers: { 'content-length': '4' } }),
      new Response(body([2]), { headers: { 'content-length': '4' } }),
      new Response(body([3]), { headers: { 'content-length': '4' } }),
    ]);
    await expect(runDirectJob(job, h.deps)).rejects.toMatchObject({
      detail: { kind: 'incomplete', ratio: 0.25 },
    });
    expect(h.deps.fetch).toHaveBeenCalledTimes(3);
  });

  it('resumes a cut body with a Range request', async () => {
    const h = harness([
      new Response(body([1, 2]), { headers: { 'content-length': '4', etag: '"v1"' } }),
      new Response(body([3, 4]), {
        status: 206,
        headers: { 'content-range': 'bytes 2-3/4' },
      }),
    ]);
    await runDirectJob(job, h.deps);
    expect(h.calls[1]?.headers).toEqual({ Range: 'bytes=2-', 'If-Range': '"v1"' });
    expect(h.writes).toEqual([
      [0, [1, 2]],
      [2, [3, 4]],
    ]);
  });

  it('starts over without a Range request when the file has no validator', async () => {
    const h = harness([
      new Response(body([1, 2]), { headers: { 'content-length': '4' } }),
      new Response(body([1, 2, 3, 4]), { headers: { 'content-length': '4' } }),
    ]);
    await runDirectJob(job, h.deps);
    expect(h.calls[1]?.headers).toEqual({});
    expect(h.writer.truncate).toHaveBeenCalledWith(0);
  });

  it('uses Last-Modified as the validator and rejects a range of a different size', async () => {
    const h = harness([
      new Response(body([1, 2]), {
        headers: { 'content-length': '4', 'last-modified': 'Thu, 01 Jan 1970 00:00:10 GMT' },
      }),
      new Response(body([9, 9, 9]), { status: 206, headers: { 'content-range': 'bytes 2-4/5' } }),
      new Response(body([1, 2, 3, 4]), { headers: { 'content-length': '4' } }),
    ]);
    await runDirectJob(job, h.deps);
    expect(h.calls[1]?.headers?.['If-Range']).toBe('Thu, 01 Jan 1970 00:00:10 GMT');
    expect(h.writer.truncate).toHaveBeenCalledWith(0);
    // The mismatched partial body is never written; the file is fetched again without Range.
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]?.headers).toEqual({});
    expect(h.writes).toEqual([
      [0, [1, 2]],
      [0, [1, 2, 3, 4]],
    ]);
  });

  it('reads a plain 200 answer to a ranged request from byte 0', async () => {
    const h = harness([
      new Response(body([1, 2]), { headers: { 'content-length': '4', etag: '"v1"' } }),
      new Response(body([1, 2, 3, 4]), { headers: { 'content-length': '4', etag: '"v2"' } }),
    ]);
    await runDirectJob(job, h.deps);
    expect(h.calls[1]?.headers?.['Range']).toBe('bytes=2-');
    expect(h.writer.truncate).toHaveBeenCalledWith(0);
    expect(h.writes).toEqual([
      [0, [1, 2]],
      [0, [1, 2, 3, 4]],
    ]);
  });

  it('starts over when the server ignores the range', async () => {
    const h = harness([
      new Response(body([1, 2]), { headers: { 'content-length': '4' } }),
      new Response(body([1, 2, 3, 4]), { headers: { 'content-length': '4' } }),
    ]);
    await runDirectJob(job, h.deps);
    expect(h.writer.truncate).toHaveBeenCalledWith(0);
    expect(h.writes.at(-1)).toEqual([0, [1, 2, 3, 4]]);
  });

  it('cancels during a backoff wait and removes the file', async () => {
    const h = harness([new Response(body([1]), { headers: { 'content-length': '4' } })]);
    const controller = new AbortController();
    h.deps.sleep = vi.fn(async () => {
      controller.abort();
      throw new JobError({ kind: 'cancelled' });
    });
    const error = await runDirectJob(job, h.deps, controller.signal).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'cancelled' });
    expect(h.writer.remove).toHaveBeenCalled();
  });

  it('cancels a fetch that rejects because of the abort', async () => {
    const h = harness([]);
    const controller = new AbortController();
    h.deps.fetch = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await runDirectJob(job, h.deps, controller.signal).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'cancelled' });
    expect(h.deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports progress as bytes arrive', async () => {
    const h = harness([new Response(body([1, 2], [3]), { headers: { 'content-length': '3' } })]);
    const onProgress = vi.fn();
    await runDirectJob(job, { ...h.deps, onProgress });
    expect(onProgress.mock.calls).toEqual([
      [2, 3],
      [3, 3],
    ]);
  });
});

describe('toDownloadError', () => {
  it('keeps other errors as unknown with their message', () => {
    expect(toDownloadError(new Error('boom'))).toEqual({ kind: 'unknown', message: 'boom' });
    expect(toDownloadError('str')).toEqual({ kind: 'unknown', message: 'str' });
  });

  it('maps decryption, protection and media errors', () => {
    expect(toDownloadError(new DecryptError('bad key'))).toEqual({ kind: 'decrypt' });
    expect(toDownloadError(new ProtectedContentError())).toEqual({ kind: 'protected' });
    expect(toDownloadError(new UnsupportedMediaError('Unsupported codec dts'))).toEqual({
      kind: 'unknown',
      message: 'Unsupported codec dts',
    });
    expect(toDownloadError(new SegmentError('demux', 'The segment could not be opened'))).toEqual({
      kind: 'unknown',
      message: 'The segment could not be opened',
    });
  });
});
