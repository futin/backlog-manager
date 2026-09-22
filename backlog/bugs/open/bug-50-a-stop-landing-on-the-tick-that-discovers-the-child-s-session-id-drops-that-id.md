---
id: bug-50
title: A stop landing on the tick that discovers the child's session id drops that id
created: 2026-09-22
---

## Symptom

An item that was already `dispatched` keeps `sessionId: null` on the run file and on its published claim state after the run is stopped. The abort path then has
no session id for the child it just signalled, so nothing downstream can name the transcript that item actually ran in — `usage`/`denials` reads, the retro's
session join, and any later "which session was this" question all come up empty for that item.

Observed on `futin/guide-manager` issue #5, run `run-20260922-141510` on the Linux host: `pending` 14:15:10Z, `preflight` 14:15:33Z, `dispatched` 14:16:09Z,
stop requested and claim released 14:17:03Z. Claim comment `5778128279` shows `state.stage: "dispatched"` with `state.sessionId: null`, `fixLoops: 0`, worktree
`.worktrees/5`, branch `backlog/5`. The child process was alive (the dashboard saw `runningClaudeProcs` go 1 -> 2 at 14:16:20Z), so the transcript existed and
the id was discoverable.

## Repro

1. Start a run on any project and let an item reach `dispatched`.
2. Request a stop timed so it is seen by the same `watch` tick that first finds the child's session id in the jsonl — i.e. the stop lands in the interval
   between the child writing its `{"type":"system","subtype":"init"}` line and the next tick after the one that reads it.
3. Abort the run and read the run file (or the claim comment on a tracker project): the item is `dispatched` with `sessionId: null`.

A deterministic test can drive this directly: a `watch` loop whose first jsonl-bearing tick also sees an effective stop request.

## Affects

- `skills/backlog-orchestrate/tools/orchestrate.mjs:4233` — the `stopRequestEffective(...)` branch, which SIGTERMs `pid` and `return EXIT_STOP_REQUESTED`
- `skills/backlog-orchestrate/tools/orchestrate.mjs:4243` — the `applyQueueItemFields(findQueueItem(run, itemId), { session: newlyFoundSessionId })` write that
  is never reached on that tick
- `skills/backlog-orchestrate/tools/orchestrate.mjs:4186` — `findSessionIdInJsonl` discovery, whose result lives only in the local `newlyFoundSessionId`

## Cause

In the `watch` loop the stop check sits ABOVE the session-id write. On the tick that both discovers the id and observes an effective stop request, the function
signals the child and returns `EXIT_STOP_REQUESTED` before line 4243 runs, so `newlyFoundSessionId` — a fact that has already been learned from disk — is
discarded with the stack frame. There is no later tick to recover it, and no other writer of that field: `stage --session` is the only other path and the run is
over.

The ordering itself is deliberate and its comment is correct about WHY: the stop branch must run before the heartbeat write so a stopped run does not get its
`updatedAt` pushed forward, because `takeOverRun` reads that freshness to decide whether an abort from elsewhere is refused. That reasoning covers the
`run.updatedAt = nowISO()` bump. It does not cover the session-id field, which is not a freshness signal and which no predicate branches on.

Sibling of bug-43 (the same stop window leaving `pid` null), same cause shape, different field — which is the argument for fixing the window rather than the
field: a third field will otherwise follow.

## Fix

Persist a freshly-discovered session id before the stop return, as its own write that leaves `updatedAt` alone.

Concretely: inside the stop branch, after the `process.kill` attempt and before `return EXIT_STOP_REQUESTED`, apply `{ session: newlyFoundSessionId }` to the
queue item and write the run atomically WITHOUT touching `run.updatedAt`. The existing `applyQueueItemFields` + `writeRunAtomic` pair is reused; the only
difference from line 4243's write is that the `updatedAt` bump is skipped, which is exactly the property the early return was protecting.

Worth checking in the same change whether `pid` (bug-43) can be persisted by the same pre-return write, since both fields are learned in this loop and lost at
the same boundary.
