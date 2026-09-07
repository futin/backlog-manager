---
id: idea-9
title: The Orchestrate sheet marks groomed items that are not committed, before the run skips them
created: 2026-09-06
tags: client, server, orchestrate
updated: 2026-09-07T05:27:32Z
promoted-to: task-32
groom-elapsed: 158
groom-tokens: 25001
---

## Problem

The Orchestrate sheet's step 1 previews the queue from the board's item scan, which
reads the working tree. The run that follows reads each item at `<base>`, the commit
its worktree starts from. The two disagree exactly when an item was groomed and not
committed — and then the sheet shows a ready bug, the run's `plan` verdict is
"ungroomed — not committed on main", and the item is skipped after the person has
already walked away. Five such skips across three projects in the 2026-09-06 sweep
(bug-12 twice here, bug-13 and bug-7 in claude-agents-dashboard, bug-16 in ixray).
task-29 makes `backlog-groom` say so at groom time; this is the board-side half, for
the person who groomed yesterday and is launching today.

## Rough shape

- The items endpoint (or a small sibling) reports, per item, whether the item file at
  the registered path differs from `HEAD` — `git status --porcelain -- backlog/` scoped to
  the project path, the same read-only git the `lastCommit` scan already runs in
  `server/src/items/git-dates.util.ts`, and degrading the same way: no git, no repo, not
  tracked → "unknown", never an error.
- `OrchestrateSheet` step 1 marks such items with an `uncommitted` chip and excludes
  them from the default selection, with a one-line hint quoting the run's own verdict so
  the two surfaces use the same words. Step 3's Start is not blocked: a person may want
  to commit and start in one breath, and the run's gate is the authority anyway.
- The Board card could carry the same chip, but only the sheet is where it costs a run
  slot to miss it.

## Open questions

- Is a per-request `git status` over `backlog/` cheap enough beside the memoised
  `lastCommit` scan, or does it join that memo (keyed on `index` mtime, which is exactly
  what changes when the answer changes)?
- An item that is committed on a branch but not on `main` reads as committed to `git
  status` and is still skipped by a run that starts from `main`. Is "differs from
  `HEAD`" the right question, or "absent from `main`" — the latter needs the branch name
  the run will use, which the sheet does not know.
- Whether the chip belongs on the Board card as well, and whether `leavesBoard` or any
  other derived state should read it (probably not: it is a launch-time fact, not a
  lifecycle one).
