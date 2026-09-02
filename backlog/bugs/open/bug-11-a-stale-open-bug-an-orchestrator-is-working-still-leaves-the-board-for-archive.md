---
id: bug-11
title: A stale open bug an orchestrator is working still leaves the Board for Archive
created: 2026-09-01
tags: client, board, archive, orchestrator
updated: 2026-09-02T07:35:12Z
groom-elapsed: 306
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

**Staleness is the reader at fault, not the orchestrator.** `isStale`
(`client/src/lib/item-stale.ts`) answers "has nobody touched this" out of the
item file alone — `updated ?? created`, plus the `isInProgress` exemption that
reads `started:`. That was a complete account of live work until
`backlog-orchestrate` existed. It no longer is: a run works each item inside
its own worktree and stamps only that copy, so the main tree's copy — the one
`/api/items` scans and both surfaces render — is silent for the whole run. The
run payload is where the fact lives, and `runClaimBlock` (`shared/agent.ts`)
already states the rule in its own doc comment: *"'this item is claimed by a
run' therefore exists in exactly one place, the run payload, and every surface
that needs it has to be handed it explicitly."* `isStale` is a surface that
needs it and was never handed it. The exemption it does have is not wrong —
it is one source short.

The fork this capture left open resolves against both of the other two
candidates, on grounds stronger than cost:

- **Against stamping the main tree.** It would put a writer on item files
  during a run — against the single-writer invariant — and put it inside the
  tree the worktree exists to keep untouched. That trades an isolation
  boundary for a read gap, and the read gap has a reader-side fix.
- **Against exempting at BoardView's filter.** `leavesBoard` is deliberately
  the one implementation both surfaces read, so an item can never be in both
  or in neither. A Board-only exemption leaves Archive's copy of the question
  answering the old way, and the repair for that is to paste the same
  exemption into Archive — two copies of the rule the module exists to
  prevent.

Two things the capture did not weigh, both of which fall out of the same
cause:

- **The attention stages are hit too, and worse.** `needs-answers` and
  `parked` mean the run has stopped and is waiting for a person. `liveRank`
  ranks exactly those 0 — the top of the column — while `leavesBoard`, blind
  in the same way, sends them to Archive. An item asking for a human answer is
  the last card that should leave the human's surface, so a fix scoped to
  `dispatched..merging` only re-files this bug under a new number.
- **The widening is nearly free at both call sites.** BoardView already holds
  `runs` (`useOrchestratorRuns`, for the strip) and ArchiveView already holds
  the same payload (for `runClaimBlock`, imported at `ArchiveView.tsx:13`).
  Neither surface gains a fetch, a hook or a poll — only an argument.

## Fix

Widen the predicate and hand it the second source. Six edits, in dependency
order.

1. **`shared/types.ts` — move `ATTENTION_RUN_STAGES` here** from
   `client/src/components/board/ItemCard.tsx`, beside `RUN_CLAIMED_STAGES`,
   whose doc comment already reasons about this partition ("a new stage added
   to the union three lines up has to be classified in the same edit"). Two
   importers today, `ItemCard` and `BoardView`; no test imports it, so the move
   is mechanical. `ACTIVE_RUN_STAGES` stays on the card — it really is a
   rendering fact (which cards wear a cyan stage badge) — but `ATTENTION` stops
   being one the moment staleness reads it, and a `lib/` module importing a
   React component to get it would invert the layering both surfaces depend on.
2. **`shared/agent.ts` — add `runHoldsItem(item, runs): boolean`** next to
   `runClaimBlock`, true when a **fresh** run in the item's project has the
   item at a stage in `RUN_CLAIMED_STAGES` **or** `ATTENTION_RUN_STAGES` — that
   is, at every stage but the four true exits (`merged`, `failed`, `skipped`,
   `ungroomed`). Extract the fresh/project/id lookup the two now share into one
   private helper rather than writing a second scan: `runClaimBlock`'s own
   comment records that those three lines are exactly the part a second copy
   gets subtly wrong. Keep `runClaimBlock`'s narrower `RUN_CLAIMED_STAGES` rule
   as it is — the two questions genuinely differ, and the difference is the
   point: a parked item may be dispatched by hand (that is what parking is
   for), which requires it to still be on the Board to dispatch from.
3. **`client/src/lib/item-stale.ts` — take `runs`.** `isStale(item,
   windowDays, now, runs)` and `leavesBoard(item, windowDays, now, runs)`, with
   `runs` **required and given no `[]` default**. A default is what makes this
   bug recur silently for the next caller; the compiler asking is the whole
   value of the change. Sequence the new half into rule 3, ahead of the
   arithmetic exactly as the file already sequences the old one:
   `if (isInProgress(item) || runHoldsItem(item, runs)) return false;`. Rewrite
   rule 3's comment and the module header: the rule is now "the file says
   someone is on it, or a fresh run does" — one predicate over two sources, and
   the header's "pure function of the item file" framing is what the rewrite
   has to retire.
4. **`BoardView.tsx` — pass `runs` at both call sites** (`visible`, `staleFor`)
   — the full `runs`, not `freshRuns`, since `runHoldsItem` filters on `fresh`
   itself. Replace the comment at 344-350: its "they disagree harmlessly"
   paragraph is this bug's own written record and becomes false. The
   hook-ordering reason for computing `hasLive` on `matched` rather than
   `visible` is unrelated and must survive the rewrite.
5. **`ArchiveView.tsx` — pass `runs` to `leavesBoard`**, and rewrite the
   `runBlockFor` comment. Its stated case (a stale item sitting `pending` in a
   run's queue) can no longer reach this surface at all; what remains reachable
   is an item rejected while a run held it, which enters Archive by section
   rather than by staleness. The block stays — it is now the narrow case rather
   than the common one, and deleting it would let a rejected-mid-run card
   dispatch from Archive while the Board's equivalent is blocked.
6. **`CLAUDE.md` — update the Board-versus-Archive invariant.** It currently
   says the split is derived from `updated ?? created` and lists four rules the
   predicate encodes; add the fifth, that a fresh run holding the item outranks
   the arithmetic the same way `started` does, and that this is why the
   predicate takes the run payload.

Two consequences to accept deliberately rather than discover:

- **`pending`/`preflight` are included**, so starting a whole-queue run pulls
  every stale queued bug back onto the Board at once — unpinned, since
  `liveRank` still ranks them 2. That is the correct answer: the run will reach
  them without anyone asking, so they are claimed work, not neglected work.
  They return to Archive only if the run exits them at `failed`/`skipped`/
  `ungroomed`; a merged one is in `done/` and stale to nobody.
- **Archive shrinks while a run is live** and is the same set afterwards, which
  is the self-clearing property the Symptom already notes, now on the correct
  side.

### Test cases

- `test/agents-shared.test.ts` — `runHoldsItem` is `true` for every member of
  `RUN_CLAIMED_STAGES` and both `ATTENTION_RUN_STAGES` members, and `false` for
  `merged`, `failed`, `skipped`, `ungroomed`; `false` when the run is not
  `fresh`; `false` when the run's `project` is another path or the id is not in
  its queue; `false` for an empty `runs` list. Extend the existing
  `Record<RunStage, true>` partition test so a new stage member must also be
  classified live-or-exited, not just claimed-or-terminal.
- `test/item-stale.test.ts` — an open bug stale by `updated` is **not** stale
  when a fresh run has it at `dispatched`, at `pending`, at `parked` and at
  `needs-answers`; **is** still stale at `merged`/`failed`/`skipped`/
  `ungroomed`, when the run's `fresh` is `false`, and when the run belongs to
  another project. Every existing case re-passes with `[]` for `runs`, and
  `leavesBoard` mirrors the same set (a stale task is still kept and marked
  regardless of any run).
- `test/board.test.tsx` — a stale open bug plus a fresh run holding it at
  `dispatched` renders in the Bugs column, first in it; the same bug with the
  run at `fresh: false` is absent, as today.
- `test/archive.test.tsx` — the existing stale-bug fixture with the runs stub
  returning a fresh run that holds it disappears from Archive's Bugs column,
  and reappears when that run is stale. This is the assertion that proves the
  two surfaces stayed complementary.

In the browser (playwright MCP tools): with a fresh orchestrator run holding a
long-untouched open bug at `dispatched`, open the Board at
`http://127.0.0.1:5177/` — the bug's card is in the Bugs column with its live
run bar, and it is first in that column; then open Archive from the side rail
and confirm the same card is absent from its Bugs column.
