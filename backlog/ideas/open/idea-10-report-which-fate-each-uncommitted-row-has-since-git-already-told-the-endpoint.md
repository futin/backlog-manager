---
id: idea-10
title: Report which fate each uncommitted row has, since git already told the endpoint
created: 2026-09-07
from: task-32
---

## Problem

`GET /api/items/uncommitted` (task-32) answers `{ paths, known }` — a flat union of
two git reads that each mean something different, and the difference is exactly what
the Orchestrate sheet's note has to explain in the abstract:

- a path from `git diff --name-only main -- backlog` is **present** at `main` and
  edited since, so a run gates and EXECUTES `main`'s copy of it;
- a path from `git ls-files --others --exclude-standard -- backlog` was **never
  tracked**, so it is absent from `main` and a run refuses it with
  `not committed on main` and skips it.

`uncommittedItemPaths` knows which read produced each path and then throws that away
in the union (`uncommitted.util.ts`, the `new Set([...lines(diffed),
...lines(untracked)])` line). The sheet therefore has to describe both fates on every
launch — "one missing from main altogether is skipped; one present but stale is gated
and run on main's bytes" — even when exactly one row is flagged and the server knew
which sentence applied to it. Raised as a Minor in task-32's review round 2, and
deliberately left out of that item's last fix loop: it is a shape change to a wire
format, not a wording fix.

Worth noting this is not the same as the "absent" set being the untracked set. A file
tracked on a branch `main` does not contain is reported by `diff` and is still absent
from `main` — Decision 2 in task-32 exists because that case is real. So the fate is
not "which read found it" but "does `main` hold this path at all", which is a third
question git can answer directly (`git ls-tree`/`cat-file -e main:<path>`, or reading
`diff --diff-filter=A` for the added-relative-to-main set).

## Rough shape

Something like `{ items: [{ path, atBase: boolean }], known: boolean }`, or keep
`paths` and add a second array — whichever keeps the client's `Set.has` membership
test intact, since that is what the chip is derived from and it should not have to
change.

The sheet would then say the true sentence per row: a chip that reads differently for
"the run will not find this" versus "the run will run an older copy of this", and a
note that stops hedging. `deselect uncommitted (N)` arguably splits too — dropping a
row the run cannot see costs nothing, while dropping a stale one cancels work that
would have happened.

## Open questions

- Does the extra git read cost anything worth caring about? The endpoint is one
  project, once per sheet open (task-32's Decision 1), so a third spawn is probably
  free — but `cat-file -e` per flagged path is O(flagged) spawns, so `ls-tree` over
  `backlog` once is likely the right shape.
- Is a per-row fate actually worth two chip vocabularies on one screen, or is the
  split note enough? task-32 settled on one word (`uncommitted`) across chip, button,
  endpoint and docs precisely to avoid a second vocabulary; this idea reopens that.
- Does anything else want the distinction, or is the sheet still the only consumer?
  If it stays a single consumer, the client-side `UncommittedItems` declaration stays
  out of `shared/types.ts` for the same reason it is out today.

## Not this

Making the board's own scan carry the flag per item. task-32's Decision 4 refused
that (an un-memoisable git read inside `scanProject`, which runs for every registered
project on `/api/items` and `/api/projects`) and nothing here changes that reasoning.
