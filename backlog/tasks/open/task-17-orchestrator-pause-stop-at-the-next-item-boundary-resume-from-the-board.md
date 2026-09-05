---
id: task-17
title: Orchestrator pause — stop at the next item boundary, resume from the board
created: 2026-09-05
---

## Goal

A board control that asks a running orchestrator run to stop dispatching at
the next item boundary and leave it resumable: a fifth run status `paused`,
a server-owned pause-request file the tool reads at its two dispatch gates,
`unpause` as the resume path's first write, and Pause / Cancel / Resume
offered on both the Board's run drawer and the Runs view's detail pane. The
motivating case is an account usage window about to run out — stop before
the next execute session starts, continue later.

## Plan

Design: `docs/superpowers/specs/2026-09-05-orchestrator-pause-design.md`.
Implementation plan, ten tasks with test cases and expected values:
`docs/superpowers/plans/2026-09-05-orchestrator-pause.md`. Execute the plan
task by task, in order; the plan's test cases are authoritative and its code
blocks are shapes, not text to transcribe.

1. Vocabulary — `paused` in the status union and every `Record` keyed on it,
   `unpausedAt?`, `pauseRequested` on the runs payload, `PauseResult`,
   `resumeGate` hoisted out of `BoardView` into `shared/agent.ts`.
2. Tool — `controlHome`/`controlFilePath`/`pauseRequestEffective` in
   `orchestrate.mjs`; `stage <id> preflight|dispatched` refuse with exit `6`
   on an effective request when the call is a transition; `finish --status
   paused`; new `unpause`; `status` suffix; harness pins
   `BM_ORCH_CONTROL_HOME`.
3. Server — `server/src/orchestrator/pause-control.util.ts` (read, write,
   clear, the predicate), `runs()` annotates `pauseRequested`,
   `test/helpers/env.ts` defaults `BM_ORCH_CONTROL_HOME` to a temp dir.
4. Server — `POST /api/agents/pause` (`{ project, cancel? }` →
   `{ pauseRequested }`, guarded, independent of `BM_AGENTS`); `resume()`
   accepts `paused` and clears the file after a spawn; sweep tests pin
   that a paused run arms nothing and a crashed run with a request still
   spawns.
5. Client plumbing — `useOrchestratorRuns` gains `noteResume`/`resuming`
   with `RESUME_POLL_GRACE_MS = 180_000`; `pauseOrchestrate` and
   `cancelPauseOrchestrate` in `lib/agents.ts`.
6. `client/src/components/RunControls.tsx` — Pause / Cancel / Resume from
   the run entry alone; crashed, done, aborted, failed render nothing.
7. Board — the drawer head hosts `RunControls`; the fresh strip gains the
   `pausing · finishes <id>` chip; a `paused` run renders a paused strip
   with Resume (no watchdog clause); `BoardView` wires `resumeGate`,
   `noteResume`, `resuming`.
8. Runs view — `pausing` badge on a fresh row; the detail pane hosts
   `RunControls`; `RunsView` reads `useAgents` for the gate.
9. Skill prose — `SKILL.md` exit `6` row, the §3/§4 reactions, a §10
   "Pausing" step; `recovery.md` runs `unpause` on a paused run and names
   the `preflight`-stage leftover as "re-enter at dispatch".
10. Docs — `CLAUDE.md` layout + invariant, `docs/invariants.md` section,
    the amended `settings/` sentence in `watchdog-config.util.ts`; final
    `pnpm test`, `pnpm run test:skills`, `pnpm run typecheck`, `pnpm run
    build`.

Constraints the plan states and this item restates because they are the
ones a rushed execution breaks: `run.json` keeps its single writer — the
server never writes it; the effectiveness predicate is derived on both
sides, never stored; the pause gates refuse transitions only, never a
re-stamp of an item already at that stage; `heartbeat` never changes a
status. Editing `skills/` changes nothing until the merge is pushed and
`pnpm run plugin:sync` runs — that is a step after the merge, not part of
this item.

## Test cases

The plan carries the full list per task. The ones that decide the feature:

- effective request → `stage <id> preflight` from `pending` exits 6 with
  `run.json` byte-identical; same for `dispatched` from `preflight`; a
  re-stamp of an already-`dispatched` item exits 0.
- request pinned to another `runId`, or dated before `startedAt`, or before
  `unpausedAt`, or malformed → not effective, `preflight` proceeds.
- `unpause` on `paused` → `running`, `unpausedAt === updatedAt`; on any
  other status → exit 1, nothing written.
- `POST /api/agents/pause`: 400 no project; 409 no run / done / paused; 200
  `{ pauseRequested: true }` for fresh and stale running runs, file written
  with the run's `runId`; `cancel: true` deletes it; no dashboard call ever,
  `BM_AGENTS` unset still 200.
- `resume()` accepts a `paused` run with the unchanged spawn body and
  deletes the request file after a successful spawn; a paused run's payload
  entry never carries a `watchdog` key.
- sweeper: a `paused` run file → no spawn, one idle event.
- `RunControls` table: Pause / Pausing + Cancel / Resume / aria-disabled
  Resume / Resuming… / nothing, by run entry; clicks call the right helper
  and `onChanged(kind)`.
- strip: pausing chip; paused strip with Resume gated by `resumeGate`;
  `done` still renders nothing. Drawer and detail pane host the controls.
- hook: `noteResume` polls at once and every 5s while the run is not
  `running`, stops when it is, expires after 3 minutes.

## Done when

```bash
pnpm test
```

```bash
pnpm run test:skills
```

```bash
pnpm run typecheck
```

```bash
pnpm run build
```
