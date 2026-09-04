---
id: task-14
title: Show a board-started orchestrator run in the strip immediately
created: 2026-09-04
tags: orchestrator, board, server
---

## Goal

A run started from the board takes 1–5 minutes to appear in the run strip.
`GET /api/orchestrator/runs` can only see `run.json`, and `run.json` is first
written by `orchestrate.mjs init` (SKILL.md §2) — so the dashboard spawning
`claude -p`, the session booting, the model reading a 1360-line SKILL.md, and
the §1 `plan` turn are all invisible.

Close the **feedback** gap, not the latency. `plan --project "$PWD"` measured
0.2s on this repo; the delay is agent boot plus model turns and cannot be
removed from the client side of the API at all. Boot time stays what it is.

Full design, rejected alternatives and per-case test list:
[docs/superpowers/plans/2026-09-04-starting-run-placeholder.md](../../../docs/superpowers/plans/2026-09-04-starting-run-placeholder.md).
That plan is approved; read it before starting — it specifies behaviour and
test cases, deliberately not literal code.

## Plan

A server-side, in-memory record of "a spawn was requested", surfaced as a
**separate array** in the runs payload. Adds no writer to the run file.

1. **`shared/types.ts`** — add `StartingRun { project: string; requestedAt: string }`
   and a new top-level `starting: StartingRun[]` on `OrchestratorRunsPayload`.
   A separate array, NOT a `status: 'starting'` member of `runs`:
   `OrchestratorRun` is documented as a verbatim read of a file
   `orchestrate.mjs` wrote, and `runs` is iterated by `aggregateRuns`
   (`client/src/lib/run-stats.ts`), `ArchiveView` and `RunsView` — a synthetic
   member would reach all of them and every exhaustiveness site. A separate
   field reaches only what opts in.

2. **`server/src/orchestrator/starting-runs.service.ts`** (new) — a
   `Map<projectPath, requestedAtMs>`, one entry per project (a second POST
   overwrites). `mark(project)`; `list(realRuns, now?)` evicts **on read**, no
   timers, when either: a run in `realRuns` matches the project and its
   `startedAt` parses to `>= requestedAt` (NOT "a run.json exists" — `cmdInit`
   archives the old file and writes a new one, so a project that has run before
   always has one); or `now - requestedAt > RUN_STALE_MS` (reuse the constant;
   do not mint a second freshness number). Eviction prunes the map, not just
   the returned row. Export from `OrchestratorModule`.

3. **`orchestrator.service.ts`** — inject it; `runs()` returns
   `{ runs, starting: this.starting.list(runs) }`. The `readdirSync` catch that
   returns `{ runs: [] }` must carry `starting` too — that is the shape a
   project's first-ever run takes.

4. **`agents.service.ts`** — `orchestrate()` calls `mark(project)` **after**
   `spawn()` resolves, never before, so a failed spawn leaves no ghost.

5. **Client** — `useOrchestratorRuns` surfaces `starting` and includes "has a
   starting entry" in the 5s fast-poll predicate (otherwise the card sits there
   until the next focus event). BoardView renders a small sibling to `RunStrip`
   when this project has a starting entry and no fresh run: project name,
   "starting…", elapsed via the existing `elapsedSince`. No progress bar and no
   percentage — a 0% bar reads as a stalled run, not an unstarted one.

Deliberate limits, to be stated in the code comments: lost on API restart (the
real run is unaffected — this is a hint, not state); vanishes after
`RUN_STALE_MS` if `init` never lands (a session that spawned but never reached
`init` is diagnosed at the dashboard, not by a card that lies forever); carries
no ids and no merge mode, declined as scope even though the server has both in
hand after `resolveIds`.

`skills/backlog-orchestrate/SKILL.md` is **not** edited by this work — it is
re-read on every one of a run's several hundred turns, so editing it carries a
real ongoing cost and drift risk, and the placeholder covers the whole gap.

## Test cases

Cases 1–18 are enumerated in the plan file. The ones that decide whether the
implementation is right:

- A real run for the project whose `startedAt` is **before** `requestedAt` (the
  previous run's superseded file) → the entry **survives**. This distinguishes
  "a run landed" from "this project has run before" and is what a naive
  implementation gets wrong.
- An unparseable `startedAt` → the entry **survives**.
- `RUN_STALE_MS` boundary asserted in **both** directions (−1 present, +1 gone),
  and the map pruned, not just the row hidden.
- `runs()` on a **missing** orchestrator directory with a marked project →
  `{ runs: [], starting: [one entry] }` — the first-ever-run shape, easily
  swallowed by the `readdirSync` catch.
- A spawn that rejects (dashboard 4xx; missing `sessionId` → 502) and a request
  refused before spawn (`RUN_IN_PROGRESS` 409, bad `mergeMode` 400) mark
  nothing — assert `starting` is empty, not merely that `mark` wasn't called.
- Starting entry **and** a fresh run in the same payload → real `RunStrip`
  renders, placeholder does not.
- Every existing fixture building an `OrchestratorRunsPayload` gains
  `starting: []`; run `pnpm run typecheck` early to find them.

## Done when

- `pnpm test` green and `pnpm run typecheck` clean.
- A board-started run shows a card in the strip within one poll of pressing
  Start, and that card is replaced by the real `RunStrip` once `init` lands.
