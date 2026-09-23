---
id: task-54
title: orchestrator:queued — Stop sweeps the queue server-side
created: 2026-09-23
---

## Goal

A board Stop clears `orchestrator:queued` from every never-claimed queue item at once, server-side, before the abort spawns — so teammates learn the plan is
off within seconds even when the driver is mid-session or dead. Spec: [docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md](docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md) §3, §3.1, §3.2. Plan: [docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md](docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md) Task 3.

## Plan

Depends on task-53 (`ItemWriter.queue`).

1. `shared/types.ts`: `StopResult.unqueueFailed?: string[]` — present only when at least one removal was refused; ids spelled as `run.json` spells them
   (`'31'`).
2. `server/src/agents/agents.service.ts` `stop()` (~line 1152): after `writePauseRequest(..., 'stop')` and before `spawnAbort`, a private `unqueue(project, run)`:
   `this.items.writerFor(project)`; not writable (files) → return; for each queue item with `claim === undefined`, `await writer.queue(..., { queued: false })`
   sequentially; a refusal OR a thrown error adds the id to the failed list and never propagates. Never touch `GithubClient` from agents.

## Test cases (`test/agents-stop.test.ts`)

- Tracker run, queue `[31 claimed, 32 pending, 33 pending]` → removals on 32 and 33 only, in order; `stopRequested: true`; abort spawn attempted; no
  `unqueueFailed` key.
- Same, 32's removal answered 403 + `x-ratelimit-remaining: 0` → `unqueueFailed: ['32']`, 33 still removed, `stopRequested: true`, abort still spawned.
- `files` run → zero item-writer calls, no `unqueueFailed` key.
- No running run → the existing 409, no sweep.
- Call order: stop control file written, then the sweep, then `spawnAbort`.
- The issue number that reached the fake for queue id `'32'` is 32 (id spelling).

## Done when

Cases pass; `pnpm test` and `pnpm run typecheck` green.
