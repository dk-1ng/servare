# Contribuindo com o Servare

Obrigado pelo interesse! Este guia explica como o projeto é organizado e o que é esperado de cada contribuição.

## Política de código original (obrigatória)

Para manter o projeto juridicamente limpo:

- **Todo código deve ser original** ou vir de dependências com licença compatível com MIT (ou LGPL, quando isolada como biblioteca separada), declaradas em `THIRD_PARTY_NOTICES.md`.
- **Não envie código copiado, adaptado ou derivado de software proprietário**, incluindo código descompilado, desofuscado ou extraído de outras extensões, aplicativos ou players.
- Baseie-se em especificações públicas (RFC 8216, ISO/IEC 23009-1, MDN, documentação do FFmpeg e das WebExtensions).
- Ao abrir o PR você confirma, pelo checklist do template, que tem o direito de contribuir com o código sob a licença MIT.

## Escopo

Não serão aceitas contribuições que:
- adicionem suporte ao YouTube;
- contornem DRM, login, paywall, captcha ou qualquer medida de proteção técnica;
- injetem ou modifiquem JavaScript/DOM das páginas visitadas;
- enviem dados a servidores externos (telemetria, analytics, regras remotas).

## Fluxo de trabalho

1. Escolha uma issue (ou abra uma descrevendo a proposta) e comente que vai trabalhar nela.
2. Crie uma branch a partir de `main`: `feat/<issue>-descricao-curta`, `fix/...`, `chore/...`, `docs/...`.
3. Commits seguem [Conventional Commits](https://www.conventionalcommits.org/pt-br/), com descrição em português no imperativo:
   ```
   feat(detection): adiciona classificador de tipos MIME
   fix(hls): corrige cálculo do IV para segmentos com sequência alta
   ```
   Escopos usuais: `detection`, `hls`, `dash`, `download`, `media`, `net`, `ui`, `platform`, `rules`, `ci`, `docs`.
4. Abra o PR referenciando a issue (`Closes #N`) e preencha o template.
5. O CI precisa passar: lint, typecheck, testes e build para Firefox e Chromium.

## Padrões de código

- TypeScript estrito; sem `any` implícito.
- Diferenças entre navegadores ficam em `src/platform/`.
- Dados que cruzam contextos (background, worker, UI) passam por schemas zod em `src/messaging/`.
- Testes ao lado do comportamento: parsers e utilitários puros exigem testes unitários.
- Fixtures de mídia são **geradas localmente** (`test/fixtures/make.sh`); não adicione vídeos ou áudios de terceiros ao repositório.

## Reportando problemas

Use os templates de issue. Ao reportar um site que não funciona, descreva o tipo de mídia e o comportamento — evite links para conteúdo protegido por direito autoral.
