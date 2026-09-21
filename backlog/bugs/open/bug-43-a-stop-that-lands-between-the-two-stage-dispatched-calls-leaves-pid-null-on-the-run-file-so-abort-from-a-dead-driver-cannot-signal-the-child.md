---
id: bug-43
title: A stop that lands between the two stage dispatched calls leaves pid null on the run file, so abort from a dead driver cannot signal the child
created: 2026-09-21
tags: orchestrator, stop, abort, pid
---

## Symptom

SKILL.md's dispatch step is two `stage <id> dispatched` calls: one with `--worktree`/`--branch`/`--permission-mode` BEFORE the child is spawned, then, once
`logs/<id>.pid` exists, a second with `--pid`. A stop request that lands in that window makes the second call exit `10` (`stage` refuses every transition
under a stop), so `RunQueueItem.pid` stays `null` while a `claude -p` child is running. `cmdAbort` signals only the pids the run file carries — both abort
sessions on 2026-09-21 printed `abort: signalled 0 live session(s)` — so with the driver dead the child is orphaned: it keeps working in a worktree the abort
has just removed.

Observed 2026-09-21, run `run-20260921-091645` on `futin/test-claude-issues` (verification doc, Test 3): the stop was posted at 09:18:30, between the first
`stage 6 dispatched` (09:18:15) and the `--pid` call (09:18:44, refused). The child was killed only because the live driver ran `kill -TERM $(cat logs/6.pid)`
from `recovery.md` before its own `abort`.

## Repro

1. Start a run for one issue; watch `run.json` for `stage: dispatched` with `pid: null`.
2. `POST /api/agents/stop { project }` inside that window (seconds), then kill the driver.
3. The spawned abort session prints `signalled 0 live session(s)`; `ps -p $(cat <dir>/logs/<id>.pid)` still shows the `claude -p /backlog-execute` child.

## Affects

- `skills/backlog-orchestrate/SKILL.md` — the dispatch step (two `stage dispatched` calls around the spawn).
- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `cmdStage`'s stop gate (exit `10` on every transition, including the same-stage `--pid` update) and
  `cmdAbort`'s pid source (the run file only; nothing reads `logs/<id>.pid`).

## Cause

The pid reaches the run file through a transition the stop gate refuses, and `abort` has no second source for it. `logs/<id>.pid` is written by the driver
before the refused call, so the fact exists on disk and the tool does not look there.

## Fix

unknown
