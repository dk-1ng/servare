/**
 * Node-side helpers for the libav integration tests: a fresh libav instance per test, an
 * in-memory positional file, and `ffprobe`/`ffmpeg` checks of the output.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLibav, LIBAV_FACTORY_PATH, LIBAV_WASM_PATH } from '../../src/media/libav/loader';
import type { Libav, LibavFactory } from '../../src/media/libav/types';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const FIXTURES = path.join(ROOT, 'test/fixtures/out');
const DIST = path.join(ROOT, 'vendor/libav/dist');

const hasTool = (name: string): boolean =>
  spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
export const hasFfprobe = hasTool('ffprobe') && hasTool('ffmpeg');

/** One fresh instance per test, as the worker does per job. */
export async function newLibav(): Promise<Libav> {
  const url = pathToFileURL(path.join(DIST, path.basename(LIBAV_FACTORY_PATH))).href;
  const module = (await import(/* @vite-ignore */ url)) as { default: LibavFactory };
  // Node's Emscripten runtime reads the WASM from a file path.
  return createLibav(module.default, path.join(DIST, path.basename(LIBAV_WASM_PATH)));
}

/** Collects positional writes into a buffer the way an OPFS file would. */
export function memoryFile(): {
  write: (position: number, data: Uint8Array) => void;
  bytes: () => Uint8Array<ArrayBuffer>;
  positions: number[];
} {
  let buffer = new Uint8Array(0);
  let size = 0;
  const positions: number[] = [];
  return {
    positions,
    write(position, data) {
      positions.push(position);
      const end = position + data.byteLength;
      if (end > buffer.byteLength) {
        const grown = new Uint8Array(Math.max(end, buffer.byteLength * 2));
        grown.set(buffer);
        buffer = grown;
      }
      buffer.set(data, position);
      size = Math.max(size, end);
    },
    bytes: () => buffer.slice(0, size),
  };
}

export interface Probe {
  format: { format_name: string; duration: string; start_time: string };
  streams: {
    index: number;
    codec_type: string;
    codec_name: string;
    nb_read_packets?: string;
  }[];
}

export function probe(file: string): Probe {
  return JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-count_packets', '-show_format', '-show_streams', '-of', 'json', file],
      { encoding: 'utf8' },
    ),
  ) as Probe;
}

export function codecsOf(result: Probe): string[] {
  return result.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort();
}

export function packetCount(result: Probe, type: string): number {
  return Number(result.streams.find((s) => s.codec_type === type)?.nb_read_packets ?? NaN);
}

/** Decodes everything; returns ffmpeg's error output (empty when clean). */
export function decodeErrors(file: string): string {
  const run = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  return run.status === 0 ? run.stderr.toString() : `exit ${run.status}: ${run.stderr.toString()}`;
}

export interface StreamTiming {
  /** DTS steps larger than 1.5 × the stream's usual packet duration, in seconds. */
  gaps: number[];
  /** True when DTS strictly increases. */
  monotonic: boolean;
}

/** Per stream index: where the DTS sequence jumps (gaps) and whether it ever goes back. */
export function timing(file: string): Map<number, StreamTiming> {
  const output = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'packet=stream_index,dts:stream=index,time_base',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  ) as {
    packets: { stream_index: number; dts?: number | string }[];
    streams: { index: number; time_base: string }[];
  };
  const result = new Map<number, StreamTiming>();
  for (const stream of output.streams) {
    const [num, den] = stream.time_base.split('/').map(Number) as [number, number];
    const packets = output.packets.filter(
      (p) => p.stream_index === stream.index && p.dts !== undefined && p.dts !== 'N/A',
    );
    const dts = packets.map((p) => Number(p.dts));
    const steps = dts.slice(1).map((d, i) => d - (dts[i] ?? 0));
    // The muxer may stretch the packet before a gap, so judge steps by the usual duration.
    const sorted = [...steps].sort((a, b) => a - b);
    const usual = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (dts.length < 2) throw new Error(`stream ${String(stream.index)} has no timed packets`);
    result.set(stream.index, {
      gaps: steps.filter((s) => s > usual * 1.5).map((s) => (s * num) / den),
      monotonic: steps.every((s) => s > 0),
    });
  }
  return result;
}
