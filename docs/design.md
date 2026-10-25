# Servare — Documento de design

> Status: rascunho aprovado para o MVP · Última revisão: 2026-10-24

## 1. Visão geral

Servare é uma extensão de navegador (Firefox e Chromium, Manifest V3) que detecta vídeos e áudios carregados pela página atual e permite salvá-los localmente. Todo o processamento acontece no navegador — não há aplicativo nativo nem servidor.

### 1.1 Escopo
- Arquivos de mídia diretos (MP4, WebM, MKV, MP3, …).
- Streams HLS (RFC 8216), incluindo criptografia `AES-128` padrão do protocolo.
- Streams DASH (ISO/IEC 23009-1) sem proteção de conteúdo.
- Transmissões ao vivo em HLS.
- Faixas de áudio alternativas, legendas e extração de áudio para MP3.

### 1.2 Não-objetivos (permanentes)
- **YouTube** — não há e não haverá suporte.
- **Conteúdo protegido por DRM** (Widevine, PlayReady, FairPlay, `SAMPLE-AES`, CENC etc.). O Servare **detecta e recusa**; não existe nenhum caminho de código para contornar DRM.
- Contornar login, paywall, captcha ou qualquer controle de acesso.
- Gravação de tela.
- Modificar o JavaScript ou o DOM das páginas visitadas.
- Telemetria ou qualquer comunicação com servidores próprios.

### 1.3 Princípios
1. **Implementação original.** Todo código é escrito a partir de especificações públicas (RFC 8216, ISO/IEC 23009-1, documentação MDN/WebExtensions, FFmpeg). Ver [CONTRIBUTING.md](../CONTRIBUTING.md).
2. **Somente leitura na página.** Content scripts apenas leem metadados; nada é injetado.
3. **Um único pipeline de mídia** para todos os formatos.
4. **Privacidade.** Nenhum dado sai do navegador além das requisições necessárias ao download; janelas privadas não deixam rastro persistente.
5. **Bom comportamento na rede.** Concorrência limitada, respeito a `429`/`Retry-After`.

---

## 2. Arquitetura

### 2.1 Stack
| Item | Escolha | Motivo |
|---|---|---|
| Framework de extensão | [WXT](https://wxt.dev) + TypeScript estrito | Manifest por navegador, `browser.*` unificado, HMR |
| Motor de mídia | [libav.js](https://github.com/Yahweasel/libav.js) (FFmpeg em WebAssembly, LGPL-2.1) | Demux/mux de TS, fMP4, Matroska; legendas; MP3 |
| Parsers de manifesto | `m3u8-parser`, `mpd-parser` | Mantidos pela comunidade Video.js, Apache-2.0 |
| Validação de dados | zod | Contratos de mensagens e estado |
| Testes | Vitest, Playwright, FFmpeg/ffprobe local | Unidade, E2E e verificação de saída |

### 2.2 Componentes
| Componente | Firefox | Chromium | Responsabilidade |
|---|---|---|---|
| Background | event page | service worker | Detecção, estado por aba, fila, regras de headers, entrega via `downloads` |
| Host do worker | background ou página da extensão (decisão no spike #3) | offscreen document (motivo `WORKERS`) | Manter o worker de download vivo |
| Download worker | Web Worker (módulo) | Web Worker (módulo) | Rede, decifração AES-128, libav, escrita em OPFS |
| Content script | mundo ISOLATED | mundo ISOLATED | Ler título, miniatura e elementos `<video>` sob demanda |
| UI (popup, sidebar, opções) | — | — | Projetada separadamente; consome o contrato da §2.5 |

### 2.3 Riscos de ciclo de vida
- **Chromium:** o service worker é encerrado quando ocioso. Todo estado vive em `storage.session`/`storage.local`; o offscreen document mantém worker e blobs vivos enquanto houver trabalho.
- **Firefox:** a event page MV3 também é suspensa. O spike #3 avalia: (a) `runtime.Port` aberta a partir de uma página da extensão, (b) página da extensão dedicada ao worker, (c) background persistente em MV2 apenas no Firefox.
- O blob entregue a `downloads.download` precisa existir até o download ser concluído.

### 2.4 Estrutura do repositório
```
entrypoints/        background, offscreen (Chromium), download-worker, content, popup/sidebar/options
src/
  messaging/        contratos zod e barramento sobre runtime.Port
  state/            store e migrações
  detection/        observador de rede, classificadores, tipos MIME
  manifest/         HLS, DASH, codecs, detecção de DRM
  rules/            regras por domínio
  download/         fila, jobs, estratégias por formato
  net/              fetcher, retry, semáforo, regras de headers
  crypto/           AES-128 (WebCrypto)
  media/            loader libav, remux, MP3, legendas, escrita OPFS
  naming/           templates e sanitização de nome de arquivo
  platform/         diferenças Firefox/Chromium isoladas
vendor/libav/       build reprodutível do libav.js
test/               unit, fixtures (geradas localmente), e2e
docs/               este documento e o contrato de UI
```

### 2.5 Modelo de dados (contrato com a UI)
```ts
type MediaKind = 'direct' | 'hls' | 'dash';

interface MediaItem {
  id: string; tabId: number; kind: MediaKind;
  url: string; pageUrl: string; title: string; thumbnail?: string;
  duration: number | 'live';
  variants: Variant[]; audioTracks: Track[]; subtitles: Track[];
  protected: boolean;            // DRM detectado → não baixável
  detectedAt: number;
}

interface Variant { id: string; width?: number; height?: number; bandwidth?: number; codecs?: string; container: string }
interface Track   { id: string; language?: string; label?: string; codecs?: string }

interface DownloadJob {
  id: string; mediaId: string; variantId?: string;
  audioTrackIds: string[]; subtitleIds: string[];
  mode: 'video' | 'audio';
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  progress: number | 'indeterminate'; bytesWritten: number;
  error?: DownloadError; outputName: string;
}

type DownloadError =
  | { kind: 'cancelled' } | { kind: 'http'; status: number }
  | { kind: 'incomplete'; ratio: number } | { kind: 'decrypt' }
  | { kind: 'quota' } | { kind: 'protected' } | { kind: 'unknown'; message: string };
```
Detalhes das mensagens ficam em `docs/ui-contract.md` (issue #12).

---

## 3. Detecção

### 3.1 Observação de rede
1. `webRequest.onSendHeaders` guarda os headers enviados por requisição (cache com TTL). No Chromium é necessário `extraHeaders` para ver `Cookie`/`Referer`.
2. `webRequest.onResponseStarted` avalia a resposta. Descartes: status fora de 2xx, esquemas não-HTTP, requisições da própria extensão, requisições sem aba, fragmentos de stream (`.ts`, `.m4s`, `.aac` de segmento) e domínios com detecção desativada.
3. Classificação na ordem: **HLS → DASH → arquivo direto**.

### 3.2 Arquivos diretos
- Gatilho: tipo de requisição `media` ou `Content-Type` `video/*`/`audio/*` reconhecido (tabela própria em `src/detection/mime.ts`, baseada no registro IANA).
- Tamanho mínimo padrão: **1 MiB** (configurável por domínio). Lido de `Content-Length` ou do total de `Content-Range`.
- Suporte a retomada se `Accept-Ranges: bytes`.
- Nome sugerido: `Content-Disposition` → caminho da URL → tipo MIME.

### 3.3 Manifestos
- O manifesto é obtido novamente com os mesmos headers para confirmar o tipo pelo conteúdo.
- **HLS master:** variantes (`RESOLUTION`, `BANDWIDTH`, `CODECS`), `EXT-X-MEDIA` de áudio e legenda. Variantes com codec desconhecido são ocultadas.
- **HLS media:** duração (soma de `EXTINF`), `EXT-X-KEY`, `EXT-X-MAP`, `EXT-X-BYTERANGE`. Ao vivo = sem `EXT-X-ENDLIST`.
- **DASH:** `AdaptationSet`/`Representation`, `SegmentTemplate`/`SegmentList`/`SegmentBase`.
- **Ordenação de qualidade:** altura, depois bitrate.

### 3.4 Conteúdo protegido
O item é marcado `protected: true` e a UI o mostra como indisponível quando houver:
- `ContentProtection` em DASH (qualquer `schemeIdUri`);
- `EXT-X-KEY`/`EXT-X-SESSION-KEY` com método diferente de `NONE` e `AES-128`, ou com `KEYFORMAT` diferente de `identity`.

Não há tentativa de obter licenças, chaves de CDM ou equivalentes.

### 3.5 Lista por aba
- Limpa em `webNavigation.onBeforeNavigate` e `tabs.onRemoved`.
- Deduplicação por URL normalizada (sem parâmetros de query voláteis).
- Se a aba tem manifesto HLS/DASH, arquivos diretos pequenos e playlists de mídia avulsas são ocultados por padrão (normalmente são fragmentos ou anúncios).
- Metadados (título, `og:image`, `poster`) lidos pelo content script.
- **Busca manual:** ação "procurar nesta página" varre `<video>`/`<source>`; se o player usa `blob:` (MSE) e nenhum manifesto foi visto, a UI explica o motivo.

---

## 4. Download

### 4.1 Preparação
1. Verifica `protected`, espaço disponível (`navigator.storage.estimate()`) e cria o job.
2. **Compatibilidade de headers:** muitos servidores exigem o mesmo `Referer`/`Origin`/`Cookie` que o player enviou (proteção contra hotlink). O Servare cria regras `declarativeNetRequest` de sessão que reaplicam esses valores **somente às requisições da própria extensão** (`tabIds: [-1]` e/ou `initiatorDomains`), nunca ao tráfego da página. As regras são removidas ao fim do job (`finally`) e regras órfãs são limpas na inicialização.
3. Envia o job ao worker.

### 4.2 Rede
- `fetch` em streaming, semáforo por host, retry com backoff exponencial e jitter, respeito a `429`/`Retry-After`.
- **Perfis de velocidade** (padrão por domínio, configurável):

| Perfil | Comportamento |
|---|---|
| Econômico | 1 conexão, ordem sequencial, ritmo próximo ao da reprodução |
| Padrão | até 4 conexões por host |
| Rápido | até 8 conexões; arquivos diretos com `Accept-Ranges` divididos em faixas paralelas |

### 4.3 AES-128 (HLS)
Conforme RFC 8216 §5.2: chave obtida pela URI de `EXT-X-KEY` (com os mesmos headers do player), AES-CBC via WebCrypto, IV explícito ou derivado do número de sequência do segmento. Chaves em cache por URI durante o job.

### 4.4 Remux
Pipeline único sobre a API do libav.js:
1. cada segmento (ou o arquivo inteiro) é demuxado em pacotes;
2. timestamps são reescritos para continuidade entre segmentos;
3. pacotes são muxados num dispositivo de escrita ligado ao OPFS.

**Contêiner por codec:** H.264/H.265 + AAC → MP4; VP9/AV1/Opus/Vorbis → MKV (ou WebM se todas as faixas forem compatíveis). Legendas: `mov_text` em MP4, WebVTT em MKV.

### 4.5 Ao vivo
Recarrega a playlist a cada `EXT-X-TARGETDURATION / 2`, adiciona apenas segmentos novos, encerra por ação do usuário ou após várias recargas sem novidade. Progresso indeterminado.

### 4.6 Áudio
Faixas alternativas são baixadas em paralelo e muxadas com metadado de idioma. Modo "somente áudio" decodifica, reamostra para 44,1 kHz e codifica em MP3 (`libmp3lame`, VBR, qualidade configurável).

### 4.7 Legendas
WebVTT, SRT e TTML vindas de HLS/DASH: embutidas no contêiner ou salvas como arquivo separado.

### 4.8 Robustez e validação
- Segmentos com falha após as tentativas são pulados, exceto o primeiro; acima de **20%** de falhas o job é abortado (configurável).
- Saída validada: arquivo vazio = falha; duração abaixo de **97%** da esperada = `incomplete`.

### 4.9 Escrita e entrega
- Escrita posicional no OPFS com `createSyncAccessHandle` (sem manter o arquivo em memória; `unlimitedStorage`).
- No fim: `File` → blob URL → `downloads.download` (`conflictAction: 'uniquify'`, "salvar como" opcional). No Chromium o nome é garantido via `downloads.onDeterminingFilename`.
- Após a conclusão: remoção do arquivo temporário e revogação do blob.

### 4.10 Fila, pausa e retomada
Jobs e índices de segmentos concluídos são persistidos. Downloads retomam após reiniciar o navegador (HLS/DASH por segmento; arquivos diretos por `Range`).

---

## 5. Modo espelho (Firefox)

Em vez de baixar de novo, reutiliza os dados que **o player da página já recebeu**: `webRequest.filterResponseData` copia o corpo das respostas de segmentos enquanto o vídeo toca, e o pipeline da §4.4 monta o arquivo.

- Zero carga extra no servidor e economia de banda.
- Cobre o que o player buscou; a UI mostra a cobertura e oferece completar o restante pelo caminho normal.
- Indisponível no Chromium (não há API equivalente em MV3).

---

## 6. Regras por domínio

Arquivo `src/rules/default-rules.json`, validado por zod e editável nas opções:

```jsonc
{
  "version": 1,
  "domains": {
    "example.com": {
      "detection": true,          // desativa detecção no domínio
      "minDirectSize": 1048576,   // bytes
      "propagateQuery": false,    // copia a query do manifesto para os segmentos
      "audioOnly": false,         // trata streams como áudio
      "feedMode": false,          // lista rotativa para sites de rolagem infinita
      "hideFragments": true,      // oculta fragmentos quando há manifesto
      "speedProfile": "standard"  // economic | standard | fast
    }
  }
}
```
Regras casam por domínio e subdomínios. Não há download remoto de regras.

---

## 7. Nomes de arquivo

- Template padrão `{title}`; variáveis: `{title}`, `{host}`, `{date}`, `{quality}`, `{lang}`.
- Sanitização: normalização NFC, remoção de caracteres inválidos em Windows/macOS/Linux, nomes reservados do Windows (`CON`, `NUL`…), colapso de espaços, limite de 180 caracteres, fallback `video`.
- Subpasta opcional dentro da pasta de downloads.

---

## 8. Build do libav.js

Variante própria, reproduzível por script em `vendor/libav/`, contendo apenas: demuxers `mpegts`, `mov`, `matroska`, `mp3`, `aac`, `webvtt`; muxers `mp4`, `matroska`, `webm`, `mp3`; bitstream filters `aac_adtstoasc`, `h264_mp4toannexb`, `hevc_mp4toannexb`; decoders de áudio `aac`, `mp3`, `opus`, `vorbis`; encoder `libmp3lame`; codecs de legenda `mov_text`, `webvtt`, `subrip`; filtro `aresample`. Nenhum decoder de vídeo (vídeo é sempre copiado).

Licenciamento: libav.js/FFmpeg e LAME são LGPL-2.1. O repositório mantém o script de build, as versões fixadas e os avisos em `THIRD_PARTY_NOTICES.md`.

---

## 9. Marcos

| Marco | Entrega | Critério de pronto |
|---|---|---|
| **M0 — Fundação** | Scaffold, CI, mensageria, estado, spikes de ciclo de vida e headers, escrita OPFS + entrega | Arquivo sintético de 2 GB salvo nos dois navegadores; worker sobrevive a 10 min |
| **M1 — Arquivos diretos** | Detecção, lista por aba, download com headers, nomes, regras, histórico | MP4 protegido por Referer + cookie baixado nos dois navegadores |
| **M2 — HLS** | libav.js, parser, AES-128, fetcher, remux, áudio alternativo, validação, fila com retomada | HLS com AES-128 e áudio separado → MP4 sincronizado |
| **M3 — DASH** | Parser e download vídeo + áudio | H.264/AAC → MP4 e VP9/Opus → MKV |
| **M4 — Ao vivo, legendas e áudio** | Live HLS, legendas, MP3, busca manual na página | Live gravada 5 min; legendas visíveis; MP3 válido |
| **M5 — Evolução** | Modo espelho, faixas paralelas, opções, extratores por site, pré-visualização, atalhos, releases | — |

---

## 10. Estratégia de testes

- **Unidade (Vitest):** parsers, detecção de proteção, tipos MIME, AES-128 com vetores conhecidos, nomes de arquivo, regras, migrações.
- **Fixtures geradas localmente** com FFmpeg (`test/fixtures/make.sh`) a partir de fontes sintéticas (`testsrc`, `sine`) — nenhum conteúdo de terceiros no repositório.
- **Servidor de teste** (Node): exige `Referer`/cookie, injeta erros 5xx, suporta `Range`, simula live com janela deslizante.
- **E2E:** Playwright no Chromium; `web-ext` no Firefox; saída verificada com `ffprobe` (duração, codecs, faixas, sincronismo).
- **CI:** lint, typecheck, testes e build dos dois navegadores a cada push/PR.
