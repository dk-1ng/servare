# Servare — Design Document

> Status: approved draft for the MVP · Last revised: 2026-10-25

## 1. Overview

Servare is a browser extension (Firefox and Chromium, Manifest V3) that detects video and audio loaded by the current page and lets the user save it locally. All processing happens inside the browser — there is no native app and no server.

### 1.1 Scope

- Direct media files (MP4, WebM, MKV, MP3, …).
- HLS streams (RFC 8216), including the protocol's standard `AES-128` encryption.
- DASH streams (ISO/IEC 23009-1) without content protection.
- HLS live streams.
- Alternate audio tracks, subtitles and audio extraction to MP3.

### 1.2 Non-goals (permanent)

- **YouTube** — not supported, now or later.
- **DRM-protected content** (Widevine, PlayReady, FairPlay, `SAMPLE-AES`, CENC, etc.). Servare **detects and refuses** it; there is no code path to circumvent DRM.
- Bypassing login, paywalls, captchas or any other access control.
- Screen recording.
- Modifying the JavaScript or DOM of visited pages.
- Telemetry or any communication with project-owned servers.

### 1.3 Principles

1. **Original implementation.** All code is written from public specifications (RFC 8216, ISO/IEC 23009-1, MDN/WebExtensions docs, FFmpeg). See [CONTRIBUTING.md](../CONTRIBUTING.md).
2. **Read-only on the page.** Content scripts only read metadata; nothing is injected.
3. **One media pipeline** for every format.
4. **Privacy.** No data leaves the browser beyond the requests needed for the download; private windows leave no persistent trace.
5. **Good network citizenship.** Bounded concurrency, honoring `429`/`Retry-After`.

---

## 2. Architecture

### 2.1 Stack

| Item                | Choice                                                                                       | Rationale                                        |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Extension framework | [WXT](https://wxt.dev) + strict TypeScript                                                   | Per-browser manifests, unified `browser.*`, HMR  |
| Media engine        | [libav.js](https://github.com/Yahweasel/libav.js) (FFmpeg compiled to WebAssembly, LGPL-2.1) | Demux/mux of TS, fMP4, Matroska; subtitles; MP3  |
| Manifest parsers    | `m3u8-parser`, `mpd-parser`                                                                  | Maintained by the Video.js community, Apache-2.0 |
| Data validation     | zod                                                                                          | Message and state contracts                      |
| Testing             | Vitest, Playwright, local FFmpeg/ffprobe                                                     | Unit, E2E and output verification                |

### 2.2 Components

| Component                    | Firefox                                      | Chromium                              | Responsibility                                                          |
| ---------------------------- | -------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| Background                   | event page                                   | service worker                        | Detection, per-tab state, queue, header rules, delivery via `downloads` |
| Worker host                  | extension page in an inactive tab (spike #3) | offscreen document (reason `WORKERS`) | Keep the download worker alive                                          |
| Download worker              | module Web Worker                            | module Web Worker                     | Networking, AES-128 decryption, libav, OPFS writes                      |
| Content script               | ISOLATED world                               | ISOLATED world                        | Read title, thumbnail and `<video>` elements on demand                  |
| UI (popup, sidebar, options) | —                                            | —                                     | Designed separately; consumes the contract in §2.5                      |

### 2.3 Lifecycle risks

Both backgrounds are suspended after about 30 s without extension events, and anything they own (including a Web Worker) dies with them. So the download worker never lives in the background. It lives in a **worker host**: an extension document whose lifetime does not depend on the background.

**Decision (spike #3):**

- **One `worker-host` entrypoint** (an HTML page that creates the module Web Worker) serves both browsers. Only the way it is opened differs, and that code lives in `src/platform/`:
  - **Chromium:** `offscreen.createDocument({ reasons: ['WORKERS'] })`. `WORKERS` has no lifetime limit; only `AUDIO_PLAYBACK` closes after 30 s of silence. One offscreen document per extension.
  - **Firefox:** `tabs.create({ url: worker-host, active: false })`, plus `autoDiscardable: false` where supported. Firefox has no offscreen API, so the host is a regular extension tab.
- The host is opened lazily when the first job starts and closed when the queue drains. There must never be more than one host. Find an existing one with `runtime.getContexts` (available on both browsers), and keep a single in-flight `ensureWorkerHost()` promise in the background so two events in the same wake cannot both create one. On Chromium, treat a "document already exists" error from `createDocument` as success.
- The background stays suspendable. It is woken by the host's `runtime.sendMessage` (progress milestones, completion, errors) and keeps all job state in `storage.session`/`storage.local`. It never relies on in-memory state between events.
- Ports between the host and the background are **not** a lifetime mechanism. Firefox closes them when the event page suspends. The message bus must treat `onDisconnect` as normal and reconnect on demand.
- **Firefox only:** if the user closes the host tab, its worker dies with it. `tabs.onRemoved` marks running jobs `paused`, and they resume through the §4.10 path. The host page also registers a `beforeunload` prompt while jobs run, but this is best-effort only: browsers show it just for pages the user interacted with, and the host tab never is. `tabs.onRemoved` is the real mechanism.
- Offscreen documents only get `runtime` APIs, so the host cannot use `downloads`. The host creates the blob URL and sends it to the background. The background calls `downloads.download` and watches `downloads.onChanged` (which also wakes it). When the download completes or is interrupted, the background tells the host to revoke the URL and then closes the host (`offscreen.closeDocument` / `tabs.remove`). The blob URL must outlive the download.

**Evidence** (Chromium 156 headless and Firefox 158 headless via `web-ext run`, 2026-10-25). Each variant ran one throwaway probe extension. The module worker fetched 256 KiB chunks from a local server, hashed them with SHA-256 and wrote them to OPFS through `createSyncAccessHandle`, reporting a heartbeat every 10 s to a log endpoint. The background stayed idle during the job. Every 10-minute survivor delivered all 59 heartbeats and about 740 MiB, and its OPFS writes succeeded. Chromium's service-worker state was sampled every 5 s from the DevTools target list without attaching to it.

| Variant                                                                     | Background during job                                                                                             | Worker                  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Chromium: offscreen document (`WORKERS`) hosting the worker                 | service worker stopped 30 s after start and stayed stopped for 9 min 26 s; woken by the host's completion message | survived the 10-min job |
| Firefox: worker owned by the MV3 event page (control)                       | suspended at about 30 s                                                                                           | killed at suspension    |
| Firefox (a): idle `runtime.Port` from an extension tab                      | suspended at about 30 s; port disconnected                                                                        | killed at suspension    |
| Firefox (a2): same port, page posts a message every 20 s                    | kept alive by the messages                                                                                        | survived the 10-min job |
| Firefox (b): extension tab hosting the worker                               | suspended at about 30 s; woken by the host's message                                                              | survived the 10-min job |
| Firefox (c): MV2 persistent background owning the worker                    | never suspended                                                                                                   | survived the 10-min job |
| Firefox: event page writes progress to `storage.local` every 5 s            | suspended at about 30 s (`storage.local.set` calls do not reset the idle timer)                                   | killed (60 s run)       |
| Firefox: event page with `webRequest` listener on the worker's own requests | kept alive while requests were frequent; suspended 30 s after the last one                                        | survived (60 s run)     |
| Same, but one long streaming `fetch` (single big direct file)               | suspended at about 30 s                                                                                           | killed mid-response     |

**Rejected:**

- **(a) an idle Port.** It does not prevent suspension.
- **(a2) a pinging Port.** It works, but it still needs an open extension page, so it is strictly worse than (b): two contexts instead of one, plus a keepalive-by-traffic hack.
- **Implicit keepalive through the extension's own `webRequest` events.** It breaks on a long single response, long `Retry-After` backoff, live playlists with long target durations, and CPU-only phases (final remux, MP3 encode).
- **(c) a persistent MV2 background.** It works and needs no visible tab, but it forks the Firefox manifest and API surface away from "MV3 everywhere", and Mozilla's MV2 commitment is open-ended rather than permanent. It is the documented **fallback** if the host-tab UX proves unacceptable, or for Firefox for Android, where background tabs are less reliable.

**Not verified by the spike** (check when the host is implemented):

- headed (non-headless) browsers;
- packaged rather than temporary/unpacked installs;
- Firefox tab unloading under memory pressure, and whether `autoDiscardable: false` is honored for extension tabs;
- Firefox for Android;
- the `beforeunload` prompt in a host tab the user never interacted with (expected not to show);
- delivering a blob URL created in the host and passed to the background for `downloads.download` (covered by the M0 OPFS + delivery issue).

### 2.4 Repository layout

```
entrypoints/        background, worker-host, download-worker, content, popup/sidebar/options
src/
  messaging/        zod contracts and message bus (runtime.sendMessage wakes the background; runtime.Port for live UI streams, reconnect on disconnect)
  state/            store and migrations
  detection/        network observer, classifiers, MIME types
  manifest/         HLS, DASH, codecs, protection detection
  rules/            per-domain rules
  download/         queue, jobs, per-format strategies
  net/              fetcher, retry, semaphore, header rules
  crypto/           AES-128 (WebCrypto)
  media/            libav loader, remux, MP3, subtitles, OPFS writer
  naming/           file name templates and sanitization
  platform/         isolated Firefox/Chromium differences
vendor/libav/       reproducible libav.js build
test/               unit, fixtures (generated locally), e2e
docs/               this document and the UI contract
```

### 2.5 Data model (UI contract)

```ts
type MediaKind = 'direct' | 'hls' | 'dash';

interface MediaItem {
  id: string;
  tabId: number;
  kind: MediaKind;
  url: string;
  pageUrl: string;
  title: string;
  thumbnail?: string;
  duration: number | 'live';
  variants: Variant[];
  audioTracks: Track[];
  subtitles: Track[];
  protected: boolean; // DRM detected → not downloadable
  detectedAt: number;
}

interface Variant {
  id: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  codecs?: string;
  container: string;
}
interface Track {
  id: string;
  language?: string;
  label?: string;
  codecs?: string;
}

interface DownloadJob {
  id: string;
  mediaId: string;
  variantId?: string;
  audioTrackIds: string[];
  subtitleIds: string[];
  mode: 'video' | 'audio';
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  progress: number | 'indeterminate';
  bytesWritten: number;
  error?: DownloadError;
  outputName: string;
}

type DownloadError =
  | { kind: 'cancelled' }
  | { kind: 'http'; status: number }
  | { kind: 'incomplete'; ratio: number }
  | { kind: 'decrypt' }
  | { kind: 'quota' }
  | { kind: 'protected' }
  | { kind: 'unknown'; message: string };
```

Message details live in `docs/ui-contract.md` (issue #12).

---

## 3. Detection

### 3.1 Network observation

1. `webRequest.onSendHeaders` stores the headers sent per request (TTL cache). Chromium needs `extraHeaders` to see `Cookie`/`Referer`.
2. `webRequest.onResponseStarted` evaluates the response. Discarded: non-2xx status, non-HTTP schemes, the extension's own requests, requests without a tab, stream fragments (segment `.ts`, `.m4s`, `.aac`) and domains with detection disabled.
3. Classification order: **HLS → DASH → direct file**.

### 3.2 Direct files

- Trigger: request type `media`, or a recognized `video/*`/`audio/*` `Content-Type` (own table in `src/detection/mime.ts`, based on the IANA registry).
- Default minimum size: **1 MiB** (configurable per domain), read from `Content-Length` or the `Content-Range` total.
- Resumable when `Accept-Ranges: bytes`.
- Suggested name: `Content-Disposition` → URL path → MIME type.

### 3.3 Manifests

- The manifest is fetched again with the same headers to confirm the type from its content.
- **HLS master:** variants (`RESOLUTION`, `BANDWIDTH`, `CODECS`), `EXT-X-MEDIA` audio and subtitles. Variants with unknown codecs are hidden.
- **HLS media:** duration (sum of `EXTINF`), `EXT-X-KEY`, `EXT-X-MAP`, `EXT-X-BYTERANGE`. Live = no `EXT-X-ENDLIST`.
- **DASH:** `AdaptationSet`/`Representation`, `SegmentTemplate`/`SegmentList`/`SegmentBase`.
- **Quality ordering:** height, then bitrate.

### 3.4 Protected content

The item is flagged `protected: true` and shown as unavailable when there is:

- `ContentProtection` in DASH (any `schemeIdUri`);
- `EXT-X-KEY`/`EXT-X-SESSION-KEY` with a method other than `NONE` and `AES-128`, or a `KEYFORMAT` other than `identity`.

There is no attempt to obtain licenses, CDM keys or equivalents.

### 3.5 Per-tab list

- Cleared on `webNavigation.onBeforeNavigate` and `tabs.onRemoved`.
- Deduplicated by normalized URL (volatile query parameters removed).
- When the tab has an HLS/DASH manifest, small direct files and standalone media playlists are hidden by default (usually fragments or ads).
- Metadata (title, `og:image`, `poster`) read by the content script.
- **Manual scan:** a "scan this page" action inspects `<video>`/`<source>`; if the player uses `blob:` (MSE) and no manifest was seen, the UI explains why.

---

## 4. Download

### 4.1 Preparation

1. Check `protected`, available space (`navigator.storage.estimate()`) and create the job.
2. **Header compatibility:** many servers require the same `Referer`/`Origin`/`Cookie` the player sent (hotlink protection). Servare creates session `declarativeNetRequest` rules that reapply those values **only to the extension's own requests** (`tabIds: [-1]` and/or `initiatorDomains`), never to page traffic. Rules are removed when the job ends (`finally`), and orphaned rules are cleared on startup.
3. Send the job to the worker.

### 4.2 Networking

- Streaming `fetch`, per-host semaphore, exponential backoff with jitter, honoring `429`/`Retry-After`.
- **Speed profiles** (per-domain default, configurable):

| Profile  | Behavior                                                                          |
| -------- | --------------------------------------------------------------------------------- |
| Economy  | 1 connection, sequential order, pace close to playback                            |
| Standard | up to 4 connections per host                                                      |
| Fast     | up to 8 connections; direct files with `Accept-Ranges` split into parallel ranges |

### 4.3 AES-128 (HLS)

Per RFC 8216 §5.2: key fetched from the `EXT-X-KEY` URI (with the player's headers), AES-CBC via WebCrypto, explicit IV or derived from the segment's media sequence number. Keys cached by URI for the duration of the job.

### 4.4 Remux

A single pipeline on top of the libav.js API:

1. each segment (or the whole file) is demuxed into packets;
2. timestamps are rewritten for continuity across segments;
3. packets are muxed into a write device backed by OPFS.

**Container by codec:** H.264/H.265 + AAC → MP4; VP9/AV1/Opus/Vorbis → MKV (or WebM when every track is compatible). Subtitles: `mov_text` in MP4, WebVTT in MKV.

### 4.5 Live

Reload the playlist every `EXT-X-TARGETDURATION / 2`, append only new segments, stop on user action or after several reloads with nothing new. Indeterminate progress.

### 4.6 Audio

Alternate tracks are downloaded in parallel and muxed with language metadata. "Audio only" mode decodes, resamples to 44.1 kHz and encodes MP3 (`libmp3lame`, VBR, configurable quality).

### 4.7 Subtitles

WebVTT, SRT and TTML from HLS/DASH: embedded in the container or saved as a separate file.

### 4.8 Robustness and validation

- Segments that still fail after retries are skipped, except the first; above **20%** failures the job is aborted (configurable).
- Output validation: empty file = failure; duration below **97%** of the expected = `incomplete`.

### 4.9 Writing and delivery

- Positional writes to OPFS with `createSyncAccessHandle` (the file is never held in memory; `unlimitedStorage`).
- At the end: `File` → blob URL → `downloads.download` (`conflictAction: 'uniquify'`, optional "save as"). On Chromium the name is enforced via `downloads.onDeterminingFilename`.
- After completion: the temporary file is removed and the blob URL revoked.

### 4.10 Queue, pause and resume

Jobs and the indexes of completed segments are persisted. Downloads resume after a browser restart (HLS/DASH per segment; direct files via `Range`).

---

## 5. Mirror mode (Firefox)

Instead of downloading again, reuse the data **the page's player has already received**: `webRequest.filterResponseData` copies segment response bodies while the video plays, and the §4.4 pipeline assembles the file.

- Zero extra load on the server and bandwidth savings.
- Covers what the player fetched; the UI shows coverage and offers to complete the rest through the regular path.
- Unavailable on Chromium (no equivalent MV3 API).

---

## 6. Per-domain rules

File `src/rules/default-rules.json`, validated by zod and editable in the options page:

```jsonc
{
  "version": 1,
  "domains": {
    "example.com": {
      "detection": true, // disable detection on the domain
      "minDirectSize": 1048576, // bytes
      "propagateQuery": false, // copy the manifest query string to segments
      "audioOnly": false, // treat streams as audio
      "feedMode": false, // rolling list for infinite-scroll sites
      "hideFragments": true, // hide fragments when a manifest exists
      "speedProfile": "standard", // economy | standard | fast
    },
  },
}
```

Rules match the domain and its subdomains. Rules are never downloaded remotely.

---

## 7. File names

- Default template `{title}`; variables: `{title}`, `{host}`, `{date}`, `{quality}`, `{lang}`.
- Sanitization: NFC normalization, removal of characters invalid on Windows/macOS/Linux, Windows reserved names (`CON`, `NUL`…), whitespace collapsing, 180-character limit, `video` fallback.
- Optional subfolder inside the downloads folder.

---

## 8. libav.js build

A custom variant, reproducible from a script in `vendor/libav/`, containing only: demuxers `mpegts`, `mov`, `matroska`, `mp3`, `aac`, `webvtt`; muxers `mp4`, `matroska`, `webm`, `mp3`; bitstream filters `aac_adtstoasc`, `h264_mp4toannexb`, `hevc_mp4toannexb`; audio decoders `aac`, `mp3`, `opus`, `vorbis`; encoder `libmp3lame`; subtitle codecs `mov_text`, `webvtt`, `subrip`; filter `aresample`. No video decoders (video is always stream-copied).

Licensing: libav.js/FFmpeg and LAME are LGPL-2.1. The repository keeps the build script, pinned versions and notices in `THIRD_PARTY_NOTICES.md`.

---

## 9. Milestones

| Milestone                        | Deliverable                                                                                                   | Done when                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **M0 — Foundation**              | Scaffold, CI, messaging, state, lifecycle and header spikes, OPFS writes + delivery                           | A 2 GB synthetic file is saved on both browsers; the worker survives 10 min |
| **M1 — Direct files**            | Detection, per-tab list, download with page headers, naming, rules, history                                   | An MP4 protected by Referer + cookie downloads on both browsers             |
| **M2 — HLS**                     | libav.js, parser, protection detection, AES-128, fetcher, remux, alternate audio, validation, resumable queue | HLS with AES-128 and separate audio → synchronized MP4                      |
| **M3 — DASH**                    | Parser and video + audio download                                                                             | H.264/AAC → MP4 and VP9/Opus → MKV                                          |
| **M4 — Live, subtitles & audio** | Live HLS, subtitles, MP3, manual page scan                                                                    | Live recorded for 5 min; subtitles visible; valid MP3                       |
| **M5 — Evolution**               | Mirror mode, parallel ranges, options, site extractors, preview, shortcuts, releases                          | —                                                                           |

---

## 10. Testing strategy

- **Unit (Vitest):** parsers, protection detection, MIME types, AES-128 with known vectors, file names, rules, migrations.
- **Locally generated fixtures** with FFmpeg (`test/fixtures/make.sh`) from synthetic sources (`testsrc`, `sine`) — no third-party content in the repository.
- **Test server** (Node): requires `Referer`/cookie, injects 5xx errors, supports `Range`, simulates live with a sliding window.
- **E2E:** Playwright on Chromium; `web-ext` on Firefox; output verified with `ffprobe` (duration, codecs, tracks, sync).
- **CI:** lint, typecheck, tests and builds for both browsers on every push/PR.
