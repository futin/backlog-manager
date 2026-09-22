---
id: bug-50
title: A stop landing on the tick that discovers the child's session id drops that id
created: 2026-09-22
---

## Symptom

On the tick where `watch` both learns the child's session id and observes an effective stop request, the id is discarded: the item stays `dispatched` with
`sessionId: null` on the run file and on its published claim state, and no later tick exists to recover it.

This is a code-path defect read off the source, NOT a reproduced observation. Three live aborts on `futin/guide-manager` issue #5 on 2026-09-22 all ended
`dispatched` + `sessionId: null`, and all three are explained by bug-52 instead — on the one run reconstructible end to end (run-20260922-144041, Mac) `watch`
never ran at all, because the stop landed inside the dispatch block and the second `stage --pid` refused with exit `10`. `findSessionIdInJsonl` is reached only
from `cmdWatch`, so on that path the discovery code is never entered. See bug-52 for the mechanism that actually produced the observed symptom, and fix it
first: it accounts for every stop in the first minute of an item, which is the window people actually stop in.

What is left here is the narrower race: a run whose `watch` has begun ticking, stopped on the exact tick that first reads the init event out of the jsonl.
Real, unwitnessed, and cheap to fix while the surrounding code is open.

## Repro

No natural repro has been captured — the window is one tick wide and a hand-timed stop has landed outside it on every attempt so far.

A deterministic test drives it directly: a `watch` loop whose first jsonl-bearing tick also sees an effective stop request. That is the repro this item should
be closed against, not a timed run against a live project.

1. Start a run and let an item reach `dispatched` with `watch` ticking.
2. Arrange for the stop request to become effective in the interval between the child writing its `{"type":"system","subtype":"init"}` line and the tick that
   reads it.
3. Abort and read the run file: the item is `dispatched` with `sessionId: null`, and `logs/<id>.jsonl` holds the id that was read and dropped.

## Affects

- `skills/backlog-orchestrate/tools/orchestrate.mjs:4233` — the `stopRequestEffective(...)` branch, which SIGTERMs `pid` and `return EXIT_STOP_REQUESTED`
- `skills/backlog-orchestrate/tools/orchestrate.mjs:4243` — the `applyQueueItemFields(findQueueItem(run, itemId), { session: newlyFoundSessionId })` write that
  is never reached on that tick
- `skills/backlog-orchestrate/tools/orchestrate.mjs:4186` — `findSessionIdInJsonl` discovery, whose result lives only in the local `newlyFoundSessionId`

## Cause

In the `watch` loop the stop check sits ABOVE the session-id write. On a tick that both discovers the id and observes an effective stop request, the function
signals the child and returns `EXIT_STOP_REQUESTED` before line 4243 runs, so `newlyFoundSessionId` — a fact already read from disk — is discarded with the
stack frame. There is no later tick, and no other writer of that field: `stage --session` is the only other path and the run is over.

The ordering itself is deliberate and its comment is correct about WHY: the stop branch must run before the heartbeat write so a stopped run does not get its
`updatedAt` pushed forward, because `takeOverRun` reads that freshness to decide whether an abort from elsewhere is refused. That reasoning covers the
`run.updatedAt = nowISO()` bump. It does not cover the session-id field, which is not a freshness signal and which no predicate branches on.

Sibling of bug-43 (the same stop window leaving `pid` null), same shape, different field.

## Fix

Persist a freshly-discovered session id before the stop return, as its own write that leaves `updatedAt` alone.

Concretely: inside the stop branch, after the `process.kill` attempt and before `return EXIT_STOP_REQUESTED`, apply `{ session: newlyFoundSessionId }` to the
queue item and write the run atomically WITHOUT touching `run.updatedAt`. The existing `applyQueueItemFields` + `writeRunAtomic` pair is reused; the only
difference from line 4243's write is that the `updatedAt` bump is skipped, which is exactly the property the early return was protecting.

Do bug-52 first. If bug-52's abort-side harvest lands, this fix becomes a narrowing rather than a rescue — the id would be recovered from `logs/<id>.jsonl` at
abort time anyway — so the open question to answer in the implementation is whether this is still worth its own write at all, or whether the honest resolution
is to close this as covered. Answer that with bug-52's change in front of you; do not assume either way now.
