# Servare — instruções para agentes

Extensão open source (MIT) de download de vídeos para Firefox e Chromium: WXT + TypeScript + libav.js.
Leia `docs/design.md` antes de qualquer mudança; ele é a fonte de verdade do comportamento.

## Regras inegociáveis
- Sem YouTube. Sem contorno de DRM, login, paywall ou captcha. Conteúdo protegido é detectado e recusado.
- Código 100% original, escrito a partir de especificações públicas (RFC 8216, ISO/IEC 23009-1, MDN, FFmpeg). Nunca copiar, adaptar ou consultar código de outras extensões ou software proprietário — ver `CONTRIBUTING.md`.
- Nada de scripts no mundo MAIN, nada de `web_accessible_resources`, nada de telemetria ou regras remotas.
- Fixtures de mídia sempre sintéticas, geradas localmente.
- UI visual é projetada em outro chat; aqui só o contrato de dados (`docs/ui-contract.md`).

## Acompanhamento
Tudo vive no GitHub `dk-1ng/servare`: issues, milestones `M0`…`M5` e o Project "Servare".
Labels: `type: *`, `area: *`, `browser: *`, `status: ready | in progress | blocked | triage`.

### Quando o usuário disser "continue"
1. Retomar a issue com `status: in progress`, se houver (ler os comentários para ver onde parou):
   `gh issue list -R dk-1ng/servare --state open --label "status: in progress"`
2. Senão, pegar a issue aberta de menor número no milestone aberto mais antigo, ignorando `status: blocked`:
   `gh issue list -R dk-1ng/servare --state open --milestone "<milestone>" --json number,title,labels`
3. Trocar o label para `status: in progress`, mover o card para "In Progress" e criar a branch `<tipo>/<n>-descricao`.
4. Implementar seguindo a issue e o design. Rodar lint, typecheck, testes e a verificação descrita nos critérios de aceite.
5. Commits em Conventional Commits (descrição em português). Abrir PR com `Closes #N`, aguardar CI, fazer squash merge.
6. Se a sessão terminar no meio, comentar na issue o estado exato (feito, falta, arquivos tocados, próximos passos).
7. Decisões que mudem o design → atualizar `docs/design.md` no mesmo PR.

### Mover card no Project
Project: https://github.com/users/dk-1ng/projects/4 · ID `PVT_kwHOE9rcGM4BomU0`
Campo Status `PVTSSF_lAHOE9rcGM4BomU0zhnFrbU` · opções: Todo `f75ad846` · In Progress `47fc9ee4` · Done `98236657`
```sh
ITEM=$(gh project item-list 4 --owner dk-1ng --limit 200 --format json --jq '.items[]|select(.content.number==N).id')
gh project item-edit --project-id PVT_kwHOE9rcGM4BomU0 --id "$ITEM" \
  --field-id PVTSSF_lAHOE9rcGM4BomU0zhnFrbU --single-select-option-id <opção>
```
