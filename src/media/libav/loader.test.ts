import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLibav, LIBAV_FACTORY_PATH, LIBAV_WASM_PATH } from './loader';
import type { LibavFactory } from './types';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DIST = path.join(ROOT, 'vendor/libav/dist');

function shippedFiles(): string[] {
  return readFileSync(path.join(DIST, 'SHA256SUMS'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^[0-9a-f]{64} [ *]/, ''));
}

describe('libav loader', () => {
  it('points at exactly the files the build ships, under libav/', () => {
    expect(path.posix.dirname(LIBAV_FACTORY_PATH)).toBe('/libav');
    expect(path.posix.dirname(LIBAV_WASM_PATH)).toBe('/libav');
    expect(
      [path.posix.basename(LIBAV_FACTORY_PATH), path.posix.basename(LIBAV_WASM_PATH)].sort(),
    ).toEqual(shippedFiles().sort());
  });

  it('imports the factory with a literal path (web-ext lint flags computed imports)', () => {
    const source = readFileSync(path.join(import.meta.dirname, 'loader.ts'), 'utf8');
    expect(source).toContain(`import(/* @vite-ignore */ '${LIBAV_FACTORY_PATH}')`);
  });

  it('builds the codecs design §8 lists, and no video decoder', async () => {
    const url = pathToFileURL(path.join(DIST, path.basename(LIBAV_FACTORY_PATH))).href;
    const { default: factory } = (await import(/* @vite-ignore */ url)) as {
      default: LibavFactory;
    };
    const libav = (await createLibav(
      factory,
      path.join(DIST, path.basename(LIBAV_WASM_PATH)),
    )) as unknown as Record<string, (name: string) => number | Promise<number>>;
    const decoder = async (name: string): Promise<boolean> =>
      (await libav['avcodec_find_decoder_by_name']!(name)) !== 0;
    const encoder = async (name: string): Promise<boolean> =>
      (await libav['avcodec_find_encoder_by_name']!(name)) !== 0;

    for (const name of ['aac', 'mp3', 'opus', 'vorbis', 'mov_text', 'webvtt', 'subrip']) {
      expect(await decoder(name), `decoder ${name}`).toBe(true);
    }
    for (const name of ['libmp3lame', 'mov_text', 'webvtt', 'subrip']) {
      expect(await encoder(name), `encoder ${name}`).toBe(true);
    }
    for (const name of ['h264', 'hevc', 'vp9', 'av1']) {
      expect(await decoder(name), `decoder ${name}`).toBe(false);
    }
  });
});
