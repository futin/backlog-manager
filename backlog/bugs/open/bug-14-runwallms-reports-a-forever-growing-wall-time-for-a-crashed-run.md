---
id: bug-14
title: runWallMs reports a forever-growing wall time for a crashed run
created: 2026-09-02
---

## Symptom

A run whose orchestrator crashed keeps its `run.json` at `status: "running"`
forever — that is the documented invariant: `orchestrate.mjs init` refuses on
any `status: "running"` file, "fresh or stale — a stale one means a crashed
run, recoverable only via `--resume`/`--abort`". `GET /api/orchestrator/archive`
serves that file verbatim.

`runWallMs` forks on `status === 'running'` alone and answers `now − startedAt`
for it. So a crashed run's wall time in the Runs list grows by a second every
second, indefinitely, reported as "how long this run has taken". Three days
after the crash it reads three days.

## Repro

1. Start an orchestrator run and kill the process mid-item (or find an existing
   crashed run — `run.json` left at `status: "running"` with an `updatedAt`
   older than `RUN_STALE_MS`).
2. Open the Runs tab. The row's wall time keeps climbing on every render.

## Affects

- `client/src/lib/run-stats.ts` — `runWallMs`, the `status === 'running'`
  branch.
- `client/src/lib/run-time.ts:179` — `runElapsedMs` already solves the same
  problem correctly, forking on `status === 'running' && fresh` and freezing at
  `updatedAt` otherwise. Its comment states the reasoning: "nobody knows whether
  that process is still working, so freezing the total at its last confirmed
  heartbeat is the only honest reading".
- `shared/types.ts:511` — `RUN_STALE_MS`, the heartbeat window.

## Cause

`runWallMs` reads `status` but not the heartbeat. Its own doc comment used to
assert that an archived run "cannot go stale — it is either still running right
now or it is finished forever", which is false for exactly the crashed case
above; that sentence was corrected in the runs-view-redesign branch
(2026-09-02) but the behaviour was deliberately left alone as out of that
branch's scope.

`runStageTotals` in the same file had the identical defect and was fixed in
that branch: it now takes a required `updatedAt` and ends an open span at `now`
only while `now − updatedAt < RUN_STALE_MS`, else at `updatedAt`. That fix is
the pattern to copy.

The reason `runStageTotals` was fixed and this was not: `runStageTotals` feeds
`sumStageTotals`, so one crashed run contaminated an aggregate across all of
history with no "this run is dead" cue anywhere on it. `runWallMs` is a single
per-run reading shown beside its own `running` status chip, which at least
hints at why the number is odd. That makes this lower severity, not correct.

## Fix

unknown
