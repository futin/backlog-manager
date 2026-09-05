---
id: idea-6
title: Scrollable runs list panel with load-more paging
created: 2026-09-05
tags: ui, runs
updated: 2026-09-05T11:47:22Z
promoted-to: task-16
groom-elapsed: 110
groom-tokens: 16734
---

## Problem

The Runs list grows without bound. `.runs-list` (`client/src/styles.css:1531`) is a
plain flex column inside `.runs-split`'s `align-items: start` grid, so every day group
the range control admits is laid out at full height and the only way to reach an older
run is to scroll the whole page. Two things get worse as history accumulates:

- The stat tiles, the range control and the project filter scroll off the top, so by the
  time you are looking at a run from three weeks ago you can no longer see which range
  or project you are looking at.
- The detail pane is the reason this layout exists at all (see the `.runs-split` comment)
  and it is `align-items: start`, so it stays pinned at the top of a list that may now be
  several screens tall — select a run near the bottom and the pane describing it is
  off-screen.

The `All` range is the case that motivates this, but `This month` already reaches it on a
machine that runs the orchestrator daily.

## Rough shape

Two separable halves; either is useful without the other.

**Scroll container.** Give the list its own bounded, scrollable region so the page itself
stops growing — the list scrolls, the tiles/range/filter above it and the detail pane
beside it stay put. Needs a height that is a viewport calculation rather than a fixed
pixel count, and needs to collapse cleanly at the existing 700px breakpoint where the
layout is already one column, list above detail — a scroll box nested inside a scrolling
page is worse than the status quo on a phone, so the bounded height likely belongs to the
wide layout only.

**Load more.** A button at the foot of the list that reveals older runs, so the initial
render is a window rather than the whole corpus.

## Open questions

- **Client-side window or server-side page?** `GET /api/orchestrator/archive`
  (`orchestrator.controller.ts:41`) returns every run a project has ever produced in one
  payload, and `useOrchestratorArchive` fetches it whole on mount and window focus with
  no polling. A client-side window (render N groups, `load more` raises N) needs no server
  change at all and keeps the hook's cache-nothing simplicity; a server-side page changes
  a read-only endpoint's shape and has to stay compatible with the run-state directory
  being the only source. Client-side is almost certainly right until the payload itself
  gets expensive — worth measuring the payload size for a year of runs before deciding.
- **What is the unit of "more" — runs or day groups?** The list is day-grouped, so paging
  by run can split a day across the boundary. Paging by day group keeps the headings
  honest but makes the page size lumpy.
- **How does the window interact with the range control?** Range already scopes the tiles,
  list and wide tile together (`lib/run-range.ts`). Switching range presumably resets the
  window to its first page; confirm that rather than assume it.
- **Do the pinned live runs stay outside the window?** Fresh live runs are pinned above
  history today. They should almost certainly never be paged away, but that makes the
  pinned region and the paged region two different things in one scroll container.
- **Does selection survive paging?** RunsView already drops the selection when the
  selected run leaves the list (`RunsView.tsx:533`); a shrinking window is a new way for
  that to happen and it should not silently blank the pane on a `load more` that only
  ever adds.
