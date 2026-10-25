# Servare

[![CI](https://github.com/dk-1ng/servare/actions/workflows/ci.yml/badge.svg)](https://github.com/dk-1ng/servare/actions/workflows/ci.yml)

[English](../../README.md) · **Português (BR)** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

> Esta é uma tradução. Em caso de divergência, vale a [versão em inglês](../../README.md).

Extensão para Firefox e Chromium que detecta vídeos e áudios carregados pela página e permite salvá-los localmente — arquivos diretos, HLS e DASH — com todo o processamento feito dentro do navegador.

> **Status:** em desenvolvimento (pré-alpha). Acompanhe pelo [quadro do projeto](https://github.com/users/dk-1ng/projects/4) e pelos [milestones](https://github.com/dk-1ng/servare/milestones).

## Funcionalidades planejadas

- Detecção automática de mídia observando as requisições da página
- Arquivos diretos (MP4, WebM, MKV, MP3…), HLS e DASH
- Escolha de qualidade, faixa de áudio e legendas
- Gravação de transmissões ao vivo (HLS)
- Extração de áudio para MP3
- Fila com pausa e retomada, inclusive após reiniciar o navegador
- Remux local com FFmpeg compilado para WebAssembly — sem aplicativo nativo, sem servidor, sem telemetria
- Modo espelho (Firefox): reaproveita os dados que o player já baixou, sem requisições extras

## Fora de escopo

- **YouTube** — não suportado, por decisão de projeto.
- **Conteúdo com DRM** (Widevine, PlayReady, FairPlay etc.) — detectado e recusado. O Servare não contém e não aceitará código que contorne DRM, login, paywall ou qualquer outra medida de proteção técnica.

## Desenvolvimento

Requisitos: Node.js LTS, pnpm, FFmpeg (para gerar as fixtures de teste).

```sh
pnpm install
pnpm dev            # Chromium com recarga automática
pnpm dev:firefox    # Firefox
pnpm test           # testes unitários
pnpm build          # pacotes de produção para os dois navegadores
```

Documentação técnica (em inglês): [docs/design.md](../design.md). Como contribuir: [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Aviso legal

O Servare é uma ferramenta de uso geral para salvar mídia que o seu navegador já recebe. **Você é o único responsável pelo uso que fizer dela.** Baixe apenas conteúdo que você tem direito de baixar — conteúdo próprio, sob licença livre, em domínio público ou com autorização do titular — e respeite as leis de direito autoral do seu país e os termos de uso de cada site.

O projeto não é afiliado, patrocinado ou endossado por nenhum site, serviço de streaming ou outra extensão. Nomes e marcas de terceiros pertencem aos seus respectivos donos.

O software é fornecido "no estado em que se encontra", sem garantias, conforme a [licença MIT](../../LICENSE).

## Licença

[MIT](../../LICENSE). Componentes de terceiros (como libav.js/FFmpeg e LAME, sob LGPL-2.1) mantêm suas próprias licenças, listadas em `THIRD_PARTY_NOTICES.md`.
