---
id: bug-51
title: A starting entry survives a run that ran remotely, blocking the board for the full RUN_STALE_MS
created: 2026-09-22
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
