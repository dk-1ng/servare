# Servare

**English** · [Português (BR)](docs/readme/README.pt-BR.md) · [Español](docs/readme/README.es.md) · [Français](docs/readme/README.fr.md) · [Deutsch](docs/readme/README.de.md) · [Русский](docs/readme/README.ru.md) · [简体中文](docs/readme/README.zh-CN.md) · [日本語](docs/readme/README.ja.md)

A Firefox and Chromium extension that detects video and audio loaded by the page and lets you save it locally — direct files, HLS and DASH — with all processing done inside the browser.

> **Status:** in development (pre-alpha). Follow progress on the [project board](https://github.com/users/dk-1ng/projects/4) and the [milestones](../../milestones).

## Planned features

- Automatic media detection by observing the page's network requests
- Direct files (MP4, WebM, MKV, MP3…), HLS and DASH
- Quality, audio track and subtitle selection
- Live stream recording (HLS)
- Audio extraction to MP3
- Queue with pause and resume, even after restarting the browser
- Local remuxing with FFmpeg compiled to WebAssembly — no native app, no server, no telemetry
- Mirror mode (Firefox): reuses the data the player has already downloaded, with no extra requests

## Out of scope

- **YouTube** — not supported, by design.
- **DRM-protected content** (Widevine, PlayReady, FairPlay, etc.) — detected and refused. Servare does not contain, and will not accept, code that circumvents DRM, logins, paywalls or any other technical protection measure.

## Development

Requirements: Node.js LTS, pnpm, FFmpeg (to generate test fixtures).

```sh
pnpm install
pnpm dev            # Chromium with live reload
pnpm dev:firefox    # Firefox
pnpm test           # unit tests
pnpm build          # production packages for both browsers
```

Technical documentation: [docs/design.md](docs/design.md). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md).

## Legal notice

Servare is a general-purpose tool for saving media that your browser already receives. **You are solely responsible for how you use it.** Only download content you have the right to download — your own content, content under a free license, in the public domain, or with the rights holder's permission — and respect the copyright laws of your country and each website's terms of service.

This project is not affiliated with, sponsored by or endorsed by any website, streaming service or other extension. Third-party names and trademarks belong to their respective owners.

The software is provided "as is", without warranty of any kind, under the [MIT license](LICENSE).

## License

[MIT](LICENSE). Third-party components (such as libav.js/FFmpeg and LAME, under LGPL-2.1) keep their own licenses, listed in `THIRD_PARTY_NOTICES.md`.
