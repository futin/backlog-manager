---
id: idea-4
title: Sort orchestrator-active items to the top of their column
created: 2026-09-01
tags: ui, board, orchestrator
updated: 2026-09-01T12:28:04Z
promoted-to: task-9
groom-elapsed: 182
---

## Problem

An item the orchestrator is currently working sits wherever the column's sort
put it — usually somewhere down the list, indistinguishable at a glance from
the twelve items nobody has touched. The board already answers "which of these
is anyone on" for hand-run work: `inProgressRank`
(`client/src/components/board/BoardView.tsx:84`) sorts live cards to rank 0 and
`ItemCard` paints them with the amber `.board-card-live-bar`. An orchestrator
run gets neither. All it gets is the small `runStage` chip in the card footer
(`ItemCard.tsx:192`), which reads last among the footer markers by design and
is not something you can scan a column for.

The likely reason the existing marker never fires for orchestrated work — worth
confirming before designing around it — is that `isInProgress`
(`client/src/lib/item-progress.ts:13`) is derived from the item file's
`started:` key, and `backlog-execute` writes that key inside the per-item
**worktree**. The main tree's copy of the file, which is the one the server
reads and serves, never gets stamped. So the board's file-derived notion of
"live" is structurally blind to orchestrated work, and the run payload is the
only source that knows.

## Rough shape

The data is already on the client: `BoardView` polls `useOrchestratorRuns` and
already computes `runStageFor(item)` per card. Two changes on top of that,
neither needing a server or skill change:

- **Ordering** — make the rank function consider the run stage as well as the
  file marker: rank 0 when `isInProgress(item)` *or* `runStageFor(item)` is one
  of `ACTIVE_RUN_STAGES` (`ItemCard.tsx:25`). It stays a two-value rank feeding
  the same `inProgressRank(a) - inProgressRank(b) || compare(a, b)` in
  `sortItems`, so the chosen sort still breaks ties and nothing else moves.
  Open question below on whether `needs-answers` and `parked` deserve their own
  rank rather than sharing one with the six running stages.
- **The marker** — give an orchestrator-active card the same amber live bar the
  hand-run ones get, with the stage as its words (`reviewing`, `verifying`)
  the way `progressLabel` names `grooming` / `executing` today. That makes one
  visual language for "something is happening here", with the bar saying *what*
  and the footer chip left to do whatever it does now. Note the theme reads
  amber as "a human is involved here" (see the comment at `ItemCard.tsx:103`) —
  an unattended run is the opposite of that, so the tone may need to be a
  different hue rather than reusing amber outright.

`ItemCard` stays a pure function of its props either way; the derivation lives
in `BoardView` beside `runStageFor`, same as now.

## Open questions

- Is the worktree explanation above actually right? Confirm whether a main-tree
  item file ever carries `started:` during an orchestrator run — if it does,
  part of this is already working and the fix is smaller than it looks.
- Should `needs-answers` and `parked` sort to the top too? They are not
  progress, but they are the items most worth seeing — arguably rank 0 ahead of
  the running ones, not below them.
- Amber, or a distinct tone for unattended work? Reusing amber collides with the
  theme's existing "a human is involved" reading; a separate hue costs a new
  palette entry in `shared/theme.css` across all five themes.
- Does the bar replace the footer stage chip for these cards, or sit alongside
  it? Both saying `reviewing` two lines apart is redundant.
- A card whose run went stale (`fresh === false` on the payload) — does it stay
  pinned to the top with a stale note, or fall back to normal order? A run that
  died mid-item would otherwise pin a card forever.
