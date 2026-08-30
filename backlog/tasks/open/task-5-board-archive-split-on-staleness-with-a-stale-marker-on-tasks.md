---
id: task-5
title: Board/Archive split on staleness, with a stale marker on tasks
created: 2026-08-30
tags: client, board
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
