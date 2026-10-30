import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  codecsOf,
  decodeErrors,
  FIXTURES,
  hasFfprobe,
  memoryFile,
  newLibav,
  packetCount,
  probe,
  timing,
} from '../../test/media/probe';
import { createRemuxer, remuxFile, SegmentError } from './remux';

const fixture = (rel: string): string => path.join(FIXTURES, rel);
const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(fixture(rel)));
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};
const have = (...rels: string[]): boolean => rels.every((r) => existsSync(fixture(r)));

const TS = ['hls/variants/hi_000.ts', 'hls/variants/hi_001.ts', 'hls/variants/hi_002.ts'];
const FMP4 = ['hls/fmp4/seg_000.m4s', 'hls/fmp4/seg_001.m4s', 'hls/fmp4/seg_002.m4s'];
const VP9 = [1, 2, 3].map((n) => `dash/vp9/chunk-0-0000${String(n)}.webm`);

let work: string;
beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'servare-remux-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Saves the output where ffprobe can read it. */
function save(name: string, bytes: Uint8Array): string {
  const file = path.join(work, name);
  writeFileSync(file, bytes);
  return file;
}

describe('remuxFile', () => {
  it.skipIf(!have(TS[0]!))('stream-copies one MPEG-TS segment into an MP4', async () => {
    const libav = await newLibav();
    const out = memoryFile();
    const result = await remuxFile(libav, read(TS[0]!), out.write);
    const mp4 = out.bytes();

    expect(result.container).toBe('mp4');
    expect(result.size).toBe(mp4.byteLength);
    expect(result.skippedSeconds).toBe(0);
    expect(result.durationSeconds).toBeCloseTo(2, 1);
    expect(new TextDecoder().decode(mp4.subarray(4, 8))).toBe('ftyp');
    // The muxer goes back to patch the header once the data size is known.
    expect(out.positions.some((p, i) => i > 0 && p < (out.positions[i - 1] ?? 0))).toBe(true);
    expect(libav.onwrite).toBeNull();

    if (!hasFfprobe) return;
    const file = save('one.mp4', mp4);
    const info = probe(file);
    expect(info.format.format_name).toContain('mp4');
    expect(Math.abs(Number(info.format.duration) - 2)).toBeLessThanOrEqual(0.1);
    expect(codecsOf(info)).toEqual(['audio:aac', 'video:h264']);
    expect(decodeErrors(file)).toBe('');
  });

  it('rejects input that is not media as a segment error and frees what it created', async () => {
    const libav = await newLibav();
    const out = memoryFile();
    const garbage = new Uint8Array(4096).map((_, i) => (i * 31) % 251);
    const error = await remuxFile(libav, garbage, out.write).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SegmentError);
    expect((error as SegmentError).reason).toBe('demux');
    expect(out.positions).toEqual([]);
    expect(libav.onwrite).toBeNull();
    // The segment file is gone from libav's file system.
    await expect(async () => {
      await libav.unlink('segment');
    }).rejects.toBeDefined();
  });

  it.skipIf(!have(TS[0]!))('stops after the read batch in which it was aborted', async () => {
    const libav = await newLibav();
    const controller = new AbortController();
    const reason = new Error('stop');
    const readFrames = libav.ff_read_frame_multi.bind(libav);
    let reads = 0;
    libav.ff_read_frame_multi = (...args) => {
      reads++;
      controller.abort(reason);
      return readFrames(...args);
    };
    const trailer = vi.spyOn(libav, 'av_write_trailer');
    await expect(
      remuxFile(libav, read(TS[0]!), memoryFile().write, controller.signal),
    ).rejects.toBe(reason);
    expect(reads).toBe(1);
    expect(trailer).not.toHaveBeenCalled();
    expect(libav.onwrite).toBeNull();
  });

  it.skipIf(!have(TS[0]!))('rethrows a failed write after libav returns', async () => {
    const libav = await newLibav();
    const failure = new DOMException('full', 'QuotaExceededError');
    await expect(
      remuxFile(libav, read(TS[0]!), () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

describe('createRemuxer', () => {
  it.skipIf(!have(...TS))(
    'joins MPEG-TS segments demuxed one by one into a gapless MP4 starting at 0',
    async () => {
      const libav = await newLibav();
      const out = memoryFile();
      const remuxer = createRemuxer(libav, out.write);
      try {
        for (const segment of TS) await remuxer.add({ data: read(segment) });
        expect(remuxer.container).toBe('mp4');
        const result = await remuxer.finish();
        expect(result.durationSeconds).toBeCloseTo(6, 1);
      } finally {
        await remuxer.dispose();
        await remuxer.dispose(); // idempotent
      }
      expect(libav.onwrite).toBeNull();
      if (!hasFfprobe) return;
      const file = save('ts.mp4', out.bytes());
      const info = probe(file);
      expect(Math.abs(Number(info.format.start_time))).toBeLessThanOrEqual(0.001);
      expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThanOrEqual(0.1);
      expect(codecsOf(info)).toEqual(['audio:aac', 'video:h264']);
      expect(packetCount(info, 'video')).toBe(90);
      for (const stream of timing(file).values())
        expect(stream).toEqual({ gaps: [], monotonic: true });
      expect(decodeErrors(file)).toBe('');
    },
    60_000,
  );

  it.skipIf(!have('hls/fmp4/init.mp4', ...FMP4))(
    'joins fMP4 fragments, each demuxed with the init section in front',
    async () => {
      const libav = await newLibav();
      const out = memoryFile();
      const remuxer = createRemuxer(libav, out.write);
      const init = read('hls/fmp4/init.mp4');
      try {
        for (const segment of FMP4) await remuxer.add({ data: concat(init, read(segment)) });
        expect((await remuxer.finish()).container).toBe('mp4');
      } finally {
        await remuxer.dispose();
      }
      if (!hasFfprobe) return;
      const file = save('fmp4.mp4', out.bytes());
      const info = probe(file);
      expect(Math.abs(Number(info.format.start_time))).toBeLessThanOrEqual(0.001);
      expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThanOrEqual(0.1);
      expect(packetCount(info, 'video')).toBe(90);
      for (const stream of timing(file).values())
        expect(stream).toEqual({ gaps: [], monotonic: true });
      expect(decodeErrors(file)).toBe('');
    },
    60_000,
  );

  it.skipIf(!have('dash/vp9/init-0.webm', ...VP9))(
    'writes WebM for VP9 from DASH init and media segments',
    async () => {
      const libav = await newLibav();
      const out = memoryFile();
      const remuxer = createRemuxer(libav, out.write);
      const init = read('dash/vp9/init-0.webm');
      try {
        for (const segment of VP9) await remuxer.add({ data: concat(init, read(segment)) });
        expect((await remuxer.finish()).container).toBe('webm');
      } finally {
        await remuxer.dispose();
      }
      if (!hasFfprobe) return;
      const file = save('vp9.webm', out.bytes());
      const info = probe(file);
      expect(info.format.format_name).toContain('webm');
      expect(codecsOf(info)).toEqual(['video:vp9']);
      expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThanOrEqual(0.1);
      expect(packetCount(info, 'video')).toBe(90);
    },
    60_000,
  );

  it.skipIf(!have(...TS))(
    'keeps the gap of a skipped segment on every stream',
    async () => {
      const libav = await newLibav();
      const out = memoryFile();
      const remuxer = createRemuxer(libav, out.write);
      try {
        await remuxer.add({ data: read(TS[0]!) });
        remuxer.skip(2);
        await remuxer.add({ data: read(TS[2]!) });
        const result = await remuxer.finish();
        expect(result.skippedSeconds).toBe(2);
        expect(result.durationSeconds).toBeCloseTo(6, 1);
      } finally {
        await remuxer.dispose();
      }
      if (!hasFfprobe) return;
      const file = save('gap.mp4', out.bytes());
      const info = probe(file);
      expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThanOrEqual(0.1);
      expect(packetCount(info, 'video')).toBe(60);
      for (const stream of timing(file).values()) {
        expect(stream.monotonic).toBe(true);
        expect(stream.gaps).toHaveLength(1);
        expect(Math.abs(stream.gaps[0]! - 2)).toBeLessThanOrEqual(0.1);
      }
      expect(decodeErrors(file)).toBe('');
    },
    60_000,
  );

  it.skipIf(!have(...TS))(
    're-anchors a segment repeated after a discontinuity without overlap',
    async () => {
      const libav = await newLibav();
      const out = memoryFile();
      const remuxer = createRemuxer(libav, out.write);
      try {
        await remuxer.add({ data: read(TS[0]!) });
        await remuxer.add({ data: read(TS[0]!), discontinuity: true });
        await remuxer.add({ data: read(TS[1]!) });
        await remuxer.finish();
      } finally {
        await remuxer.dispose();
      }
      if (!hasFfprobe) return;
      const file = save('discontinuity.mp4', out.bytes());
      const info = probe(file);
      expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThanOrEqual(0.1);
      expect(packetCount(info, 'video')).toBe(90);
      for (const stream of timing(file).values()) expect(stream.monotonic).toBe(true);
      expect(decodeErrors(file)).toBe('');
    },
    60_000,
  );

  it.skipIf(!have(TS[0]!, 'dash/h264/init-1.m4s', 'dash/h264/chunk-1-00002.m4s'))(
    'refuses an incompatible segment without writing it, and goes on',
    async () => {
      const libav = await newLibav();
      const out = memoryFile();
      const remuxer = createRemuxer(libav, out.write);
      try {
        await remuxer.add({ data: read(TS[0]!) });
        const audioOnly = concat(read('dash/h264/init-1.m4s'), read('dash/h264/chunk-1-00002.m4s'));
        const error = await remuxer.add({ data: audioOnly }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SegmentError);
        expect((error as SegmentError).reason).toBe('incompatible');
        await expect(remuxer.add({ data: new Uint8Array(1000) })).rejects.toMatchObject({
          reason: 'demux',
        });
        await remuxer.add({ data: read(TS[1]!) });
        await remuxer.finish();
      } finally {
        await remuxer.dispose();
      }
      if (!hasFfprobe) return;
      const file = save('incompatible.mp4', out.bytes());
      expect(packetCount(probe(file), 'video')).toBe(60);
      expect(decodeErrors(file)).toBe('');
    },
    60_000,
  );

  it.skipIf(!have('hls/id3/seg_000.ts'))(
    'drops a timed ID3 data stream instead of failing the MP4 header',
    async () => {
      const libav = await newLibav();
      const out = memoryFile();
      const result = await remuxFile(libav, read('hls/id3/seg_000.ts'), out.write);
      expect(result.container).toBe('mp4');
      if (!hasFfprobe) return;
      const file = save('id3.mp4', out.bytes());
      expect(codecsOf(probe(file))).toEqual(['audio:aac', 'video:h264']);
      expect(decodeErrors(file)).toBe('');
    },
    60_000,
  );
});
