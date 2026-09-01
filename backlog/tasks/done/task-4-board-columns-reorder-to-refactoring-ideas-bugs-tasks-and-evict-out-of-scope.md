---
id: task-4
title: Board columns: reorder to Refactoring Ideas Bugs Tasks and evict out-of-scope
created: 2026-08-30
tags: client, board
updated: 2026-09-01T15:13:36Z
started: 2026-09-01T15:08:17Z
execute-elapsed: 319
---

## Goal

The Board's four columns become Refactoring · Ideas · Bugs · Tasks, and
out-of-scope stops having a Board column at all. Chunk C1 of
docs/superpowers/specs/2026-08-30-board-growth-design.md. Depends on task-2
for the Refactoring column to have anything to show.

## Plan

`COLUMNS` in BoardView is reordered and its out-of-scope entry removed.
Out-of-scope items are filtered out of the Board entirely; they get their own
column in Archive (task-6), so this is a move, not a deletion.

Removing them has a non-obvious consequence in `matches`. Today the status
predicate ends in an out-of-scope bypass — `i.section === 'out-of-scope' ||
status === 'all' || i.status === status` — and the `'started'` branch is
deliberately tested *before* it, with a comment explaining that a rejected
card is never live no matter what its stale `started` stamp says. Once
out-of-scope never renders on the Board, the bypass is dead code and should
go, along with the ordering comment that only existed to defend it. Removing
it and leaving the comment, or removing the comment and leaving the bypass,
are both worse than either.

Done items become a filter value rather than a view: `Open` and
`In progress` exclude them, `Done` renders them in these same four columns,
`All` includes them. `Done` is never the default.

## Test cases

- The board renders exactly four columns, in the order Refactoring, Ideas,
  Bugs, Tasks.
- An out-of-scope item renders in no column at any of the four status filter
  values, including `All`.
- `status=done` renders done items inside their own type columns.
- `status=open` excludes done items.
- `status=started` still shows only genuinely live items, and a done item
  carrying a stale `started` stamp is not among them.
- Column counts match the number of cards rendered beneath each header.

## Done when

`pnpm test` is green, including the existing board test that asserts
out-of-scope is hidden.

## Outcome

2026-09-01 — done. `COLUMNS` in `BoardView.tsx` is now the design's four —
Refactoring · Ideas · Bugs · Tasks — with the out-of-scope entry gone, and
`matches` drops `i.section === 'out-of-scope'` outright rather than relying on
there being no column to land in: `visible` also drives the "no matches" empty
state and the `hasLive` clock, so a card the board cannot show must not be
counted. The status bypass (`i.section === 'out-of-scope' || …`) and the
ordering comment that only existed to defend running the `'started'` branch in
front of it both went with it, together as the plan required. `.board-columns`
stepped from `repeat(5, …)` to `repeat(4, …)`; the `oos` slug had no CSS of its
own to remove. CLAUDE.md's "five fixed columns" line followed.

Tests: the five-column order/count assertion became a four-column one, the
per-column card count is now asserted for every column instead of only Bugs,
the done-filter test asserts done items land in their own type columns, and the
out-of-scope regression guard was rewritten to sweep all four status values —
`open`, `started`, `done`, `all` — since `all` is the value a re-added bypass
would look most correct beneath. The three sort tests read Bugs at index 2 now.

```
$ pnpm test
Test Suites: 38 passed, 38 total
Tests:       566 passed, 566 total
Snapshots:   0 total
Time:        98.022 s
Ran all test suites.

$ pnpm run typecheck
$ tsc --noEmit
```
