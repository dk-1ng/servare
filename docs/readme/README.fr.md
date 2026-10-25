# Servare

[![CI](https://github.com/dk-1ng/servare/actions/workflows/ci.yml/badge.svg)](https://github.com/dk-1ng/servare/actions/workflows/ci.yml)

[English](../../README.md) · [Português (BR)](README.pt-BR.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

> Ceci est une traduction. En cas de divergence, la [version anglaise](../../README.md) fait foi.

Extension pour Firefox et Chromium qui détecte les vidéos et les fichiers audio chargés par la page et permet de les enregistrer localement — fichiers directs, HLS et DASH — avec tout le traitement effectué dans le navigateur.

> **Statut :** en développement (pré-alpha). Suivez l'avancement sur le [tableau du projet](https://github.com/users/dk-1ng/projects/4) et les [milestones](https://github.com/dk-1ng/servare/milestones).

## Fonctionnalités prévues

- Détection automatique des médias en observant les requêtes réseau de la page
- Fichiers directs (MP4, WebM, MKV, MP3…), HLS et DASH
- Choix de la qualité, de la piste audio et des sous-titres
- Enregistrement des diffusions en direct (HLS)
- Extraction de l'audio en MP3
- File d'attente avec pause et reprise, même après redémarrage du navigateur
- Remux local avec FFmpeg compilé en WebAssembly — sans application native, sans serveur, sans télémétrie
- Mode miroir (Firefox) : réutilise les données déjà téléchargées par le lecteur, sans requête supplémentaire

## Hors périmètre

- **YouTube** — non pris en charge, par choix de conception.
- **Contenu protégé par DRM** (Widevine, PlayReady, FairPlay, etc.) — détecté et refusé. Servare ne contient pas, et n'acceptera pas, de code contournant les DRM, les connexions, les paywalls ou toute autre mesure de protection technique.

## Développement

Prérequis : Node.js LTS, pnpm, FFmpeg (pour générer les fixtures de test).

```sh
pnpm install
pnpm dev            # Chromium avec rechargement automatique
pnpm dev:firefox    # Firefox
pnpm test           # tests unitaires
pnpm build          # paquets de production pour les deux navigateurs
```

Documentation technique (en anglais) : [docs/design.md](../design.md). Contribuer : [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Mentions légales

Servare est un outil généraliste permettant d'enregistrer des médias que votre navigateur reçoit déjà. **Vous êtes seul responsable de l'usage que vous en faites.** Ne téléchargez que du contenu que vous avez le droit de télécharger — votre propre contenu, du contenu sous licence libre, du domaine public ou autorisé par l'ayant droit — et respectez les lois sur le droit d'auteur de votre pays ainsi que les conditions d'utilisation de chaque site.

Ce projet n'est affilié, sponsorisé ni approuvé par aucun site web, service de streaming ou autre extension. Les noms et marques de tiers appartiennent à leurs propriétaires respectifs.

Le logiciel est fourni « tel quel », sans garantie, sous [licence MIT](../../LICENSE).

## Licence

[MIT](../../LICENSE). Les composants tiers (comme libav.js/FFmpeg et LAME, sous LGPL-2.1) conservent leurs propres licences, listées dans `THIRD_PARTY_NOTICES.md`.
