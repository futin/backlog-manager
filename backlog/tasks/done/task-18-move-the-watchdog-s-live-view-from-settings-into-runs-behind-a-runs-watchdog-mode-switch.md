---
id: task-18
title: Move the watchdog's live view from Settings into Runs behind a Runs / Watchdog mode switch
created: 2026-09-05
tags: ui, runs, watchdog
updated: 2026-09-06T07:36:21Z
started: 2026-09-06T07:15:24Z
execute-elapsed: 1257
execute-tokens: 218072
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

## Outcome

2026-09-06 — done. All six plan tasks executed in order on `backlog/task-18`
(task-15 and task-16 had already merged into the base, so no rebase was
needed before Task 4).

What landed:

- `stateLine` moved from `WatchdogGroup.tsx` into `client/src/lib/run-watchdog.ts`
  beside `isCrashed`/`watchdogClause`; its eight cases now live in
  `test/run-watchdog.test.ts` (two of them — a null and a past `nextTickAt`
  both reading `0s` — were never pinned by the Settings suite at all).
- `lastReportedEntry` moved from `RunStrip.tsx` into `client/src/lib/run-time.ts`,
  widened to `readonly RunQueueItem[]`, with five cases in `test/run-time.test.ts`.
  `RunStrip` imports it; `orchestrator-strip.test.tsx` unchanged and green.
- `useWatchdog({ live })` — `live: false` installs no armed 5s interval and
  changes nothing else (mount fetch, focus refetch, `save()`, error posture
  all pinned identical under both settings).
- `WatchdogMonitor` (`client/src/components/runs/WatchdogMonitor.tsx`): state
  card (state line, read-only config line, `Configure in Settings › Orchestrator
  watchdog.`), one row per `running` run with the skew rendered in both
  directions (`· not yet watched`, and a non-button placeholder row for a
  `watching` id with no run behind it), and the activity feed moved from
  Settings. 16 cases in `test/watchdog-monitor.test.tsx`.
- `client/src/lib/runs-mode.ts` + the `Runs | Watchdog` segmented control in
  `RunsView.tsx`: renders unconditionally (outside `merged.length > 0`),
  persisted under `backlog-manager.runs-mode` through `isRunsMode`, range and
  project filter gated on runs mode, body switched, `onSelectRun` returning to
  Runs on that run's detail. 3 guard cases + 8 view cases.
- `WatchdogGroup` trimmed to a `Live view` orientation row plus the four
  knobs; `useWatchdog({ live: false })`; State row, Activity block,
  `projectBasename` and the `formatClock` import deleted. Its suite now pins
  that Settings issues no watchdog GET beyond the mount one across two poll
  periods, and that the row order is `Live view, Enabled, Check every, Leave a
  resumed run alone for, Give up after`.
- `.watchdog-*` CSS moved from the Settings block into the Runs block and
  grown for the card and rows; single column under the existing 700px
  breakpoint.
- `CLAUDE.md` Layout and §6.4 of the watchdog design spec updated.

Two small deviations from the plan, both mechanical: `renderRunsView` waits on
`runs-list`, so the stored-`watchdog` case renders `<RunsView />` directly
instead; and the `Enabled` knob's hint was reworded (it said "the sweeper's
phase above", which is no longer above it) without naming `Runs › Watchdog` a
second time, since two matches broke the pointer assertion.

Nothing under `server/` or `shared/` changed — verified by
`git status --porcelain -- server shared` returning zero lines. The monitor
lands in the Runs chunk only, not the Settings chunk:

```
$ for f in client/dist/assets/RunsView-*.js client/dist/assets/SettingsView-*.js; do ... done
RunsView-WPMP1z-1.js: watchdog-rows=1 Configure-in-Settings=1
SettingsView-Ci7OiBA2.js: watchdog-rows=0 Configure-in-Settings=0
```

Verification:

```
$ pnpm test
Test Suites: 75 passed, 75 total
Tests:       1355 passed, 1355 total
Snapshots:   0 total
Time:        49.548 s
Ran all test suites.

$ pnpm run typecheck
$ tsc --noEmit
exit=0

$ pnpm run build
dist/assets/index-Bh7t_t16.js    340.28 kB │ gzip: 103.66 kB
✓ built in 1.07s
exit=0

$ pnpm run test:skills
# tests 381
# pass 381
# fail 0
```

### Review round 1 — both findings fixed

**Critical — raw NUL byte in `WatchdogMonitor.tsx`.** Confirmed exactly as
reported: one NUL at offset 7128 (line 133), standing where the separator
belongs inside the row's React key template literal. `file` read the source as
`data`, `grep -rn stateLine client/src/components/runs/` exited 1 with no
match, and `git diff --stat` printed `Bin`. Replaced with a space, matching
`runKey` (`RunsView.tsx:175`) — the same `{project, runId}` pair, keyed the
same way, rather than inventing a separator. The file now reads as
`Java source, Unicode text, UTF-8 text` and grep finds both `stateLine`
references. Swept every tracked and untracked source file under `client/`,
`server/`, `shared/`, `test/` and every `*.md` for NUL bytes: none anywhere
else, so this was one corrupted write, not a systematic problem.

Worth stating for whoever reads the history: this branch's `5f49f00` already
carries the corrupt blob, since the orchestrator committed before the review
ran. The worktree fix cleans the branch TIP — which is what a future 3-way
merge of this branch uses — but `5f49f00` itself keeps a binary blob in
history, and nothing short of a rewrite changes that.

**Important — the `next check in Ns` countdown froze.** Also confirmed. The
clock was gated on `running.length > 0` alone, on the reasoning that heartbeat
ages were the only reading that moved. They are not: `stateLine`'s countdown
reads the same `now`, and `armed` with nothing running in the payload is a
state this component deliberately renders (the skew case, and the
`watchdog-row-missing` placeholder lives in it too) — so there the countdown
sat at whatever it read on mount while the real tick came and went. Gate is
now `running.length > 0 || status?.phase === 'armed'`, with the comment
rewritten to name both readings instead of one.

Pinned by a new 17th case in `test/watchdog-monitor.test.tsx`, red before the
fix and green after: armed, `watching: []`, `runs: []`, `nextTickAt = NOW +
42s` reads `next check in 42s`, and after `advanceTimersByTimeAsync(5_000)`
reads `next check in 37s` off the identical payload. It also asserts there are
zero `watchdog-row`s, so a future fixture edit cannot quietly turn it into the
rows case with extra steps.

Re-verified after both fixes:

```
$ pnpm test
Test Suites: 75 passed, 75 total
Tests:       1356 passed, 1356 total
Time:        52.836 s

$ pnpm run typecheck
$ tsc --noEmit
exit=0

$ pnpm run build
dist/assets/index-BgOTdcxC.js    340.28 kB │ gzip: 103.65 kB
✓ built in 1.14s
exit=0

$ git status --porcelain -- server shared
(no output)
```

One thing the re-run turned up that is NOT this branch's: `pnpm test` failed
once in six full runs, on `test/agents-plan.test.ts` › "404s an item with no
next step", with `Parse Error: Expected HTTP/, RTSP/ or ICE/` — a supertest
transport race. That suite passes 8/8 when run alone, and this branch touches
no file under `server/` and none of that suite, so it is pre-existing
flakiness under `--runInBand`, not a regression here. It deserves its own
bug via `backlog-capture` rather than a silent note, but filing one is not
this skill's job.
