---
id: bug-11
title: A stale open bug an orchestrator is working still leaves the Board for Archive
created: 2026-09-01
tags: client, board, archive, orchestrator
---

## Symptom

An open bug or refactor whose `updated ?? created` is older than the staleness
window renders in Archive rather than on the Board, even while a fresh
orchestrator run has it dispatched and is actively working it. The card the run
bar and the rank were built to pin to the top of its column is the one card not
on the board at all.

The two features disagree because they read different sources, and each is
right about its own. task-9 made the Board's rank, its `started` filter and its
`hasLive` clock read the **run payload**, which is re-polled every 5s and knows
an item is live the moment it is dispatched. task-5's `isStale` reads the
**item file**, and the file cannot know: `backlog-execute` stamps `started:`
and `phase:` on the *worktree's* copy, so the main tree's copy — the one the
registry points at, the server serves and the board renders — stays untouched
for the whole run. `isStale` sequences its in-progress exemption ahead of the
date arithmetic precisely so live work is never stale, but that exemption reads
`started:` from a file nobody has stamped.

Bounded in three ways, which is why it is filed rather than fixed inline:

- **Tasks are unaffected.** `leavesBoard` exempts them outright, so a stale
  task keeps its column and gains the `stale` marker. Only the three sections
  that do leave — Refactoring, Ideas, Bugs — can hit this, and only bugs are
  ever orchestrated, so in practice it is a bug-only defect.
- **It is transient and self-clearing.** The merge moves the item to `done/`,
  after which `isStale`'s open-only half keeps it out of Archive regardless.
  There is no wrong state left behind on the other side.
- **Nothing renders wrong.** The card is simply absent from the Board and
  present in Archive; no bar, marker or ordering is incorrect where it does
  render.

## Repro

1. Have an open bug whose `updated ?? created` is older than
   `Settings.staleDays` (default 30) and which carries no `started:` key — the
   normal state of any bug not touched in a month.
2. Start an orchestrator run that includes it, and let it reach `dispatched`.
3. Open the Board with the default staleness window.

Actual: the bug is in Archive under its month subheader. Its run appears on the
run strip, and the run drawer lists the item as active, but no column on the
Board contains its card.

Expected: an item a fresh run is working is live work and belongs on the Board,
pinned by task-9's rank 1 — the same answer `isStale` already gives for a
hand-run item carrying `started:`.

## Affects

- `client/src/components/board/BoardView.tsx:344-350` — the comment recording
  this deliberately, written by task-9's session at the point where the two
  readers meet. It calls the disagreement harmless because it costs at most an
  interval installed for an off-screen card; that is true of the *clock*, and
  the missing card is the part the comment does not weigh.
- `client/src/components/board/BoardView.tsx:364` — `visible` filters `matched`
  through `leavesBoard`, which is where the card is dropped.
- `client/src/lib/item-stale.ts` — `isStale`'s in-progress exemption and its
  `updated ?? created` arithmetic, both file-derived.
- `client/src/components/archive/ArchiveView.tsx` — reads the same
  `leavesBoard` from the other side, so whatever changes here changes what
  Archive shows by construction.

## Cause

unknown

The mechanism is understood and stated above — file-derived staleness cannot
see a run that only ever stamps a worktree — but "cause" here is really a
design question that grooming should settle rather than this capture:
**which of the two readers is wrong.** Either staleness is incomplete because
it consults only the file when a second live-work signal now exists, or the
orchestrator is at fault for leaving the main tree's copy unstamped for the
whole run, and every downstream reader inherits that blindness. task-9's own
Goal section documents the unstamped main tree as confirmed behaviour, not an
oversight, which is what makes this a real fork rather than an obvious repair.

## Fix

unknown

Three shapes, in rough order of blast radius. Worth noting that the first is
the one task-9 explicitly declined, and its reason — a third reader on the
stage lists, and a change to what Archive shows — is an argument about cost,
not about correctness, so it should be re-weighed rather than treated as
settled:

- **Widen the staleness predicate to consult the run payload.** `isStale`
  gains the run's view of live work beside the file's. Most direct, and it
  keeps the Board/Archive split exactly complementary because both surfaces
  read the one predicate. Cost is what task-9 named: a third reader on
  `ACTIVE_RUN_STAGES`/`ATTENTION_RUN_STAGES`, and `item-stale.ts` stops being
  a pure function of the item file.
- **Exempt at the Board's filter rather than in the predicate.** `visible`
  keeps any card whose `liveRank` is already `< 2` — a value task-9 computes
  one line above for `hasLive`, so nothing new is derived. Smaller, but it
  breaks the "Archive is the Board's exact complement" property both surfaces
  currently rely on, and Archive would need the same exemption to avoid
  showing the card twice.
- **Have the orchestrator stamp the main tree's copy.** Closes the blind spot
  at its source, for every present and future reader. Almost certainly the
  wrong trade: it would put a writer on the main tree's item files during a
  run, which is the thing the worktree isolation exists to prevent, and it
  collides with the single-writer rule on item files.
