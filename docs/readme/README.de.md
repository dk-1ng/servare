# Servare

[![CI](https://github.com/dk-1ng/servare/actions/workflows/ci.yml/badge.svg)](https://github.com/dk-1ng/servare/actions/workflows/ci.yml)

[English](../../README.md) · [Português (BR)](README.pt-BR.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

> Dies ist eine Übersetzung. Im Zweifel gilt die [englische Fassung](../../README.md).

Eine Erweiterung für Firefox und Chromium, die von der Seite geladene Video- und Audiodateien erkennt und lokal speichern lässt — direkte Dateien, HLS und DASH — wobei die gesamte Verarbeitung im Browser stattfindet.

> **Status:** in Entwicklung (Pre-Alpha). Den Fortschritt gibt es auf dem [Projekt-Board](https://github.com/users/dk-1ng/projects/4) und in den [Milestones](https://github.com/dk-1ng/servare/milestones).

## Geplante Funktionen

- Automatische Medienerkennung durch Beobachtung der Netzwerkanfragen der Seite
- Direkte Dateien (MP4, WebM, MKV, MP3…), HLS und DASH
- Auswahl von Qualität, Audiospur und Untertiteln
- Aufnahme von Livestreams (HLS)
- Audioextraktion als MP3
- Warteschlange mit Pause und Fortsetzen, auch nach einem Browser-Neustart
- Lokales Remuxen mit nach WebAssembly kompiliertem FFmpeg — keine native App, kein Server, keine Telemetrie
- Spiegelmodus (Firefox): nutzt die Daten, die der Player bereits geladen hat, ohne zusätzliche Anfragen

## Nicht im Umfang

- **YouTube** — bewusst nicht unterstützt.
- **DRM-geschützte Inhalte** (Widevine, PlayReady, FairPlay usw.) — werden erkannt und abgelehnt. Servare enthält keinen Code zur Umgehung von DRM, Logins, Paywalls oder anderen technischen Schutzmaßnahmen und wird solchen Code nicht aufnehmen.

## Entwicklung

Voraussetzungen: Node.js LTS, pnpm, FFmpeg (zum Erzeugen der Test-Fixtures).

```sh
pnpm install
pnpm dev            # Chromium mit Live-Reload
pnpm dev:firefox    # Firefox
pnpm test           # Unit-Tests
pnpm build          # Produktionspakete für beide Browser
```

Technische Dokumentation (auf Englisch): [docs/design.md](../design.md). Mitwirken: [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Rechtlicher Hinweis

Servare ist ein Allzweckwerkzeug zum Speichern von Medien, die Ihr Browser ohnehin empfängt. **Sie allein sind für die Nutzung verantwortlich.** Laden Sie nur Inhalte herunter, zu deren Download Sie berechtigt sind — eigene Inhalte, frei lizenzierte oder gemeinfreie Inhalte oder solche mit Erlaubnis des Rechteinhabers — und beachten Sie das Urheberrecht Ihres Landes sowie die Nutzungsbedingungen der jeweiligen Website.

Dieses Projekt steht in keiner Verbindung zu Websites, Streamingdiensten oder anderen Erweiterungen und wird von diesen weder gesponsert noch unterstützt. Namen und Marken Dritter gehören ihren jeweiligen Inhabern.

Die Software wird „wie besehen“ und ohne Gewährleistung unter der [MIT-Lizenz](../../LICENSE) bereitgestellt.

## Lizenz

[MIT](../../LICENSE). Komponenten Dritter (wie libav.js/FFmpeg und LAME unter LGPL-2.1) behalten ihre eigenen Lizenzen, aufgeführt in `THIRD_PARTY_NOTICES.md`.
