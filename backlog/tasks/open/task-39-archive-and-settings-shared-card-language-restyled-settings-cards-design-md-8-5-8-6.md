---
id: task-39
title: Archive and Settings: shared card language, restyled settings cards (DESIGN.md 8.5-8.6)
created: 2026-09-15
tags: fe-redesign, archive, settings
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
