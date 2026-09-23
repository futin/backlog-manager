---
id: task-56
title: orchestrator:queued — live and stale badge on the card
created: 2026-09-23
---

## Goal

Every machine's board draws a queued tracker item as a `queued` badge while a live run holds its project, and as a dimmed `queued · stale` badge when none
does (crashed run, dead remote run, hand-added label). Spec: [docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md](docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md) §4.2. Plan: [docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md](docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md) Task 5.

## Plan

Depends on task-52 (`BacklogItem.queued`).

1. `client/src/lib/tracker.ts`: `queuedReading(item: Pick<BacklogItem, 'queued' | 'project'>, runs: readonly Pick<OrchestratorRun, 'project' | 'status' |
   'updatedAt'>[], now: number): 'live' | 'stale' | null`. `runs` = local runs plus `remote.map(remoteAsLive)`, matched on `project` path (a remote run
   carries this machine's registry path — `RemoteRunsService.list`). Live = `status === 'paused'` OR `runIsLive(run, now)` — `runIsLive` alone is false for
   paused, and a paused run still plans its items.
2. `client/src/components/board/ItemCard.tsx`: the badge through an existing `components/ui/` look (`Marker`, a muted tone for stale); the stale badge's
   `title` says no live run holds it and it can be removed on GitHub or by stopping the crashed run. Cite the `.claude/DESIGN.md` subsection in the header
   comment.

## Test cases (fixture dates relative to the assertion's clock)

- `test/tracker-lib.test.ts`: no `queued` → `null`; + local `running` run updated 1 min ago → `'live'`; + local `paused` run updated 3 h ago → `'live'`;
  + local `running` run older than `RUN_STALE_MS` → `'stale'`; + fresh remote run for the project → `'live'`; + live run for a different project only →
  `'stale'`; + `done` run → `'stale'`.
- `test/tracker-board.test.tsx`: `'live'` renders `queued`; `'stale'` renders `queued · stale` with the title; `null` renders neither.

## Done when

Cases pass; `pnpm test` and `pnpm run typecheck` green.
