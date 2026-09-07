---
id: task-21
title: Surface a starting orchestrator run in the Runs view
created: 2026-09-05
updated: 2026-09-07T02:54:42Z
started: 2026-09-07T01:57:13Z
execute-elapsed: 3449
execute-tokens: 135674
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

## Outcome

2026-09-07 — Done. `RunsView` reads `starting` off the payload it already
polls and renders a `StartingRow` per entry in its own `.runs-day` group
above the pinned live region, so a run started from the Board is visible in
Runs from the moment the spawn resolves rather than 1–5 minutes later when
`init` writes `run.json`.

What landed:

- `client/src/components/runs/RunsView.tsx` — `starting` destructured from
  `useOrchestratorRuns()`; a `StartingRow` component (project label, the word
  `starting`, `elapsedSince(requestedAt)`, a `<div>` with no focusable child);
  `startingRows`, the project-filtered list; the region rendered above the
  pinned `live` group and outside the `filtered.length === 0` ternary; both
  empty states (`no runs yet`, `no runs in this range`) suppressed while a
  placeholder shows.
- `client/src/styles.css` — `.runs-row-starting` (dashed, `cursor: default`,
  plus the `:hover` override the base rule's higher specificity requires),
  `.runs-status-starting`, `.runs-row-starting-age`.
- `test/runs-view.test.tsx` — `renderRunsView` gained an optional third
  `starting` argument (defaulted, so every existing call site is unchanged)
  and a new `RunsView · a starting run (task-21)` describe with 11 cases.
- `CLAUDE.md` — the Runs entry in Layout now records the group and its rules.

**One deliberate deviation from the plan, in step 2.** The plan asked for
BoardView's client-side collision filter (drop an entry whose project already
has a `running` run, fresh or crashed) to be hoisted into `lib/` and shared.
That filter no longer exists to hoist: bug-21 merged after this item was
groomed, moved the rule server-side into `StartingRunsService.expired()` as
its third eviction rule, and deleted the board's copy — CLAUDE.md now carries
"the board maps `StartingStrip` straight over `starting`, with **no
client-side filter**" as an invariant, on the grounds that a client
expression merely agreeing with the server rule is the two-agreeing-
expressions shape (`watchdogStoodDown`, `isStale`) this repo pins tests
against. Re-introducing it in a second view would have been that shape twice
over, so `RunsView` reads `starting` straight too, and the plan's five unit
cases for the hoisted predicate are covered where the rule actually lives
(`test/orchestrator-starting.test.ts`). The plan's component case "same
payload plus a `running` run for that project → exactly one row" was dropped
for the same reason: that payload is one the server does not emit, and
asserting the client drops it would install the second expression. Both
decisions are stated at length in the code and in the new suite's own
docblock. Every other plan item and test case is implemented as written.

A second, smaller judgement call: with `merged.length === 0` and a
placeholder present, the view falls through to its normal layout — zeroed
tiles, the starting row alone in the list, an empty detail pane — rather than
gaining a third starting-only branch. Every one of those readings is true
(this project has run nothing yet), and a separate branch would give the same
section two layouts depending on whether any history existed. The empty
detail pane is what the plan's step 4 asks for.

Verification:

```
$ pnpm run typecheck
$ tsc --noEmit
(clean, no output)

$ pnpm test
Test Suites: 79 passed, 79 total
Tests:       1510 passed, 1510 total
# tests 415
# pass 415
# fail 0
pnpm test: both runners passed.

$ pnpm run build
✓ built in 1.46s
dist/assets/BoardView-idvepSEe.js    69.12 kB │ gzip:  9.50 kB
dist/assets/RunsView-BKkKPRWW.js     73.97 kB │ gzip: 10.47 kB
```

The two chunk names above are part of the proof, not decoration: Board and
Runs are still separate lazy chunks, which is what "neither view imports the
other" means at build time.

**One flake observed, reported rather than hidden.** During verification the
full jest run failed twice out of roughly nine consecutive runs on
`test/agents-origin-guard.test.ts › 403s a urlencoded POST to dispatch
without any outbound call` — `expected 403 "Forbidden", got 400 "Bad
Request"`. It was then chased deliberately: 11 consecutive green runs on the
tree with this branch's changes reverted, and 12 more consecutive green runs
with them restored and the assertion instrumented to print the response body
on failure — it never reproduced again, so no body was captured. This diff
touches no server, `shared/` or hook code at all (client component, CSS, one
client test file, CLAUDE.md), and `OriginGuard.canActivate` is a pure
function of the `content-type` header, so a 400 there means the request was
rejected by the body parser before the guard ever ran — a shared-process
artifact of `jest --runInBand`, not something this change can reach. Flagging
it as a latent test-infrastructure flake worth its own bug rather than
claiming it does not exist.
