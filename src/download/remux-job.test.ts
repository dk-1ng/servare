import { describe, expect, it, vi } from 'vitest';
import type { Libav } from '../media/libav/types';
import type { remuxToMp4 } from '../media/remux';
import { toDownloadError, type JobWriter } from './direct-job';
import { REMUX_INPUT_LIMIT, runRemuxJob } from './remux-job';
import { isToWorker } from './worker-messages';

function body(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    },
  });
}

const fakeLibav = {} as Libav;

function setup(response: Response, remux?: typeof remuxToMp4) {
  const writes: [number, number[]][] = [];
  const file = new File(['mp4'], 'f');
  const writer: JobWriter = {
    writeAt: (at, data) => void writes.push([at, [...data]]),
    truncate: vi.fn(),
    finish: vi.fn(async () => file),
    remove: vi.fn(async () => {}),
  };
  const inputs: number[][] = [];
  const deps = {
    fetch: vi.fn(async () => response),
    openWriter: vi.fn(async () => writer),
    ensureFreeSpace: vi.fn(async () => {}),
    loadLibav: vi.fn(async () => fakeLibav),
    onProgress: vi.fn(),
    remux:
      remux ??
      vi.fn<typeof remuxToMp4>(async (_libav, input, write) => {
        inputs.push([...input]);
        // Out of order, as the MP4 muxer does when it patches the header.
        write(4, new Uint8Array([9, 9]));
        write(0, new Uint8Array([1, 2, 3, 4]));
        return 6;
      }),
  };
  return { deps, writer, writes, file, inputs };
}

const job = { jobId: 'j1', url: 'http://x/a.ts' };

describe('runRemuxJob', () => {
  it('fetches the whole input, remuxes it with the job instance and returns the file', async () => {
    const s = setup(new Response(body([1, 2], [3]), { headers: { 'content-length': '3' } }));
    expect(await runRemuxJob(job, s.deps)).toBe(s.file);
    expect(s.inputs).toEqual([[1, 2, 3]]);
    expect(s.deps.remux).toHaveBeenCalledWith(
      fakeLibav,
      expect.any(Uint8Array),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(s.writes).toEqual([
      [4, [9, 9]],
      [0, [1, 2, 3, 4]],
    ]);
    expect(s.deps.ensureFreeSpace).toHaveBeenCalledWith(3);
    expect(s.deps.onProgress).toHaveBeenLastCalledWith(3, 3);
    expect(s.deps.loadLibav).toHaveBeenCalledTimes(1);
  });

  it('fails with http before loading libav or opening a file', async () => {
    const s = setup(new Response('no', { status: 404 }));
    const error = await runRemuxJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'http', status: 404 });
    expect(s.deps.loadLibav).not.toHaveBeenCalled();
    expect(s.deps.openWriter).not.toHaveBeenCalled();
  });

  it('refuses an input whose declared length is above the limit', async () => {
    const s = setup(
      new Response(body([1]), { headers: { 'content-length': String(REMUX_INPUT_LIMIT + 1) } }),
    );
    const error = await runRemuxJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toMatchObject({ kind: 'unknown' });
    expect(s.deps.loadLibav).not.toHaveBeenCalled();
  });

  it('refuses an input that grows above the limit without a length', async () => {
    const big = new Uint8Array(REMUX_INPUT_LIMIT / 2);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(big);
      },
    });
    const s = setup(new Response(stream));
    const error = await runRemuxJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toMatchObject({ kind: 'unknown' });
    expect(s.deps.openWriter).not.toHaveBeenCalled();
  });

  it('reports a short body as incomplete', async () => {
    const s = setup(new Response(body([1]), { headers: { 'content-length': '4' } }));
    const error = await runRemuxJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'incomplete', ratio: 0.25 });
  });

  it('removes the file when the remux fails', async () => {
    const s = setup(
      new Response(body([1])),
      vi.fn(async () => {
        throw new Error('Could not open the input');
      }),
    );
    const error = await runRemuxJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({
      kind: 'unknown',
      message: 'Could not open the input',
    });
    expect(s.writer.remove).toHaveBeenCalled();
  });

  it('maps a full disk during the remux to quota', async () => {
    const s = setup(
      new Response(body([1])),
      vi.fn(async () => {
        throw new DOMException('full', 'QuotaExceededError');
      }),
    );
    const error = await runRemuxJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'quota' });
    expect(s.writer.remove).toHaveBeenCalled();
  });

  it('reports cancelled and removes the file when aborted during the remux', async () => {
    const controller = new AbortController();
    const s = setup(
      new Response(body([1])),
      vi.fn<typeof remuxToMp4>(async (_libav, _input, _write, signal) => {
        controller.abort();
        throw signal?.reason;
      }),
    );
    const error = await runRemuxJob(job, s.deps, controller.signal).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'cancelled' });
    expect(s.writer.remove).toHaveBeenCalled();
  });

  it('treats an empty output as a failure', async () => {
    const s = setup(
      new Response(body([1])),
      vi.fn(async () => 0),
    );
    const error = await runRemuxJob(job, s.deps).catch((e: unknown) => e);
    expect(toDownloadError(error)).toEqual({ kind: 'incomplete', ratio: 0 });
    expect(s.writer.remove).toHaveBeenCalled();
    expect(s.writer.finish).not.toHaveBeenCalled();
  });
});

describe('isToWorker', () => {
  const start = { type: 'start', jobId: 'j', url: 'http://x/a', filename: 'a.mp4' };

  it('accepts a start with or without remux mp4', () => {
    expect(isToWorker(start)).toBe(true);
    expect(isToWorker({ ...start, remux: 'mp4' })).toBe(true);
  });

  it('rejects an unknown remux target', () => {
    expect(isToWorker({ ...start, remux: 'mkv' })).toBe(false);
  });
});
