# Servare — agent instructions

Open source (MIT) video download extension for Firefox and Chromium: WXT + TypeScript + libav.js.
Read `docs/design.md` before any change; it is the source of truth for behavior.

## Non-negotiable rules
- No YouTube. No circumvention of DRM, logins, paywalls or captchas. Protected content is detected and refused.
- 100% original code, written from public specifications (RFC 8216, ISO/IEC 23009-1, MDN, FFmpeg). Never copy, adapt or consult code from other extensions or proprietary software — see `CONTRIBUTING.md`.
- No MAIN-world scripts, no `web_accessible_resources`, no telemetry, no remote rules.
- Media fixtures are always synthetic and generated locally.
- Visual UI design happens elsewhere; this repo only defines the data contract (`docs/ui-contract.md`).
- Everything in the repository (code, comments, docs, issues, commits, PRs) is in English. README translations live in `docs/readme/` and must be kept in sync.
- No AI attribution lines (`Co-Authored-By`, "Generated with …") in commits or PRs.

## Tracking
Everything lives on GitHub `dk-1ng/servare`: issues, milestones `M0`…`M5` and the "Servare" project.
Labels: `type: *`, `area: *`, `browser: *`, `status: ready | in progress | blocked | triage`.

### When asked to "continue"
1. Resume the issue labeled `status: in progress`, if any (read its comments to see where it stopped):
   `gh issue list -R dk-1ng/servare --state open --label "status: in progress"`
2. Otherwise take the lowest-numbered open issue in the earliest open milestone, skipping `status: blocked`:
   `gh issue list -R dk-1ng/servare --state open --milestone "<milestone>" --json number,title,labels`
3. Swap the label to `status: in progress`, move the card to "In Progress" and create the branch `<type>/<n>-short-description`.
4. Implement following the issue and the design. Run lint, typecheck, tests and the verification listed in the acceptance criteria.
5. Conventional Commits. Open a PR with `Closes #N`, wait for CI, squash merge.
6. If the session ends mid-task, comment on the issue with the exact state (done, missing, files touched, next steps).
7. Decisions that change the design → update `docs/design.md` in the same PR.

### Moving a project card
Project: https://github.com/users/dk-1ng/projects/4 · ID `PVT_kwHOE9rcGM4BomU0`
Status field `PVTSSF_lAHOE9rcGM4BomU0zhnFrbU` · options: Todo `f75ad846` · In Progress `47fc9ee4` · Done `98236657`
```sh
ITEM=$(gh project item-list 4 --owner dk-1ng --limit 200 --format json --jq '.items[]|select(.content.number==N).id')
gh project item-edit --project-id PVT_kwHOE9rcGM4BomU0 --id "$ITEM" \
  --field-id PVTSSF_lAHOE9rcGM4BomU0zhnFrbU --single-select-option-id <option>
```
