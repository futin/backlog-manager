---
id: task-6
title: Archive view: four columns, month groups, and the two promotion paths
created: 2026-08-30
tags: client, board, archive
---

## Goal

Archive becomes a real surface: Refactoring · Ideas · Bugs · Out of scope,
grouped by month, with both ways back to the Board. Chunk D of
docs/superpowers/specs/2026-08-30-board-growth-design.md. Depends on task-3
for the nav slot and task-5 for the staleness rule.

Archive is a parking lot, not a graveyard — nothing in it is finished, and
everything in it can come back.

## Plan

Contents: stale open Refactoring, Ideas and Bugs (task-5's predicate, read
from the other side), plus every out-of-scope item regardless of age. No
Tasks column — tasks never archive. No done items anywhere; there is no
action to take on them.

Archive carries no status filter: its contents are defined by staleness and
rejection, not by status. Project filter and search only.

Within each column, items group under sticky month subheaders keyed on
`updated ?? created`, newest month first. This is the one place month
grouping earns itself — a column of six-week-old items with no temporal
structure is a list, not a view.

Two promotion paths, deliberately different:

- **A stale item** promotes by dispatching a groom session. Groom's own
  `start`/`stop` refreshes `updated:` and the item is back on the Board at
  the next load. Nothing new is needed: `deriveAction` already returns groom
  for these, and the board still never writes — the spawned agent does.
- **An out-of-scope item** promotes by capturing a **new** item that cites it
  (`from: oos-N`). The original stays rejected; `moveItem` refuses every move
  out of out-of-scope, deliberately, and this does not lift that.

**The risky part, to settle before building:** dispatch derives its action and
never accepts one, and `deriveAction` currently has no answer for an
out-of-scope item. Reviving therefore needs either a third derived action or a
separate path that is not dispatch at all. Whichever is chosen, `deriveAction`
must stay the single implementation shared by the board's label and the
server's validation — two copies is the failure this rule exists to prevent.

## Test cases

- An out-of-scope item renders in Archive and nowhere else.
- A done item renders in neither Archive column nor the Board's default view.
- A stale task appears on the Board, not in Archive.
- A fresh bug appears on the Board, not in Archive.
- Archive renders no status select.
- Month subheaders appear newest-first and an item with neither date sorts
  predictably rather than into a NaN group.
- A stale card's dispatch control offers groom.
- Whatever revive turns out to be, the server still derives the action and
  409s on disagreement with the client.

## Done when

`pnpm test` is green, and a rejected item can be revived and a stale item
groomed back onto the Board without the client ever writing a file.
