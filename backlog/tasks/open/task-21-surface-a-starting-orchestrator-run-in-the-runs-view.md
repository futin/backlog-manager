---
id: task-21
title: Surface a starting orchestrator run in the Runs view
created: 2026-09-05
---

## Goal

A run started from the Board is visible on the Board strip within a second
(task-14) and invisible in Runs for the next 1–5 minutes. Runs is the surface a
person watches a run from; opening it right after pressing Orchestrate shows
either nothing at all (a project's first run) or the previous run sitting at the
top of history, both of which read as "the click did nothing" — the exact
failure task-14 exists to close, on the one surface it did not cover.

Close it the same way and no further: Runs gains a starting placeholder row.
This is a feedback row, not a run — it has no `runId`, no queue, no stages and
no history, and it must not pretend otherwise anywhere in this view.

## Plan

Behaviour, not code — the implementer writes the code and may disagree with any
line here that turns out wrong in the file.

1. **Read `starting`.** `RunsView` (`client/src/components/runs/RunsView.tsx:431`)
   destructures `runs: liveRuns` from `useOrchestratorRuns()`; that hook already
   returns `starting` and already polls while any entry is present. Take it.

2. **One collision filter, not two.** BoardView derives its rendered starting
   list at `BoardView.tsx:323` — drop an entry whose project already has a
   `running` run, fresh or crashed. Runs needs the identical rule for the
   identical reason (a crashed run renders a history row here, and the project
   would otherwise show a run row and a starting row at once). Hoist that
   predicate into a `client/src/lib/` module both views import — NOT an export
   from `BoardView`: Board and Runs are separate lazy chunks and an import
   between them undoes the split, which is why the Board/Archive shared filter
   key lives in `lib/view-keys.ts` rather than in either view. BoardView switches
   to the hoisted version in the same change; two agreeing expressions is the
   thing this repo has already been bitten by twice (`watchdogStoodDown`,
   `runEntryAt`).

3. **Where it renders.** Its own region above the pinned live region, so reading
   order is: starting, then fresh live runs, then history by day. A starting run
   is the most recent thing that happened by construction.

4. **What it does not touch.** The placeholder is excluded from `orderedRows`,
   from `selectedRow`, from `aggregateRuns`/`runStageTotals` and from the
   `projects` select's option list. It is not clickable and does not become the
   default selection: `RunDetail` is keyed on `project`+`runId` and there is no
   runId to give it. A project whose only entry is a starting one therefore
   still shows an empty detail pane — correct, and better than a pane inventing
   a run.

5. **Filters.** The project filter applies (an entry for another project is
   hidden). The range control does NOT: `inRange` reads `startedAt`
   (`lib/run-range.ts` states why that field and no other), a starting entry has
   only `requestedAt`, and every range this view offers ends at now, so an entry
   marked seconds ago is in scope for all four by definition. Render it
   regardless of range rather than teaching `inRange` a second field.

6. **Empty state.** The "no runs yet" string must not render while a starting
   row is showing — that is the exact case this task exists for.

7. **Row content.** Project label, a "starting…" label, and elapsed since
   `requestedAt`. Shaped like the other rows in this list, not like the Board's
   `run-strip`; `StartingStrip` is a strip component and reusing it here would
   drag the board's strip layout into a list. Whatever formats the elapsed
   number should be the one `StartingStrip` already uses, hoisted if it is
   currently local to that file.

8. **Older server.** `starting` is optional on the wire (`isOrchestratorRunsPayload`
   accepts it absent) and the hook already defaults it to `[]`. Nothing here may
   assume it is present.

## Test cases

The hoisted predicate (unit):

- No run at all for the entry's project → entry kept.
- A `running` **fresh** run for that project → entry dropped.
- A `running` **crashed** (stale) run for that project → entry dropped.
- A `done`/`aborted` run for that project and no `running` one → entry kept.
- A `running` run for a *different* project → entry kept.

`RunsView` (jsdom component):

- Payload with one starting entry, empty `runs`, empty archive → a starting row
  renders and the "no runs yet" empty state does not.
- Same payload plus a `running` run for that same project → exactly one row for
  the project: the run row, no starting row.
- Project filter set to a different project → starting row hidden; set back to
  its own project → shown.
- Each of the four ranges (Today / This week / This month / All) → starting row
  present in all four.
- Aggregate tiles render identical numbers with and without a starting entry in
  the payload (same archive + live runs in both).
- Clicking the starting row leaves `selectedRow` unchanged (or the row exposes
  no click target at all — either satisfies this, and the test asserts the
  detail pane's contents are unchanged).
- Payload with `starting` absent entirely → renders exactly as it does today, no
  throw.
- BoardView keeps its current starting-strip behaviour after the hoist — the
  existing task-14 board tests must pass untouched.

## Done when

- The cases above pass, `pnpm test` is green, `pnpm run typecheck` is clean.
- The collision rule exists once in `lib/` and both views call it; neither view
  imports the other.
- Pressing Orchestrate and switching to Runs shows the project immediately,
  before `run.json` exists.

## Notes

This is the visibility half of the `starting` gap. The gating half — dispatch
buttons, the Orchestrate control and the server's pre-spawn lock all staying
open through the same window — is bug-21, and the two are independent: this
task changes no gate and blocks nothing.
