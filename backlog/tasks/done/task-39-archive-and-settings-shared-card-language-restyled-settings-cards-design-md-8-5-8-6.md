---
id: task-39
title: Archive and Settings: shared card language, restyled settings cards (DESIGN.md 8.5-8.6)
created: 2026-09-15
tags: fe-redesign, archive, settings
updated: 2026-09-16T09:29:49Z
started: 2026-09-16T08:45:48Z
execute-elapsed: 2641
execute-tokens: 411746
---

## Goal

Redraw Archive to reuse the Board's own card and column language rather
than a second one, and restyle Settings onto the dashboard's borderless-card
language, without changing what either page groups, filters, or does when
clicked. Two unrelated surfaces sharing one task because neither is more
than a skin over structure the previous tasks (or, for Settings, today's
code) already got right — this task is not where Archive's columns or
Settings' groupings are decided, only where they are redrawn.

**Depends on `task-36`** (Foundation) and, for Archive specifically, on
`task-37` (Board): Archive's `ItemCard`/column language is the same
component `task-37` restyles, so Archive cannot look right until that
task's `ItemCard` and column header shapes exist. Settings only needs
`task-36`'s primitives (`Sheet`, the moved `Segmented`/`NumberField` plus
the new `Select`/`Switch`).

## Plan

Authority: `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` §5
(lines 547–572, subsections 5.1–5.2) and `.claude/DESIGN.md` §8.5, §8.6.

### 1. Archive — spec §5.1, DESIGN.md §8.5

`client/src/components/archive/ArchiveView.tsx` reuses `task-37`'s
`ItemCard` and column shape (spec §3.3–3.4) under the **same four columns it
already renders** — `ARCHIVE_COLUMNS`' `Refactoring`, `Ideas`, `Bugs`, `Out
of scope` (already exact today, not renamed by this task). **No fifth Tasks
column**: `leavesBoard` (`client/src/lib/item-stale.ts`) never lets a task
leave the Board, so a Tasks column here would only ever stand empty — this
task must not add one, and must not change `leavesBoard` to make one
possible either (that predicate is exactly the kind of thing "no new
derivations" forbids touching).

- Three of the four columns keep the ramp hue `task-36`/`task-37` set for
  their type — refactors `--amber`, ideas `--mustard`, bugs `--red` —
  because the tick names a type, and a type does not change once an item
  goes quiet. Out-of-scope's dot is a plain `--ink3` — a rejection is a
  verdict, not a type, and giving it a ramp colour would put it in the same
  vocabulary as the three columns that are still live work.
- Inside each column, cards group by month exactly as `groupByMonth`
  (`client/src/lib/item-month.ts`) already orders them — **this task
  changes only the month kicker's face**, to 13/500 `--ink2` riding the
  `--board` ground with no card of its own, so the month reads as a rule
  about the list rather than one more card. `groupByMonth`'s ordering logic
  is untouched.
- The band carries the project select and search **and nothing else** — no
  status filter, no sort control. Archive's contents are defined by
  staleness and rejection, not by status, so a status filter here would
  either do nothing or contradict the surface; the month grouping already
  is the ordering a sort control would otherwise offer. If `ArchiveView.tsx`
  renders anything else in its band today, remove it as part of this
  redraw rather than skinning it in place.
- No live strip ever paints on an Archive card — whatever put a card here
  already took it off the Board a run could be holding — and the one
  dispatch action an Archive card can still derive is `capture`
  (`shared/agent.ts`, `deriveAction`) on an out-of-scope item: the only
  `AgentAction` that section derives at all. This is existing behaviour;
  do not add or remove any action here.

### 2. Settings — spec §5.2, DESIGN.md §8.6

`client/src/components/settings/SettingsView.tsx` restates the dashboard's
own §8.2 card language rather than deriving a second one: a band header
(title 19/500, 13 px line), then borderless `Sheet` (from `task-36`) cards
at 16 px radius and 24 px padding, each a title + one-line subtitle. **The
five existing groupings are unchanged** —`Display · this device`,
`Board · this device`, `Orchestrator · this device`, `Claude Agents · this
machine` (all four already in `SettingsView.tsx`), plus
`WatchdogGroup.tsx`'s own `Orchestrator watchdog · this server` card,
rendered from its own file as it is today. **This task restyles the cards,
it does not change what they group.**

- Rows inside stay boxless: 16 px vertical padding, a hairline between,
  name 15/500 over a 13 px hint left, control right.
- One 36 px control family carries every row's control: `Select`,
  `NumberField`, a text field, a button — all from `task-36`'s `ui/`
  primitives. The on/off rows and the theme/density pickers take `Switch`'s
  pill shape (a recessed `--steel` track under a raised `--strip` option) —
  **a raised control marks a state, never a button**, the rule DESIGN.md
  states once in its §8 preamble and expects every subsection to honour.
- `Segmented` and `NumberField` are imported from `client/src/components/
  ui/` now (moved there by `task-36`) — update `SettingsView.tsx`'s and
  `WatchdogGroup.tsx`'s imports away from `./SettingsRow` if `task-36`
  hasn't already updated every call site; verify rather than assume it did,
  since `task-36`'s own scope statement only promises the move plus fixing
  up "every current importer" it found — check for stragglers.
- The theme picker's swatch buttons (`.set-theme`, `.set-swatch`,
  currently in `SettingsView.tsx`) move onto the same track-and-option
  ground the `Switch` primitive establishes, rather than today's bordered
  tile — but **the swatches themselves keep their job at 24 px and 8 px
  radius**, this design's own figure, not today's 34 px strip at a 2 px
  corner (`client/src/styles.css:613` today — verify the line in the
  worktree, it will have moved).
- Two hand-balanced columns place the cards, folding to one column under
  1100 px — above the 700 px phone break every other split on this board
  uses. This is Settings' own breakpoint, deliberately different from the
  700 px used elsewhere; do not unify it with the others.
- The watchdog group's four rows (`Enabled`, `Check every`, `Leave a
  resumed run alone for`, `Give up after`) are unchanged. What changes is
  the row above them: today's `Live view` line is prose with no control
  (`WatchdogGroup.tsx` — currently a bare `<span>`); it becomes a real link
  opening Runs › Watchdog through the same section setter the rail's
  sub-nav tree calls (landed in `task-36`, consumed by `task-38`'s Watchdog
  page) — a destination the rail can now actually name.

## Test cases

Authority: spec §9. `SettingsView.tsx`'s existing test suite is rewritten
with this task per spec §9's "component suites rewritten with their task"
rule; `ArchiveView.tsx`'s existing suite is likewise updated for the new
card/column markup without changing what it asserts about grouping.

1. **Archive still renders exactly four columns**, same labels, same slugs,
   same order, with no fifth column — a direct regression guard against
   the "no Tasks column" rule, asserted by checking `leavesBoard` is not
   imported or reimplemented differently by this task's diff.
2. **Column ramp hues match the type**, not a new mapping — refactors
   amber, ideas mustard, bugs red, out-of-scope `--ink3` with no ramp
   colour.
3. **Month grouping is unchanged** — the existing `groupByMonth` ordering
   assertions in `ArchiveView`'s suite pass unedited; only the kicker's
   rendered class/style changes.
4. **The band carries only project select and search** — no status filter,
   no sort control render anywhere in Archive's band.
5. **No live strip renders on any Archive card**, even for an item a fresh
   run currently holds (construct that case explicitly — it is the one
   Archive must get right that the Board does not need to).
6. **The one derivable action on an out-of-scope card is `capture`** —
   existing `deriveAction` assertions for Archive are unchanged.
7. **Settings' five groupings are unchanged** — `Display`, `Board`,
   `Orchestrator`, `Claude Agents`, `Orchestrator watchdog`, each still
   present, each still grouping the same rows it groups today.
8. **`Segmented`/`NumberField`/`Select`/`Switch` render from `ui/`** — a
   source-level assertion (or the existing `ui-*` component suites from
   `task-36`) that `SettingsView.tsx`/`WatchdogGroup.tsx` import them from
   `client/src/components/ui/`, not from `./SettingsRow`.
9. **Theme swatches stay 24 px / 8 px radius** — a style-suite case reading
   `.set-swatch`'s declared size and radius directly from `styles.css`.
10. **`Live view` is a real link to Runs › Watchdog** — clicking it calls
    the same section-setter function the rail's Watchdog sub-nav entry
    calls; assert against the setter, not the rendered Watchdog page.
11. **Settings folds to one column under 1100 px**, not 700 px — a
    regression guard against accidentally unifying its breakpoint with the
    board-wide 700 px one.
12. **No new derivation.** `client/src/lib/item-month.ts`,
    `client/src/lib/item-stale.ts` and `shared/agent.ts`'s `deriveAction`
    are read, never modified, by this task's diff.

## Done when

- `pnpm test` green on both runners, including every case above.
- `pnpm run typecheck` and `pnpm run build` pass.
- Archive renders the Board's card/column language under its existing four
  columns; Settings renders as borderless cards on the dashboard's §8.2
  language; neither page's grouping, filtering, or dispatch behaviour has
  changed, in all five themes, at 1400 px and 400 px wide.
- Screenshot Archive and Settings at 1400 px and 400 px, daylight and
  midnight (spec §9), through a pid-owned static server killed by pid.
- `git diff --stat` against `main` touches
  `client/src/components/archive/ArchiveView.tsx`,
  `client/src/components/settings/SettingsView.tsx`,
  `client/src/components/settings/WatchdogGroup.tsx`,
  `client/src/components/settings/SettingsRow.tsx`, `client/src/styles.css`,
  and test files. No change to `client/src/lib/item-month.ts`,
  `client/src/lib/item-stale.ts`, or `shared/agent.ts`.

## Outcome

2026-09-16 — done. Archive now draws the Board's own `Band`, `BoardColumn` and `ItemCard` rather than a second set of each, and Settings is a band over two
columns of borderless `Sheet` cards with every control from `ui/`. Neither page's grouping, filtering or dispatch behaviour changed.

What landed, against the plan:

- **Archive** — `Band` (title, `N archived across M projects`, the 36 px search field and the project `Chip`) replaces the `.board-bar`/`.board-tools`
  toolbar; the four columns are `BoardColumn`, whose `BoardColumnSlug` gained `out-of-scope` as a fifth member so the reuse is the component rather than a
  copied header. `RAMP_SLUGS` in that file is the one place deciding which slugs carry a hue, so out-of-scope falls through to `Dot`'s toneless `--ink3`. The
  month kicker is 13/500 `--ink2` on `--board` with no rule under it; `groupByMonth`'s ordering is untouched.
- **Settings** — `SettingsGroup` is `Sheet` + `SheetHead` and takes `title` and `scope` separately (`Display` + `this device`), rows are boxless with a
  hairline between, and every control is `Select`, `Segmented`, `Switch` or one of the two page-CSS members of the 36 px family (`.set-text`, `.set-link`).
  The theme picker sits on a recessed `--steel` track with 24 px / 8 px radius swatches. Two columns, folding at 1100 px.
- **`Live view`** is a real link: `App` hands `SettingsView` one `onOpenWatchdog` prop that calls `setRunsMode('watchdog')` then its own `change('runs')` —
  the same pair, in the same order, that the rail's sub-nav entry calls.

Three deliberate departures from the plan, each because following it literally would have broken a rule the plan does not mention:

1. **`BoardColumn.tsx` and `App.tsx` are in the diff**, beyond the plan's "Done when" file list. `BoardColumn` is what makes "reuses the Board's column
   language" literal rather than a second header agreeing with the first; `App.tsx` is the only place that can hand Settings the rail's own destination.
2. **The pill skin is a `pill` prop on `Segmented`, not a restyle of `.ui-seg`.** DESIGN.md §8.6 wants Settings' pickers in `Switch`'s pill shape and §8.4.1
   wants the Runs band's range control — the same component — as a stroked chip. Restyling the one class family would have silently redrawn task-38's band; a
   variant prop is what §12.1 prescribes for exactly this.
3. **`.set-name`'s new 15/500 is scoped to `.set-row`.** `LaunchSheet` and `OrchestrateSheet` borrow that bare class for their own field labels, which §8.1
   sizes at 13 as control labels, and those two surfaces are task 5's to redraw — so the bare rule keeps its 12/600 and the settings row gets its own.

Two defects found and fixed while screenshotting, both the same mistake: a flex basis has no axis of its own, only the container does. `.set-label`'s
`flex: 1 1 240px` is a wrapping WIDTH in a row and became a 240 px HEIGHT in both places the row turns on its side — `.set-row-stacked` (the theme picker) and
the ≤700 px block. Both now reset the label to `flex: 0 0 auto` and the row to `justify-content: flex-start`.

Verification:

```
$ pnpm run typecheck
$ tsc --noEmit

$ pnpm test
Test Suites: 101 passed, 101 total
Tests:       1681 passed, 1681 total
# tests 538
# pass 538
# fail 0
PASS  jest
PASS  node --test (skills)
pnpm test: both runners passed.

$ pnpm run build
✓ built in 1.05s
```

Screenshots: Archive and Settings at 1400 px and 400 px, daylight and midnight, taken through the built server on a pid-owned loopback port (4399) and killed
by that recorded pid. Eight files under the worktree's gitignored `.playwright-mcp/`. They caught both flex-basis defects above.

Contract sweep: 8 sites updated (client/src/styles.css — the dead `.board-tools`/`.board-search`/`.board-select` phone block, the `.mdetail-label` rule with
no reader left, and the Runs-section comment claiming it reuses the Board's toolbar classes; .claude/DESIGN.md §8.2's "until task 4 redraws it" clause and
§8.5/§8.6's stale line references, split-title prose, pill-prop reasoning and column-split reasoning; docs/subsystems/board.md's Archive paragraph;
test/board-column.test.tsx's two assertions about `.board-col-h`/`.board-col-tick` surviving for Archive). Left standing on purpose:
`backlog/refactors/open/ref-4`'s table still counts `.board-col-refactors .board-col-tick` among `--magenta`'s uses — that tick is gone and
`.dispatch-word.capture` is now the token's only reader, but editing another backlog item's body is `backlog-groom`'s job, not this skill's, and the item
reads truer now than it did (its own point was that magenta had a job the comment denied). `backlog/tasks/done/task-37`'s note that those classes "also stay"
is a done item, i.e. a historical record, and `docs/superpowers/plans/` and the older specs are likewise records of what was planned.

Red proof: 7 tests went red with the change reverted — `ArchiveView.tsx` reverted to `main` (19 archive cases red), `styles.css` reverted to `main` (5 red
across archive/settings-view/board-column), `SettingsGroup` drawing the old `.mdetail-label` kicker instead of `Sheet`+`SheetHead` (6 red), `WatchdogGroup`'s
`Live view` back to a bare `<span>` and `Enabled` back to a checkbox (4 red), `App.tsx` reverted to `main` (the nav link case red), `Segmented` dropping the
`ui-seg-pill` class while keeping the prop (2 red), and `BoardColumn` giving the toneless column a ramp tone (the out-of-scope dot case red). Every revert was
a file copy restored from `/tmp`, never `git stash`.

Not committed, not pushed — the run owns that. Files changed:

```
 .claude/DESIGN.md
 backlog/tasks/open/task-39-…  (this file; moves to done/ next)
 client/src/App.tsx
 client/src/components/archive/ArchiveView.tsx
 client/src/components/board/BoardColumn.tsx
 client/src/components/settings/SettingsRow.tsx
 client/src/components/settings/SettingsView.tsx
 client/src/components/settings/WatchdogGroup.tsx
 client/src/components/ui/Segmented.tsx
 client/src/styles.css
 docs/subsystems/board.md
 test/archive.test.tsx
 test/board-column.test.tsx
 test/nav.test.tsx
 test/settings-view.test.tsx
 test/settings-watchdog.test.tsx
 test/ui-segmented.test.tsx
```

Contract sweep: 8 sites updated (client/src/styles.css, .claude/DESIGN.md, docs/subsystems/board.md, test/board-column.test.tsx)
Red proof: 7 tests went red with the change reverted
