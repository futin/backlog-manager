---
id: task-38
title: Runs: figures lead, the split, the Watchdog page, the stage track (DESIGN.md 8.4)
created: 2026-09-15
tags: fe-redesign, runs
updated: 2026-09-16T08:28:50Z
started: 2026-09-16T06:56:42Z
execute-elapsed: 5528
execute-tokens: 809590
---

## Goal

Redraw Runs into shape D (`03-runs-shape.html`): a figure strip leading the
page, then a 420 px list column (a Live sheet, then a History sheet) beside
one always-visible detail sheet, with Watchdog as its own page reached
through the rail's sub-nav tree. This is also where every rule that lived on
`RunStrip`/`StartingStrip`/`RunDrawer` before `task-37` deleted them has to
actually land, not just be read about — the moved-rules table in the Plan
below is this task's real acceptance surface, as much as the visual shape is.

**Depends on `task-36`** (Foundation): this task composes `Band`,
`FigureStrip`/`Figure`, `Sheet`/`SheetHead`, `Ledger`/`DayKicker`, `Chip`,
`Pill`, `Dot` from `client/src/components/ui/`, and reads the rail's sub-nav
tree, which already writes `RUNS_MODE_KEY` (`client/src/lib/runs-mode.ts`) by
the time this task starts. It does **not** depend on `task-37`'s own board
work landing first in any functional sense — Runs reads `useOrchestratorRuns`
independently of the Board — but the orchestrator drains tasks in id order,
so `task-37` will in practice already be merged.

## Plan

Authority: `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` §4
(lines 365–546, subsections 4.1–4.3) and `.claude/DESIGN.md` §8.4, §8.4.1,
§8.4.2, §8.4.3. Read all four in full — this is the largest of the six
tasks and the spec's own citations (`file.ts:line`) inside them are accurate
against today's tree; re-verify line numbers you rely on against the actual
worktree rather than trusting them to still be exact, the same caution
`task-9`'s own record left for whoever reads it after two merges moved the
lines it cited.

**Where today's code already stands, so this reads as a redraw and not a
rebuild from nothing:** `client/src/components/runs/RunsView.tsx` already
renders `RunDetail` inline, selected and beside a list (`RunDetail` import,
`onSelectRun`, the `run-detail-slot` — it is not a modal today and never
becomes one), and already switches between a "runs" and a "watchdog" mode
via `RUNS_MODES`/`RUNS_MODE_KEY` (`lib/runs-mode.ts`) through its own
in-page segmented control. This task's job is narrower than "build the
split from scratch": restyle and re-shape what already exists into D's
figure-strip-first layout and the Live/History row split, split "Runs" into
two real pages under the rail's tree instead of one page with an in-page
toggle, and **remove that in-page segmented control now that the rail's
sub-nav tree (landed in `task-36`) is the one place that switches modes** —
leave both in place and you have two controls doing one job, which is
exactly what this redesign's rail work was for.

### 1. History — spec §4.1, DESIGN.md §8.4.1

Top to bottom, as one page (the rail's default Runs destination):

1. **Band** (`Band` primitive): `Runs`, the three-state count line
   (`3 live · 1 starting · 28 past`), project select and range control as
   chips.
2. **Figure strip** (`FigureStrip`/`Figure`), directly under the band —
   five figures reading `aggregateRuns` (`client/src/lib/run-stats.ts`) and
   nothing else, wrapping 5→3→2 under 1100/700 px: **runs** (line: the
   five-status breakdown via `STATUS_ORDER`), **completed / queued** (line:
   `merged or branched`), **avg item work** (line: `queue wait excluded`,
   the same rule `itemDurationMs` enforces), **rework / completed** (the
   one-decimal `fixLoopsPerMerged` ratio, `run-stats.ts`), **verify pass**
   (a rate over verification runs, not items). The wide machine-time tile
   becomes the sixth cell, full width: `StageBars` (`client/src/components/
  runs/StageBars.tsx`) redrawn at 10 px bar height, always seven rows in
   `MACHINE_STAGES` order, `—` for a stage never recorded, line `<range> ·
   queue wait excluded`. Hides with the list under an empty range/project
   filter, as today.
3. **The split**: a 420 px list column (Live sheet, then History sheet)
   left, one detail sheet right; stacks under 1100 px (list first), full
   width under 700 px.
4. **Live sheet** — rows, not cards, one per run that is `running`,
   `paused`, or `starting`. Everything C's live card carried that does not
   fit a 420 px row (run id, start clock, heartbeat word, `$ · turns ·
   sessions`, mode pill, `paused after <id>`, the stage track) moves to the
   detail sheet.
5. **History sheet** — day kickers, 44 px rows carrying the dot **and** the
   status word from `runStatusChip` (`client/src/lib/run-stage.ts`) — a dot
   alone cannot tell `done`/`aborted`/`failed` apart. Load-more, 25 at a
   time. A row selects into the detail sheet; nothing opens.
6. **Detail sheet** — head: project, run id, item count when finished, and
   `RunControls` (§2 below covers what changes inside it). Body: the whole
   of `RunDetail` (`client/src/components/runs/RunDetail.tsx`) re-flowed to
   one column, in the order DESIGN.md §8.4.1 gives: facts strip, mode/
   question notes, chip row (merged/branched/skipped/attention/fix loops,
   plus active/queued while live), attention entries, machine time by stage
   (`StageBars` scoped to the one run), branches to merge, then items in
   pipeline order with the stage track (§3 below) and per-item usage.
7. **Selection** is one run across both sheets: the first live run selected
   on arrival, else the newest History row. Empty states unchanged
   (`no runs yet`, `no runs in this range`).

### 2. The moved-rules table — DESIGN.md §8.4.1's own table, made concrete

Each row below is a rule stated in `CLAUDE.md` and reasoned in
`docs/subsystems/invariants.md` against a surface `task-37` just deleted.
The rule stands; this task is where its new home actually gets built —
reading DESIGN.md's table is not enough, each row is a checkable piece of
this task's own diff.

| Rule | Concrete work in this task |
|---|---|
| A crashed run renders as crashed, never as nothing | The Live sheet's crashed row: `--red` dot, `crashed` pill, a second 12 px `--amber` line carrying `no heartbeat for <age>`, then `last reported <id> at <stage>` (or `all items at rest`), then `watchdogClause` (`client/src/lib/run-watchdog.ts`) — all three readings together, or the row says less than the strip it replaces did. A finished crashed run appears once as a History row, never in both lists. |
| Resume for a crashed run stays on the strip alone → collapses to the detail sheet's head alone | The detail sheet's head is the **only** place a crashed run's Resume appears now, gated by `watchdogStoodDown` (`shared/agent.ts`). Resume for `paused` — today on the strip *and* on `RunDetail` via `RunControls` — also collapses to this one place, so there is exactly one Resume per run state, never two to keep in agreement. |
| A resume is serialized at three layers (bug-19), layer 1 | **Read `client/src/components/RunControls.tsx` before touching it — it already has a synchronous `busy` guard covering its existing `pause`/`cancel`/`resume` actions (`act()` checks `busy` before any request goes out, `finally(() => setBusy(false))` — verified in this worktree, not assumed).** What it does **not** have is any branch for a `crashed` run at all — it renders `null` for anything but `running && fresh` or `paused`. This task adds the crashed-run branch to the detail sheet's head (Resume gated by `watchdogStoodDown`), and that branch **must dispatch through the same `act`/`busy` mechanism the existing branches use** — not a second, independent state variable — because a second guard is exactly the shape that regresses this bug: a synchronous guard that does not cover every branch is no guard at all. `test/watchdog-coupling.test.tsx` is what now drives this from the detail head rather than from the deleted strip. |
| The board offers a hand resume exactly when the watchdog will not | Both the detail sheet's head and the Watchdog page's `Resume now` chip (§3 below) read the one function, `watchdogStoodDown` — neither re-derives the condition. |
| A board-started run is visible before its run file exists | The Live sheet's `starting` row: `starting… · <age>`, no controls, **not selectable** — there is no run file yet, so the detail sheet has nothing to show for it. |
| The toolbar Orchestrate control hides on a starting entry | Unchanged — this task does not touch that control or its `runClaimBlock` input. |
| `useOrchestratorRuns` polls while any run is `running`, fresh or not | Unchanged on the Runs side; both pages read the same hook instance's payload, no second poll. |

`useDialogEscape`'s dialog count (four → three) is **not** this task's
work: `RunDrawer.tsx` was already deleted by `task-37`, and updating
`invariants.md`'s "Escape has one owner" entry plus `CLAUDE.md`'s own line
is `task-40`'s (Overlays) — DESIGN.md's own §8.7 is where that edit is
discussed, not §8.4.1. Do not make that edit here.

One more invariants row lives on this surface and **is** this task's to
edit in place: task-27's "a session's cost is recorded per transcript"
(`docs/subsystems/invariants.md`), which today names "Runs row foot
(`wall · $`), detail head (`$ · turns · sessions`), per item" as where the
reading shows up. Nothing about *what* task-27 recorded or how changes —
only the surface names do, to the History row (`wall · $`), the detail
sheet's facts strip (`$ · turns · sessions`), and the per-item usage line.
Edit the entry's prose to match, in place, rather than leaving it naming a
row that no longer exists.

### 3. Watchdog — spec §4.2, DESIGN.md §8.4.2

### 3. Watchdog — spec §4.2, DESIGN.md §8.4.2

Its own page, reached through the rail's Watchdog sub-nav entry (already
wired to `RUNS_MODE_KEY` by `task-36`). Redraw today's
`client/src/components/runs/WatchdogMonitor.tsx` rather than starting over:

- **Band**: `Runs · Watchdog`, `stateLine` (`client/src/lib/
  run-watchdog.ts`) as the 13 px subtitle, a flat `Policy in Settings ›`
  chip.
- **Three-figure strip**: Sweeper (phase as a 24/700 word, a 6 px
  `.hatch`ed sweep meter under it); Watching (`N crashed · N fresh · N not
  yet watched` — those exact words, not a paraphrase); Policy (three
  label/value pairs plus the enabled switch's state as its line). All three
  values are the saved config's, bounded by `WATCHDOG_LIMITS`
  (`shared/types.ts`) — no constant duplicated here.
- **Watching sheet**: one row per running run, annotated from `watching`
  exactly as today (skew rendered as `· not yet watched`, never hidden).
  The heartbeat meter's two labels are **formatted from `RUN_STALE_MS` at
  render time**, never a typed numeral — `heartbeat Ns ago` and `stale at
  <RUN_STALE_MS>` / `past the <RUN_STALE_MS> stale line` — so the label
  cannot go stale itself the day that constant moves. A `Resume now` chip
  renders **only** when `watchdogStoodDown` allows, whatever the grace
  clock says — the same function the detail sheet's head reads. The row is
  a button: it jumps to History and selects the run there (there is nowhere
  else for it to go under shape D).
- **Activity sheet**: the existing five-column event ledger
  (`time · kind · project · run · what the sweeper did`), the
  `WATCHDOG_EVENT_CAP`-only caveat kept in its subtitle, kind cell as
  `WATCHDOG_KIND_GLYPH` + word toned by `WATCHDOG_KIND_TONE`. Scrolls inside
  its own sheet under 700 px (`Ledger` primitive).

### 4. The stage track — spec §4.3, DESIGN.md §8.4.3

`StageTrack` (`client/src/components/runs/StageTrack.tsx`) keeps its seven
equal columns and its data; only the drawing changes. Four node states told
apart by **fill and ring together**, never by four shades of one colour:
reached `--fill-progress`; current `--fill-live` under a pulsing 3 px 30%
ring; not-reached `--steel` with a `--hairline2` ring; skipped (`fixing` on
a run with no fix loop) a **dashed** `--hairline2` ring — so "never needed"
and "not there yet" read apart by stroke, not by guessing from the duration
underneath. A `×N` fix-loop badge sits on the `fixing` node itself. Under
the track: the verification line (glyph, command in an inline code span,
summary).

## Test cases

Authority: spec §9. Existing suites this task rewrites rather than leaves
stale: `test/orchestrator-runs.test.ts` (or `runs-view.test.tsx`, whichever
currently covers `RunsView`), `test/watchdog-coupling.test.tsx`,
`run-detail-crashed-style.test.ts`, `run-drawer-tail-style.test.ts`,
`run-stage-chip-style.test.ts`, `run-stepper-style.test.ts`,
`run-track-style.test.ts`, `runs-list-scroll-style.test.ts` — check the
current file list in the worktree, since another session may have touched
some of these; move each suite's cases to the selectors this task
introduces rather than deleting any of them (spec §9's rule for
`*-style.test.ts` suites).

1. **History composes the five-figure strip (plus the sixth wide cell)**
   reading `aggregateRuns` alone — no invented prior-period delta, no
   parked count, no invented ratio; each figure's `line` matches spec
   §4.1's wording.
2. **Live sheet rows** — one row per `running`/`paused`/`starting` run, in
   the compact shape (dot, project, `⚠ N`, two-tone count, elapsed, earned
   pill only); a `starting` row has no controls and is not selectable
   (clicking it is a no-op, asserted directly).
3. **Crashed row carries all three readings together** — dot, `crashed`
   pill, `no heartbeat for <age>`, `last reported…`/`all items at rest`,
   and the `watchdogClause` sentence, in one assertion so a future edit
   cannot drop one silently.
4. **History rows carry the status word**, not just a dot — one case per
   `done`/`aborted`/`failed`/`paused`, each the tone the table above names.
5. **Selection is shared across both sheets** — selecting a History row
   updates the detail sheet; the first live run is pre-selected on mount
   when one exists.
6. **Detail sheet head — crashed-run Resume.** With `watchdogStoodDown`
   true, a crashed run's detail head renders `Resume run`; with it false,
   no Resume control renders anywhere for that run (neither head nor
   anywhere else) — the negative case matters as much as the positive one.
7. **The synchronous guard covers the new branch.** Firing two rapid clicks
   on the crashed-run Resume control results in exactly one
   `resumeOrchestrate` call — the direct regression test for bug-19's layer
   1 applied to the branch this task adds. Assert the call count, not just
   the rendered state.
8. **`test/watchdog-coupling.test.tsx` now drives the detail sheet's head**,
   not a deleted strip — every case in its existing hand-checked verdict
   table still passes, reading the new component.
9. **Watchdog page**: the three figures render their exact words (`N
   crashed · N fresh · N not yet watched`); the heartbeat meter's two labels
   read the live value of `RUN_STALE_MS`, asserted by changing the constant
   in a test double and checking the rendered string changes with it, not
   by pinning today's numeral; `Resume now` renders only under
   `watchdogStoodDown`, mirroring case 6 above but for this page.
10. **A watched id with no run in the payload renders a placeholder line**,
    not nothing — the skew case.
11. **Stage track** — the four node states render distinguishable
    fill+ring combinations (assert classes/attributes, not colour values);
    a `fixing` node with zero fix loops renders the dashed skipped ring, not
    the not-reached ring; a `×N` badge renders only on the `fixing` node
    when `fixLoops > 0`.
12. **No `useDialogEscape` change in this task's diff** — `RunDrawer.tsx`'s
    deletion (already `task-37`'s) is not re-done or re-asserted here, and
    `docs/subsystems/invariants.md`'s dialog-count entry is untouched by
    this task's diff (guards against duplicating `task-40`'s work here).
13. **No new derivation.** `client/src/lib/` predicates
    (`runClaimBlock`, `runHoldsItem`, `itemDurationMs`, `watchdogStoodDown`,
    `runStatusChip`, `aggregateRuns`) are read, never modified, by this
    task's diff.

## Done when

- `pnpm test` green on both runners, including every case above.
- `pnpm run typecheck` and `pnpm run build` pass.
- Runs renders as shape D — figure strip, 420 px split, Live/History rows,
  one detail sheet — with Watchdog as its own page reached through the
  rail, in all five themes, at 1400 px and 400 px wide.
- Every row of the moved-rules table above is implemented, not merely
  cited, and has a passing test naming it.
- Screenshot Runs › History and Runs › Watchdog at 1400 px and 400 px,
  daylight and midnight (spec §9), through a pid-owned static server killed
  by pid.
- `git diff --stat` against `main` touches
  `client/src/components/runs/RunsView.tsx`,
  `client/src/components/runs/RunDetail.tsx`,
  `client/src/components/runs/WatchdogMonitor.tsx`,
  `client/src/components/runs/StageTrack.tsx`,
  `client/src/components/runs/StageBars.tsx`,
  `client/src/components/RunControls.tsx`, `client/src/styles.css`, and
  test files. No change to `shared/agent.ts`, `shared/types.ts`, or any
  server route.

## Outcome

2026-09-16 — done. Runs is shape D: a band, a six-cell figure strip, a 420 px list column (a Live sheet over a History sheet) beside one always-visible detail
sheet, with Watchdog as its own page reached through the rail's sub-nav tree. The in-page segmented control is gone, and with it `runs-mode.ts`'s `MODE_BUTTON`
pair — the rail's tree is the one place the two views are switched, and a second exported wording could only have disagreed with it.

Every row of the moved-rules table is implemented and named by a passing case:

| Rule | Where it landed | Case |
|---|---|---|
| A crashed run renders as crashed, never as nothing | the Live sheet's row — `--red` dot, `crashed` pill, and all three readings in ONE amber line (`runs-live-crashed-<runId>`) so an edit cannot drop one silently. `splitLive`'s gate is "the payload still lists this run as `running`/`paused`", freshness deliberately excluded, which is what used to drop a crashed run into history among finished ones | `runs-view` "carries all three of a crashed run's readings together on one line" |
| Resume for a crashed run → the detail sheet's head alone | `RunControls` gained the crashed branch behind `watchdogStoodDown`; the paused branch's Resume is the same control, so there is exactly one Resume per run state | `watchdog-coupling` (7 rows), `run-controls` "offers Resume, and only Resume, once the sweeper has stood down" |
| A resume is serialized at three layers, layer 1 | the crashed branch dispatches through the SAME `act` every other branch uses — no second state variable | `run-controls` × 3 double-click cases |
| The board offers a hand resume exactly when the watchdog will not | one function AND one COMPONENT: the Watchdog page's Resume is `RunControls` itself, so `WatchdogMonitor` never calls the predicate | `watchdog-coupling` reader-list case, asserted as an exact set |
| A board-started run is visible before its run file exists | the Live sheet's first rows — `starting… · <age>`, no controls, not selectable (asserted by a click, not by the absence of a handler) | `runs-view` "leads the Live sheet", "refuses to select a starting row" |
| The toolbar Orchestrate control hides on a starting entry | untouched | — |
| `useOrchestratorRuns` polls while any run is `running`, fresh or not | untouched | — |

**Three findings the work itself turned up, all fixed rather than filed:**

1. **The bug-19 guard was not synchronous.** `RunControls` guarded on a `useState` `busy`, so two clicks dispatched before React re-rendered both read `false` and
   both fired. It is now a `useRef` checked and assigned in the same turn, with the state kept for the rendering half. Found by the red proof: the first version
   of the double-click case passed with `if (busy) return` deleted, because `userEvent.click` awaits between clicks and the second one lands on a control that
   has already swapped itself for `Resuming…` — the case was pinning the rendered state, not the guard.
2. **`WatchdogMonitor` crashed on `phase: 'idle'`.** The sweeper figure's countdown parsed `nextTickAt`, which is `null` for every phase but `armed`, and fed
   `NaN` to `formatSpanCompact`. Gated on `sweepFraction`'s own verdict so the bar and the words under it can never disagree about whether a tick is pending.
3. **The History sheet's empty state had no way to say "nothing has finished yet".** With a starting placeholder and an empty archive it printed `no runs in this
   range`, sending a reader hunting through a range control for runs that do not exist. Three states now, in a fixed precedence.

**Deviations from the plan, each deliberate:**

- **The plan's line citation was stale.** It cites spec §4 at "lines 365–546"; the spec is 505 lines and §4 is 238–332. Read against the headings, as the plan's
  own caution says to.
- **Five files outside the plan's `git diff --stat` list are touched**, all additive and all for the same reason — §12.1 says a surface that needs a variant adds
  a PROP: `ui/Figure.tsx` (`cols`, `title`, `testId`, optional `value`, `children`), `ui/Ledger.tsx` (optional `columns`, so a real `<table>` can have the box
  without the grid), `ui/ProgressRow.tsx` (a `warn` fill for the heartbeat meter past its stale line), `lib/run-stage.ts` (`runDotTone`, additive — every
  existing export is byte-identical, `git diff` shows no removed line), and `lib/runs-mode.ts` + `SideRail.tsx` (the `MODE_BUTTON` removal). `shared/agent.ts`,
  `shared/types.ts` and every server route are untouched.
- **`StageBars.tsx` itself is unchanged** — its 10 px redraw is entirely CSS, and the component already drew "always seven rows, `—` for a stage never
  recorded".
- **The sweeper's phase renders at the strip's 30/700, not §4.2's 24/700.** `.ui-figure-value`'s type scale belongs to the primitive, and a per-page override
  would be exactly the restatement §12.1 forbids.
- **The Watchdog page's Resume reads `Resume run`, not the mock's `Resume now`** — because it IS `RunControls`, which is what makes "one function, not two
  agreeing expressions" true at the component level rather than at the call level.
- **§8.4.1 puts the crashed sentence in the `status` fact; it is drawn as the boxed `.run-detail-crashed` line immediately under the strip.** That line's own
  style guard (`run-detail-crashed-style.test.ts`) requires the box, and a boxed alert inside one narrow cell of a wrapping facts grid is not readable. The
  `status` fact still says `crashed` through `runStatusChip`.
- **The six figures keep their `runs-tile-*` test hooks.** The tile became a `Figure`; the reading did not change, and renaming thirty assertions would have
  churned the suite without pinning anything new.
- **Test case 9's "change the constant in a test double" could not be written.** Swapping `shared/types` needs `jest.resetModules`, which hands the re-imported
  component a second copy of React and every hook throws before a label is drawn (attempted, reverted). Replaced by two mechanisms that between them cover both
  failure modes: the rendering cases compute their expected strings from the imported constant (catches a typed numeral), and a source guard asserts the format
  call sits inside the JSX that draws each label and that the file spells the window nowhere (catches a module-scope freeze).
- **`docs/subsystems/board.md` is left describing the old Runs surface** — spec §11 assigns its rewrite to task 6 (`task-41`).

Verification:

```
$ pnpm run typecheck
$ tsc --noEmit

$ pnpm run build
✓ built in 1.04s

$ pnpm test
Test Suites: 101 passed, 101 total
Tests:       1666 passed, 1666 total
# pass 538
# fail 0
pnpm test: both runners passed.
```

Screenshots: Runs › History and Runs › Watchdog at 1400 px and 400 px, daylight and midnight — eight files under `.playwright-mcp/` (gitignored), taken against
a real API this session started on port 4399 (`PORT=4399 BM_AGENTS=off BM_WATCHDOG=off`, so nothing could spawn) serving the built client and this machine's real
run state, including this very run as the Live row. Killed by its recorded pid, never by pattern; the user's own API on 4322 was untouched throughout. The
Watchdog page necessarily shows `off — BM_WATCHDOG off`: reaching `armed` would have needed `BM_AGENTS` on, which in an unattended run risks a real spawn.

Contract sweep: 6 sites updated (client/src/lib/runs-mode.ts, client/src/components/SideRail.tsx, test/rail.test.tsx, CLAUDE.md, docs/subsystems/invariants.md,
test/watchdog-coupling.test.ts→.tsx). CLAUDE.md's resume-coupling and crashed-run bullets, its pause entry's "lands on the Runs detail head in task-38", its
`client/src/` layout line and its starting-entry bullet now name the surfaces that exist; invariants.md's crashed-run, resume-coupling and task-27 entries were
edited in place per spec §8, never deleted. Left standing on purpose: every `backlog/*/done/` item and every `docs/superpowers/plans|specs` file that names
`RunStrip`, `runs-tile` or `runs-day-live` — those are records of what was true when they were written, not statements the change makes false — and
`docs/subsystems/board.md`, whose rewrite spec §11 assigns to task-41.

Red proof: 18 tests went red with the change reverted, across seven separate reverts — StageTrack's `skipped` derivation (2 cases), `RunControls`' synchronous guard (3), the
`watchdogStoodDown` gate on the crashed Resume (6), one of the crashed row's three readings (1), the skipped node's dashed ring (1), `splitLive`'s
presence-not-freshness gate (2), and `runDotTone`'s no-tone-for-a-finished-run (3). Two of those proofs FAILED on the first attempt and are the reason two cases
now look the way they do: the double-click case was rewritten to dispatch both events in one `act` (and the production guard made synchronous), and
`runDotTone`'s verdict was pinned in `test/run-stage.test.ts`, which had no case for it at all.
