---
id: bug-36
title: Orchestrate sheet merge-mode label says "Merge to main" for any base
created: 2026-09-18
tags: ui, orchestrate
updated: 2026-09-18T15:08:39Z
groom-elapsed: 279
groom-tokens: 71370
---

## Symptom

The Orchestrate sheet's merge-mode combobox labels its `merge` option **"Merge to main"** whatever the Base branch picker beside it is set to. Since task-44
made the base branch run-scoped, that label is simply wrong for any base other than `main` — and it contradicts the explanatory note rendered directly beneath
the same row, which correctly reads "this run gates, branches and merges on `feature/tracker-backed` — `main` is never written".

Two statements of the same fact, on one screen, at the same moment, disagreeing. The note is right; the control is wrong. Nothing misbehaves downstream — the
run is launched with the selected base and merges there — so this is a labelling defect only, but it is the label on the control that decides where a whole
unattended run's work lands, which is the worst place on this sheet for a reader to be told the wrong branch name.

Settings carries the same stale string in two forms, and it is a different situation there rather than the same bug twice: `SettingsView.tsx` is picking a
*default* for a base that does not exist yet at that moment, so no base-derived wording is even available to it. Its hint sentence "«Merge to main» is what
every run does today" is separately false since task-44 regardless of what the picker is called.

## Repro

1. Board → pick a project → toolbar **Orchestrate**.
2. Step through to step 3 (modes).
3. Set **Base branch** to any non-`main` branch — e.g. `feature/tracker-backed`.
4. The note below the row updates to name that branch; the **Merge mode** combobox still reads "Merge to main".

## Affects

- `client/src/components/board/OrchestrateSheet.tsx:32-35` — `MERGE_MODE_LABELS`, the `Record<MergeMode, string>` holding the literal `'Merge to main'`.
- `client/src/components/board/OrchestrateSheet.tsx:1054-1062` — the Merge mode `Select` that renders those labels.
- `client/src/components/board/OrchestrateSheet.tsx:1083-1084` — the Base branch `Select` whose value the label ignores.
- `client/src/components/board/OrchestrateSheet.tsx:1095-1100` — the note that states the base correctly, i.e. the other half of the disagreement.
- `client/src/components/settings/SettingsView.tsx:359` — the hint's "«Merge to main» is what every run does today", false since task-44.
- `client/src/components/settings/SettingsView.tsx:365` — the same literal on the default-merge-mode picker, where no base is knowable.

## Cause

`MERGE_MODE_LABELS` is a module-level constant of static strings, evaluated once at import time, long before the component's `base` state exists — so the label
cannot vary with the base by construction. It was written when `main` was the only branch a run could merge into, and task-44 added the Base branch picker two
fields away without revisiting the sentence beside it. The `Record<MergeMode, string>` shape is deliberate (its comment explains it: the compiler refuses to
build the file the day `MergeMode` gains a third member), and nothing about that shape is at fault — a third member would still need a name. What the shape
does not survive is a label whose correct text depends on component state.

Confirmed while grooming, and it sharpens the blast radius: the stale string `'Merge to main'` exists in **four** places, not two — `OrchestrateSheet.tsx:33`,
`SettingsView.tsx:375` (the picker option), `SettingsView.tsx:369` (the hint sentence, which quotes the label by hand) and
`test/orchestrator-start-ui.test.tsx:1085`, which pins it. Each copy was typed independently, which is why task-44 could correct the note and leave all four
untouched. Nothing downstream reads any of them: the sheet already sends `base` as its own request field (`OrchestrateSheet.tsx:651`) and no derived value reads
a picker label, so the defect is confined to what a reader is told. `client/src/lib/run-stage.ts:184`'s `mergeModeLabel` is a different thing entirely — the
badge word for a run that has already started — and is correct as written.

## Fix

**Decision: derive the sheet's label from the picked base — `Merge to <base>` — and give Settings the same function's base-less wording, `Merge into the base
branch`.** Chosen over the static `"Merge"`/`"Merge into the base branch"`-everywhere candidate because the note that would have to carry the destination
instead is rendered only for a non-`main` base, so the smaller change leaves the commonest run — a `main` one — with no statement of the destination anywhere on
the screen; and because `MERGE_MODE_LABELS`'s own rule (design §2.2, quoted in its doc comment) is that each option names the **outcome** a successful run ends
in, and "merge to feature/tracker-backed" is that outcome stated exactly. The item's stated cost of this candidate — that it cannot be shared with Settings — is
avoidable and is not paid: one function serves both surfaces, with `null` for "no base is knowable here".

`AskUserQuestion` was not available in this session, so the wording above is a groom-time call rather than a confirmed pick. It is one function's two string
literals; overturning it later is a one-line edit plus the tests below.

Not `runner-fix:`. The change touches `client/` and `test/` only — none of `backlog-orchestrate`'s SKILL.md, `orchestrate.mjs`, `agents/backlog-reviewer.md` or
`server/src/agents/`.

1. **New `client/src/lib/merge-mode.ts`** — `export function mergeModeOptionLabels(base: string | null): Record<MergeMode, string>`. The returned record's
   `merge` entry is `Merge into the base branch` when `base` is `null`, and the base's own name after `Merge to ` otherwise; its `branch` entry is
   `Leave branches for me` either way. Three things this must keep:
   - the `Record<MergeMode, string>` **return type**, which is the whole of what the deleted constant's shape bought — a third `MergeMode` member still fails
     the build here, exactly as its doc comment promises;
   - `null` meaning "no base is knowable at this point", never "main". Settings picks a default before any run exists; defaulting `null` to `'main'` would
     reinstate this same bug on the one surface that genuinely cannot know the answer;
   - a header comment carrying over the surviving half of `MERGE_MODE_LABELS`'s reasoning (the outcome-not-the-flag rule, and why a `Record` rather than a pair
     of literals), plus one sentence distinguishing it from `mergeModeLabel` (`client/src/lib/run-stage.ts:184`) — and one sentence added to **that** function's
     doc comment pointing back here. Two near-homonyms in one `lib/` is how the next edit lands in the wrong file.

2. **`client/src/components/board/OrchestrateSheet.tsx`** — delete `MERGE_MODE_LABELS` and its doc comment (lines 22-35); render the Merge mode `Select`'s
   options from `mergeModeOptionLabels(base)` at the call site (lines ~1054-1062) so the labels re-derive on every `setBase`.

3. **`client/src/components/settings/SettingsView.tsx`** — in `OrchestratorGroup`, take `const labels = mergeModeOptionLabels(null)` once; use `labels.merge` /
   `labels.branch` for the two option labels (lines 375-376) **and interpolate the same two values into the hint** (line 369) rather than retyping them. The
   hand-typed quote is what produced this bug's third copy. The hint's claim also has to go: "is what every run does today" is false since task-44. Suggested
   replacement — `Preselected in the Orchestrate sheet. “${labels.merge}” merges each item into the branch the run was started on, which is main unless the
   launch picked another; “${labels.branch}” stops at a reviewed git branch per item instead. Overridable per launch.`

4. **Nothing else.** The two `docs/superpowers/` hits are the merge-mode spec and plan — historical records of what was decided in 2026-09-04, left as written —
   and no `docs/subsystems/` doc quotes the string (checked).

### Test cases

- **New `test/merge-mode-labels.test.ts`** (plain jest, no jsdom). A new file rather than cases added to `test/merge-mode.test.ts`, which is the server
  `POST /api/agents/orchestrate` suite and shares only the words:
  - `mergeModeOptionLabels('main').merge` → `'Merge to main'`
  - `mergeModeOptionLabels('feature/tracker-backed').merge` → `'Merge to feature/tracker-backed'`
  - `mergeModeOptionLabels(null).merge` → `'Merge into the base branch'`, asserted as that string — a case that also has to state it is **not**
    `'Merge to main'`, since that is the wrong answer this bug is about
  - `.branch` → `'Leave branches for me'` for all three inputs above
- **`test/orchestrator-start-ui.test.tsx`**:
  - case 1 (line ~1085) keeps `['Merge to main', 'Leave branches for me']` **unchanged** — the `base` state defaults to `'main'` (line 228), so that existing
    assertion becomes the regression guard proving a `main` run reads exactly as it did before.
  - a new case beside it: the suite's stub already answers `/api/agents/branches` with `['main', 'feature/x']` (line ~583), so
    `await userEvent.selectOptions(screen.getByLabelText('Base branch'), 'feature/x')` then expect the Merge mode picker's option text to equal
    `['Merge to feature/x', 'Leave branches for me']`. This is the case that fails today.
  - in that same new case, also assert the note beneath the row still names `feature/x` — what was filed is two statements disagreeing, so the test has to pin
    them **agreeing**, not merely pin the new string.
- **`test/settings-view.test.tsx`** — extend `offers a default merge mode, starting on merge, and persists a pick` (line 451) to assert option **text** as well
  as value: `['Merge into the base branch', 'Leave branches for me']`; and assert the row's hint no longer contains `every run does today`.
- Full verification: `pnpm test` (both runners) and `pnpm run typecheck`.

In the browser (playwright MCP tools): with the app on `http://127.0.0.1:5177`, open the Board, pick this project, click the toolbar **Orchestrate**, step
through to step 3 (modes), and set **Base branch** to a non-`main` branch (`feature/tracker-backed`). The **Merge mode** combobox's `merge` option must read
`Merge to feature/tracker-backed` — the same branch the note directly beneath the row names. Then set **Base branch** back to `main` and confirm the option
reads `Merge to main` and the note is gone.
