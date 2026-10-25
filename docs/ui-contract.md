# Servare — UI Contract

> Status: draft for review · Source of truth for the types: [`src/messaging/schemas.ts`](../src/messaging/schemas.ts) and [`src/messaging/protocol.ts`](../src/messaging/protocol.ts) · Design: [design.md](design.md) §2.5

The UI (popup, options page, any future surface) is designed separately. This document is everything it may rely on: which requests it can send, which events it receives, which states a job goes through and which errors it must be able to show. The UI never reads extension storage or page state directly.

Entries carry one of three markers:

- **implemented** — the background has a handler (or emits the event) today.
- **schema only (#N)** — the schema is in `protocol.ts` but the background does not handle it yet: it answers `unknown-request` until issue #N lands.
- **planned (#N)** — not in `protocol.ts` yet; issue #N adds schema and handler.

The shapes below are frozen by this document for schema-only and planned entries: changing one is a design change. A UI built before #N lands must treat `unknown-request` as "feature not available".

## 1. Transport

- The UI opens a `runtime.Port` to the background and talks through `src/messaging` (`PortClient`). Only extension pages are served; content scripts and web pages are disconnected.
- **Request/response.** Every request has a name, a payload and a typed response. Payloads are validated with zod on both sides; defaults (e.g. `mode: 'video'`) are applied by the receiver.
- **Events.** The background pushes events to every connected port. Events carry full state for the thing that changed (no deltas), so a UI can render from the latest event alone.
- **Reconnection.** The background is suspendable (design §2.3). The port disconnects when it stops; `PortClient` reconnects by itself with backoff while the UI listens for events. The UI **must re-fetch** (`media/list`, `download/list`) inside the client's `onReconnect` hook, because events sent while disconnected are lost.
- **Failures** of any request are a `MessagingError` with one of these codes:

| Code               | Meaning                                     | UI behavior                                                                   |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `invalid-message`  | Not a valid envelope                        | Bug; show generic error                                                       |
| `unknown-request`  | No handler (e.g. feature not shipped yet)   | Hide or disable the feature                                                   |
| `invalid-payload`  | Payload failed the schema                   | Bug; show generic error                                                       |
| `invalid-response` | The handler returned something off-schema   | Bug; show generic error                                                       |
| `handler-failed`   | The handler threw; `message` has the reason | Show `message` as a notice                                                    |
| `disconnected`     | Port closed while the request was in flight | Retry once if the request is idempotent (see below); otherwise re-fetch first |
| `timeout`          | No answer in time                           | Reconnect, re-fetch, then offer retry                                         |

**Retrying.** `disconnected` and `timeout` do not say whether the background already ran the request. Automatic retry is safe only for idempotent requests: `*/list`, `*/get`, `download/pause`, `download/resume`, `download/cancel`, `download/stop`, `download/remove`. After a failure of `download/enqueue` or `download/retry`, the UI re-fetches `download/list` and offers the action again only if no matching new job appeared.

A request failure is distinct from a **job failure**: the latter is reported through `DownloadJob.error` (§2.3).

## 2. Data types

Authoritative definitions are in `schemas.ts`; the shapes are repeated here for reading convenience.

### 2.1 `MediaItem`

One detected piece of media in a tab.

| Field         | Type                          | Notes                                                                     |
| ------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `id`          | `string`                      | Stable while the item is in the list; derived from the normalized URL     |
| `tabId`       | `number`                      |                                                                           |
| `kind`        | `'direct' \| 'hls' \| 'dash'` |                                                                           |
| `url`         | `string` (http/https)         | The media or manifest URL                                                 |
| `pageUrl`     | `string` (http/https)         |                                                                           |
| `title`       | `string` (≤ 1024)             | Page title or best available; may be empty                                |
| `thumbnail`   | `string?`                     | http(s) URL or `data:image/…`; absent when the page offers none           |
| `duration`    | `number \| 'live'`            | Seconds. `0` = unknown (direct files before a probe). `'live'` = HLS live |
| `variants`    | `Variant[]`                   | Empty for direct files and until a manifest is parsed                     |
| `audioTracks` | `Track[]`                     | Alternate audio. Appears later via `tracks/updated`                       |
| `subtitles`   | `Track[]`                     | Embedded/standalone subtitles                                             |
| `protected`   | `boolean`                     | DRM detected. Show as unavailable; **never** enqueue (see §6)             |
| `detectedAt`  | `number`                      | ms since epoch                                                            |

`Variant` = `{ id, width?, height?, bandwidth?, codecs?, container }`. `Track` = `{ id, language?, label?, codecs? }` (`language` is a BCP 47 tag when the source gives one). Any optional field may be missing; the UI must have a fallback label (e.g. "Variant 2").

```json
{
  "id": "m_7f3a",
  "tabId": 42,
  "kind": "hls",
  "url": "https://cdn.example.com/v/master.m3u8",
  "pageUrl": "https://example.com/watch/123",
  "title": "Sample video",
  "thumbnail": "https://example.com/p/123.jpg",
  "duration": 1834.2,
  "variants": [
    {
      "id": "v0",
      "width": 1920,
      "height": 1080,
      "bandwidth": 5000000,
      "codecs": "avc1.640028,mp4a.40.2",
      "container": "mp4"
    },
    {
      "id": "v1",
      "width": 1280,
      "height": 720,
      "bandwidth": 2800000,
      "codecs": "avc1.4d401f,mp4a.40.2",
      "container": "mp4"
    }
  ],
  "audioTracks": [{ "id": "a0", "language": "pt-BR", "label": "Português" }],
  "subtitles": [{ "id": "s0", "language": "en", "label": "English" }],
  "protected": false,
  "detectedAt": 1761400000000
}
```

### 2.2 `DownloadJob`

| Field           | Type                              | Notes                                                               |
| --------------- | --------------------------------- | ------------------------------------------------------------------- |
| `id`            | `string`                          |                                                                     |
| `mediaId`       | `string`                          | May no longer be in the tab list (tab navigated)                    |
| `variantId`     | `string?`                         | Absent = default variant (direct files, audio-only)                 |
| `audioTrackIds` | `string[]`                        | Extra audio tracks muxed into the output                            |
| `subtitleIds`   | `string[]`                        | Subtitle tracks to embed or save                                    |
| `mode`          | `'video' \| 'audio'`              | `'audio'` = MP3 extraction (#30)                                    |
| `status`        | see §3                            |                                                                     |
| `progress`      | `number (0–1) \| 'indeterminate'` | `'indeterminate'` for live and when the size is unknown             |
| `bytesWritten`  | `number`                          | Bytes written to the temporary file so far                          |
| `error`         | `DownloadError?`                  | Present only when `status` is `failed` or `cancelled`               |
| `outputName`    | `string` (≤ 255)                  | Final file name (after template and sanitization, §7 of the design) |
| `waiting`       | `{ reason, blockingJobId? }?`     | **Planned (#25).** Only on `queued`; see §3.2                       |

```json
{
  "id": "j_19c2",
  "mediaId": "m_7f3a",
  "variantId": "v0",
  "audioTrackIds": ["a0"],
  "subtitleIds": ["s0"],
  "mode": "video",
  "status": "running",
  "progress": 0.42,
  "bytesWritten": 183500800,
  "outputName": "Sample video.mp4"
}
```

### 2.3 `DownloadError`

Discriminated on `kind`. The UI maps each to a message and, where listed, an action.

| `kind`       | Extra fields      | Meaning                                              | Suggested action                                                       |
| ------------ | ----------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `cancelled`  | —                 | The user cancelled                                   | None                                                                   |
| `http`       | `status: number`  | A request was refused or failed after retries        | On `401`/`403`: "reopen the page and play the media again", then retry |
| `incomplete` | `ratio: 0–1`      | Output shorter than expected (< 97%, design §4.8)    | Offer retry; show the percentage                                       |
| `decrypt`    | —                 | AES-128 key unavailable or segment failed to decrypt | Offer retry                                                            |
| `quota`      | —                 | Not enough storage for the temporary file            | Tell the user to free disk space                                       |
| `protected`  | —                 | Protected content (design §3.4)                      | None; explain Servare does not handle protected media                  |
| `unknown`    | `message: string` | Anything else                                        | Show `message`; offer retry                                            |

## 3. `DownloadJob` states and transitions

### 3.1 States

| Status      | Terminal | Meaning                                                                                        |
| ----------- | -------- | ---------------------------------------------------------------------------------------------- |
| `queued`    | no       | Accepted, waiting for a blocking condition                                                     |
| `running`   | no       | Data is being fetched and written                                                              |
| `paused`    | no       | Stopped by the user (or by the host tab closing on Firefox); progress persisted                |
| `done`      | yes      | File delivered to the browser's download manager                                               |
| `failed`    | yes*     | Ended with `error`. *Retry creates a new job from the same parameters (§4.2, `download/retry`) |
| `cancelled` | yes      | Ended by the user; the temporary file is deleted                                               |

```
              enqueue
                 │
                 ▼
   ┌──────── queued ◄───────────────────────┐
   │           │  ▲                         │
   │  no block │  │ browser restart,        │ resume
   │           │  │ header conflict (§3.2)  │
   │           ▼  │                         │
   │        running ──── pause ───────► paused
   │         │  │  │                        │
   │         │  │  └── all data written ──► done
   │         │  └───── error ─────────────► failed
   │         │                              │
   └── cancel (from queued, running or paused) ──► cancelled
```

| From      | To          | Trigger                                                                                                                                                                      |
| --------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(new)_   | `queued`    | `download/enqueue`                                                                                                                                                           |
| `queued`  | `running`   | No blocking condition holds                                                                                                                                                  |
| `queued`  | `cancelled` | `download/cancel`                                                                                                                                                            |
| `running` | `paused`    | `download/pause`; or Firefox host tab closed (design §2.3; planned with #25, today such jobs fail with `unknown`)                                                            |
| `running` | `done`      | Output validated and delivered; or `download/stop` on a live job (planned, #28)                                                                                              |
| `running` | `failed`    | Error (§2.3).                                                                                                                                                                |
| `running` | `queued`    | Browser restart (design §4.10); or header conflict mid-job (§3.2)                                                                                                            |
| `running` | `cancelled` | `download/cancel`                                                                                                                                                            |
| `paused`  | `queued`    | `download/resume` (it passes through `queued` so the header conflict check applies). A job paused because its Firefox host tab closed resumes the same way, never on its own |
| `paused`  | `done`      | `download/stop` on a live job: deliver what was recorded (planned, #28)                                                                                                      |
| `paused`  | `cancelled` | `download/cancel`                                                                                                                                                            |

At browser restart, a **private-window** job in any non-terminal status (`queued`, `running` or `paused`) moves to `failed` with an `unknown` error whose message asks the user to reopen the page (design §4.10). Regular jobs follow the rows above.

No other transition exists. `done`, `failed` and `cancelled` never change again. Every transition emits `job/updated`.

### 3.2 Waiting reason (planned, #25)

A `queued` job may carry `waiting`, explaining why it is not running:

| `reason`          | Extra field     | Meaning                                                                                                                                    |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `header-conflict` | `blockingJobId` | Another running job needs different headers for the same origin (design §4.1.1). Typical for a live job that holds its origin indefinitely |

For `header-conflict` the UI should explain it and may offer to end the blocking job: `download/stop` when it is a live recording (keeps what was recorded), otherwise `download/pause` or `download/cancel`. `waiting` is cleared when the job leaves `queued`.

### 3.3 Progress rules

- `progress` is monotonic within one run; it may restart from the persisted value after a resume.
- `'indeterminate'` for live recordings and for sources with unknown size. `bytesWritten` is always meaningful.
- Progress events are throttled; do not assume a fixed rate, and treat `bytesWritten` as the source for speed/ETA computed in the UI.

## 4. Requests

All requests are sent by the UI to the background. Errors per §1.

### 4.1 Media

| Name         | Status        | Request     | Response                               |
| ------------ | ------------- | ----------- | -------------------------------------- |
| `media/list` | implemented   | `{ tabId }` | `MediaItem[]`                          |
| `media/scan` | planned (#31) | `{ tabId }` | `{ found: number, blobOnly: boolean }` |

`media/list` returns the tab's current list, already deduplicated and with fragments hidden (design §3.5). Items are ordered oldest first.

`media/scan` is the manual "scan this page" action. It inspects `<video>`/`<source>` and reports the outcome; new items arrive through `media/updated`. `blobOnly: true` means the player uses a `blob:` URL (MSE) and no manifest was seen: the UI should explain that the page streams in a way Servare cannot capture on its own.

```json
{ "name": "media/list", "payload": { "tabId": 42 } }
```

### 4.2 Downloads

| Name               | Status            | Request                                                                                      | Response                      |
| ------------------ | ----------------- | -------------------------------------------------------------------------------------------- | ----------------------------- |
| `download/enqueue` | schema only (#25) | `{ mediaId, variantId?, audioTrackIds = [], subtitleIds = [], mode = 'video', outputName? }` | `DownloadJob`                 |
| `download/pause`   | schema only (#25) | `{ jobId }`                                                                                  | `null`                        |
| `download/resume`  | schema only (#25) | `{ jobId }`                                                                                  | `null`                        |
| `download/cancel`  | implemented       | `{ jobId }`                                                                                  | `null`                        |
| `download/list`    | schema only (#25) | `{}`                                                                                         | `DownloadJob[]`               |
| `download/retry`   | planned (#25)     | `{ jobId }`                                                                                  | `DownloadJob` (a **new** job) |
| `download/remove`  | planned (#25)     | `{ jobId }` (terminal jobs only)                                                             | `null`                        |
| `download/stop`    | planned (#28)     | `{ jobId }` (live media; `running` or `paused`)                                              | `null`                        |

Rules:

- `download/enqueue` fails with `handler-failed` when the item is `protected`, when `mediaId` is unknown, or when `variantId`/track IDs do not belong to the item. `outputName`, when present, replaces the template result and is sanitized anyway.
- `mode: 'audio'` ignores `variantId` and `subtitleIds`. `audioTrackIds` then selects the source track (first entry); when empty, the media's default audio is used.
- `pause`/`resume` on a job whose status does not allow the transition (§3.1) fail with `handler-failed`; they succeed as a no-op when the job is already in the target status. `cancel` on a job that is terminal or unknown succeeds as a no-op (it is the idempotent "make sure this is gone").
- `download/stop` is valid only for live media, from `running` or `paused`: the job finishes the current segment, validates, delivers what was recorded and ends as `done`. `download/cancel` discards instead.
- `download/retry` is valid for `failed` jobs and creates a new job with the same parameters; the old job stays as history until removed.

`download/start-direct` exists today as a temporary development entry point and is **not** part of the UI contract; it is removed when `download/enqueue` is handled (#25).

```json
{
  "name": "download/enqueue",
  "payload": {
    "mediaId": "m_7f3a",
    "variantId": "v0",
    "audioTrackIds": ["a0"],
    "subtitleIds": ["s0"]
  }
}
```

### 4.3 History

Planned (#15). History respects private windows: private jobs never appear in it (design principle 4).

| Name             | Request              | Response         |
| ---------------- | -------------------- | ---------------- |
| `history/list`   | `{ limit?: number }` | `HistoryEntry[]` |
| `history/remove` | `{ entryId }`        | `null`           |
| `history/clear`  | `{}`                 | `null`           |

`HistoryEntry` = `{ id, title, pageUrl, outputName, kind, completedAt, bytes, status: 'done' | 'failed' }`.

### 4.4 Rules and settings

Planned (#34, the options page; M5). Until then M1–M4 behavior is driven by built-in defaults and the bundled `default-rules.json` (#14), and the popup has no settings to edit. Rules are the per-domain schema of design §6; they are validated in the background and never fetched remotely.

| Name           | Request                        | Response                                              |
| -------------- | ------------------------------ | ----------------------------------------------------- |
| `rules/get`    | `{}`                           | `{ version: 1, domains: Record<string, DomainRule> }` |
| `rules/set`    | `{ domain, rule: DomainRule }` | `null`                                                |
| `rules/remove` | `{ domain }`                   | `null`                                                |
| `settings/get` | `{}`                           | `Settings`                                            |
| `settings/set` | `Partial<Settings>`            | `Settings`                                            |

`DomainRule` has exactly the keys and types of design §6: `detection: boolean`, `minDirectSize: number` (bytes), `propagateQuery: boolean`, `audioOnly: boolean`, `feedMode: boolean`, `hideFragments: boolean`, `speedProfile: 'economy' | 'standard' | 'fast'`; every key is optional and falls back to the default.

`Settings`:

| Field                | Type                                | Default      | Notes                                             |
| -------------------- | ----------------------------------- | ------------ | ------------------------------------------------- |
| `nameTemplate`       | `string`                            | `{title}`    | Variables from design §7                          |
| `subfolder`          | `string`                            | `''`         | Empty = downloads folder root; sanitized per §7   |
| `saveAs`             | `boolean`                           | `false`      | Ask for the location on delivery                  |
| `speedProfile`       | `'economy' \| 'standard' \| 'fast'` | `'standard'` | Global default; a `DomainRule` overrides it       |
| `mp3Quality`         | `number` (LAME VBR 0–9, 0 best)     | `2`          | Used by `mode: 'audio'`                           |
| `failureThreshold`   | `number` (0–1)                      | `0.2`        | Share of failed segments that aborts a job (§4.8) |
| `preferredLanguages` | `string[]` (BCP 47)                 | `[]`         | Pre-selects matching audio and subtitle tracks    |

`rules/set` and `settings/set` fail with `invalid-payload` on schema violations; the UI should surface the issue paths.

### 4.5 Internal requests (not for the UI)

`delivery/*` and `worker/*` connect the background and the worker host. A UI must not send them.

## 5. Events

Pushed to every connected port. Names and payloads are final.

| Name               | Status            | Payload                             | When                                                                                   |
| ------------------ | ----------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `media/updated`    | implemented       | `{ tabId, items: MediaItem[] }`     | A tab's list changed (added, removed, cleared on navigation). `items` is the full list |
| `tracks/updated`   | schema only (#23) | `{ mediaId, audioTracks: Track[] }` | Alternate audio tracks became known after the manifest was parsed                      |
| `job/updated`      | implemented       | `{ job: DownloadJob }`              | Any change to a job: status, progress, `bytesWritten`, error, `waiting`                |
| `job/removed`      | planned (#25)     | `{ jobId }`                         | A terminal job was removed                                                             |
| `history/updated`  | planned (#15)     | `{ entries: HistoryEntry[] }`       | History changed                                                                        |
| `settings/updated` | planned (#34)     | `{ settings: Settings }`            | Settings or rules changed (e.g. from another page)                                     |

Ordering: events for the same job arrive in order. `job/updated` for a terminal status is always the last one for that job.

## 6. Protected and unavailable media

- `protected: true` items appear in `media/list` so the UI can tell the user why nothing is offered. `download/enqueue` for them fails with `handler-failed`. Servare has no code path to download protected content (design §1.2, §3.4).
- A `DownloadError` of kind `protected` can still appear on a job when protection is found only after the download started (e.g. a key response); the UI treats it the same way.

## 7. Coverage by milestone

Every user action planned through M4 and how the UI performs it:

| Action                                         | Milestone | Mechanism                                                                                       |
| ---------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| See media detected in the current tab          | M1        | `media/list` + `media/updated`                                                                  |
| Download a direct file                         | M1        | Dev-only `download/start-direct` (temporary popup, #16); `download/enqueue` arrives in M2 (#25) |
| Name the output                                | M1        | `outputName` (the template itself is configured in M5 via `Settings.nameTemplate`)              |
| Per-domain behavior (disable, min size, speed) | M1        | Bundled defaults (#14); editing is M5 via `rules/*`                                             |
| See past downloads                             | M1        | `history/*` + `history/updated`                                                                 |
| Cancel a download                              | M1        | `download/cancel`                                                                               |
| Choose a quality (HLS)                         | M2        | `variantId` from `MediaItem.variants`                                                           |
| Choose alternate audio tracks                  | M2        | `audioTrackIds` from `MediaItem.audioTracks`                                                    |
| See that content is protected                  | M2        | `MediaItem.protected`, `DownloadError.protected`                                                |
| Pause / resume / survive a restart             | M2        | `download/pause`, `download/resume`, §3.1                                                       |
| Understand why a job is waiting                | M2        | `DownloadJob.waiting`                                                                           |
| Retry a failed download                        | M2        | `download/retry`                                                                                |
| Understand a failure                           | M2        | `DownloadJob.error` (§2.3)                                                                      |
| Choose quality (DASH), separate video + audio  | M3        | Same as HLS: `variants`, `audioTracks`                                                          |
| Record a live stream, stop it                  | M4        | `duration: 'live'`, `progress: 'indeterminate'`; stop with `download/stop` (see note below)     |
| Include or save subtitles                      | M4        | `subtitleIds`                                                                                   |
| Extract audio as MP3                           | M4        | `mode: 'audio'`                                                                                 |
| Scan the page manually / explain MSE           | M4        | `media/scan`                                                                                    |

**Stopping a live recording.** Ending a live job normally must keep what was recorded, while `cancel` deletes it; hence `download/stop` (§4.2).

## 8. Versioning

The contract follows `docs/design.md`. Adding an optional field, a request, an event or a `DownloadError` kind is backwards compatible; the UI must ignore unknown fields and treat an unknown `error.kind` as `unknown`. Removing or retyping anything requires a design change.
