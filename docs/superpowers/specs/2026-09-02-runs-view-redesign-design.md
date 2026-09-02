# Runs view redesign (range picker, stage track, machine time) — design

Date: 2026-09-02
Status: approved (user-reviewed via remote decision session: four
option picks, then an interactive HTML mockup on real run data)

## Problem

The Runs section's detail pane (`RunDetail.tsx`, from the 2026-09-01
orchestration-archive design) is technically complete and practically
unreadable. Looking at a live run:

- The per-item **stage bar** is a 4px strip whose segments are all the
  same colour. Every pipeline stage (`dispatched` … `merging`) maps to
  the single `active` tone in `STAGE_TONE`, so a bar meant to show
  "where did the time go" renders as one cyan line with hairline seams.
  The colour vocabulary is semantic on purpose (cyan = live, green =
  done, amber = a human, red = broken) and cannot be widened to six
  stage hues without breaking that legend everywhere else.
- The **per-stage durations** — the most useful thing the pane knows —
  live in a 10px `--ink3` caption under that bar
  (`pending 1m · preflight 2m · dispatched 42m · …`). The user's words:
  "not visible at all".
- The **drawer's seven-dot stepper** (`RunDrawer.tsx`) is the design the
  user actually reads, but it exists only in the slide-out, at 6px dots
  with 5px gaps. The pane it should scale into is ~1000px wide.
- There is **no time window** on the statistics: the tiles aggregate
  everything ever recorded, filtered by project only.

Reading the code alongside the screenshot turned up three defects that
are not matters of taste:

1. **Item wall time counts queue wait.** `itemWallMs` (run-stats.ts)
   spans first stamp to last stamp *including* `pending`, while the
   drawer's `itemDurationMs` (run-time.ts) deliberately excludes it.
   Real data, run `run-20260901-112815`: bug-7 reads **161m** in the
   pane and **25m** in the drawer — the other 136 minutes were the four
   items ahead of it in the queue. The same number feeds the "avg item"
   tile, so the headline statistic is inflated by queue position.
2. **`runStageTotals` is exported, tested and never rendered.** The
   2026-09-01 spec's run-level "stage-time breakdown" was never surfaced.
3. **A live item shows no in-stage time.** `itemStageSpans` covers
   closed spans only; the drawer's "now fixing · 2m 08s in stage" has no
   equivalent here.

## Decisions taken (with the user, in order)

1. **"Timeline" means a range picker, not a chart.** A segmented control
   — Today / This week / This month / All — scopes the tiles, the run
   list and the new stage rollup together, exactly as the project filter
   already does. Rejected: a bars-over-time chart under the tiles (13
   runs exist on disk; the chart would be mostly empty — revisit when
   there is a month of history), and a chart-only control.
2. **Per-item time is the drawer's stepper, scaled up.** Seven nodes at
   full pane width, each with its stage name and its duration printed
   beneath; the current node pulses and its duration ticks; fix loops
   become a `×N` badge on the `fixing` node. Rejected: a tall
   proportional bar with in-segment labels (a 15s `merging` beside a
   42m `dispatched` never gets room for a label, and the one-tone
   problem above stands), and a stage × item table (densest, but throws
   away the drawer look the user asked to keep).
3. **A run-level "machine time by stage" rollup**: one horizontal bar
   per stage, in the detail pane for the selected run *and* as a wide
   tile for the whole range in scope. Surfaces `runStageTotals` at last.
4. **The first-arrival blur stays.** `stageAt` keeps recording only each
   stage's first arrival; no `orchestrate.mjs` change. The `×N` badge
   marks where a second pass happened, and the documented folding (the
   second `reviewing` pass lands inside whichever span was open) is
   accepted for now. Rejected for now: an append-only `transitions[]`
   log in the run file — exact per-pass times for future runs, at the
   cost of touching the CLI, its node tests and the resume path.
5. **Mockup approved as drawn** —
   `docs/superpowers/specs/2026-09-02-runs-view-redesign-mockup.html`, a
   standalone page (open it in a browser; no server needed) built on real
   run data from `~/.backlog-manager/orchestrator` as of 2026-09-02, with
   two selectable runs (the IXRAY live row and the backlog-manager 17:07
   row), a working range control and project filter, and a frozen clock
   that ticks from page-open so the live parts move. Everything below
   describes that mockup precisely enough to build without it; the file
   is the visual reference, not the contract.

## Non-goals

- **No server or API change.** Both orchestrator endpoints already carry
  every field this needs (`startedAt`, `updatedAt`, `stageAt`,
  `fixLoops`, `verification`). The single-writer/single-reader invariant
  is untouched.
- **No `orchestrate.mjs` change** (decision 4).
- **No chart over time** (decision 1).
- **No persistence of the range.** Component state, default `all`,
  matching the project filter's own non-persisted `useState`.
- **No change to what `RunDrawer` looks like.** One helper (`RowTime`)
  moves out of it into a shared file so both surfaces read an item's
  time through one implementation; the drawer's rendered output is
  pinned by its existing suites and must not change.
- **No change to Board, RunStrip or ItemCard.**

## Definitions — the vocabulary the lib encodes

These are the rules; `client/src/lib/` is where each has exactly one
implementation.

- **Queue wait** — `pending` stamp to the item's first non-`pending`
  stamp. Waiting for the items ahead in the queue. It is *not* work on
  this item and is excluded from every duration below; it is shown only
  as muted context.
- **Item work time** — `itemDurationMs` (run-time.ts), unchanged: first
  non-`pending` arrival to the terminal stage's own stamp (falling back
  to the last recorded arrival), or to `now` while the item is still
  moving. `run-stats.ts`'s `itemWallMs` is **deleted**; `aggregateRuns`
  imports `itemDurationMs` instead of re-deriving a second, disagreeing
  rule. `run-stats.ts`'s file header currently argues that it should not
  import `run-time.ts`; the new reason it does — one rule for "how long
  did this item take", read by the drawer, the pane and the tiles — is
  stated there in place of that argument.
- **Stage span** — `itemStageSpans`, unchanged: the gap between two
  consecutive recorded arrivals, labelled by the earlier stage.
- **Open span** — for an item whose stage is not terminal
  (`isTerminalStage`, run-time.ts): current stage's arrival to `now`.
  This is `inStageMs` (run-time.ts), already written.
- **Machine time by stage** — the sum over a run's items of every span
  whose label is in `MACHINE_STAGES`, plus, for each non-terminal item
  whose current stage is in `MACHINE_STAGES`, that item's open span.
  `MACHINE_STAGES`, in pipeline order:
  `preflight, dispatched, inspecting, reviewing, fixing, verifying, merging`.
  Spans labelled `pending` (queue wait) and spans labelled by any
  terminal stage (a `parked` item that later gained a stamp, say) are
  excluded. This is `runStageTotals(run, now)`; the range-level number is
  the field-wise sum of it over every run in scope.
- **Range** — a calendar-aligned window in the viewer's local time,
  tested against the run's `startedAt`:
  `today` = since local midnight; `week` = since the most recent Monday
  00:00 local (a Sunday belongs to the week that started six days
  earlier); `month` = since the 1st of the current month 00:00 local;
  `all` = no filter. A run whose `startedAt` will not parse is in `all`
  only. Local rather than UTC for the reason `dayKey` already gives: "this
  week's runs" only means something against the viewer's own calendar.
  Keyed on `startedAt` rather than `updatedAt` because that is what the
  day groups already key on; a run that started at 23:50 and finished
  after midnight sits under yesterday in both places.
- **The blur, restated once.** `stageAt` is first-arrival only, so a
  fix-looped item's second pass through `reviewing` is invisible as its
  own span and folds into the span that was open when it happened (see
  `itemStageSpans`'s KNOWN BLUR note). The track shows `×N` on `fixing`
  wherever `fixLoops > 0`, which is the honest tell that the durations
  around that node span more than one pass.

## Layout

### Toolbar

`RunsView`'s existing `.board-bar`: title, then `.board-tools` holding
the **range control** and the existing project `<select>`, in that
order. The range control is a segmented group of four `<button>`s
(`role="group"` with `aria-label="Range"`; each button carries
`aria-pressed`), styled to sit beside `.board-select`: the same steel
well, hairline border and 10px mono; the pressed segment gets `--strip-hi`,
`--ink`, and a 2px cyan inset rule along its bottom — the rail's own
`.rail-link.on` idiom for "the one that is on". No new colour.

Range and project both narrow the same `filtered` list; every number and
row below the bar is computed from that one list.

### Tiles

The existing five tiles, with one change and one addition:

- **avg item** becomes **avg item work**, computed with `itemDurationMs`
  over merged items (queue wait excluded — that exclusion is stated in a
  substat line under the label, the way the runs tile already carries a
  substat).
- A sixth, **wide tile**: label "machine time by stage", a right-aligned
  substat naming the scope (`today` / `this week` / `this month` /
  `all runs`, then `· queue wait excluded`), and the StageBars widget
  (below) over the range's summed `runStageTotals`. Grid:
  `repeat(5, minmax(0, 1fr)) minmax(300px, 2.3fr)`; under 900px three
  columns with the wide tile spanning the row; under the existing 700px
  breakpoint two columns, wide tile still spanning.

### Split

Unchanged structure (200px list, `1fr` detail).

**List.** Same pinned-live region and day groups, over the range- and
project-filtered rows. When the filter leaves nothing, the list shows a
single note `no runs in this range` in the existing `.drawer-empty`
register; the view-level `no runs yet` empty state stays reserved for the
case where both payloads are genuinely empty. Selection falls back to the
newest visible row, exactly as today.

**Detail pane** (`RunDetail`), top to bottom:

1. Header row and chips — unchanged.
2. **Machine time by stage** — a section heading in the pane's existing
   small-caps register with a right-aligned `queue wait excluded`
   sub-label, then StageBars over `runStageTotals(authority, now)`. For a
   live run this includes the current item's open span, so the row for
   the stage it is in grows as the pane ticks.
3. **Items** — one card per queue item:
   - head: id · title · stage chip · **RowTime** at the right margin.
     `RowTime` is the drawer's own function, moved verbatim to a shared
     file: `<work> · <HH:MM>` for a finished row, `<work> elapsed` for an
     active one, `—` for `pending`, nothing for `ungroomed`/`skipped`.
   - a muted **lead line**: `queue <wait>` and, when a `preflight` span
     exists, `· preflight <span>`. Omitted entirely when neither is known.
   - the **StageTrack** (below).
   - the verification `<details>` — unchanged (last entry only, failed
     seeds open).
   - The separate `N fix loops` line is **removed**; the track's badge
     carries it.
4. Attention — unchanged.

### StageTrack

The drawer's `STEPPER_STAGES` (run-time.ts) — `dispatched, inspecting,
reviewing, fixing, verifying, merging, merged` — as a seven-column grid
spanning the card. Not eight: `pending` and `preflight` stay off the
track for the reason `STEPPER_STAGES`'s own comment gives (nothing about
the item is happening yet), and the lead line already prints both.

Per node, top to bottom: a 10px dot on a 2px horizontal line, the stage
name (10px mono), the duration (12px mono, semibold, tabular).

- **Dot state** comes from `stepperDots(item)`, unchanged: `filled`
  (visited, green `--good`), `current` (cyan, with a soft pulsing ring —
  `prefers-reduced-motion` disables the pulse), `hollow` (never entered).
  A stage skipped between two visited ones stays hollow *on a green line*
  — "passed through without stopping", the fact the drawer's comment
  calls the most useful thing the row says.
- **Line segments.** Let `last` be the index of the last visited node.
  The segment entering node `i` is green when `i ≤ last`, hairline
  otherwise; the segment leaving node `i` is green when `i < last`,
  hairline otherwise. The segment entering the `current` node is
  instead cyan with a slow sweep animation along it — the "moving line".
  Reduced motion renders it as a solid cyan segment.
- **Duration under each node:** the node's stage span from
  `itemStageSpans` when it has one; for the `current` node, `inStageMs`
  (ticking); for the last node when the item is `merged`, the finish
  clock (`formatClock`, secondary ink) instead of a span, because the
  last arrival has no span and "when did it finish" is the question left;
  `—` in muted ink for a hollow node.
- **Badge:** when `fixLoops > 0`, a small `×N` pill beside the `fixing`
  dot, with `title` and `aria-label` reading `N fix loop(s)`.
- **A11y:** the stage name is printed under every dot, so no dot needs
  its own label; the dots are `aria-hidden`. The chip in the head still
  names the current stage in words.
- Rendered for every row but `ungroomed` (which never entered the
  pipeline), matching `RowStepper`'s own rule.

### StageBars

One horizontal bar per `MACHINE_STAGES` entry, always all seven, always
in pipeline order (the categories are ordered, and a stable row set keeps
the run-level and range-level instances of the widget comparable at a
glance). Row grid: label (mono 10px, `--ink2`) · track · value (mono
10.5px, `--ink`, tabular, right-aligned). Bars: single hue (`--cyan`),
6px tall, square at the baseline and rounded at the data end, scaled to
the largest value in the set, `min-width: 2px` so a real 23s stays
visible beside a 46m; a 1px `--hairline2` baseline on the left of the
track column. An absent or zero stage draws no bar and prints `—` in
muted ink. No legend (one series), no gridlines, no in-bar labels.

### Live ticking

`RunDetail` reads its clock from `useNow(live !== null, 1_000)` instead
of `Date.now()` per render: the current node's duration, the active
row's `elapsed`, and the live run's rollup row must move every second,
and the 5s poll re-render alone makes them jump five seconds at a time.
`useNow` installs no interval when the selection is not live, so an
archived run renders as a pure function of its props exactly as today.
`RunsView` keeps its per-render `Date.now()`: its list walls print in
compact form, where a 5s cadence is already the right one.

## Components and files

- `client/src/lib/run-range.ts` — **new.** `RUN_RANGES` (the four keys,
  in display order), `RunRange`, `RANGE_LABEL`, `rangeStart(range, now)`
  (`null` for `all`), `inRange(startedAt, range, now)`.
- `client/src/lib/run-stats.ts` — delete `itemWallMs`; `aggregateRuns`
  computes `avgItemWorkMs` (renamed from `avgItemWallMs`) via
  `itemDurationMs`; `runStageTotals(run, now)` per the definition above;
  export `MACHINE_STAGES`; add `sumStageTotals(totals[])` for the range
  tile. File header's "do not import run-time" paragraph rewritten.
- `client/src/lib/run-time.ts` — export `itemQueueWaitMs(item)` (pending
  stamp → `startedAtMs`, `null` when either side is missing).
  `startedAtMs` stays private.
- `client/src/components/board/RunRowTime.tsx` — **new.** `RowTime` and
  `TIMELESS_STAGES`, moved verbatim from `RunDrawer.tsx`, which imports
  them back. Rendered output identical.
- `client/src/components/runs/StageBars.tsx` — **new.**
- `client/src/components/runs/StageTrack.tsx` — **new.**
- `client/src/components/runs/RunDetail.tsx` — rollup section, item
  card rewrite (RowTime, lead line, StageTrack; bar, caption and
  fix-loops line removed), `useNow`.
- `client/src/components/runs/RunsView.tsx` — range state and control,
  range filter, wide tile, tile relabel, range-empty note.
- `client/src/styles.css` — new `.runs-seg*`, `.runs-tile-wide`,
  `.run-bars*`, `.run-track*`; delete `.run-detail-stagebar`,
  `.run-detail-seg`, `.run-detail-caption` and the six `.run-seg-*`
  tone classes (nothing else reads them).
- Docs: CLAUDE.md layout bullet for Runs; a new invariant bullet in
  CLAUDE.md and section in `docs/invariants.md` — **queue wait is not
  work**: `itemDurationMs` is the one implementation of an item's
  duration, read by drawer, pane and tiles alike, and machine time
  excludes `pending`; the bug-7 161m/25m measurement is the reason.

## Error handling

Every derivation keeps the lib's existing contract — `null` or a skipped
entry, never a throw, on an unparseable stamp — and each surface has a
defined rendering for that `null`: a track node prints `—`; the lead
line omits whichever half is unknown and disappears when both are; the
rollup skips the span; `RowTime` degrades exactly as it does in the
drawer today. A run with an unparseable `startedAt` appears only under
`all` (it has no honest day to be windowed into). An empty range renders
the list note above, tiles computed over an empty scope (`0`, `—`) and a
wide tile of seven `—` rows — never a hidden section, so the control
visibly did something.

## Testing

Jest, flat in `test/`, cases not code — the implementation plan carries
the full case list. Coverage the plan must include:

- `run-range`: each window's start against fixed local instants
  (including a Sunday for `week` and the 1st for `month`); `all` is
  `null`; unparseable `startedAt` is in `all` only; exact-midnight
  boundary is inclusive.
- `run-stats`: `avgItemWorkMs` excludes queue wait (a fixture whose
  `pending` stamp precedes `preflight` by an hour must not move the
  average); `runStageTotals` excludes `pending` and terminal-labelled
  spans, includes a live item's open span (and not a terminal item's),
  keys only `MACHINE_STAGES`; `sumStageTotals` over an empty list is
  `{}`; `itemWallMs` no longer exists.
- `run-time`: `itemQueueWaitMs` normal / missing pending / pending-only.
- `RunDetail`: track renders seven nodes with name and duration per
  node; hollow skipped node between visited ones; current node ticks
  under fake timers and is not rendered for a finished run; `×N` badge
  present iff `fixLoops > 0`; lead line content and omission; rollup
  rows including the live open span; head time excludes queue wait
  (fixture modelled on the bug-7 measurement); no track for `ungroomed`;
  the old stagebar/caption testids are gone.
- `RunsView`: four range buttons with `aria-pressed`, `all` pressed by
  default; `today` narrows list, tiles and wide tile together and composes
  with the project filter; range-empty note; wide tile renders one row
  per `MACHINE_STAGES` entry in order; `avg item work` label.
- `RunDrawer` suites (`orchestrator-drawer`, `run-time-ui`) pass
  unchanged after the `RowTime` move.
- Style tests: the existing `run-stepper-style` suite is unaffected (the
  drawer keeps its classes); no new style test unless a rule is
  load-bearing and invisible to jsdom, per the existing pattern.
