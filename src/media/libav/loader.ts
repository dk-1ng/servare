import type { Libav, LibavFactory } from './types';

/**
 * Package paths of the libav.js build (design §8). The build copies `vendor/libav/dist/` to
 * `libav/` in each browser's output; `loader.test.ts` checks these names against
 * `vendor/libav/dist/SHA256SUMS`.
 */
export const LIBAV_FACTORY_PATH = '/libav/libav-6.10.9.0-servare.wasm.mjs';
export const LIBAV_WASM_PATH = '/libav/libav-6.10.9.0-servare.wasm.wasm';

/** FFmpeg's `AVERROR_EOF` (`-MKTAG('E','O','F',' ')`). */
export const AVERROR_EOF = -0x20464f45;
/** POSIX `EAGAIN` in Emscripten's libc; FFmpeg returns it negated (`AVERROR(EAGAIN)`). */
export const EAGAIN = 6;

/** Instantiates one libav module from its factory. Each job gets its own instance. */
export async function createLibav(factory: LibavFactory, wasmurl: string): Promise<Libav> {
  return (await factory({ wasmurl })) as Libav;
}

/**
 * Loads libav.js in the download worker, without its frontend or internal worker. The
 * `import()` path stays a literal so `web-ext lint` and reviewers can see what is loaded;
 * the factory module is cached by the browser, the WASM is compiled per instance.
 */
export async function loadLibav(): Promise<Libav> {
  // @ts-expect-error -- a package file copied at build time (design §8), not a source module.
  const module = (await import(/* @vite-ignore */ '/libav/libav-6.10.9.0-servare.wasm.mjs')) as {
    default: LibavFactory;
  };
  return createLibav(module.default, LIBAV_WASM_PATH);
}
