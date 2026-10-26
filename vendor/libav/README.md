# libav.js build

Servare's own build of [libav.js](https://github.com/Yahweasel/libav.js) (FFmpeg and LAME
compiled to WebAssembly), with only the components listed in `docs/design.md` §8.

| File             | What it is                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `versions.env`   | Every pinned input: libav.js commit, source tarballs with SHA-256, emsdk image            |
| `fragments.json` | The libav.js configuration fragments (components) of the `servare` variant                |
| `build.sh`       | Downloads and verifies the inputs, builds in the pinned emsdk container                   |
| `dist/`          | The two shipped files and their `SHA256SUMS` (committed, copied to `libav/` in the build) |

`pnpm build`, CI and contributors use the committed `dist/` files: no Docker or Emscripten is
needed unless the pins or fragments change.

## Building

Requires bash, git, curl, jq, sha256sum, gzip and Docker (about 3 GB for the emsdk image).
A build takes a couple of minutes on a recent machine.

```sh
pnpm libav:build                          # rebuild and replace dist/ (files and SHA256SUMS)
pnpm libav:check                          # rebuild in a temp dir and compare with dist/SHA256SUMS
bash vendor/libav/build.sh --sources DIR  # write the verified source archives to DIR
```

What `build.sh` does:

1. Fetches libav.js at `LIBAVJS_COMMIT` and checks the commit; checks that this commit builds
   the pinned FFmpeg, LAME and emfiberthreads versions.
2. Downloads the FFmpeg, LAME and emfiberthreads tarballs and checks their SHA-256.
3. Runs `npm ci --ignore-scripts` in the container for libav.js's build tools (the only step
   with network access).
4. Runs `configs/mkconfig.js` with `fragments.json` and FFmpeg's `configure`, with
   `--network none`, as the calling user, with the tree at the fixed path `/src`.
5. Checks that every requested component is enabled in `config_components.h`: FFmpeg ignores
   unknown names silently (the subtitle codec is `movtext`, not `mov_text`).
6. Builds only the non-threaded WebAssembly ES module target, checks that the license header is
   in the output, and copies the `.wasm.mjs` and `.wasm.wasm` files to `dist/` (or compares them
   with `--check`). Sizes are printed raw and gzipped.

The `libav.js build` workflow (`.github/workflows/libav.yml`) runs `--check` whenever this
directory changes.

## Changing the build

1. Edit `versions.env` (new versions and checksums, taken from the upstream release) or
   `fragments.json`.
2. If the libav.js version changes, update the file names in `src/media/libav/loader.ts`.
3. Run `pnpm libav:build`, then `pnpm test` (the remux tests run on the new files).
4. Update the sizes and component notes in `docs/design.md` §8 and the versions in
   `THIRD_PARTY_NOTICES.md`.
5. Commit `versions.env`, `fragments.json` and `dist/` together.

## Licensing

The output is LGPL (FFmpeg 9.0: LGPL-2.1-or-later, built without GPL or version 3 parts;
LAME 3.100: LGPL-2.0-or-later); libav.js's own code and emfiberthreads are 0BSD. See
`THIRD_PARTY_NOTICES.md`. Releases attach the archives from `--sources` as the corresponding
source.
