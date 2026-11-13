# UI verify — reviewer coverage, anchors and groups

Plan: [2026-11-12-reviewer-coverage-anchors-groups.md](../plans/2026-11-12-reviewer-coverage-anchors-groups.md), Task 11 Step 6. Spec:
[2026-11-12-reviewer-coverage-anchors-groups-design.md](../specs/2026-11-12-reviewer-coverage-anchors-groups-design.md).

**Verdict: PASS after one fix** — the Orchestrate sheet drew the Reviewer section between the Question mode select and that select's own note; moved below
every note in `fix(board): ui-verify findings`.

## Reference

No mock: the spec names none, and the plan cites none for Task 11. The reference is the spec's layout text (Settings › Shared gains a `Reviewer` card; both
launch sheets gain a `Reviewer` section seeded from it; the run detail gains one line) plus `.claude/DESIGN.md`'s families. Checked: geometry, copy, placement
relative to neighbouring controls, both themes.

## Inventory

| View | How opened | Data | States |
| ---- | ---------- | ---- | ------ |
| Settings › Shared › Reviewer | `?section=settings&settings=shared` | `/api/settings/review` routed per state | split, same, `fileError` |
| LaunchSheet (execute, PR finish) | Files board, project filter stored, item's `execute` chip, Finish → PR | branch API on scratch registry; `/api/agents/status` and `/api/agents/plan` stubbed so the scratch project is dispatchable | untouched (no `--review-`), small model changed |
| Orchestrate sheet, step 3 · modes | Files board, `Orchestrate`, next, next | same | seeded from the saved setting |
| Run detail | `?section=runs` | scratch `BM_ORCH_HOME` run with `reviewConfig` split big opus/high, small sonnet/low, 300 | recorded config |

Each at 1440×1000 and 390×844 (the app folds at 700 px), Daylight and Midnight (the app themes from its own setting, not `prefers-color-scheme`). Start,
launch and Resume were never pressed; every POST in the Settings scenarios was intercepted and echoed.

## Geometry

Harness: headless Chromium from the cached `playwright` package (Playwright MCP failed to connect), one script re-run per pass.

- Settings, all states and widths: no overflow, no page errors.
- LaunchSheet, all: no overflow, no page errors.
- Orchestrate modes: only `PRE.orchestrate-merge-hint-json` — `overflow-x: auto` by design (4e992f6e), the JSON snippet scrolls.
- Run detail: `SPAN.run-drawer-item-verify-tail` (an ellipsis span, zero width by design) and, at 390 only, `DIV.run-track 448>272` — the seven-stage track
  clips its last stage at phone width. Pre-existing (cd2d9233's area), not touched by this branch; noted as a follow-up, not fixed here.

## Regions

- Settings card head — `Reviewer` + `this machine` pill: match.
- Settings `Models` row — `Same for all groups` / `Big and small groups` segments: match; same mode shows `Model` / `Effort`, split mode the four pair rows and
  `Small group limit` with its hint: match. Options read `Agent default (Opus)`, `Opus`…`Fable`, `Default`, `Low`…`XHigh`, `Max`: match.
- Settings `fileError`: error row under the card with the spec's words: match.
- LaunchSheet clause line untouched: `` Finish with `--finish pr --base main`: … `` — no `--review-`: match (the pick equals the seed, so nothing is sent).
- LaunchSheet clause line after Small groups — model → Opus: all seven `--review-*` flags inside the backticks: match.
- LaunchSheet Reviewer section: below the PR switches and their note, above Permission mode / Model / Effort; 390 px wraps the four selects two by two:
  match.
- Orchestrate Reviewer section: **defect, fixed** — drawn right under the Permission/Model/Effort/Merge/Question/Base selects, so the question-mode note
  (and the base and merge-hint notes) sat below the reviewer pickers and read as describing them. Now after the merge hint, above the error line.
- Run detail: `Reviewer: big Opus · High, small Sonnet · Low up to 300 lines` as a `run-fact-note` under `Base · mode`, wrapping inside its column at 390:
  match.

## Screenshots

In the session scratchpad `uiv/`: `set-{split,same,fileerror}-{1440,390}-*.jpg`, `set-split-1440-dark-midnight.jpg`, `set-same-390-dark-midnight.jpg`,
`launch-{untouched,changed}-{1440,390}-{light,dark}.jpg`, `orch-modes-*.jpg` (before) and `orch-modes-*-fixed.jpg` (after), `run-detail-{1440,390}-{light,dark}.jpg`.
