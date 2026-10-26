#!/usr/bin/env bash
# Reproducible build of Servare's libav.js variant (docs/design.md §8).
#
# Usage:
#   vendor/libav/build.sh                 build and replace dist/ (files and SHA256SUMS)
#   vendor/libav/build.sh --check         build in a temporary directory and compare the
#                                         result with dist/SHA256SUMS; dist/ is not touched
#   vendor/libav/build.sh --sources DIR   write the verified source archives the build uses
#                                         (the LGPL corresponding source) to DIR; no build
#
# Every input is pinned in versions.env and verified (git commit, SHA-256) before use.
# The compiler runs in a pinned emsdk image, as the calling user and with networking
# disabled, so nothing outside these pins can reach the build.
#
# Requires: bash, git, curl, sha256sum, jq, gzip and Docker (Docker not needed for --sources).
# JOBS=<n> overrides the number of parallel make jobs (default: nproc).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$HERE/dist"
# shellcheck source=versions.env
source "$HERE/versions.env"

MJS="libav-$LIBAVJS_VERSION-$VARIANT.wasm.mjs"
WASM="libav-$LIBAVJS_VERSION-$VARIANT.wasm.wasm"
JOBS="${JOBS:-$(nproc)}"

die() {
  echo "build.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

need() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found in PATH"
  done
}

mode=build
sources_out=""
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  --sources)
    mode=sources
    sources_out="${2:-}"
    [[ -n "$sources_out" ]] || die "--sources needs a directory"
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

need git curl sha256sum jq gzip
[[ "$mode" == sources ]] || need docker

WORK="$(mktemp -d "${TMPDIR:-/tmp}/servare-libav.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/libav.js"
SOURCES="$WORK/sources"

# Downloads <url> to <file> and fails unless its SHA-256 is <sha256>.
download() {
  local url="$1" file="$2" sha256="$3"
  echo "==> $url"
  curl -fsSL --retry 3 -o "$file" "$url"
  echo "$sha256  $file" | sha256sum -c --quiet - || die "SHA-256 mismatch for $url"
}

fetch_sources() {
  echo "==> libav.js $LIBAVJS_VERSION ($LIBAVJS_COMMIT)"
  git init -q "$REPO"
  git -C "$REPO" fetch -q --depth 1 "$LIBAVJS_REPO" "$LIBAVJS_COMMIT"
  git -C "$REPO" -c advice.detachedHead=false -c core.autocrlf=false checkout -q FETCH_HEAD
  [[ "$(git -C "$REPO" rev-parse HEAD)" == "$LIBAVJS_COMMIT" ]] ||
    die "libav.js checkout is not $LIBAVJS_COMMIT"

  # The pins must be the versions this libav.js commit builds, or make would download others.
  grep -qx "FFMPEG_VERSION_MAJOR=${FFMPEG_VERSION%%.*}" "$REPO/Makefile.m4" &&
    grep -qx "FFMPEG_VERSION_MINREV=${FFMPEG_VERSION#*.}" "$REPO/Makefile.m4" ||
    die "libav.js $LIBAVJS_COMMIT does not build FFmpeg $FFMPEG_VERSION"
  grep -qx "LAME_VERSION=$LAME_VERSION" "$REPO/mk/lame.mk" ||
    die "libav.js $LIBAVJS_COMMIT does not build LAME $LAME_VERSION"
  grep -qx "EMFT_VERSION=$EMFT_VERSION" "$REPO/mk/emfiberthreads.mk" ||
    die "libav.js $LIBAVJS_COMMIT does not build emfiberthreads $EMFT_VERSION"

  mkdir -p "$SOURCES"
  download "$FFMPEG_URL" "$SOURCES/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"
  download "$LAME_URL" "$SOURCES/lame-$LAME_VERSION.tar.gz" "$LAME_SHA256"
  download "$EMFT_URL" "$SOURCES/emfiberthreads-$EMFT_VERSION.tar.gz" "$EMFT_SHA256"
}

write_sources() {
  mkdir -p "$sources_out"
  cp "$SOURCES"/* "$sources_out/"
  git -C "$REPO" archive --format=tar.gz --prefix="libav.js-$LIBAVJS_VERSION/" \
    -o "$sources_out/libav.js-$LIBAVJS_VERSION.tar.gz" HEAD
  cp "$HERE/versions.env" "$HERE/fragments.json" "$HERE/build.sh" "$sources_out/"
  (cd "$sources_out" && sha256sum -- *.tar.* >SHA256SUMS)
  echo "sources written to $sources_out"
}

# Runs a command in the emsdk image, as the calling user, with the libav.js tree at /src.
# A fixed path keeps absolute paths that end up in the output identical between machines.
in_container() {
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$REPO:/src" -w /src "$@"
}

# FFmpeg's configure silently ignores unknown component names: make sure every component
# the fragments asked for is really enabled.
check_components() {
  local header="$REPO/build/ffmpeg-$FFMPEG_VERSION/build-base-$VARIANT/config_components.h"
  local requested="$REPO/configs/configs/$VARIANT/ffmpeg-config.txt"
  [[ -f "$header" && -f "$requested" ]] || die "configure output not found"
  local kind name macro missing=0 count=0
  while read -r kind name; do
    macro="CONFIG_${name^^}_${kind^^}"
    count=$((count + 1))
    if ! grep -qx "#define $macro 1" "$header"; then
      echo "build.sh: $kind '$name' was requested but is not enabled ($macro)" >&2
      missing=1
    fi
  done < <(grep -oE -- '--enable-(demuxer|muxer|parser|bsf|decoder|encoder|filter|protocol)=[A-Za-z0-9_]+' "$requested" |
    sed -E 's/^--enable-([a-z]+)=(.*)$/\1 \2/')
  [[ "$count" -gt 0 ]] || die "no components found in $requested"
  [[ "$missing" -eq 0 ]] || die "fix fragments.json: FFmpeg ignored the components above"
  echo "==> all $count requested components are enabled"
}

build() {
  mkdir -p "$REPO/build"
  cp "$SOURCES"/* "$REPO/build/"

  echo "==> npm ci (libav.js build tools; the only step with network access)"
  in_container "$EMSDK_IMAGE" npm ci --ignore-scripts --no-audit --no-fund --loglevel=error

  local fragments
  fragments="$(jq -c . "$HERE/fragments.json")"
  echo "==> configure variant '$VARIANT'"
  in_container --network none "$EMSDK_IMAGE" \
    bash -c 'cd configs && ./mkconfig.js "$1" "$2"' _ "$VARIANT" "$fragments"
  in_container --network none "$EMSDK_IMAGE" \
    make -j"$JOBS" "build/ffmpeg-$FFMPEG_VERSION/build-base-$VARIANT/ffbuild/config.mak"
  check_components

  echo "==> build $MJS"
  in_container --network none "$EMSDK_IMAGE" make -j"$JOBS" "dist/$MJS"
  [[ -f "$REPO/dist/$MJS" && -f "$REPO/dist/$WASM" ]] || die "build output missing"
  # The license headers are what the LGPL notice requirement rests on: never ship without them.
  head -c 65536 "$REPO/dist/$MJS" | grep -q "GNU LESSER GENERAL PUBLIC LICENSE" ||
    die "license header missing from $MJS"
}

report_sizes() {
  local dir="$1" file
  for file in "$MJS" "$WASM"; do
    printf '%-40s %10d bytes  %10d gzip -9\n' "$file" \
      "$(stat -c %s "$dir/$file")" "$(gzip -9 -c "$dir/$file" | wc -c)"
  done
}

fetch_sources
case "$mode" in
  sources)
    write_sources
    ;;
  build)
    build
    mkdir -p "$DIST"
    cp "$REPO/dist/$MJS" "$REPO/dist/$WASM" "$DIST/"
    (cd "$DIST" && sha256sum -- "$MJS" "$WASM" >SHA256SUMS)
    cat "$DIST/SHA256SUMS"
    report_sizes "$DIST"
    ;;
  check)
    [[ -f "$DIST/SHA256SUMS" ]] || die "dist/SHA256SUMS not found"
    (cd "$DIST" && sha256sum -c SHA256SUMS) || die "dist/ does not match dist/SHA256SUMS"
    build
    (cd "$REPO/dist" && sha256sum -c "$DIST/SHA256SUMS") ||
      die "the rebuilt files differ from dist/SHA256SUMS"
    report_sizes "$REPO/dist"
    echo "==> reproducible: the rebuild matches dist/SHA256SUMS"
    ;;
esac
