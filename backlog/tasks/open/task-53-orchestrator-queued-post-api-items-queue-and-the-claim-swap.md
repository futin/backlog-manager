---
id: task-53
title: orchestrator:queued — POST /api/items/queue and the claim swap
created: 2026-09-23
---

## Goal

The eighth guarded write route, `POST /api/items/queue` `{ project, id, queued: boolean }`, plus the claim swap: a won claim removes `orchestrator:queued` as it
adds `in-progress`. Spec: [docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md](docs/superpowers/specs/2026-09-23-orchestrator-queued-label-design.md) §2, §3.3. Plan: [docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md](docs/superpowers/plans/2026-09-23-orchestrator-queued-label.md) Task 2.

## Plan

Depends on task-52 (`QUEUED_LABEL`).

1. `server/src/items/sources/source.ts`: `ItemQueueRequest = { project: string; id: string; queued: boolean }`; `ItemWriter.queue(project, marker, req):
   Promise<WriteOutcome<{ id: string; queued: boolean }>>`.
2. `server/src/items/sources/github.source.ts`: `queue` resolves the number (`issueNumberFor`), runs on the item's `serialise(issueUrn(...))` chain, calls
   `client.addLabels` or `client.removeLabel`; a remove 404 is success; other failures through `refusalFor`. Does not read the issue's state — a closed issue
   is not refused.
3. Same file, won-claim branch (~line 474): after `addLabels(['in-progress'])`, `removeLabel(QUEUED_LABEL)`, result ignored for the reason the neighbouring
   `in-progress` removal comments give. A lost claim removes nothing.
4. `server/src/items/items-write.controller.ts`: `@Post('queue')` using the existing `required`/`writable`/`answer` helpers; 400 on missing `project`/`id` or
   non-boolean `queued`. Guarded like the seven, refused for a `files` project.

## Test cases

- `queued: true` on `#31` → fake records one add on issue 31 with `['orchestrator:queued']`; `200 { id: '#31', queued: true }`.
- `queued: false`, label present → one remove; `200 { queued: false }`. Fake answers remove with 404 → still `200`. Closed issue → `200`.
- `queued: 'yes'` → 400; missing `id` → 400; a `files` project → the same refusal the other seven give it (read it off an existing case).
- `test/tracker-origin.test.ts`: missing JSON content-type and a foreign Origin are refused like `POST /api/items/claim`.
- A concurrent `queue` + `claim` on one issue both resolve; the final labels are `in-progress` without `orchestrator:queued`.
- Won claim on an issue carrying the label → removed, `in-progress` added. Lost claim → label stays.

## Done when

Cases pass in `test/tracker-write.test.ts` / `tracker-claim.test.ts` / `tracker-origin.test.ts`; `pnpm test` and `pnpm run typecheck` green.
