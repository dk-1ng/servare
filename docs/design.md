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

| Item                | Choice                                                                                       | Rationale                                           |
| ------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Extension framework | [WXT](https://wxt.dev) + strict TypeScript                                                   | Per-browser manifests, unified `browser.*`, HMR     |
| Media engine        | [libav.js](https://github.com/Yahweasel/libav.js) (FFmpeg compiled to WebAssembly, LGPL-2.1) | Demux/mux of TS, fMP4, Matroska; subtitles; MP3     |
| Manifest parsers    | In-house HLS parser (`src/manifest/hls.ts`), `mpd-parser` for DASH                           | HLS: see §3.3. DASH: Video.js community, Apache-2.0 |
| Data validation     | zod                                                                                          | Message and state contracts                         |
| Testing             | Vitest, Playwright, local FFmpeg/ffprobe                                                     | Unit, E2E and output verification                   |

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
- Offscreen documents only get `runtime` APIs, so the host cannot use `downloads`. The host creates the blob URL and sends it to the background. The background calls `downloads.download` and watches `downloads.onChanged` (which also wakes it). When the download completes or is interrupted, the background tells the host to revoke the URL; once no jobs are running or awaiting delivery, it closes the host (`offscreen.closeDocument` / `tabs.remove`). The blob URL must outlive the download.

**Messaging between host and background (implemented in #6):**

- Host → background (`delivery/deliver`, `worker/failed`): `PortClient` over `runtime.connect`, reconnecting on demand.
- Background → host (`worker/start`, `delivery/release`): the same request envelopes over `runtime.sendMessage` (`src/messaging/runtime.ts`). A port cannot carry these: it is gone whenever the background was suspended, which is exactly when `downloads.onChanged` wakes it to release a blob URL. `worker/start` is retried for a few seconds because a freshly created host is not listening yet. Hosts only answer senders from the extension's own origin.
- A host owns no job when it starts, and blob URLs die with their page, so at start it deletes every temporary OPFS file (`cleanupOrphans` with an empty keep set) before accepting jobs.
- If `delivery/deliver` throws, the host revokes the blob URL, deletes the OPFS file and reports `worker/failed`.
- The download worker bundle must not depend on zod (its `new Function` probe trips `web-ext lint`); it uses the plain types in `src/download/worker-messages.ts`.
- `download/start-direct` is a temporary trigger for development and E2E, replaced by the real enqueue flow in #25 (the temporary popup, #16, uses it too). It takes an optional `tabId`: the header rules of §4.1.1 are built from that tab's captured headers for the file's exact origin. It also takes an optional `remux: 'mp4'` (#17, temporary like the request itself, replaced by the remux pipeline in #22 and #25), carried through `worker/start` to the worker: the worker then fetches the whole file (refused above 64 MiB, no retries), creates the job's libav instance (§8) and stream-copies every stream into an MP4 written to OPFS through `OpfsWriter.writeAt`, then delivers it like any other file. Cancelling is checked between read batches. Also host-bound: `worker/cancel` (background → host, aborts the job; the worker deletes its file and reports `cancelled`) and `worker/progress` (host → background, throttled to 4 per second per job).
- **Direct-file retries (§4.2):** network errors, `408`, `429` and `5xx` are retried up to 4 tries in total with exponential backoff (500 ms base, 30 s cap) and jitter, honoring `Retry-After`. After a partial body the retry sends `Range: bytes=<written>-` (plus `If-Range` with a strong `ETag`, else `Last-Modified`; with neither it starts over without `Range`) and keeps the written bytes only when the answer is `206` whose `Content-Range` starts at the next byte and reports the same total size. A `206` that does not match is discarded and the file is requested again from byte 0; a `200` is read from the start. Other `4xx` codes fail at once. The worker fetches with `credentials: 'omit'`.
- **Not done yet, left to #25:** parking a job as `queued` on a header conflict (for now `start-direct` refuses it), the mid-job redirect rule request, and persisting jobs across restarts. Rules are owned by the `download.replay` record in `storage.session` and swept when the background starts. A job always gets a rule for its file's origin, empty when nothing usable was captured, so it can never inherit another running job's cookies. When a tab is removed and no host exists any more, the background fails every job still marked running and removes their rules.

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
  downloadId?: number; // browser download, from `done` on; checked as in §4.9.1
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

Message details live in [`docs/ui-contract.md`](ui-contract.md). It adds, for later issues, `DownloadJob.waiting` (why a `queued` job is not running, §4.1.1) and a `download/stop` request that ends a live recording keeping what was recorded (§4.5), as opposed to `download/cancel`, which discards.

---

## 3. Detection

### 3.1 Network observation

1. `webRequest.onSendHeaders` stores the headers sent per request (TTL cache), keyed by tab and exact origin. Chromium needs `extraHeaders` to see `Cookie`/`Referer`. The extension's own requests are skipped here too (see step 2), so headers replayed by §4.1.1 never enter the cache.
2. `webRequest.onResponseStarted` evaluates the response. Discarded: non-2xx status, non-HTTP schemes, the extension's own requests (recognized by `initiator`/`originUrl` with the extension's origin, not by `tabId`: on Firefox they carry the host tab's ID, see §4.1.1), requests without a tab, stream fragments (segment `.ts`, `.m4s`, `.aac`) and domains with detection disabled.
3. Classification order: **HLS → DASH → direct file**.

**Implemented in #9 (`src/detection/`):** the header cache keeps the latest `Referer`/`Origin`/`Cookie` per (tab, exact origin) in memory and mirrors it to `storage.session` (TTL 30 min, 500 entries, cleared on `tabs.onRemoved`). Classifiers are a plain ordered list (`defaultClassifiers`), so the manifest issues can replace the HLS/DASH hint classifiers. A `206` whose `Content-Range` does not start at byte 0 is a seek and is ignored, so a player yields one detection per file, and the total size comes from `Content-Range`. A response of unknown size is kept, since it cannot be shown to be small. Deduplication across repeated requests belongs to the per-tab list (#10). `HeaderEntry.incognito` is set only where `webRequest` reports it (Firefox); on Chromium it is unknown and job preparation must resolve it from the tab, never assume `false`. Readers of the cache must `await restore()` first after a wake-up.

### 3.2 Direct files

- Trigger: request type `media`, or a recognized `video/*`/`audio/*` `Content-Type` (own table in `src/detection/mime.ts`, based on the IANA registry).
- Default minimum size: **1 MiB** (configurable per domain), read from `Content-Length` or the `Content-Range` total.
- Resumable when `Accept-Ranges: bytes`.
- Suggested name: `Content-Disposition` → URL path → MIME type.

### 3.3 Manifests

- The manifest is fetched again with the same headers to confirm the type from its content.
- **HLS master:** variants (`RESOLUTION`, `BANDWIDTH`, `CODECS`), `EXT-X-MEDIA` audio and subtitles. Variants with unknown codecs are hidden.
- **HLS media:** duration (sum of `EXTINF`), `EXT-X-KEY`, `EXT-X-MAP`, `EXT-X-BYTERANGE`. Live = no `EXT-X-ENDLIST`.
- **Implemented in #18 (`src/manifest/hls.ts`):** the HLS parser is written in-house from RFC 8216 instead of using `m3u8-parser`: the protection rules of §3.4 need `EXT-X-SESSION-KEY`, `KEYFORMAT` and per-segment key/map state, and a small pure parser avoids a dependency to audit. Unknown tags are ignored; `file:`/`data:`/other non-http(s) URIs are rejected. A key with a method other than `NONE`/`AES-128`, or a `KEYFORMAT` other than `identity`, sets `protected` and its URI is not exposed. A missing `IV` stays absent (the caller derives it from `Segment.sequence`). `BYTERANGE` without an offset continues the previous range of the same resource. `containerForCodecs` maps `CODECS` to `mp4`, `webm` or `mkv` (§4.4) and returns `undefined` for unknown codecs (subtitle codecs are ignored). `isHiddenVariant` hides a variant only when its `CODECS` lists an unknown codec; `CODECS` is optional in RFC 8216, so a variant without it is kept. A malformed `IV`, an `AES-128` key without `URI`, or a line over 64 KiB makes the parser throw `PlaylistError` rather than guess (a wrong IV would corrupt output silently). Attribute entries that do not parse are skipped, but a key whose `KEYFORMAT` was lost that way counts as protected (fail closed). A `BYTERANGE` with no offset must follow a previous range of the same resource, or the parse fails (RFC 8216 §4.3.2.2).
- **DASH:** `AdaptationSet`/`Representation`, `SegmentTemplate`/`SegmentList`/`SegmentBase`.
- **Quality ordering:** height, then bitrate.

### 3.4 Protected content

The item is flagged `protected: true` and shown as unavailable when there is:

- `ContentProtection` in DASH (any `schemeIdUri`);
- `EXT-X-KEY`/`EXT-X-SESSION-KEY` with a method other than `NONE` and `AES-128`, or a `KEYFORMAT` other than `identity`.

There is no attempt to obtain licenses, CDM keys or equivalents.

**Implemented in #19 (`src/manifest/protection.ts`):** HLS protection is decided by the parser (#18). `mpdIsProtected` scans a DASH MPD textually for `ContentProtection` with any namespace prefix, after removing comments and CDATA; a scan (no `DOMParser` in the Chromium background) can only err towards "protected". `assertDownloadable` throws `ProtectedContentError` for an item with `protected: true`; the enqueue flow (#25) must call it before creating a job, mapping the error to `handler-failed` (`docs/ui-contract.md`). Any DTD counts as protected. The DASH parser (#26) reuses `mpdIsProtected` and must also run it on every remote element resolved through `xlink:href` (ISO/IEC 23009-1 §5.5), or refuse XLink.

### 3.5 Per-tab list

- Cleared when the top frame commits a new document (`webNavigation.onCommitted`, `frameId === 0`) and on `tabs.onRemoved`. Not on `onBeforeNavigate`: a download link or a `204` starts a navigation that never replaces the page.
- Deduplicated by normalized URL (volatile query parameters removed).
- When the tab has an HLS/DASH manifest, small direct files and standalone media playlists are hidden by default (usually fragments or ads).
- Metadata (title, `og:image`, `poster`) read by the content script.
- **Implemented in #10 (`src/detection/tab-list.ts`, `normalize.ts`, `page-meta.ts`):** entries are keyed by the URL without fragment or volatile parameters (tokens, signatures, expiry stamps, `X-Amz-*`/`X-Goog-*`) and with the rest sorted; the latest URL wins, since its token is freshest. With a manifest in the tab, direct files known to be under 10 MiB are hidden (unknown size stays visible). Regular tabs are mirrored to `storage.session`; **private tabs live only in memory** and are lost if the background is suspended. Whether a tab is private comes from `tabs.get`, not `webRequest`. The content script (top frame, read-only) answers a background request with title, `og:image` or `video[poster]`; only http(s) thumbnails are kept. Direct files have `duration: 0` until a probe exists. A detection that began before the tab was closed is discarded (per-tab generation counter). Titles are clamped and oversized URLs dropped. Hiding standalone media playlists waits on manifest parsing (#18).
- **Documents (#56, `src/detection/tab-list.ts`):** each entry records the `documentId` and `parentDocumentId` of its latest request. On a top-frame commit of document D, every document seen in the tab so far is **retired**: the previous top document (always, kept apart from its frames), the frames committed under it (from `onCommitted` with `frameId !== 0`, the latest 64), and the `documentId`/`parentDocumentId` of every entry the commit drops; and the list keeps only entries that already belong to D: requested by D, by a direct frame of D (`parentDocumentId === D`), or the navigation response itself (a `main_frame` response, flagged by the observer, with the same normalized URL as the commit; a media file opened in the tab). While a navigation is in flight Firefox can report the tab as `about:blank` (seen in the E2E for a media file opened in the tab, whose response arrived before the commit); a `main_frame` response is then recorded with its own URL as `pageUrl` (any other detection from such a tab is skipped), and the commit corrects it. Kept entries get the committed URL as `pageUrl` and lose the previous page's title and thumbnail until the next detection. A later detection whose `documentId` or `parentDocumentId` is retired is ignored; the check is repeated inside the serialized write. A document committed again (back/forward cache, prerender activation) leaves the retired set together with the frames retired with it, and their nested frames, since a restore does not announce its frames again. Frames are linked to their parent both from frame commits and from the `documentId`/`parentDocumentId` of dropped entries, so frames known only from stored entries (after a suspension, or past the 64-frame cap) come back too; a frame that commits under the current top document also leaves it. If the top frame committed after a detection started, the page info read for it described the old page, so only the committed URL is recorded (and nothing for a non-http(s) page). Document tracking lives in memory only, so a suspension (normal while a video plays without new requests) forgets the current top document and its frames. The stored entries survive it and still name their documents, which is why a commit also retires the documents of the entries it drops; what a suspension can still lose is a document that reported no media, whose late responses would then be accepted. The retired list is capped at 300 IDs per tab, more than one commit can add.
  - **Evidence** (throwaway probe extension, Chromium 156 and Firefox 158 headless, 2026-10-25): both browsers report `documentId`/`parentDocumentId` on `webRequest` and `webNavigation` (Chromium since 106, Firefox since 153 per MDN compat data); `documentLifecycle` and `frameType` are Chromium-only. Navigation requests (`main_frame`, `sub_frame`) carry no `documentId`; a `sub_frame` request carries its parent's. A fetch the old page started before leaving got its response after the new commit on Chromium, still tagged with the old `documentId` and with `documentLifecycle: "active"` (so the lifecycle cannot tell it apart); Firefox cancelled it, except a `keepalive` fetch, which Firefox reports with no `documentId`. A download link (`Content-Disposition: attachment`) and a `204` fire `onBeforeNavigate` and never `onCommitted`. Event order between the two APIs is not guaranteed: on Firefox a `main_frame` `onResponseStarted` arrived both before and after its `onCommitted`. A top-level media file: Chromium sees the navigation response, then a `media` request from the media document; Firefox sees only the navigation response.
  - **Rejected:** keeping the per-tab generation bump on commit (it would discard the new document's detections that started before the commit event arrived); `documentLifecycle` (Chromium-only, and the probe showed `active` on the old page's late response); comparing `timeStamp`s across the two APIs (no ordering guarantee); a `documentUrl` comparison (fails on reloads of the same URL).
  - **Degraded cases:** on Firefox 140–152 (no document IDs) the list is cleared on commit, late responses of the old page are not recognized, and the new page's detections that arrive before its commit are dropped. A Firefox `keepalive` fetch from the old page is not recognized either. A frame that reported no media is retired only if its commit was seen and it is among the latest 64 frames, so otherwise its late responses are accepted; after a suspension, a restored page's frames that reported no media were never retired and need no restore. Detections from a Chromium prerender appear in the current list before activation, as before.
- **Manual scan:** a "scan this page" action inspects `<video>`/`<source>`; if the player uses `blob:` (MSE) and no manifest was seen, the UI explains why.

---

## 4. Download

### 4.1 Preparation

1. Check `protected`, available space (`navigator.storage.estimate()`) and create the job.
2. **Header compatibility:** many servers require the same `Referer`/`Origin`/`Cookie` the player sent (hotlink protection). Servare creates session `declarativeNetRequest` rules that reapply those values **only to the extension's own requests**, never to page traffic. Rules belong to `running` jobs only. They are removed on every transition out of `running`, and rules no running job owns are cleared whenever the background starts. Details in §4.1.1.
3. Send the job to the worker.

#### 4.1.1 Header replay rules (spike #7)

**Decision:**

- **Scope: own requests to one exact origin.** Every rule's condition is `initiatorDomains: [<own extension host>]` plus `regexFilter: '^' + escapeRegExp(new URL(u).origin) + '/'`. The origin (scheme, host and port) comes from `URL` parsing, never from string slicing, and every regex metacharacter in it is escaped, including the `[`/`]` of IPv6 literals. `URL.origin` leaves out default ports, as browsers do when they serialize the request URL, so the two match. The extension host is read at runtime from `runtime.getURL('/')` (the Chromium extension ID, or the per-install Firefox UUID).
  - No `tabIds`: on Firefox the download worker lives in the host **tab** (§2.3), so its requests carry that tab's ID, not `-1`, and `tabIds: [-1]` silently does not match them. `initiatorDomains` matches the extension's own requests on both browsers and never matches page traffic, whatever the page's tab or origin.
  - No `requestDomains`: it also matches subdomains and ignores scheme and port. A cookie captured for `example.com` would reach `cdn.example.com`, and one captured over `https` could be replayed over `http`. The exact-origin `regexFilter` was verified on both browsers: it matched its origin and did not match the same host on another port or another host name for the same address (`localhost` vs `127.0.0.1`).
- **One rule per (job, origin), never shared.** A captured `Cookie` is replayed only to the exact origin (scheme included) it was captured for, never to another one (a segment CDN, a key server, the same host over another scheme). There is no refcount: a count kept in memory dies with the suspended background (§2.3), and a persisted one adds a second source of truth. Two jobs with identical header sets for one origin each have their own rule. Both rules write the same values, so it does not matter which one the browser applies, and removing one leaves the other in place.
- **Where header values come from.** Values are read from the §3.1 cache, using only requests that came from the media item's own tab (`tabId`), and therefore from that tab's cookie store and private-window state (Firefox also records the `cookieStoreId`). For each origin, the most recent such request is used. They are never taken from the newest request to that host from any tab. The job records whether its tab was private.
  - For origins known at preparation time (manifest, segment and key origins after parsing), the background adds the rules before starting the worker.
  - An origin first seen later, such as a new origin in a live playlist, makes the worker ask the background for a rule before its first request there. The background runs the same exact-origin conflict check as for a queued job (see Conflicts) before adding it.
  - If the tab never sent a request to that origin, only `Referer` and `Origin` are replayed, never a `Cookie`.
- **Redirects.** DNR evaluates every redirect hop against that hop's own URL. This was verified on both browsers by redirecting from the echo origin to `/guarded/…`. With a rule only on the source origin, the target answered `403`. With a rule on the target origin, it answered `200`. So:
  - Rules are created up front for every origin the tab's player traffic reached, including redirect targets, which `webRequest` reports as their own requests.
  - When a response has `response.redirected` and its final origin has no rule, the worker asks the background for a rule for that origin and retries the request once. Values come from the same tab capture if there is one; otherwise only `Referer`/`Origin`. The conflict check (see Conflicts) runs before the rule is added.
- **Headers replayed:**
  - `Referer`: `set` to the player's value. If the player sent none, `remove`.
  - `Origin`: `set` when the player sent one, `remove` otherwise. Extension `GET`s carry no `Origin` on either browser, but a `POST` carries `chrome-extension://…`/`moz-extension://…`, which a server checking `Origin` rejects. Other methods are expected to behave the same, per the Fetch standard. One rule shape covers both cases.
  - `Cookie`: `set` to the player's value, otherwise `remove`. The worker fetches with `credentials: 'omit'`, so the browser's own cookies for the site (the "jar") are never used. That means no cookies the player did not send and no `Set-Cookie` written into the regular jar from private-window jobs. Partitioned cookies (dFPI / CHIPS) also work, because the value comes from the player's request, not from a jar lookup. `credentials: 'omit'` plus a DNR `Cookie` `set` was verified to reach the server on both browsers.
  - Not replayed for now: `User-Agent` (same browser), `Sec-Fetch-*`, `Authorization`. The table shows they can be set, so a per-domain rule can add one later if a real site needs it, backed by evidence.
- **Conflicts.** Two running jobs that need different header sets for the same origin would match each other's rules: DNR cannot tell two requests from the same extension apart without changing their URL. The check is keyed on the same exact origin as the rule. The check runs at two points, against every other `running` job:
  - **On the transition to `running`.** A job whose header set for some origin differs from the set a `running` job uses there stays `queued` until that job leaves `running`.
  - **When a running job asks for a rule mid-job** (a new origin in a live playlist, a redirect target). If another running job uses a different header set for that origin, the asking job leaves `running`: its rules are removed as on any exit from `running`, and it goes back to `queued` with `waiting: { reason: 'header-conflict', blockingJobId }`. It resumes from its persisted progress (§4.10). If the values are identical, the rule is added as usual.
  - A live job (§4.5) can hold this indefinitely. The UI contract (`docs/ui-contract.md` §3.2) therefore gives a queued job `waiting: { reason: 'header-conflict', blockingJobId }`, so the UI can explain it and offer to stop the blocking job.
- **Lifecycle.** The background is suspendable (§2.3), so rules are never tied to a `finally` in background code. They are owned by job state:
  - Rule IDs come from a range reserved for header replay.
  - Before calling `updateSessionRules`, the background writes the job's rule IDs into the job record (write-ahead), so a crash between the two steps leaves an owned rule, not an untracked one.
  - Only `running` jobs own rules. Rules are created on the transition to `running`.
  - Rules are removed in the background's state handlers on **every** transition out of `running`: `done`, `failed`, `cancelled` and `paused`. That includes the user's pause and the Firefox `tabs.onRemoved` pause when the host tab closes (§2.3).
  - Each time the background starts, it reads `getSessionRules()` and removes every rule in the range that is not listed by a `running` job in the store.
  - **Browser startup.** An empty `storage.session` marks it, which is more reliable than `runtime.onStartup` for an event page. Every job stored as `running` moves to `queued` and its rule IDs are cleared, except private-window jobs, which move to `failed` (see Restart and resume). Its session rules no longer exist, and stale IDs must not look owned. It then resumes through the normal transition into `running`, conflict check included.
- **Restart and resume vs. privacy.** Session rules are dropped on browser shutdown and on extension update (both browsers' docs). Recreating them after a restart needs the captured values again. **Decision: cookie values are session-only** for every job: kept in `storage.session`, never in `storage.local`. Regular jobs persist `Referer`/`Origin` with the job. **Private-window jobs** keep every replayed value, `Referer`/`Origin` included, in `storage.session` only (principle 4), so they do not resume after a browser restart; they fail with an error that asks the user to reopen the page.
  - **Within the same browser session** (for example after a pause), the background re-captures from the job's tab when that tab still exists, has the private-window state and Firefox `cookieStoreId` the job recorded, and the cache has a fresh request from it to the origin.
  - **After a browser restart**, the stored tab ID is treated as gone: tab IDs are reused across restarts, so it may now belong to an unrelated page. A regular job resumes with its persisted `Referer`/`Origin` only.
  - If the server then answers `401`/`403`, the job fails with `{ kind: 'http', status }`, and the UI suggests reopening the page and playing the media again.
  - Rationale: cookies are session credentials. Writing them to disk would break principle 4 (private windows leave no trace, nothing kept beyond need). They usually expire long before a restart anyway. The rejected alternative was persisting them in `storage.local` and wiping them on every terminal state, which leaves them on disk after a crash.
  - Resume after restart therefore stays fully automatic for media that does not need cookies, which keeps §4.10's promise for those cases.
- **Detection side effects (§3.1):** the extension's own requests appear in `webRequest` with the DNR-modified headers already applied. On Firefox they also carry the host tab's `tabId`. They are recognized by `initiator` (Chromium) or `originUrl`/`documentUrl` (Firefox) starting with the extension's own origin, not by `tabId === -1`. They are dropped in **both** `onSendHeaders` and `onResponseStarted`, so replayed headers never overwrite cache entries.

**Compatibility table** (Chromium 156 headless, Firefox 158 headless, 2026-10-25). A throwaway MV3 probe used the production layout: a module worker in the worker host (offscreen document on Chromium, inactive extension tab on Firefox). For each case it added a session `modifyHeaders` rule and fetched an echo server that returned the request headers it received. Every `updateSessionRules` call was accepted, and every operation below reached the server as written on **both** browsers:

| Header                                                                                        | `set` | `remove`                  | `append`    | Notes                                                                |
| --------------------------------------------------------------------------------------------- | ----- | ------------------------- | ----------- | -------------------------------------------------------------------- |
| `Referer`                                                                                     | yes   | yes                       | not tested  | Extension requests send no `Referer` by default                      |
| `Origin`                                                                                      | yes   | yes                       | not tested  | Absent on extension `GET`; extension origin on `POST`, both browsers |
| `Cookie`                                                                                      | yes   | yes                       | yes (`; v`) | `set` replaces jar cookies; works with `credentials: 'omit'`         |
| `User-Agent`, `Accept`, `Accept-Language`, `Authorization`, `Range`, `Priority`, custom `X-*` | yes   | not tested                | not tested  | `Range` also works when passed to `fetch` directly                   |
| `Sec-Fetch-Site`/`-Mode`/`-Dest`                                                              | yes   | yes (`-Site` only tested) | not tested  | Extension defaults differ: Chromium `none`, Firefox `same-origin`    |
| `Accept-Encoding`, `Host`                                                                     | yes   | not tested                | not tested  | Both are honored. Never touch them                                   |

Rule scope, measured as "did the request get the rule's header?". Page traffic was a normal web tab on another origin doing `fetch` (credentialed, CORS) and `<img>` to the same URLs while the rules were active:

| Condition                           | Chromium worker (offscreen) | Firefox worker (host tab) | Background (SW / event page) | Page `fetch` and `<img>`    |
| ----------------------------------- | --------------------------- | ------------------------- | ---------------------------- | --------------------------- |
| none (control)                      | yes                         | yes                       | yes                          | **yes (leak)**              |
| `tabIds: [-1]`                      | yes                         | **no**                    | yes                          | no                          |
| `initiatorDomains: [own host]`      | yes                         | yes                       | yes                          | no                          |
| `tabIds: [-1]` + `initiatorDomains` | yes                         | **no**                    | yes                          | no                          |
| `tabIds: [<host tab>]` (Firefox)    | —                           | yes                       | no                           | no                          |
| `excludedInitiatorDomains: [page]`  | yes                         | yes                       | yes                          | no (but only for that page) |

`webRequest` view of the same requests: Chromium worker → `tabId -1`, `initiator: chrome-extension://<id>`. Firefox worker → `tabId <host tab>`, `originUrl`/`documentUrl: moz-extension://<uuid>/<worker script>`. Firefox event page → `tabId -1`.

Acceptance run against the test server's `/guarded/…` (same-origin `Referer` and the session cookie required). Rule: `requestDomains` + `initiatorDomains`, `Referer` and `Cookie` set, `Origin` removed (the exact-origin `regexFilter` replaced `requestDomains` after this run and was checked separately, below). On both browsers the worker got `403 referer required` without the rule, then `200` with all 1 MiB, and `206` for a `Range` request with the rule. While the rule was active, the page tab's `fetch` and `<img>` for the same URL still got `403`, and the server logged the page's own `Referer`. `getSessionRules()` listed the leftover rule, and removing it left zero rules.

Exact origin and redirects (second run, same browsers), with `regexFilter: ^<escaped origin>/` + `initiatorDomains`, `credentials: 'omit'`:

- Request to the rule's origin: header applied. Same host on another port: not applied (checked through `webRequest`, which shows DNR-modified headers). Same address under another host name (`localhost`): not applied.
- `302` from the echo origin to `/guarded/…`, rule on the target origin only: `200`, full body. Rule on the source origin only: `403 referer required`.

**Rejected:**

- **`tabIds: [-1]` as the scope.** It works on Chromium but misses the Firefox worker (host tab). Adding the host tab ID instead would tie the rules to a tab that can be closed and reopened mid-job.
- **Headers on `fetch` itself.** `Cookie`, `Origin` and `Referer` (cross-origin) are forbidden request headers in the Fetch standard, so a page or worker cannot set them.
- **`credentials: 'include'` (jar cookies).** Both browsers send the regular jar's cookies for the target host. That works only when the player's cookies are unpartitioned and from a regular window, sends cookies the player did not send, and lets server `Set-Cookie` responses write into the jar.
- **`requestDomains` as the origin filter.** It matches subdomains and ignores scheme and port (see Scope).
- **Shared, refcounted rules.** An in-memory count dies with the suspended background, and a persisted owner list adds a second source of truth for no gain, because identical rules from two jobs are harmless.
- **One rule per host shared by every job without conflict checks.** Two pages with different sessions on the same CDN would get each other's cookies.
- **Picking header values as the newest capture for a host from any tab.** It would mix sessions and cookie stores (private vs. regular windows, Firefox containers).

**Not verified by the spike:** headed browsers and packaged installs; rule behavior across a real Chromium service-worker stop and a Firefox event-page suspension mid-job (the docs only say session rules are dropped on browser shutdown and extension update, so they are expected to survive suspension); interaction with another extension's `modifyHeaders` rules on the same header (Chromium gives the most recently installed extension precedence); Firefox versions between 140 and 158; private-window jobs end to end; the exact-origin `regexFilter` with IPv6 literals, internationalized host names and explicit default ports (`:443`); the redirect-and-retry path inside the real worker; Chromium's regex rule limits (`MAX_NUMBER_OF_REGEX_RULES`) under many concurrent jobs and origins.

#### 4.1.2 Download history

Implemented in #15 (`src/history`). Finished (`done`) and `failed` jobs are recorded in `storage.local`, newest first, capped at 200 entries (the oldest go first); cancelled jobs are not recorded. Private-window jobs are never recorded, and neither are jobs whose tab is unknown or gone (`download/start-direct` without `tabId`): when privacy cannot be told, nothing is kept. A private job does not even keep its title or page URL in `storage.session`. Page URLs over 8192 characters or not http(s) are stored empty. Jobs persisted before the history existed count as private. A `done` entry may also keep a reference to its browser download, served as `downloadId` only after the check of §4.9.1.

### 4.2 Networking

- Streaming `fetch`, per-host semaphore, exponential backoff with jitter, honoring `429`/`Retry-After`.
- **Speed profiles** (per-domain default, configurable):

| Profile  | Behavior                                                                          |
| -------- | --------------------------------------------------------------------------------- |
| Economy  | 1 connection, sequential order, pace close to playback                            |
| Standard | up to 4 connections per host                                                      |
| Fast     | up to 8 connections; direct files with `Accept-Ranges` split into parallel ranges |

**Implemented in #21 (`src/net/fetcher.ts`):** `createFetcher` wraps `fetch` for the download worker, one instance per worker so the limit holds across jobs.

- **Per-host limit.** A FIFO semaphore per `host:port` allows `CONNECTIONS_PER_PROFILE` requests at once (1, 4 or 8). The profile comes from the per-domain rules for the request's host name (`rulesFor`), so only the built-in rules apply until the options page (#34) stores the user's. A slot is held until the response body ends, is cancelled or fails, or the request's signal aborts, and is released while a failed request backs off. Callers must consume or cancel every body.
- **Request-phase retries.** Network errors and `408`, `429` and `5xx` are retried up to 4 tries with exponential backoff (500 ms base, 30 s cap) scaled to 50-100% by jitter. Other statuses are returned as they are, and so is a transient status that outlasts the retries.
- **`Retry-After`** (seconds or HTTP date) replaces the backoff for that wait. A `429`, or any retry that carries `Retry-After`, also holds back every other request to the same host for that long. A server asking for more than 120 s is not retried: its response is returned and the job fails with `{ kind: 'http', status }`.
- **Body-phase retries stay with the job.** A body cut midway is retried by the runner (`src/download/direct-job.ts`) with the same backoff helper, resuming with `Range` (§4.1); the new request goes through the fetcher again.
- **Not in the fetcher:** the pace of Economy ("close to playback") belongs to the HLS runner, which decides when to ask for the next segment; parallel range splitting for Fast is #33.

### 4.3 AES-128 (HLS)

Per RFC 8216 §5.2: key fetched from the `EXT-X-KEY` URI (with the player's headers), AES-CBC via WebCrypto, explicit IV or derived from the segment's media sequence number. Keys cached by URI for the duration of the job.

- **Implemented in #20 (`src/crypto/aes128.ts`):** `decryptSegment(data, key, sequence, keys)` decrypts a whole segment with AES-CBC and PKCS#7 padding. The IV is the explicit `IV` or, when absent, the media sequence number as a 128-bit big-endian integer. `KeyCache` takes an injected `KeyFetcher` (the HLS runner will build it on the fetcher of §4.2), caches the import by URI for the job, and drops a failed fetch so the next segment retries. A key that is not 16 bytes, a segment whose length is not a multiple of 16, a bad IV or a WebCrypto failure all throw `DecryptError` (`kind: 'decrypt'`). Padding is checked by WebCrypto, so a wrong key is usually reported but can occasionally decrypt to garbage.

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
- **Private windows (#63).** The pending delivery of a private job (or of one whose tab is unknown) is listed in `storage.session`, never `storage.local`, so no file name or blob URL reaches disk; if the browser closes mid-download, OPFS orphan cleanup is the recovery. On Firefox `downloads.download` also gets `incognito: true` when the job's tab was actually seen as incognito (not merely unknown: Firefox refuses the option for an extension without private-window access), so the item stays out of the persisted downloads list. The failure record of a private job is kept in `storage.session` too. Chromium rejects the option (`platform.downloadsIncognitoOption`), and its background is a spanning one, so a private-window download would be listed in the regular downloads history there. Instead (`platform.erasePrivateDownloads`, #64), once such a download reaches a terminal state `Delivery` calls `downloads.erase({ id })`, which drops the history entry and keeps the file; a failed erase is logged and never blocks the release. Jobs whose tab is unknown are erased too (they are treated as private). If the browser closes mid-download, no terminal event arrives, so that interrupted entry stays in the history after the next start. The E2E helper page records downloads as they happen, since tabless (private) jobs are no longer found by `downloads.search` on Chromium. The Firefox behavior has not been verified in a real private window.

#### 4.9.1 Opening and showing delivered files (#79)

The UI lets the user open a delivered file or show it in its folder, from the finished job and later from the history. It does so with the browser's own `downloads.open(id)` / `downloads.show(id)`, so it needs the browser download id.

**Decision:**

- **The UI page calls `downloads.open` / `downloads.show` itself, in its click handler.** This is the one documented exception to "the UI only talks through the contract" (`docs/ui-contract.md` §4.6). `downloads.open` needs a user action, and that action does not survive a message to the background (see Evidence), so a background `download/open` request cannot work. `downloads.show` would work from the background, but one mechanism for both buttons is simpler than two. The UI calls no other `downloads` function.
- **Permission `downloads.open`** is added to the required permissions on both browsers. It cannot be optional: requesting it in the same click and then opening fails on Firefox, because the user action is lost at the first `await`. A two-click flow (grant, then open) was rejected as clumsy for a core action. Install prompt cost: on Chromium its warning is "Manage your downloads", the same text as `downloads`, which is already required, so no new line is expected. On Firefox it adds "Open files downloaded to your computer". Servare is not published yet, so adding it now asks no existing user to re-approve.
- **`DownloadJob.downloadId`** is set on the `done` event of a job, from the id `downloads.download` resolved with. Within one browser session an id is never reused (Evidence), so this value needs no check. It is left out when the delivery will erase the download (`platform.erasePrivateDownloads`: private and tabless jobs on Chromium, §4.9), since the id stops existing a moment later. Firefox private jobs keep it for the session. Private jobs never reach the history, so for them the field exists only on the job; the browser's own downloads list is the fallback. When #25 persists jobs, a stored `done` job's `downloadId` must go through the same check as the history below (or be dropped at browser startup): only the value in the `done` event is served unchecked.
- **`HistoryEntry.downloadId` is never replayed from storage.** A `done` entry stores `download: { id, fingerprint }`, where `fingerprint` is the lowercase hex SHA-256 (WebCrypto) of `JSON.stringify([filename, startTime])` taken from `downloads.search({ id })` once the item is `complete`. On every `history/list` and every `history/updated` it emits, the background looks each stored id up again and serves `downloadId` only when the item exists, its `state` is `complete`, `exists` is not `false`, and its fingerprint matches. Anything else (erased, list cleared, id reassigned after a restart, search failure) leaves the field out; the stored reference is kept, since the check is cheap and a failed lookup may be temporary.
  - **Fields.** `filename` (absolute path) and `startTime` (ISO 8601 with milliseconds) are present and unchanged on both browsers, and the pair is unique in practice: `conflictAction: 'uniquify'` keeps paths distinct while the files exist, and `startTime` separates a later download that reuses a freed path. `endTime` is not used (Firefox reports `null`), nor `fileSize` (Firefox reports `-1` while in progress, and it adds nothing to the pair).
  - **Why a hash.** The check only needs equality, so the absolute path (which usually contains the user's account name) is not copied into `storage.local`. The browser already keeps that path in its own download history for regular downloads, so storing it would have been acceptable for regular jobs, but there is no need. The hash is data minimization, not secrecy: a path is guessable.
  - **When it is taken.** The history entry is written at `done`, but the item may still be `in_progress` then (Chromium decides the final `filename` later, and Firefox waits on a save-as dialog). The fingerprint is attached when `Delivery` sees `complete`, and also right after the entry is recorded if the item is already complete (a small file can finish before the entry exists). Attaching is idempotent and a no-op when no entry exists (private, cancelled or failed jobs). A delivery that ends `interrupted` never gets one, so its entry never carries `downloadId`.
- **`exists` is a hint, not a guarantee.** Both browsers kept reporting `exists: true` for a file deleted from disk until they rechecked later (Chromium updated it after a restart; Firefox did not in the probe). So the UI must handle a rejected `open` and must not promise that the file is there.
- **`done` comes before `complete`.** `done` is emitted when `downloads.download` resolves. Until the browser finishes writing, `open` rejects ("Download must be complete" on Chromium, "Download has not completed." on Firefox); `show` works. The UI shows the rejection as "not ready yet / no longer available", it does not retry on its own.

**Evidence** (throwaway probe extension driven by `puppeteer-core`, Chromium 156 headless over CDP and Firefox 158 headless over WebDriver BiDi, 2026-10-25; synthetic 1 KiB files from a local server; the browsers ran without `DISPLAY` or a D-Bus session so no file manager or application could start):

| Question                                             | Chromium 156                                                                                                                                          | Firefox 158                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ids after a browser restart (same profile)           | Same ids, same `filename` and `startTime`; an erased id was not reused (next new id was max + 1)                                                      | `downloads.search({})` returned **nothing** from the previous session (the items were still in the browser's history database); the next download got id **1** again, the id an earlier file had |
| Ids after "clear list" and a restart                 | `erase({})`, restart: the next download got id **1** again                                                                                            | Same as above                                                                                                                                                                                    |
| Ids after `erase({})` within one session             | Not reused (1, 2 erased → 3)                                                                                                                          | Not reused (1, 2 erased → 3)                                                                                                                                                                     |
| `open` with no user action (from the background)     | Rejected: "User gesture required"                                                                                                                     | Rejected: "downloads.open may only be called from a user input handler" (also from an extension page outside a click)                                                                            |
| `open` synchronously in a click on an extension page | Accepted                                                                                                                                              | Accepted (the in-progress probe item failed only with "Download has not completed.")                                                                                                             |
| `open` after an `await` in the same click            | Accepted after 50 ms and after `permissions.request` (already granted, no prompt); rejected after 6 s: "User gesture required" (transient activation) | Rejected after a 50 ms `await`, and after `permissions.request`                                                                                                                                  |
| `open` on an in-progress item, with a user action    | "Download must be complete"                                                                                                                           | "Download has not completed."                                                                                                                                                                    |
| `show` from the background (no user action)          | Resolves `undefined` for a valid, an erased and an unknown id alike (never reports failure)                                                           | Resolves `true` for a valid id; rejects "Invalid download id N" for an erased or unknown one                                                                                                     |
| `exists` after deleting the file from disk           | Still `true` 1.5 s later; `false` only after the next restart                                                                                         | Still `true` 1.5 s later                                                                                                                                                                         |
| Fingerprint fields of a completed item               | `filename` absolute, `startTime` and `endTime` ISO with ms, `fileSize` exact; uniquified name `probe-a (1).bin`                                       | `filename` absolute, `startTime` ISO with ms, `endTime` `null`, `fileSize` exact (`-1` while in progress); uniquified name `probe-a(1).bin`                                                      |

So the id is not a stable handle on either browser: Chromium reuses ids after the list is cleared and the browser restarts (erasing only the newest items probably does the same, since the next id followed the highest one kept; not tested), and Firefox numbers each session from 1 and forgets earlier ones. A replayed id could open a different file; the fingerprint prevents that. On Firefox a history entry from an earlier session never gets a `downloadId`.

Documentation agrees on the rest: MDN (`downloads.open`, "User actions") requires `downloads` plus `downloads.open` and a user-action handler, lists "clicking a button on a page bundled with the extension" as a user action, and says a handler that waits on a promise loses that status; it lists `downloads.open` among the allowed optional permissions. Chrome's docs require the same permission pair and a user gesture, give `downloads.open` the warning "Manage your downloads", and call `id` "persistent across browser sessions" (true only while the browser keeps the item, as the table shows). Mozilla's permission-messages article describes "Open files downloaded to your computer".

**Rejected:**

- **Background requests (`download/open`, `history/open`, …).** `open` fails there on both browsers (no user action). A `show`-only request would work but would make two mechanisms for one feature.
- **Optional `downloads.open`.** One click cannot both grant and open on Firefox. On Chromium it would depend on the user answering the prompt within the transient-activation window (about 5 s).
- **Replaying the stored id.** Opens the wrong file after a restart on both browsers.
- **Checking in the UI before opening** (`downloads.search` in the click handler). The `await` loses the user action on Firefox; the check belongs in the background, before the id is served.
- **Storing the raw absolute path.** Not needed for an equality check.
- **`fileSize` or `endTime` in the fingerprint.** `endTime` is `null` on Firefox; `fileSize` adds nothing.

**Not verified:** headed browsers and real (not WebDriver-synthesized) clicks; packaged installs and the actual install prompt text of either browser with `downloads.open` (taken from the docs above); a real `permissions.request` prompt; Firefox with a profile not started by automation (the probe's profile wrote no `downloads.json`; a session list restored from it would still be renumbered); downloads made in a real Firefox private window (`incognito: true`) and whether a non-private extension page can open them; `open`/`show` actually launching an application or file manager (the probe kept both from starting); Windows and macOS.

### 4.10 Queue, pause and resume

Jobs and the indexes of completed segments are persisted. Downloads resume after a browser restart (HLS/DASH per segment; direct files via `Range`). On browser startup, jobs stored as `running` move to `queued` with their header-rule IDs cleared, and resume through the normal transition into `running`, including the header conflict check (§4.1.1). Captured cookies are not persisted (§4.1.1): after a restart a job resumes with `Referer`/`Origin` only. If the server then refuses it, it fails with an `http` error that asks the user to reopen the page. Private-window jobs do not resume after a restart at all: they move to `failed` instead of `queued`.

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
- Sanitization: NFC normalization, removal of characters invalid on Windows/macOS/Linux, Windows reserved names (`CON`, `NUL`…), whitespace collapsing, 180-character limit (code points, including the extension) and a 240-byte UTF-8 limit, whichever is stricter, `video` fallback.
- Optional subfolder inside the downloads folder.

---

## 8. libav.js build

A custom variant, reproducible from a script in `vendor/libav/`, containing only: demuxers `mpegts`, `mov`, `matroska`, `mp3`, `aac`, `webvtt`; muxers `mp4`, `matroska`, `webm`, `mp3`; parsers `h264`, `hevc`, `aac`, `mpegaudio`, `opus`, `vorbis`, `vp9`, `av1`; bitstream filters `aac_adtstoasc`, `h264_mp4toannexb`, `hevc_mp4toannexb`; audio decoders `aac`, `mp3`, `opus`, `vorbis`; encoder `libmp3lame`; subtitle codecs `movtext` (FFmpeg's component name for `mov_text`), `webvtt`, `subrip`; filters `aresample`, `aformat`. No video decoders (video is always stream-copied).

Licensing: FFmpeg (built without `--enable-gpl`/`--enable-version3`) is LGPL-2.1-or-later, LAME is LGPL-2.0-or-later (GNU Library GPL v2), and libav.js is LGPL with its own glue under 0BSD. The repository keeps the build script, pinned versions and notices in `THIRD_PARTY_NOTICES.md`.

**Decision (#17):**

- **Pinned inputs.** libav.js `v6.10.9.0` (commit `c80e885c3461f7bb7ea565c9631b34243ae0dbf1`, FFmpeg 9.0), LAME 3.100, emfiberthreads 1.3 (a libav.js build dependency, 0BSD), all checked by SHA-256 (git commit for libav.js), built in `emscripten/emsdk:6.0.5` pinned by image digest (the emsdk version libav.js's own CI uses). The libav.js fragment names map to the list above; `muxer-mp4` also brings the other `movenc` muxers (`mov`, `ipod`, `ismv`, …: shared code, no size cost), `avformat` brings the `file`/`data` protocols, and FFmpeg adds the `ac3` parser as a dependency. Network access is not needed for any of it (`--disable-network`).
- **Build mechanism.** `vendor/libav/build.sh` downloads and verifies the sources on the host, runs `npm ci` for libav.js's own build tools (`terser`) in the container, then builds with `docker run --network none` as the calling user, so a hidden download fails the build. It runs `configs/mkconfig.js` with `vendor/libav/fragments.json` and asks `make` only for the non-threaded WebAssembly ES module target. After `configure` it checks `config_components.h` for every requested component, because FFmpeg silently ignores an unknown name (`mov_text` enabled nothing; the component is `movtext`).
- **Committed output.** The two shipped files (`libav-6.10.9.0-servare.wasm.mjs`, `libav-6.10.9.0-servare.wasm.wasm`) and a `SHA256SUMS` are committed in `vendor/libav/dist/`, so `pnpm build`, CI and contributors need no Docker or Emscripten. `build.sh --check` rebuilds in a temporary directory and compares against `SHA256SUMS`; a CI job runs it when `vendor/libav/**` changes. The asm.js, threaded and debug targets and libav.js's frontend are not built or shipped.
- **Loading.** A WXT `build:publicAssets` hook copies the two files to `libav/` in each browser's output. They are package files reached only by extension pages and the worker, so they need no `web_accessible_resources`. The download worker loads libav.js **without its frontend and without its internal worker**: it imports the Emscripten factory with a literal path, `import('/libav/libav-6.10.9.0-servare.wasm.mjs')`, and calls it with `{ wasmurl: '/libav/libav-6.10.9.0-servare.wasm.wasm' }`. The resulting module runs synchronously in the download worker (the frontend's "direct" mode, which is what `noworker` selects). Servare's own typed wrapper in `src/media/libav/` exposes the functions it uses and defines the two constants the frontend would otherwise add (`AVERROR_EOF`, `AVERROR(EAGAIN)`). The WASM stays a separate file loaded at run time and is never bundled into Servare's code, which also keeps it replaceable as LGPL §6 expects.
- **CSP.** `'wasm-unsafe-eval'` in `content_security_policy.extension_pages` is required on both browsers (already in the manifest); module workers inherit it.
- **Instances.** One libav instance per job, created lazily when the job needs media processing and dropped when it ends. Instances are never shared between concurrent jobs (Asyncify-based I/O is not reentrant). Output goes through a libav block writer device whose `onwrite(name, pos, data)` writes synchronously to the job's `OpfsWriter.writeAt`, because in direct mode `data` is a view into WASM memory that is only valid during the call.
- **Size** (committed build, #17). `.wasm` 2,528,349 bytes (2.41 MiB; 1,036,503 bytes gzip -9); factory glue 330,818 bytes (61,755 gzip). The spike's probe build was 10,886 bytes smaller because it asked for `mov_text`, which enabled nothing; the evidence below was measured on it. Instantiation took 35–56 ms in the worker.
- **Not in libav.js's API:** subtitle decoding/encoding (`avcodec_decode_subtitle2`/`avcodec_encode_subtitle` are not exported). M4 must either synthesize subtitle packets for the muxers (e.g. 3GPP timed text samples for `mov_text`) or extend the bindings; the subtitle codecs stay in the build until that is decided.

**Evidence** (2026-10-25, throwaway probe extension with the production CSP; Chromium 156 headless, Firefox 158 headless via `web-ext run`). A module worker in an extension page imported the factory from the package, instantiated it, wrote three concatenated synthetic HLS segments (`test/fixtures/make.sh`, H.264 + AAC in MPEG-TS, 6 s) into libav's in-memory file system, stream-copied them through the `mp4` muxer into an OPFS file via a block writer device and returned the file. Both browsers produced the same 227,120-byte MP4 (identical SHA-256), and so did Node 26 with the same files. `ffprobe` reported H.264 320×240 (90 frames, 6.0 s) and AAC 48 kHz, and `ffmpeg -xerror -f null` decoded it without errors. `instantiateStreaming` succeeded on both browsers (no ArrayBuffer fallback), so Firefox serves `.wasm` package files as `application/wasm`. Without `'wasm-unsafe-eval'` both browsers refused to compile the module. Three independent builds (one as root with network, one from a clean `git archive`, one offline as a regular user) produced byte-identical files, each in about 1 min 40 s on 12 cores. A WXT build with the hook kept the literal `import()` paths in the IIFE worker bundle. `web-ext lint` reports nothing for the factory files; libav.js's frontend would add two warnings (a computed `import()` and an unexpected global), another reason not to ship it. With the committed build (#17), `src/media/remux.test.ts` remuxes the same three segments in Node (H.264 + AAC, 6 s, decoded by `ffmpeg -xerror` without errors), E2E step 8 does the same for one segment through `download/start-direct` in Chromium 156 and Firefox 158 (OPFS left empty), and `build.sh --check` reproduced both files byte for byte from a second clean build with a different `make -j`.

**Rejected:**

- **libav.js's frontend with `noworker`.** It works, but it ships extra loading code (worker, threads, asm.js and `<script>` paths) that never runs here and that `web-ext lint` flags. Its only use in direct mode is wrapping results in promises, which `await` already handles.
- **libav.js's internal worker** (its default). It would start a nested worker from inside the download worker, and copy every packet across a second message boundary.
- **Prebuilt npm variants (`@libav.js/variant-*`).** None has the §8 component list; the variants with MPEG-TS or AAC are not published.
- **Building in CI on every build, or in `postinstall`.** It makes Docker and a 3 GB image a requirement for every contributor and every CI run, for output that changes only when the pins change.
- **Bundling the factory through Vite.** Emscripten's module locates its WASM and environment itself; bundling would also merge LGPL code into Servare's bundle instead of keeping it a separately replaceable file.
- **Threaded (`thr`) build.** It needs `SharedArrayBuffer` (cross-origin isolation) and only speeds up codecs; remux is I/O-bound.

**Not verified:** Firefox 140 ESR (minimum version) and Firefox for Android; packaged (signed) installs; reproducibility on a machine other than the one used for the three builds (the CI check covers it); streaming input through block reader devices (Asyncify) in the worker, which arrives with the remux pipeline (#22); AMO's handling of the WASM in review (the build script and `vendor/libav/` are the source it asks for).

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

---

## 11. Supply chain and releases

- **CI:** every action is pinned to a full commit SHA (`@<sha> # vX.Y.Z`); `zizmor` audits the workflows on every PR; the repository requires SHA pinning.
- **Dependencies:** the lockfile is always installed with `--frozen-lockfile`; Dependabot waits 7 days (`cooldown`) before adopting a new version, so a malicious release has time to be reported and removed. Security updates are not delayed.
- **Release workflow:** publishing happens in a **separate job that does not build**. It receives the finished `.zip`/`.xpi` as an artifact, verifies its checksum, and publishes. Store keys (AMO, Chrome Web Store) live only as secrets of a protected GitHub `environment` with required manual approval, and are never available to jobs that build or run third-party actions (the publish job may use GitHub-owned actions pinned by SHA, or plain `run:` steps).
- **Store accounts:** the maintainer checklist in issue #69 must be confirmed before the first publication.
- **LGPL sources (§8):** every release attaches the exact source archives the shipped libav.js build came from (libav.js at its pinned commit, FFmpeg, LAME, emfiberthreads, each matching the SHA-256 in `vendor/libav/`), produced by `vendor/libav/build.sh --sources`. The AMO source submission includes `vendor/libav/` with its build instructions.
