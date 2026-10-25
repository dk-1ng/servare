# Contributing to Servare

Thanks for your interest! This guide explains how the project is organized and what is expected from every contribution.

## Original code policy (mandatory)

To keep the project legally clean:

- **All code must be original** or come from dependencies under a license compatible with MIT (or LGPL, when isolated as a separate library), declared in `THIRD_PARTY_NOTICES.md`.
- **Do not submit code copied, adapted or derived from proprietary software**, including code that was decompiled, deobfuscated or extracted from other extensions, apps or players.
- Work from public specifications (RFC 8216, ISO/IEC 23009-1, MDN, FFmpeg and WebExtensions documentation).
- By opening a pull request you confirm, through the template checklist, that you have the right to contribute the code under the MIT license.

## Scope

Contributions that do any of the following will not be accepted:

- add YouTube support;
- circumvent DRM, logins, paywalls, captchas or any technical protection measure;
- inject or modify JavaScript/DOM on visited pages;
- send data to external servers (telemetry, analytics, remote rules).

## Workflow

1. Pick an issue (or open one describing the proposal) and comment that you are working on it.
2. Branch off `main`: `feat/<issue>-short-description`, `fix/...`, `chore/...`, `docs/...`.
3. Commits follow [Conventional Commits](https://www.conventionalcommits.org/), in English, imperative mood:
   ```
   feat(detection): add MIME type classifier
   fix(hls): correct IV derivation for high sequence numbers
   ```
   Common scopes: `detection`, `hls`, `dash`, `download`, `media`, `net`, `ui`, `platform`, `rules`, `ci`, `docs`.
4. Open the PR referencing the issue (`Closes #N`) and fill in the template.
5. CI must pass: lint, typecheck, tests and builds for Firefox and Chromium.

## Code standards

- Strict TypeScript; no implicit `any`.
- Browser differences live in `src/platform/`.
- Data crossing contexts (background, worker, UI) goes through zod schemas in `src/messaging/`.
- Tests sit next to the behavior: parsers and pure utilities require unit tests.
- Media fixtures are **generated locally** (`test/fixtures/make.sh`); do not add third-party video or audio to the repository.
- When a change to the README affects user-facing information, update the translations in `docs/readme/` too (or open an issue for them).

## Reporting problems

Use the issue templates. When reporting a site that does not work, describe the media type and the behavior — avoid links to copyrighted content.
