---
id: bug-35
title: Watchdog retries a permanently-refused resume forever
created: 2026-09-16
tags: watchdog, orchestrator
updated: 2026-09-22T16:13:46Z
groom-elapsed: 175
groom-tokens: 52535
started: 2026-09-22T15:33:57Z
execute-elapsed: 2389
execute-tokens: 346142
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


Confirmed against the current source while grooming: `entry.attempts += 1` is line 521 of `watchdog.service.ts`, inside the `try` and after the awaited
`resume()`; the `catch` (525-534) writes `lastError` and pushes `failed` with the literal `(not counted)`; `visit()`'s only stand-down is
`watchdogStoodDown({ enabled, exhausted })` at 384, whose `exhausted` is `watchdogExhausted(entry.attempts, …)` at 383. One further detail the filing did not
name and the fix depends on: `entry.lastSpawnAt` is stamped at 518, *before* the call, so a refusal re-arms grace exactly as a success does. That is why the
failures arrive one per `graceMs` forever rather than once per tick — the loop is stable, not a thundering one, which is precisely what let it run for 5h20m
without anything else noticing.

## Fix

**Shape 1 — a consecutive-failure ceiling — measured against the cap that already exists.** Shape 3 (classify the refusal) is rejected for now: the taxonomy
would have to come from the status `AgentsService.resume()` throws, and those statuses do not carry the distinction. `409` covers both a terminal refusal
(`projectDispatchGate` disabled, the dashboard's own "remote answers are off") and a wholly benign one (bug-19's resume lock, "a resume was already started
12s ago"), while the dashboard's spawn failures arrive with the upstream's own status. Classifying by text is ruled out by the Cause above. Shape 2 (backoff)
is rejected because it fixes only the ring-buffer half and never tells anybody. Shape 1 makes the sweeper's existing exit reachable by refusals, and the
existing coupling then does the telling: standing down is exactly what makes the board render its hand-Resume control.

**No second number.** The ceiling is `WatchdogConfig.maxAttempts`, the "Give up after N" the user already sets — an alias, not a new setting, for the reason
`CLAIM_STALE_MS` is an alias of `RUN_STALE_MS`. Nothing is added to `WatchdogConfig`, `watchdog-config.util.ts`, the Settings card or the config route, and
raising "Give up after" re-enters a stood-down run through the same path it already re-enters an exhausted one.

### The change

1. **`server/src/orchestrator/watchdog-state.service.ts`** — add `consecutiveFailures: number` to `WatchdogEntry`, initialised `0` in `upsert`, beside
   `attempts` and with its own comment explaining that the two count different things: `attempts` is sessions this sweeper started, `consecutiveFailures` is
   refusals in a row since the last one it started. Both are in-memory and lost on restart, unchanged.

   In `annotate()`, fill two new `RunWatchdog` fields from the same single read of the entry and the config that already fills `exhausted`:
   `failures: entry?.consecutiveFailures ?? 0` and `failing: watchdogFailing(failures, config.maxAttempts)`. Same rule as `exhausted`: derived at annotate
   time, never stored, so a `POST /api/agents/watchdog/config` between two reads can never publish `failing: true` beside numbers that contradict it.

2. **`shared/agent.ts`** — add `watchdogFailing(consecutiveFailures: number, maxAttempts: number): boolean`, `>=`, the one-line sibling of
   `watchdogExhausted` and written the same way and for the same reason (a person reading the board must be able to check the sentence against the two numbers
   printed beside it).

   Widen the stand-down predicate to `watchdogStoodDown(w: { enabled: boolean; exhausted: boolean; failing: boolean })` — **a required third property, no
   default**, the rule `runClaimBlock` follows for `starting` (bug-21). A default would let a future caller silently opt out of the new stand-down and put the
   board back to offering Resume while the sweeper still spawns, which is the one thing this predicate exists to prevent. `RunControls` passes
   `run.watchdog` whole and needs no edit; `watchdog.service.ts`'s object literal is the one call site the compiler will fail, which is the intent.

3. **`shared/types.ts`** — add `failures: number` and `failing: boolean` to `RunWatchdog`, both required (the compiler is the fixture checklist here, the same
   way it is for `BacklogItem.source`). Add `'stalled'` to `WatchdogEventKind`.

   `stalled`, not a reuse of `exhausted`: the strip and the Activity list both render `exhausted after ${attempts} attempts`, and at `attempts: 0` — the
   observed case — that sentence is false. This answers the first of the two questions the filing left open: a stood-down-on-failure run reports its own kind.

4. **`server/src/agents/watchdog.service.ts`**
   - `spawn()`: on success, `entry.consecutiveFailures = 0` beside the existing `attempts += 1` / `lastError = null`. In the `catch`, `entry.consecutiveFailures += 1`,
     and change the pushed detail so it stops claiming nothing was counted when something now is:
     `resume failed: ${entry.lastError} (${entry.consecutiveFailures}/${maxAttempts} in a row; no session started, so the attempt cap is untouched)`.
   - `visit()`: `const failing = watchdogFailing(entry.consecutiveFailures, config.maxAttempts);` beside the existing `enabled`/`exhausted`, passed into the
     one `watchdogStoodDown` call. Inside the stand-down branch the existing `off` → `exhausted` ladder gains a third rung, ranked last: `off` first (an
     operator who just flipped the toggle is owed the fact they can act on), then `exhausted`, then `stalled`, each logged once per condition behind its own
     `…Logged` flag — `entry.stalledLogged`, initialised `false` in `upsert` and cleared alongside `entry.exhaustedLogged = false` on the line past the branch,
     so a raised cap lets a run say it again rather than stalling in silence. The line: `` `resume refused ${entry.consecutiveFailures}× in a row — resume by hand (last: ${entry.lastError})` ``.
   - `visit()` step 1 (`run.fresh`, the `recovered` branch) and `noteBoardResume()`: both set `entry.consecutiveFailures = 0`. Recovery and a hand resume that
     actually spawned are the two events that prove the refusal has cleared, and a person clicking the control this stand-down exists to reveal must not have
     to click it twice.

5. **`client/src/lib/run-watchdog.ts`** — `watchdogClause` gains one clause, between `!w.enabled` and the `lastError` fallback (which it subsumes, so ordering
   matters): `` if (w.failing) return `watchdog: resume refused ${w.failures}× — resume by hand`; ``. Add `stalled` to `WATCHDOG_KIND_GLYPH` and to
   `WATCHDOG_KIND_TONE` (tone `warn`, the same tone `exhausted` and `disabled` carry — a state needing a person, not a failure of this run).

**The ring buffer needs nothing of its own**, which answers the filing's second open question: with a ceiling of `maxAttempts` a run can push at most that many
`failed` lines plus one `stalled`, so the 17-line flood is gone as a consequence of the fix rather than as a second mechanism. Collapsing duplicate events is
therefore NOT part of this bug; if it is ever wanted it is a separate item about the log, not about the watchdog.

**Known and accepted: bug-19's resume lock counts.** A sweeper tick that lands inside the 15-minute window of a board resume is refused, and that refusal
increments the counter like any other. It is not worth a new error code to exclude: a successful board resume resets the counter through `noteBoardResume`
before the sweeper can see the lock, and a resume that recovers the run resets it again through `recovered`. What remains is a run that a person resumed, that
did not recover, and that the sweeper then stands down on early — which is the correct outcome anyway.

### Test cases

- `test/helpers/watchdog-coupling.ts` — `CouplingRow` gains `consecutiveFailures`, `rowWatchdog` fills `failures` and
  `failing: watchdogFailing(row.consecutiveFailures, row.maxAttempts)`, and every existing row gains `consecutiveFailures: 0` so its hand-checked `standsDown`
  verdict is unchanged. Three rows added, each with `standsDown` written out by hand, never derived: enabled with `attempts: 0, consecutiveFailures: 2, maxAttempts: 3`
  → `false`; enabled with `attempts: 0, consecutiveFailures: 3, maxAttempts: 3` → `true` (**the bug's own state**, and the row whose absence let it ship);
  enabled with `attempts: 0, consecutiveFailures: 3, maxAttempts: 4` → `false`, the raised-cap re-entry.
- `test/watchdog-sweep.test.ts` — a sweep case driving the real failure: `AgentsService.resume` stubbed to reject with an `HttpException` every time, a
  crashed run, `maxAttempts: 3`, and grace advanced between ticks. Assert after the third tick that `consecutiveFailures` is `3`, `attempts` is still `0`,
  exactly one `stalled` event exists, and that the fourth and fifth ticks add no further `failed` event and make no further `resume` call (today's code makes
  one per tick forever — that call count is the red proof, and it must be taken from the stub, not from the log). Then a sixth tick with the stub resolving
  and `maxAttempts` raised to `4`: one `spawned` event, `attempts: 1`, `consecutiveFailures: 0`.
- `test/watchdog-sweep.test.ts` — reset coverage: a run that goes fresh after two failures clears `consecutiveFailures` (via the `recovered` branch), and
  `noteBoardResume` clears it too.
- `test/watchdog-coupling.test.tsx` — unchanged in structure; it re-runs the widened table through both `watchdogStoodDown` and `RunControls`, so the three new
  rows assert the client's half (a Resume control renders for the stalled state) for free. Its "exactly one client reader" source guard must stay green.
- `test/run-watchdog.test.ts` — the `Record<WatchdogEventKind, true>` literal forces `stalled` into the glyph and tone maps; add `watchdogClause` cases for
  `failing: true` (the new sentence), and for `failing: true` with `exhausted: true` (exhausted still wins, the existing order).
- `test/agents-shared.test.ts` — a `watchdogFailing` table mirroring the `watchdogExhausted` one, `>=` included.

No browser check is written for this fix, deliberately, and this line is the reason rather than an omission: the state it would have to show is server memory
that only real refused spawns can produce — `consecutiveFailures` cannot be written from the outside, and a hand-built `run.json` would violate the run file's
single-writer rule while still not reaching `WatchdogStateService`. The two rendered readings (`RunControls`'s Resume, `watchdogClause`'s sentence) are pinned
in jsdom by the suites above, which is where every other watchdog rendering in this repo is pinned.

No `runner-fix:` marker, also deliberately: the code is under `server/src/agents/`, but the marker exists so the *rest of a run* is not executed by the version
being repaired, and a server change cannot take effect inside a run that is already going — the process holding the broken watchdog is not restarted by a merge.
Hoisting this item would buy nothing.

## Outcome

2026-09-22 — fixed as Shape 1, the consecutive-failure ceiling, with no new setting. `WatchdogEntry` gained `consecutiveFailures` (spawns refused since the
last one that started a session) and `stalledLogged`; `shared/agent.ts` gained `watchdogFailing(consecutiveFailures, maxAttempts)` beside `watchdogExhausted`
and `watchdogStoodDown` took `failing` as a required third property — which is what broke `visit()`'s object literal at compile time, the one call site that
had to be revisited. `RunWatchdog` carries `failures`/`failing`, filled in `annotate()` from the same single config read `exhausted` already used;
`WatchdogEventKind` gained a ninth member, `stalled`, and `watchdogClause` a clause between `!enabled` and `lastError`. The counter is incremented in
`spawn()`'s catch and zeroed by the three things that prove the refusals are over: a spawn that returned a session id, the run heartbeating again (on the
`fresh` branch itself, not inside the `recovered` guard, which needs `attempts > 0` a run of pure refusals never has), and `noteBoardResume`.

The `failed` event's detail changed with it: `(not counted)` was true and read as "this costs nothing and will be retried", which is right for an outage and
wrong for a refusal that can never clear. It now reads `(<n>/<max> in a row; no session started, so the attempt cap is untouched)`, so the ceiling is visible
in the feed before it arrives rather than only once.

Verified — `pnpm test` (both runners) and `pnpm run typecheck`:

```
Test Suites: 129 passed, 129 total
Tests:       2182 passed, 2182 total
# tests 779
# pass 779
# fail 0
PASS  jest
PASS  node --test (skills)
pnpm test: both runners passed.

$ tsc --noEmit --tsBuildInfoFile node_modules/.cache/tsconfig.tsbuildinfo
```

The behaviour the bug describes, as the sweep case now pins it: three refusals against `maxAttempts: 3` leave `attempts` at `0` and stop the asking — the
fourth and fifth ticks make no `resume` call at all (`dash.spawns()` stays at 3, taken from the stub rather than from the log) and add no further `failed`
line, while exactly one `stalled` event says why. Raising "Give up after" to 4 revives the run through the same path an exhausted one re-enters by.

Contract sweep: 6 sites updated (CLAUDE.md — the "only a success counts against the cap" headline now names both ledgers; .claude/rules/dispatch-watchdog.md —
the same headline byte-equal plus the mechanism for the two counters, the three rungs and the three resets; .claude/rules/board.md — the coupling's inputs are
three, not two; docs/subsystems/invariants.md — the reasoning, under the existing "Grace" and "Resume coupling" headings so the cited anchors still resolve;
.claude/DESIGN.md §8.4.2 — "never while the sweeper still has attempts" was false for a stalled run; client/src/lib/run-watchdog.ts — the CLAUDE.md headline
it quotes verbatim). Four test sites carried the old wording or an exhaustive literal and were updated with the production change: the three
`toContain('not counted')` assertions in watchdog-sweep, `upsert`'s zeroed-entry literal and `annotate`'s zeroed-defaults literal in watchdog-state, and four
`RunWatchdog` fixtures the two new required fields broke (run-controls, runs-view, watchdog-monitor ×2). Left standing on purpose: the historical records under
`docs/superpowers/plans/`, `docs/superpowers/specs/` and `backlog/*/done/` that quote the old `(not counted)` line or the old two-input rule — those are dated
accounts of what was decided then, and rewriting them would erase the state this fix was made against. `invariants.md`'s "`'stopped'` is an eighth
`WatchdogEventKind`" is also left: it is a statement about bug-39's addition and stays true with a ninth beside it.

Red proof: 7 tests went red with the change reverted — each production change reverted on its own through a file copy, never `git stash`, and restored after.
`consecutiveFailures += 1` removed → the sweep's ceiling case fails (5 spawn calls instead of 3, the endless loop itself). The `fresh`-branch reset removed →
the reset case fails. `noteBoardResume`'s reset removed → the same case fails on its second half. `failing` forced to `false` in `visit()`'s
`watchdogStoodDown` call → the ceiling case fails. `annotate()`'s pair hard-coded to `0`/`false` → both new watchdog-state cases fail. `watchdogFailing`'s `>=`
weakened to `>` → the `agents-shared` table and the coupling table fail (3 cases). `watchdogClause`'s new clause removed → the `run-watchdog` case fails.
