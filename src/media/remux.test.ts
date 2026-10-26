import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLibav, LIBAV_FACTORY_PATH, LIBAV_WASM_PATH } from './libav/loader';
import type { Libav, LibavFactory } from './libav/types';
import { remuxToMp4 } from './remux';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIST = path.join(ROOT, 'vendor/libav/dist');
const SEGMENTS = path.join(ROOT, 'test/fixtures/out/hls/variants');
const hasTool = (name: string): boolean =>
  spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfprobe = hasTool('ffprobe');
const segmentFiles = ['hi_000.ts', 'hi_001.ts', 'hi_002.ts'].map((f) => path.join(SEGMENTS, f));

/** One fresh instance per test, as the worker does per job. */
async function newLibav(): Promise<Libav> {
  const url = pathToFileURL(path.join(DIST, path.basename(LIBAV_FACTORY_PATH))).href;
  const module = (await import(/* @vite-ignore */ url)) as { default: LibavFactory };
  // Node's Emscripten runtime reads the WASM from a file path.
  return createLibav(module.default, path.join(DIST, path.basename(LIBAV_WASM_PATH)));
}

/** Collects positional writes into a buffer the way an OPFS file would. */
function memoryFile(): {
  write: (position: number, data: Uint8Array) => void;
  bytes: () => Uint8Array;
  positions: number[];
} {
  let buffer = new Uint8Array(0);
  const positions: number[] = [];
  return {
    positions,
    write(position, data) {
      positions.push(position);
      const end = position + data.byteLength;
      if (end > buffer.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(buffer);
        buffer = grown;
      }
      buffer.set(data, position);
    },
    bytes: () => buffer,
  };
}

let work: string;
beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'servare-remux-'));
}, 120_000);
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const haveSegments = (): boolean => segmentFiles.every((f) => existsSync(f));

describe('remuxToMp4', () => {
  it.skipIf(!haveSegments())(
    'stream-copies three concatenated MPEG-TS segments into a valid MP4',
    async () => {
      const input = Buffer.concat(segmentFiles.map((f) => readFileSync(f)));
      const libav = await newLibav();
      const out = memoryFile();
      const size = await remuxToMp4(libav, new Uint8Array(input), out.write);
      const mp4 = out.bytes();

      expect(size).toBe(mp4.byteLength);
      expect(size).toBeGreaterThan(1000);
      expect(new TextDecoder().decode(mp4.subarray(4, 8))).toBe('ftyp');
      // The muxer goes back to patch the header once the data size is known.
      expect(out.positions.some((p, i) => i > 0 && p < (out.positions[i - 1] ?? 0))).toBe(true);
      expect(libav.onwrite).toBeNull();

      if (!hasFfprobe) return;
      const file = path.join(work, 'remuxed.mp4');
      writeFileSync(file, mp4);
      const probe = JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
          { encoding: 'utf8' },
        ),
      ) as {
        format: { format_name: string; duration: string };
        streams: { codec_type: string; codec_name: string }[];
      };
      expect(probe.format.format_name).toContain('mp4');
      expect(Number(probe.format.duration)).toBeCloseTo(6, 0);
      expect(Math.abs(Number(probe.format.duration) - 6)).toBeLessThanOrEqual(0.1);
      expect(probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort()).toEqual([
        'audio:aac',
        'video:h264',
      ]);
      // Decoding everything must not raise a single error.
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
      expect(decode.status, decode.stderr.toString()).toBe(0);
      expect(decode.stderr.toString()).toBe('');
    },
    60_000,
  );

  it('rejects input that is not media and frees what it created', async () => {
    const libav = await newLibav();
    const out = memoryFile();
    const garbage = new Uint8Array(4096).map((_, i) => (i * 31) % 251);
    await expect(remuxToMp4(libav, garbage, out.write)).rejects.toThrow();
    expect(out.positions).toEqual([]);
    expect(libav.onwrite).toBeNull();
    // The input file is gone from libav's file system.
    await expect(async () => {
      await libav.unlink('input');
    }).rejects.toBeDefined();
  });

  it.skipIf(!haveSegments())('stops after the read batch in which it was aborted', async () => {
    const input = Buffer.concat(segmentFiles.map((f) => readFileSync(f)));
    const libav = await newLibav();
    const controller = new AbortController();
    const reason = new Error('stop');
    const read = libav.ff_read_frame_multi.bind(libav);
    let reads = 0;
    libav.ff_read_frame_multi = (...args) => {
      reads++;
      controller.abort(reason);
      return read(...args);
    };
    const trailer = vi.spyOn(libav, 'av_write_trailer');
    await expect(
      remuxToMp4(libav, new Uint8Array(input), memoryFile().write, controller.signal),
    ).rejects.toBe(reason);
    expect(reads).toBe(1);
    expect(trailer).not.toHaveBeenCalled();
    expect(libav.onwrite).toBeNull();
  });

  it.skipIf(!haveSegments())('rethrows a failed write after libav returns', async () => {
    const input = readFileSync(segmentFiles[0]!);
    const libav = await newLibav();
    const failure = new DOMException('full', 'QuotaExceededError');
    await expect(
      remuxToMp4(libav, new Uint8Array(input), () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
