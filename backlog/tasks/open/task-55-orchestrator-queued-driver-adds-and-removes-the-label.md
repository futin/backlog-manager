---
id: task-55
title: orchestrator:queued — driver adds and removes the label
created: 2026-09-23
---

## Goal

The orchestrator driver marks a tracker run's queue with `orchestrator:queued` at `init` and removes it on skip, `finish` and `--abort`, through
`POST /api/items/queue`, never failing a command over it. Spec: [docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md](docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md) §3, §3.2. Plan: [docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md](docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md) Task 4.

## Plan

Depends on task-53 (the route). `runner-fix` is NOT set: nothing in the run's own machinery depends on this label.

1. `skills/backlog-orchestrate/tools/orchestrate.mjs`, beside the `tracker*` helpers (~line 2048): `trackerQueueLabel(run, items, queued)` — one
   `apiCall('POST', '/api/items/queue', { project: claimProjectOf(run), id: claimItemId(item.id), queued })` per item, sequential, never throws. Non-2xx →
   stderr `orchestrator:queued: <add|remove> failed for <id> — <error>`. An `EXIT_API_DOWN` throw → ONE line `orchestrator:queued: API down — label not
   <added|removed> on <n> item(s)` and stop iterating.
2. Call sites: `cmdInit` after the run file is first written (github project only, items at `pending`, i.e. the queue as built under `--max`); `cmdStage`'s
   preflight claim-lost branch (~line 3162) for that item; `trackerFinish` (~line 3589) and `cmdAbort` (~line 5061, after the in-flight release) sweep every
   queue item with `claim === undefined`. A won claim sends nothing (the server's swap owns it).
3. `skills/backlog-orchestrate/SKILL.md`: one line only if it enumerates the driver's tracker writes.
4. Publishing: `skills/` changes reach nothing until commit, push, `pnpm run plugin:sync` — the orchestrator merges; pushing stays the user's call.

## Test cases (`orchestrate.test.mjs`, `withApi` recording requests)

- `init`, tracker, candidates 31/32/33, `--max 2` → exactly two queue bodies, `{ id: '#31', queued: true }` and `{ id: '#32', queued: true }` in the run file's
  queue order; exit 0.
- `init` on a files project → zero `/api/items/queue` requests.
- `init`, route answers 502 for `#32` → exit 0, run file written, stderr contains `orchestrator:queued: add failed for 32`.
- `stage 32 preflight`, claim lost → item `skipped` and one `{ id: '#32', queued: false }` follows; claim won → no queue request.
- `finish`, queue `[31 merged, 32 skipped, 33 pending]` → removals for 32 and 33, none for 31. `--abort` → the same sweep, after the in-flight release.
- `finish` with the API down → exactly one stderr line matching `API down`, exit code equal to the same `finish` on a files project.

## Done when

Cases pass under `pnpm run test:skills`; `pnpm test` green.
