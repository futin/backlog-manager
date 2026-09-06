---
id: task-17
title: Orchestrator pause — stop at the next item boundary, resume from the board
created: 2026-09-05
updated: 2026-09-06T06:32:36Z
started: 2026-09-06T05:33:54Z
execute-elapsed: 3522
execute-tokens: 459856
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

## Outcome

2026-09-06 — Implemented, all ten plan tasks in order.

The shape that shipped matches the plan with three deliberate departures,
each recorded here because a future reader will otherwise wonder:

1. **`RunStrip`'s pausing chip reads `inFlightItemId`, not the strip's own
   `current`.** Those answer different questions — `current` is the first
   entry the run has not let go of and includes a `pending` item (right for
   the stage chip beside it), while the chip has to name the item the run is
   actually *working*. Using `RunControls`' exported implementation means the
   strip's chip and the drawer's note can never name different items for the
   same run.
2. **`RunDetail`'s `live` prop is typed `OrchestratorRun & { fresh;
   pauseRequested }`, not the whole payload entry.** Those two annotations
   are what the controls decide from; `pastRuns` and `watchdog` ride the same
   entry and are none of that pane's business, so the prop states what it
   reads.
3. **`BoardView` gained a THIRD run list (`stripRuns`) rather than widening
   `runningRuns`.** `runningRuns` is also what `startingRuns` subtracts
   against, and that subtraction is specifically about the `init` lock, which
   only a `running` run file holds — folding `paused` in would have
   suppressed a legitimate starting placeholder for a project whose previous
   run was paused.

One test-only change the plan did not anticipate: `RunDrawer` and `RunDetail`
each gained three required props, so ~45 pre-existing render call sites in
`test/run-time-ui.test.tsx`, `test/orchestrator-drawer.test.tsx` and
`test/run-detail.test.tsx` take a shared `CONTROL_PROPS` spread with a closed
gate. Kept required rather than defaulted: a host that forgets to wire them
would otherwise render no controls, silently.

Verification (all four commands from Done when, run fresh in one pass):

```
===== pnpm test =====
Test Suites: 73 passed, 73 total
Tests:       1312 passed, 1312 total
Snapshots:   0 total
Time:        52.586 s
Ran all test suites.
===== pnpm run test:skills =====
# tests 381
# pass 381
# fail 0
===== pnpm run typecheck =====
$ tsc --noEmit
typecheck exit: 0
===== pnpm run build =====
dist/assets/index-sOFJg6ET.js    340.23 kB │ gzip: 103.62 kB
✓ built in 1.09s
build exit: 0
```

### Review round 1 — one Critical, fixed

`resume()` cleared the pause request unconditionally after a successful
spawn. That is right for a `paused` run and wrong for a **crashed** one, and
the crashed path is the one automation takes by default: a person pauses a
running run, the run crashes before reaching its next dispatch gate, the
watchdog resumes it, and the clear deletes a request that nothing has yet
seen — the resumed session never exits `6` and drains the whole queue against
an explicit pause. Design §4.4 says the opposite in as many words: "a crashed
run with an effective request is still resumed by the sweeper — the request
is honoured by the resumed session at its first gate."

The bug came from reading §4.3's "tidiness, not correctness" as unconditional.
It is not: that argument holds only for the paused case, because that is the
only one where an `unpause` is coming to retire the request anyway. A crashed
run's resumed session takes `recovery.md`'s `running` path, which heartbeats
and never unpauses, so the gate honouring the request is the *only* thing
that would ever act on it.

Fix: the clear is now guarded on `run.status === 'paused'`, with the
reasoning above in the code beside it.

Two assertions were missing, which is why the branch went green with the
bug in it — `test/watchdog-sweep.test.ts`'s crashed-run case asserted the
spawn count while its own comment claimed "let the resumed session decide
what the request means", a claim nothing tested:

- `test/agents-resume.test.ts` — a crashed-run resume leaves the request on
  disk **and still effective** (present-but-refused would be the same failure
  with an extra step).
- `test/watchdog-sweep.test.ts` — the sweeper's own crashed-run resume leaves
  it in place too, closing the gap between that case's comment and its
  assertions.

Red-green verified rather than assumed: with the guard reverted, exactly
those two cases fail (2 failed, 51 passed); with it restored, 53/53.

Re-verification after the fix:

```
===== pnpm test =====
Test Suites: 73 passed, 73 total
Tests:       1313 passed, 1313 total
Snapshots:   0 total
Time:        53.528 s
Ran all test suites.
===== pnpm run test:skills =====
# tests 381
# pass 381
# fail 0
===== pnpm run typecheck =====
$ tsc --noEmit
typecheck exit: 0
===== pnpm run build =====
dist/assets/index-sOFJg6ET.js    340.23 kB │ gzip: 103.62 kB
✓ built in 1.06s
build exit: 0
```

Not part of this item, and required before a run can actually be paused from
the board: the merge has to be pushed and `pnpm run plugin:sync` run — the
board spawns runs from the *installed* plugin, and tasks 2 and 9 edited
`skills/`.
