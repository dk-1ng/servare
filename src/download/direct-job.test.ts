import { describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../media/storage';
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
    finish: vi.fn(async () => file),
    remove: vi.fn(async () => {}),
  };
  const deps = {
    fetch: vi.fn(async () => response),
    openWriter: vi.fn(async () => writer),
    ensureFreeSpace: ensure,
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

describe('toDownloadError', () => {
  it('keeps other errors as unknown with their message', () => {
    expect(toDownloadError(new Error('boom'))).toEqual({ kind: 'unknown', message: 'boom' });
    expect(toDownloadError('str')).toEqual({ kind: 'unknown', message: 'str' });
  });
});
