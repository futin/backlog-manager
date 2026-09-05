---
id: task-18
title: Move the watchdog's live view from Settings into Runs behind a Runs / Watchdog mode switch
created: 2026-09-05
tags: ui, runs, watchdog
---

## Goal

With `run-20260905-113818` live and the watchdog armed on it, "where can I inspect the
watchdog?" had the answer "Settings, bottom group" — a 5s-polling State row and an
Activity feed sitting on a preferences page nobody has open during a run. Move the
sweeper's live surface (phase line, the runs it is watching, the activity feed) into the
Runs section behind a `Runs | Watchdog` segmented control, and leave Settings with the
four knobs alone. Rule the change establishes: **nothing in Settings is live.**

No server change. The monitor is a client-side join of two payloads the client already
fetches (`GET /api/agents/watchdog`, `GET /api/orchestrator/runs`).

Design: `docs/superpowers/specs/2026-09-05-watchdog-monitor-design.md` (commit `c4d6de1`).
Plan: `docs/superpowers/plans/2026-09-05-watchdog-monitor.md` (commit `8c197a7`).

## Plan

Execute `docs/superpowers/plans/2026-09-05-watchdog-monitor.md` task by task, in order.
Read the spec first; the plan argues from its section numbers. The plan states behaviour
and exact test cases, never literal code — write the tests from the cases as given.

The six tasks, for orientation (the plan carries the detail):

1. **Move `stateLine`** from `client/src/components/settings/WatchdogGroup.tsx` into
   `client/src/lib/run-watchdog.ts` beside `isCrashed`/`watchdogClause`; its pure tests
   move from `test/settings-watchdog.test.tsx` to `test/run-watchdog.test.ts`.
2. **`useWatchdog({ live })`** — `live: false` installs no armed 5s interval; mount fetch,
   focus refetch and `save()` unchanged. Default `true`.
3. **`WatchdogMonitor`** (`client/src/components/runs/WatchdogMonitor.tsx`), tested
   standalone on its props `{ runs, onSelectRun }`: a state card (`stateLine`, read-only
   config line, "Configure in Settings › Orchestrator watchdog."), one row per `running`
   run in the live payload (rows from the runs payload, `watching` only annotates — two
   projects can share a `runId`), the activity feed moved from Settings. Lift
   `lastReportedEntry` out of `RunStrip.tsx` into `lib/run-time.ts` so the strip and the
   monitor share the "current item" rule. Styles move from the Settings CSS block to the
   Runs block.
4. **Mode switch in `RunsView.tsx`** — `lib/runs-mode.ts` (`RunsMode`, `isRunsMode`,
   `RUNS_MODE_KEY = 'backlog-manager.runs-mode'`); the control renders unconditionally,
   before the range control; range and project filter render only in runs mode; body
   switches; a monitor row click lands on that run's detail in runs mode.
5. **Trim `WatchdogGroup`** to a `Live view` orientation row plus the four knobs;
   `useWatchdog({ live: false })`; delete the State row, Activity block and the private
   `projectBasename`.
6. **Docs** — `CLAUDE.md` Layout (Runs gains the mode + monitor; Settings' group is knobs
   only), supersession note on §6.4 of
   `docs/superpowers/specs/2026-09-04-orchestrator-watchdog-design.md`; whole
   `pnpm test`, `pnpm run typecheck`, `pnpm run build`.

Sequencing: **land after task-15** (the runs-view sweep, which edits `RunsView.tsx`);
rebase onto its result before plan Task 4. task-16 (bounded runs list) is independent —
this work touches the bar and the body switch, not the list.

## Test cases

Every case is spelled out per task in the plan; the suites it touches:

- `test/run-watchdog.test.ts` — `stateLine`: off with/without reason, idle with/without
  `· resume disabled`, armed countdown, `0s` for a null or past `nextTickAt`.
- `test/run-time.test.ts` — `lastReportedEntry`: last in-flight entry, not first; `null`
  for terminal-plus-pending queues, empty queues, and a parked-then-pending queue.
- `test/watchdog-hook.test.tsx` — `live: false` never polls while armed; focus refetch
  and `save()` still work; default and explicit `live: true` still poll.
- `test/watchdog-monitor.test.tsx` (new, 16 cases) — unavailable notice; off/idle/armed
  states; one fresh row with `bug-16 · dispatched`, `heartbeat 4s ago`, `ok`; `between
  items`; crashed row reads `crashed · ` + `watchdogClause(annotation)`; crashed with no
  annotation reads `crashed`; `· not yet watched`; placeholder row for a `watching` id
  with no payload run; two rows for a shared `runId`; done runs are not rows; row click
  calls `onSelectRun(project, runId)`; three events newest-first with clock, project tail
  and detail; empty feed copy and `WATCHDOG_EVENT_CAP` in the hint; heartbeat advances
  with `useNow`.
- `test/runs-mode.test.ts` (new) — `isRunsMode` accepts exactly `runs`/`watchdog`.
- `test/runs-view.test.tsx` — switch renders by default and on an empty payload; Watchdog
  hides range/project/tiles/list/pane and mounts the monitor; switching back keeps the
  selection; stored `watchdog` restores; stored garbage clamps to runs; the choice
  persists; row click-through selects the run.
- `test/settings-watchdog.test.tsx` — State/Activity cases removed (they moved); no
  `idle —`/`Activity` text; `Runs › Watchdog` pointer present; no watchdog GET beyond the
  mount one across two poll periods; row order `Live view, Enabled, Check every, Leave a
  resumed run alone for, Give up after`; every knob case unchanged.

## Done when

- Runs shows a `Runs | Watchdog` control; Watchdog mode shows the state line, the
  watched-run rows and the activity feed; runs mode is byte-for-byte today's section.
- Settings' watchdog group shows the four knobs and a `Live view` pointer, nothing that
  changes on a clock, and issues no poll.
- `stateLine`, `watchdogClause`, `isCrashed` live in `lib/run-watchdog.ts`;
  `lastReportedEntry` in `lib/run-time.ts`; no component keeps a private copy of either.
- Nothing under `server/` or `shared/` changed.
- `pnpm test`, `pnpm run typecheck`, `pnpm run build` all green; `CLAUDE.md` and the
  watchdog spec's §6.4 updated.
