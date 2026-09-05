---
id: task-14
title: Show a board-started orchestrator run in the strip immediately
created: 2026-09-04
tags: orchestrator, board, server
updated: 2026-09-05T17:04:26Z
started: 2026-09-05T16:46:25Z
execute-elapsed: 1081
execute-tokens: 189289
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
test cases, deliberately not literal code. **Both it and the steps below were
re-anchored 2026-09-05 against `fcf4680`** (the orchestrator-watchdog merge,
which landed after both were written); the plan marks every re-anchored
passage with ▲.

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
   overwrites). **Three methods, split pure/mutating** (▲ re-anchored — the
   approved version had `list` evict on read, and `runs()` is now documented
   as a pure read): `mark(project)`; `list(realRuns, now?)`, a **pure** filter
   that never touches the map, the counterpart of the watchdog's `annotate()`;
   and `sweep(realRuns, now?)`, which deletes what `list` filtered, the
   counterpart of `observe()`. Both share ONE predicate, not two agreeing
   expressions. The rule is unchanged: drop an entry when a run in `realRuns`
   matches the project and its `startedAt` parses to `>= requestedAt` (NOT "a
   run.json exists" — `cmdInit` archives the old file and writes a new one, so
   a project that has run before always has one), or when
   `now - requestedAt > RUN_STALE_MS` (reuse the constant; do not mint a second
   freshness number). Correctness never depends on the prune — `list`
   re-applies both rules every call, so an unswept map leaks memory, never
   lies, which is what makes `AgentsService`'s own direct `runs()` calls (the
   lock check, `resume()`) safe without a sweep. Export from
   `OrchestratorModule`.

3. **`orchestrator.service.ts`** — inject it; `runs()` returns
   `{ runs, starting: this.starting.list(runs) }`, the pure half only. The
   `readdirSync` catch that returns `{ runs: [] }` must carry `starting` too —
   that is the shape a project's first-ever run takes. ▲ The prune is a
   separate `sweep(payload.runs)` line in **`orchestrator.controller.ts`**,
   beside the existing `watchdogState.observe(payload)` and for the identical
   reason.

4. **`agents.controller.ts`** (▲ the controller, not `agents.service.ts` as
   approved) — call `mark(project)` after `await this.agents.orchestrate(...)`
   returns, beside `this.watchdog.arm()`. That is where `fcf4680` put every
   other spawn-success side effect (`arm()`, `noteBoardResume()`), and a third
   one in a different layer would split one pattern across two. **After, never
   before**: a spawn that throws never reaches the line, so a failed spawn
   leaves no ghost. Order versus `arm()` is immaterial — the sweeper never
   reads starting entries — unlike `noteBoardResume`'s deliberate
   before-`arm()` placement; say so in the comment. Needs
   `StartingRunsService` injected into `AgentsController`.

5. **Client** — `useOrchestratorRuns` surfaces `starting` and ORs "has a
   starting entry" into `anyLive`, the existing fast-poll predicate (▲ widened
   by `fcf4680` to `fresh || status === 'running'`), otherwise the card sits
   there until the next focus event. BoardView renders a small sibling to
   `RunStrip` when this project has a starting entry and **no `running` run at
   all, fresh or crashed** (▲ the approved "no fresh run" is now wrong:
   `RunStrip` returns null only for `!fresh && status !== 'running'` and
   BoardView maps `runningRuns`, so a crashed run already renders a strip).
   Card shows project name, "starting…", elapsed via the existing
   `elapsedSince`. No progress bar and no percentage — a 0% bar reads as a
   stalled run, not an unstarted one.

Deliberate limits, to be stated in the code comments: lost on API restart (the
real run is unaffected — this is a hint, not state); vanishes after
`RUN_STALE_MS` if `init` never lands (a session that spawned but never reached
`init` is diagnosed at the dashboard, not by a card that lies forever); carries
no ids and no merge mode, declined as scope even though the server has both in
hand after `resolveIds`.

`skills/backlog-orchestrate/SKILL.md` is **not** edited by this work — it is
re-read on every one of a run's several hundred turns, so editing it carries a
real ongoing cost and drift risk, and the placeholder covers the whole gap.

▲ **`POST /api/agents/resume` is out of scope.** `fcf4680` added a second
board control that spawns a headless session with the same invisible boot gap,
but the run it resumes already reads `status: 'running'`, so the board is
already rendering a crashed strip for it — the screen is not blank, which is
the condition this feature exists for. Do not `mark()` from the resume path.

## Test cases

Cases 1–18 are enumerated in the plan file. The ones that decide whether the
implementation is right:

- A real run for the project whose `startedAt` is **before** `requestedAt` (the
  previous run's superseded file) → the entry **survives**. This distinguishes
  "a run landed" from "this project has run before" and is what a naive
  implementation gets wrong.
- An unparseable `startedAt` → the entry **survives**.
- `RUN_STALE_MS` boundary asserted in **both** directions (−1 present, +1 gone).
- ▲ **`runs()` does not prune, the controller does.** Two `runs()` calls after
  a matching run lands → `starting` empty both times AND the map still holds
  the entry; one GET through `OrchestratorController.runs()` → the map is
  empty. This is the pair that fails if `sweep` gets merged back into `list`.
- `runs()` on a **missing** orchestrator directory with a marked project →
  `{ runs: [], starting: [one entry] }` — the first-ever-run shape, easily
  swallowed by the `readdirSync` catch.
- A spawn that rejects (dashboard 4xx; missing `sessionId` → 502) and a request
  refused before spawn (`RUN_IN_PROGRESS` 409, bad `mergeMode` 400) mark
  nothing — assert `starting` is empty, not merely that `mark` wasn't called.
- Starting entry **and** a fresh run in the same payload → real `RunStrip`
  renders, placeholder does not.
- ▲ Starting entry **and a crashed run** (`running`, `fresh: false`) → crashed
  `RunStrip` renders, placeholder does not. Unlike the fresh case the server
  will NOT have evicted — `init` refuses a run file that still says `running`,
  so rule 1 never matches and the entry lives out `RUN_STALE_MS`. Reachable
  from the UI, since the pre-spawn lock only refuses a *fresh* run.
- ▲ A starting entry alone makes the hook fast-poll (assert the second fetch,
  not the predicate).
- Every existing fixture building an `OrchestratorRunsPayload` gains
  `starting: []` — ▲ sixteen test files as of `fcf4680`, up from ~ten when
  this was written; run `pnpm run typecheck` early to find them.

## Done when

- `pnpm test` green and `pnpm run typecheck` clean.
- A board-started run shows a card in the strip within one poll of pressing
  Start, and that card is replaced by the real `RunStrip` once `init` lands.

## Outcome

2026-09-05 — implemented as planned, on `backlog/task-14`. The payload gained a
separate top-level `starting: StartingRun[]`; `StartingRunsService`
(`server/src/orchestrator/starting-runs.service.ts`) holds the
`Map<project, requestedAt>`, split pure/mutating (`list` from
`OrchestratorService.runs()`, `sweep` from `OrchestratorController.runs()`)
over one shared `expired()` predicate; `AgentsController.orchestrate()` calls
`mark(project)` after the awaited spawn, beside `arm()`. The client hook
surfaces `starting` and ORs it into `anyLive`; `StartingStrip.tsx` renders the
placeholder, gated in BoardView on "no `running` run at all for this project,
fresh or crashed".

Two things the plan did not call for and that were added anyway, both narrow:
`isOrchestratorRunsPayload` (`client/src/lib/agents.ts`) now checks `starting`
— **absent accepted** (an older server must not blank the strip), present-but-
wrong rejected, since `BoardView` calls `.filter` on it during render and an
unguarded throw there unmounts the tree; and the hook defaults `payload.starting
?? []` for the same older-server case. CLAUDE.md gained the invariant paragraph
and two layout-line updates.

Both load-bearing rules were red-green verified rather than merely asserted.
Replacing the eviction predicate with the naive "a run.json exists for this
project":

```
    ✕ keeps the entry when the only run for that project started BEFORE it was marked (1 ms)
    ✕ keeps the entry when a run for that project has an unparseable startedAt
    ✕ sweep leaves an entry list would have kept (1 ms)
Tests:       3 failed, 9 passed, 12 total
--- restored, re-running ---
Tests:       12 passed, 12 total
```

Narrowing the BoardView gate to the approved-but-wrong "no fresh run":

```
    ✕ renders the crashed strip and NOT the placeholder when the run crashed (11 ms)
Tests:       1 failed, 8 passed, 9 total
--- restored ---
Tests:       9 passed, 9 total
```

Full verification:

```
$ pnpm run typecheck
$ tsc --noEmit
TYPECHECK_EXIT=0

$ pnpm run build
dist/assets/BoardView-Bu3kUNrV.js                                   55.15 kB │ gzip:   8.02 kB
dist/assets/index-D03LL75k.js                                      340.08 kB │ gzip: 103.57 kB
✓ built in 1.38s
BUILD_EXIT=0

$ pnpm test
Test Suites: 69 passed, 69 total
Tests:       1170 passed, 1170 total
Snapshots:   0 total
Time:        51.942 s
```

Not verified end to end: the third "Done when" bullet (a card appearing within
one poll of a real board Start, then being replaced once `init` lands) needs an
actual headless orchestrator run against the dashboard, which this session did
not start. Its two halves are covered mechanically instead — `records a starting
entry for the project after a successful spawn` and `filters starting against
the real runs it just read` (`test/orchestrator-start.test.ts`,
`test/orchestrator-runs.test.ts`) for the server, and the five BoardView cases
in `test/starting-strip.test.tsx` for the render.

Note for whoever picks this branch up: the worktree had no `node_modules`, so
`pnpm install` was run inside it to make jest's `moduleNameMapper` resolve.
`pnpm-lock.yaml` is unchanged.
