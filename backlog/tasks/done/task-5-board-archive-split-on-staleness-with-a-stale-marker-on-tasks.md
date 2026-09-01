---
id: task-5
title: Board/Archive split on staleness, with a stale marker on tasks
created: 2026-08-30
tags: client, board
updated: 2026-09-01T15:47:42Z
started: 2026-09-01T15:30:11Z
execute-elapsed: 1051
---

## Goal

The Board shows only what has been touched recently; everything older moves to
Archive on its own. Chunk C2 of
docs/superpowers/specs/2026-08-30-board-growth-design.md. Depends on task-1,
which writes the `updated:` stamp this reads.

## Plan

The staleness window is a client setting with a default of 30 days, clamped
like every other setting, because Board-versus-Archive is a view decision and
the server already returns the whole corpus for client-side narrowing.

An item is stale when `updated ?? created` is older than the window. The
fallback matters: every file on disk today predates the stamp, so the first
load after this ships moves genuinely old, never-touched items into Archive.
That is the correct answer rather than a migration accident, but it will look
abrupt and belongs in the release note.

Stale open Refactoring, Ideas and Bugs leave the Board. **Tasks never leave**
— a task is committed work, and one rotting for six weeks is a fact to be made
to look at, not one to tidy away. A stale task keeps its column and gains a
`stale` marker chip instead.

An in-progress item is never stale regardless of its stamp: `started` means
someone is on it right now, which outranks any date arithmetic.

The predicate belongs in one small module beside `item-age.ts` and
`item-progress.ts`, not inline in BoardView — task-6 reads the same rule from
the other side.

## Test cases

- An item one second inside the window is on the Board; one second outside it
  is not.
- An item with no `updated:` key falls back to `created`.
- An item with neither `updated:` nor `created` is treated as fresh, not
  archived — a malformed file should not vanish.
- A stale task stays on the Board and carries the marker.
- A fresh task carries no marker.
- An in-progress item with a stale stamp stays on the Board.
- A window setting of zero, a negative, or a hand-edited non-number clamps to
  the default.
- A bare `YYYY-MM-DD` in either field ages in whole days.

## Done when

`pnpm test` is green and changing the window in Settings visibly moves items
between the two surfaces.

## Outcome

2026-09-01 — Done. The staleness split is live on the Board.

`client/src/lib/item-stale.ts` is the one implementation: `isStale` (open only,
never while `started` is set, `updated ?? created`, unparseable reads as fresh,
bare `YYYY-MM-DD` aged in whole days via `daysSince`, strict `>` so exactly the
window is still inside it) and `leavesBoard` (`isStale` plus the tasks
exemption). BoardView filters `matched` through `leavesBoard` after the toolbar
filter and hands every surviving card `stale={isStale(...)}`; ItemCard renders a
mustard `stale` chip in the footer after `done`. The window is
`Settings.staleDays`, default 30, offered as 7/14/30/90 in a new "Board · this
device" group; its clamp falls back to the DEFAULT below `min` rather than to
`min`, because a stored `0` would silently empty three columns.

Two decisions the plan left open, both defended in comments: a done or rejected
item is never stale (otherwise a long-finished bug vanishes from the Board's own
`Done` filter, the only surface that shows it), and `hasLive` is computed before
the staleness filter rather than after (a hook cannot run after a filter that
needs its value, and the two sets agree because a stale item is never in
progress).

The Archive half of "visibly moves items between the two surfaces" is task-6:
evicted items are listed nowhere yet, so `ArchiveView`'s placeholder now says so
outright instead of implying nothing has left the Board. The window reaching the
filter is asserted through a real `SettingsProvider` in `test/board.test.tsx`
("keeps a ten-day-old bug under the default window" / "drops that same bug once
the stored window is seven days") — the seam a click in Settings cannot prove on
its own. Also note for the release: every file with no `updated:` falls back to
`created`, so the first load after this ships moves genuinely old, never-touched
items off the Board. README says so in the architecture section.

Red-green checked, not just green: neutering `leavesBoard` to `return false`
took 4 tests red, and stubbing the card's `stale` chip off took "keeps a stale
task on the board and marks it" red. Both restored before the run below.

```
$ pnpm test
Test Suites: 39 passed, 39 total
Tests:       591 passed, 591 total
Snapshots:   0 total
Time:        34.704 s

$ pnpm run typecheck
$ tsc --noEmit
typecheck exit=0

$ pnpm run build
dist/assets/BoardView-BFbSufAr.js       72.04 kB │ gzip: 21.72 kB
dist/assets/index-l5LK9OSM.js          149.66 kB │ gzip: 48.97 kB
✓ built in 1.39s
build exit=0

$ pnpm run test:skills
# pass 264
# fail 0
```
