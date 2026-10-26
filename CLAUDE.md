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
- Transparency: every commit ends with the trailer `Assisted-by: Claude Code` (a blank line before it). Never use `Co-Authored-By` or "Generated with …", and put no AI marks in PRs, issues or comments. Squash merges must keep the trailer in the final commit message. The README section "How this project is built" is the public disclosure; keep it accurate.

## Tracking

Everything lives on GitHub `dk-1ng/servare`: issues, milestones `M0`…`M5` and the "Servare" project.
Labels: `type: *`, `area: *`, `browser: *`, `complexity: high`, `status: ready | in progress | blocked | triage`.

## Model routing

The main session is expected to run on **Sonnet** (`/model sonnet`). It orchestrates, implements small issues inline and delegates the rest to the agents in `.claude/agents/`:

| Agent           | Model                                                | Use for                                                                                                            |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `architect`     | Opus                                                 | `type: spike`, planning `complexity: high` issues, changes to `docs/design.md`, bugs that survived one fix attempt |
| `implementer`   | Sonnet (pass `model: "opus"` for `complexity: high`) | Implementing an issue too large to do inline                                                                       |
| `test-engineer` | Sonnet                                               | Fixtures, test server, E2E suites                                                                                  |
| `reviewer`      | Opus                                                 | Reviewing every branch before merge                                                                                |
| `translator`    | Sonnet                                               | Syncing `docs/readme/` after `README.md` changes                                                                   |
| `tracker`       | Haiku                                                | Labels, project cards, status comments                                                                             |

Subagents start without this conversation's context, so delegate only when the task is large or needs a different model; give them the issue number, branch and any decision already made.

If the main session is running on Opus and the next issue is not `complexity: high`, tell the user **before starting** and suggest `/model sonnet`. If it runs on Sonnet and the issue is a spike or `complexity: high`, delegate to `architect`/`implementer` on Opus instead of asking the user to switch.

### When asked to "continue"

1. Find the issue: resume the one labeled `status: in progress` (read its comments to see where it stopped):
   `gh issue list -R dk-1ng/servare --state open --label "status: in progress"`
   otherwise take the lowest-numbered open issue in the earliest open milestone, skipping `status: blocked`:
   `gh issue list -R dk-1ng/servare --state open --milestone "<milestone>" --json number,title,labels`
2. Check the model routing rule above; warn the user if needed.
3. `tracker`: mark the issue in progress. Main session: create the branch `<type>/<n>-short-description` from an up-to-date `main`.
4. Route the work:
   - `type: spike` → `architect`;
   - `complexity: high` → `architect` plans, then `implementer` with `model: "opus"`;
   - test infrastructure → `test-engineer`;
   - otherwise implement inline, or `implementer` if the issue spans many files.
5. Verify: lint, typecheck, tests, build and the acceptance criteria.
6. `reviewer` on the branch. On `CHANGES REQUESTED`, fix (or send back to the implementer) and review again.
7. If `README.md` changed, `translator` syncs `docs/readme/`.
8. Open the PR (`Closes #N`, PR template filled in), wait for CI, squash merge, update local `main`.
9. `tracker`: mark the issue done.
10. Tell the user the issue is finished and that this is a good moment to run `/clear` and say "continue" again (one issue per session keeps context small).
11. If the session must stop mid-task, `tracker` posts a comment with the exact state (done, missing, files touched, next steps).

Decisions that change the design → update `docs/design.md` in the same PR.

### Release gate (store accounts)

Before starting #37, any release/publish workflow, or the first submission to AMO or the Chrome Web Store, **stop and show the maintainer the checklist in issue #69** (`gh issue view 69 -R dk-1ng/servare`). Explain it in plain terms (the maintainer is not a developer) and wait for confirmation of each item. Do not treat silence or an earlier general approval as confirmation. Also read `docs/design.md` §11 for how the publish job must be separated.

### Moving a project card

Project: https://github.com/users/dk-1ng/projects/4 · ID `PVT_kwHOE9rcGM4BomU0`
Status field `PVTSSF_lAHOE9rcGM4BomU0zhnFrbU` · options: Todo `f75ad846` · In Progress `47fc9ee4` · Done `98236657`

```sh
ITEM=$(gh project item-list 4 --owner dk-1ng --limit 200 --format json --jq '.items[]|select(.content.number==N).id')
gh project item-edit --project-id PVT_kwHOE9rcGM4BomU0 --id "$ITEM" \
  --field-id PVTSSF_lAHOE9rcGM4BomU0zhnFrbU --single-select-option-id <option>
```
