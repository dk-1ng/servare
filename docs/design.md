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
- Offscreen documents only get `runtime` APIs, so the host cannot use `downloads`. The host creates the blob URL and sends it to the background. The background calls `downloads.download` and watches `downloads.onChanged` (which also wakes it). When the download completes or is interrupted, the background tells the host to revoke the URL; once no jobs are running or awaiting delivery, it closes the host (`offscreen.closeDocument` / `tabs.remove`). The blob URL must outlive the download.

**Messaging between host and background (implemented in #6):**

- Host → background (`delivery/deliver`, `worker/failed`): `PortClient` over `runtime.connect`, reconnecting on demand.
- Background → host (`worker/start`, `delivery/release`): the same request envelopes over `runtime.sendMessage` (`src/messaging/runtime.ts`). A port cannot carry these: it is gone whenever the background was suspended, which is exactly when `downloads.onChanged` wakes it to release a blob URL. `worker/start` is retried for a few seconds because a freshly created host is not listening yet. Hosts only answer senders from the extension's own origin.
- A host owns no job when it starts, and blob URLs die with their page, so at start it deletes every temporary OPFS file (`cleanupOrphans` with an empty keep set) before accepting jobs.
- If `delivery/deliver` throws, the host revokes the blob URL, deletes the OPFS file and reports `worker/failed`.
- The download worker bundle must not depend on zod (its `new Function` probe trips `web-ext lint`); it uses the plain types in `src/download/worker-messages.ts`.
- `download/start-direct` is a temporary trigger for development and E2E, replaced by the real enqueue flow in #25. It takes an optional `tabId`: the header rules of §4.1.1 are built from that tab's captured headers for the file's exact origin. Also host-bound: `worker/cancel` (background → host, aborts the job; the worker deletes its file and reports `cancelled`) and `worker/progress` (host → background, throttled to 4 per second per job).
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
- **Implemented in #10 (`src/detection/tab-list.ts`, `normalize.ts`, `page-meta.ts`):** entries are keyed by the URL without fragment or volatile parameters (tokens, signatures, expiry stamps, `X-Amz-*`/`X-Goog-*`) and with the rest sorted; the latest URL wins, since its token is freshest. With a manifest in the tab, direct files known to be under 10 MiB are hidden (unknown size stays visible). Regular tabs are mirrored to `storage.session`; **private tabs live only in memory** and are lost if the background is suspended. Whether a tab is private comes from `tabs.get`, not `webRequest`. The content script (top frame, read-only) answers a background request with title, `og:image` or `video[poster]`; only http(s) thumbnails are kept. Direct files have `duration: 0` until a probe exists. A detection that began before a clear is discarded (per-tab generation counter). Titles are clamped and oversized URLs dropped. Hiding standalone media playlists waits on manifest parsing (#18).
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
