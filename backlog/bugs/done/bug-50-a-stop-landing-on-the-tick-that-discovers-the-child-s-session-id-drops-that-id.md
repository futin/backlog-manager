---
id: bug-50
title: A stop landing on the tick that discovers the child's session id drops that id
created: 2026-09-22
updated: 2026-09-22T15:28:39Z
started: 2026-09-22T15:17:02Z
execute-elapsed: 697
execute-tokens: 63252
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

## Outcome

2026-09-22 — fixed as written, and the open question the Fix left is answered: **still worth its own write.** bug-52 has not landed (it is still in
`backlog/bugs/open/`, and nothing in `cmdAbort` reads `logs/<id>.jsonl`), so there is no abort-side harvest for this to be a narrowing of. Even once bug-52
lands the two are not redundant in one direction that matters: this write puts the id on the run file at the moment the stop is observed, so a driver that is
itself killed between the stop and the `--abort` — the case bug-52's harvest cannot cover, because the harvest runs inside the abort that never happens — still
leaves the id recorded. Closing this as covered was the alternative and it was declined on that evidence, not on preference.

The change is in `cmdWatch`'s stop branch (`skills/backlog-orchestrate/tools/orchestrate.mjs`): after the `process.kill` attempt and before
`return EXIT_STOP_REQUESTED`, a freshly-discovered `newlyFoundSessionId` is applied through the existing `applyQueueItemFields` + `writeRunAtomic` pair, with
the `run.updatedAt = nowISO()` bump deliberately not repeated — that bump is the one property the early return exists to protect, since `takeOverRun` reads the
run's freshness to decide whether an abort from elsewhere is refused. The write is wrapped in a try/catch that prints one stderr line, in the same spirit as the
`SIGTERM` above it: a run file that cannot be written is not a reason to withhold exit `10` from a caller whose child has already been signalled.

Verification — `pnpm run test:skills` (node runner, the suite this tool's tests live in):

```
ℹ tests 779
ℹ suites 0
ℹ pass 779
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 108317.65242
```

`pnpm run test:jest` was run too: 128 of 129 suites pass, 2152 of 2154 tests. The two reds are `test/supertest-bind.test.ts`'s platform cases
(`listen EADDRINUSE: address already in use :::<port>`), which fail on this WSL kernel independently of any branch work and are unrelated to this change — no
file this diff touches is read by that suite.

Contract sweep: 3 sites updated (`.claude/rules/orchestrator.md` — the stop bullet's `watch` clause now says the tick also persists a just-read session id with
`updatedAt` untouched; `docs/subsystems/invariants.md` — the reasoning under "A stop is the control file's second kind", why the early return may drop the
freshness bump but not the id; `skills/backlog-orchestrate/SKILL.md` §4's `exit 10` bullet — a stopped run may now carry the id, which is what §10's
`resume-session` / `redispatch-after-stop` split turns on). Checked and left standing: `skills/backlog-orchestrate/references/recovery.md`'s
`redispatch-after-stop` clause ("no session id was ever recorded, so there is nothing to resume") — still exactly true, just reached less often;
`shared/types.ts`'s `RunQueueItem.sessionId` comment, which describes when the field is null and is unchanged by this; and prettier's pre-existing formatting
drift in both `orchestrate.mjs` and `orchestrate.test.mjs`, which is present at HEAD and was not reflowed here.

Red proof: 1 test went red with the change reverted — run before the fix existed, which is how it was written:

```
✖ a stop on the tick that first reads the session id persists that id, without bumping updatedAt (bug-50)
  AssertionError [ERR_ASSERTION]: the discovered session id was dropped with the stack frame
  + actual - expected
  + null
  - 'a1b2c3d4-5e6f-4a1b-8c2d-9f0e1a2b3c4d'
```
