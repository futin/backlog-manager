---
id: bug-35
title: Watchdog retries a permanently-refused resume forever
created: 2026-09-16
tags: watchdog, orchestrator
---

## Symptom

A resume the dashboard refuses for a reason that cannot clear on its own — remote answers toggled off, `BM_AGENTS` misconfigured, the dashboard down — is retried
every `graceMs` for as long as the run stays crashed, with no ceiling and no escalation. `maxAttempts` does not bound it, because `entry.attempts` is incremented
only on a spawn that returned a session id, so a refusal is bookkept as "not counted" and the cap never moves.

Observed on `run-20260915-215917` (this repo, 2026-09-15 → 09-16): **17 consecutive `failed` events** carrying `resume failed: remote answers are off in the
dashboard (not counted)`, at 23:49 → 05:09 UTC, one every 20 minutes — 5h20m during which the run was crashed, the watchdog was doing the one thing it exists to
do, and nobody was told. The 3 real attempts (`1/3`, `2/3`, `3/3` at 05:29 / 05:49 / 06:09) only began once remote answers were switched back on, and the run
exhausted at 06:19. From the outside this reads as "the watchdog retried 20 times against a cap of 3".

Two costs, and the second is the one that makes it a bug rather than a design tradeoff:

1. **The recovery never happened.** A crashed run sat unresumed for 5h20m while the feature whose entire purpose is that recovery looped on a refusal it could
   have recognised as terminal on the second occurrence.
2. **The evidence was destroyed.** `WatchdogStateService`'s event log is a 50-entry ring buffer. 17 identical failure lines are 34% of it; a longer outage evicts
   every `spawned`, `recovered` and `exhausted` line the log exists to hold. The Settings Activity list is the answer to "where do I see that it ran", and a
   permanent refusal turns it into a single sentence repeated until nothing else survives.

## Repro

1. Have a crashed orchestrator run — `status: "running"`, `updatedAt` older than `RUN_STALE_MS` — in a project the dashboard can see.
2. Turn remote answers off in the dashboard (any refusal `AgentsService.resume()` surfaces as an `HttpException` reproduces it; this is just the cheapest one).
3. Leave the watchdog armed and enabled.
4. `GET /api/agents/watchdog` after a few ticks: one `failed` event per `graceMs`, `attempts` still `0`, `exhausted` still `false`, forever.

## Affects

- `server/src/agents/watchdog.service.ts:513` — `spawn()`. `entry.attempts += 1` sits inside the `try`, after `await this.agents.resume(...)` returns; the
  `catch` deliberately leaves `attempts` untouched and pushes `failed`.
- `server/src/agents/watchdog.service.ts:383` — `visit()` step 2/3. `watchdogExhausted(entry.attempts, config.maxAttempts)` is the only thing that can stand the
  sweeper down, and it reads a counter a refusal never moves.
- `server/src/orchestrator/watchdog-state.service.ts:85` — `WatchdogEntry`. Has `lastError` (the most recent refusal's sentence) but no count of consecutive
  failures, so no ceiling can be derived from what is stored today.
- `server/src/orchestrator/watchdog-state.service.ts` — the 50-entry event ring the duplicate lines evict.
- `shared/agent.ts:580` — `watchdogExhausted`, and `watchdogStoodDown` at `:615`. Any new stand-down condition has to go through these two, since the board's
  hand-resume offer is the same predicate (CLAUDE.md: "the board offers a hand resume exactly when the watchdog will not spawn one").

## Cause

"Any spawn attempt starts the grace clock; only a success counts against the cap" (CLAUDE.md invariant,
[why](../../../docs/subsystems/invariants.md#grace-any-attempt-starts-the-clock-only-a-success-counts)) is correct for what it was written about and silent about
this case. It splits attempts into two classes — grace-affecting and cap-affecting — on the axis of *did a session start*, which is the right axis for a
**transient** failure: a dashboard that was restarting should not spend a cap slot, because the next tick may well succeed. It has no third class for a failure
that is **terminal until a human acts**, and every refusal `AgentsService.resume()` raises is currently treated as the transient kind.

So the sweeper has exactly one exit from a crashed run — the cap — and a refusal is by construction unable to move it. `lastError` records *what* went wrong and
nothing reads it; `entry` has no notion of "this is the Nth time in a row".

The refusal in this instance is the dashboard's, not this app's: the message comes from `claude-agents-dashboard`'s spawn endpoint, surfaced here by
`resumeErrorMessage`. That matters for the fix — the sentence is another repo's string, so a fix must not classify refusals by matching on its text.

## Fix

unknown

Three shapes were considered while filing; the choice is grooming's, not this file's.

1. **Consecutive-failure ceiling.** Add `consecutiveFailures` to `WatchdogEntry`, reset on any success, and stand the sweeper down at a bound (its own setting, or
   reuse `maxAttempts`). Smallest change; has to enter through `watchdogStoodDown` so the board's Resume control appears at the same moment, which means a new
   input to a predicate two suites pin from one table (`test/watchdog-coupling.test.tsx`, `test/watchdog-sweep.test.ts`).
2. **Exponential backoff on `lastSpawnAt`.** Keeps trying forever — right if the refusal really is transient — but only widens the interval, so it fixes the ring
   buffer and not the "nobody was told" half.
3. **Classify the refusal.** Terminal (remote answers off, `BM_AGENTS` off, project not visible) stands down on the first occurrence; transient (network, 5xx)
   backs off. Best behaviour, most coupling: the taxonomy has to come from a status code or an error code, never from matching the dashboard's prose.

Whichever lands, two things are worth deciding with it: whether a stood-down-on-failure run reports a different `kind` than `exhausted` (the strip currently says
"exhausted after N attempts", which would be a lie at `attempts: 0`), and whether repeated identical failures should collapse in the event log rather than
consuming one ring slot each.
