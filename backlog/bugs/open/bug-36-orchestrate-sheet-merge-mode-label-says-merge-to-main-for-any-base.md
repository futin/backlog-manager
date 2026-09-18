---
id: bug-36
title: Orchestrate sheet merge-mode label says "Merge to main" for any base
created: 2026-09-18
tags: ui, orchestrate
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

## Fix

unknown — the wording is grooming's call, not capture's. Two candidates, with what each costs:

- **Derive from the base — "Merge to `<base>`".** Most informative, and it makes the control agree with the note word for word. Costs: `MERGE_MODE_LABELS` stops
  being a module constant and becomes a function of `base` (or the label is composed at the `Select` call site), so the compile-time exhaustiveness the constant
  buys has to be preserved deliberately rather than inherited; and it cannot be shared with Settings, which has no base to derive from — so Settings keeps its
  own wording and the two surfaces stop reading from one string.
- **Drop the branch name — "Merge".** Smallest change, keeps the constant a constant, keeps one string shared with Settings, and cannot go stale again because
  it no longer asserts a branch. Costs: the option loses the one word that told a reader what the mode actually does, leaning entirely on the note below it —
  which is rendered only for a non-`main` base, so a `main` run would be left with a bare "Merge" and no statement of the destination anywhere on the screen.
  A variant worth considering is "Merge into the base branch", which stays static and shared while still naming the destination by role.

Whichever is picked, the Settings hint at `SettingsView.tsx:359` needs its own correction in the same pass — "what every run does today" is false independently
of this label, and leaving it would just move the disagreement one screen over.
