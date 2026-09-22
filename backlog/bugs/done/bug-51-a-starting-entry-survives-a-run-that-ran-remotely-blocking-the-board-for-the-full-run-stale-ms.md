---
id: bug-51
title: A starting entry survives a run that ran remotely, blocking the board for the full RUN_STALE_MS
created: 2026-09-22
updated: 2026-09-22T19:03:36Z
started: 2026-09-22T18:52:02Z
execute-elapsed: 694
execute-tokens: 72462
---

## Symptom

After a board-started run whose driver ran on ANOTHER machine, the launching machine's board stays blocked for a full fifteen minutes even though the run has
visibly started and finished. The Orchestrate control is hidden (the environment-level block) and every per-item control for that project is disabled, so the
project cannot be launched again until the starting mark ages out.

Nothing is wrong with the item or its claim while this lasts: the issue reads unassigned, `in-progress` removed, no live claim comment. The only thing holding
the board is a `starting` entry in server memory that no longer describes anything.

Observed 2026-09-22. The Mac server's `/api/orchestrator/runs` answered `starting: [{project: .../guide-manager, requestedAt: "2026-09-22T14:14:36.166Z"}]`
while the same payload carried, in `remote`, the run that mark was for: `run-20260922-141510`, `startedAt` 14:15:10Z, host `futin_ubuntu@JevticPC`, status
`aborted`. The board was still blocked at 14:25:35Z and would not free until 14:29:36Z — 14 minutes after that run had already ended.

## Repro

1. From the board on machine A, launch an orchestrator run for a project whose driver runs on machine B (a remote run).
2. Let the run start — `startedAt` later than the launch's `requestedAt` — and then end, by abort or otherwise.
3. Poll `/api/orchestrator/runs` on machine A: the `starting` entry for that project is still listed, and the board's Orchestrate control is still hidden.
4. It clears only once `now - requestedAt > RUN_STALE_MS`.

## Affects

- `server/src/orchestrator/starting-runs.service.ts:172` — `expired()`, the one eviction predicate, and specifically its line 175 started-check
- `server/src/orchestrator/starting-runs.service.ts:90` — `list()`, which filters by it
- `server/src/orchestrator/starting-runs.service.ts:107` — `sweep()`, which prunes by it
- `server/src/orchestrator/remote-runs.service.ts` — the remote runs the predicate never sees

## Cause

`expired()` decides a mark is spent from three clauses, and both of its run-shaped questions are asked only of `realRuns` — the run files this server reads off
its own disk:

```
173    if (now - requestedAt > RUN_STALE_MS) return true;
174    if (realRuns.some((run) => run.project === project && run.status === 'running')) return true;
175    return realRuns.some((run) => run.project === project && Date.parse(run.startedAt) >= requestedAt);
```

A run that ran on another machine writes no run file here, so it is never in `realRuns` — it arrives as a REMOTE run, derived from the tracker cache and carried
beside `runs` in the same payload. Line 175's question ("has a run for this project started since I marked it?") was answered by `run-20260922-141510` the whole
time; the predicate simply never looked in the array holding it. Only the timeout clause on line 173 can retire such a mark, which is why the block lasts the
full `RUN_STALE_MS` rather than ending when the run did.

This is the cost of "remote runs ride beside `runs`, never in it" landing (task-48) without this predicate being revisited. The invariant is about what the
`runs` array may contain, and it should stay — but `expired` is not asking a question about that array, it is asking whether a run started, and a remote run
answers it exactly as well as a local one.

## Fix

Give `expired()` the remote runs as well as the local ones, and let the started-check (line 175) consider both. `RUN_STALE_MS` stays as the backstop for a spawn
that never became any kind of run.

Two details worth deciding deliberately rather than by accident:

- The `running` clause on line 174 should probably also consider remote runs, since a remote run in flight is exactly as good a reason to keep the mark alive as
  a local one — but confirm that against what the board does with a live remote run before widening it.
- `list()` and `sweep()` both take `realRuns` from their callers, so the remote runs have to be threaded through the same call sites rather than read inside the
  service; keep the injectable `now` and the no-timers property intact.

Test cases: a mark plus a remote run for the same project with `startedAt` after `requestedAt` evicts; the same with `startedAt` BEFORE `requestedAt` does not
(an older remote run must not retire a fresh mark); a mark with a remote run for a DIFFERENT project does not evict; and the existing local-run boundary cases
keep passing unchanged.

## Done when

`test/orchestrator-starting.test.ts` covers the four cases above, and a board that launched a run which ran remotely frees its controls as soon as that run is
visible, not fifteen minutes later.

## Outcome

2026-09-22. Cause confirmed against the live code: `expired()` asked both run-shaped questions of `realRuns` only, and a run another machine drove never
reaches that array. `StartingRunsService.list`/`sweep` now take a third argument, `remoteRuns` (default `[]`, after `now` so every existing call keeps its
shape), and rule 1 (started at/after the mark) considers local and remote runs alike. `OrchestratorController.runs()` reads `remoteRuns.list()` first, then
re-filters `payload.starting` and sweeps against both, with one shared `now`.

Two deliberate decisions:

- **Rule 3 (`running`) stays LOCAL-only.** It holds because `init` refuses a local `running` file; another machine's run blocks no `init` here (spec §7.4),
  so a remote run already in flight must not strip the placeholder of a local spawn that can still land. Pinned by its own test.
- **Remote runs are threaded from the controller only.** `OrchestratorService` cannot be handed them — `RemoteRunsService` already injects it, so that would be
  a cycle. `AgentsService`'s direct `runs()` callers (the RUN_IN_PROGRESS starting lock at `agents.service.ts:653`, dispatch gates) therefore see a
  remote-retired mark until the next GET sweeps it. That errs toward blocking, and the GET that tells the board the project is free is the same request whose
  sweep frees the lock — pinned by the controller test, which asserts `OrchestratorService.runs().starting` is empty after one GET.

Verification:

```
$ pnpm run typecheck
$ tsc --noEmit --tsBuildInfoFile node_modules/.cache/tsconfig.tsbuildinfo
(clean)

$ pnpm run test:jest
Test Suites: 129 passed, 129 total
Tests:       2188 passed, 2188 total

$ pnpm test   (node half)
# tests 779
# pass 779
# fail 0
```

Contract sweep: 4 sites updated (server/src/orchestrator/orchestrator.controller.ts — the "starting sweep reads `runs` alone" and "safe without a sweep of
their own" comments; server/src/orchestrator/starting-runs.service.ts — class comment's "correctness never depends on the sweep"; .claude/rules/dispatch-watchdog.md
— the three-rules bullet; docs/subsystems/invariants.md — rule 1, rule 3 and the sweep paragraph of "A board-started run is visible before its run file exists")
Red proof: 6 tests went red with the change reverted (predicate's remote half removed → 2 service evict cases + the controller case; controller reverted to
the local-only sweep → the controller case; remote match widened to ignore project/startedAt → the two "keeps" cases; rule 3 widened to remote → the
remote-running "keeps" case)
