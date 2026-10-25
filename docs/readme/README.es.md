# Servare

[![CI](https://github.com/dk-1ng/servare/actions/workflows/ci.yml/badge.svg)](https://github.com/dk-1ng/servare/actions/workflows/ci.yml)

[English](../../README.md) · [Português (BR)](README.pt-BR.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

> Esta es una traducción. En caso de discrepancia, prevalece la [versión en inglés](../../README.md).

Extensión para Firefox y Chromium que detecta los vídeos y audios cargados por la página y permite guardarlos localmente — archivos directos, HLS y DASH — con todo el procesamiento dentro del navegador.

> **Estado:** en desarrollo (pre-alfa). Sigue el progreso en el [tablero del proyecto](https://github.com/users/dk-1ng/projects/4) y en los [milestones](https://github.com/dk-1ng/servare/milestones).

## Funcionalidades previstas

- Detección automática de medios observando las peticiones de red de la página
- Archivos directos (MP4, WebM, MKV, MP3…), HLS y DASH
- Selección de calidad, pista de audio y subtítulos
- Grabación de transmisiones en directo (HLS)
- Extracción de audio a MP3
- Cola con pausa y reanudación, incluso tras reiniciar el navegador
- Remux local con FFmpeg compilado a WebAssembly — sin aplicación nativa, sin servidor, sin telemetría
- Modo espejo (Firefox): reutiliza los datos que el reproductor ya descargó, sin peticiones adicionales

## Fuera de alcance

- **YouTube** — no soportado, por decisión de diseño.
- **Contenido con DRM** (Widevine, PlayReady, FairPlay, etc.) — se detecta y se rechaza. Servare no contiene ni aceptará código que eluda DRM, inicios de sesión, muros de pago ni ninguna otra medida de protección técnica.

## Desarrollo

Requisitos: Node.js LTS, pnpm, FFmpeg (para generar los fixtures de prueba).

```sh
pnpm install
pnpm dev            # Chromium con recarga automática
pnpm dev:firefox    # Firefox
pnpm test           # pruebas unitarias
pnpm build          # paquetes de producción para ambos navegadores
```

Documentación técnica (en inglés): [docs/design.md](../design.md). Cómo contribuir: [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Aviso legal

Servare es una herramienta de uso general para guardar medios que tu navegador ya recibe. **Eres el único responsable del uso que hagas de ella.** Descarga solo contenido que tengas derecho a descargar — contenido propio, bajo licencia libre, de dominio público o con permiso del titular — y respeta las leyes de derechos de autor de tu país y los términos de uso de cada sitio.

Este proyecto no está afiliado, patrocinado ni respaldado por ningún sitio web, servicio de streaming ni otra extensión. Los nombres y marcas de terceros pertenecen a sus respectivos dueños.

El software se proporciona "tal cual", sin garantías, bajo la [licencia MIT](../../LICENSE).

## Licencia

[MIT](../../LICENSE). Los componentes de terceros (como libav.js/FFmpeg y LAME, bajo LGPL-2.1) conservan sus propias licencias, listadas en `THIRD_PARTY_NOTICES.md`.
