---
id: bug-39
title: No force stop for an orchestrator run
created: 2026-09-19
tags: watchdog, orchestrator
runner-fix: true
updated: 2026-09-20T12:31:44Z
groom-elapsed: 351
groom-tokens: 92549
---

## Symptom

There is no way to force-stop a running orchestrator run. A user stopped the run's driver session (2026-09-19, run `run-20260919-135747`, task-47) and the
watchdog resumed it anyway: the watchdog log shows `spawned resume 1/3` at 14:41 and a `recovered — run fresh again` at 14:46. Killing the resumed session
by pid did not end the run either: `orchestrate.mjs abort` exits `7` with `run ... is alive (last heartbeat ...) and driven by session <id> — nothing to take
over`, because the run file still says `running`, its heartbeat is under `RUN_STALE_MS` (15 minutes) old, and its lease belongs to another session. Nothing was
actually alive at that point. The run stays un-abortable until the heartbeat ages out, and the watchdog will resume it before or around that moment unless it
is disabled globally.

The pause request (`POST /api/agents/pause`) did not help either: it is only read at the tool's two dispatch gates (`stage <id> preflight`/`dispatched`), so
it does not stop a session that is already mid-item, and a resumed session carries on the same work.

## Repro

1. Start a run from the board and let it dispatch an item.
2. Stop the driver `claude -p` session by hand (or send it a message that ends its turn).
3. Wait one watchdog tick: the run is resumed by a new `claude -p --resume ...` process.
4. Kill that process and run `orchestrate.mjs abort` from the project root: exit `7`, run still `running`.

## Affects

- `skills/backlog-orchestrate/tools/orchestrate.mjs:660-705` (`takeOverRun`: refuses a `running`, fresh run led by another session, with no check that the
  lease holder's process exists)
- `skills/backlog-orchestrate/tools/orchestrate.mjs:2290-2308` (`finish` asserts the driver lease, so it cannot end the run either)
- `server/src/agents/watchdog.service.ts` (`visit()` resumes on staleness; a stop request the user made is not something it can see)
- `server/src/agents/agents.controller.ts:298` (`pause` is the only stop-shaped route and only acts at the dispatch gates)
- `shared/agent.ts:676` (`watchdogStoodDown` has no input for "the user stopped this run")

## Cause

Three mechanisms can stop a run today, and none of them is a stop.

**1. `pause` is a cooperative request read at two gates.** The gate (`orchestrate.mjs:2904`) fires only on `stage <id> preflight` / `stage <id> dispatched`,
and only on a *transition* — deliberately, so that pausing never strands half-finished work in a worktree nobody is coming back to (the gate's own comment:
"stop at the next item boundary is precisely the boundary these two calls sit on"). A session that is dead, or forty minutes into `watch`, reaches no boundary,
so the request is invisible to exactly the run a person wants to stop. Pause is a graceful stop and was never anything else.

**2. `abort` is the only command that ends a run, and its gate measures the wrong thing.** `cmdAbort` (`orchestrate.mjs:4457`) opens with `takeOverRun`
(`:826`), which refuses when the file says `running`, `isFresh(run.updatedAt)` holds, and the lease names another session. Freshness is a property of the run
**file**, not of the driver **process**: nothing anywhere records a pid for the driver — `run.driver` is `{ sessionId, at }`, and `RunQueueItem` carries
`sessionId`, `worktree`, `branch` and no pid — so no reader can ask whether that process still exists, and `isFresh` (`:219`, against `RUN_STALE_MS` = 15
minutes) is the only liveness proxy this system has. A session killed one second ago leaves a lease that reads live for fifteen minutes.

That refusal also catches the caller most likely to be a human. Its condition is `driver.sessionId !== me`, and a hand-run terminal has `me === null`
(`sessionIdentity`, `:732`), so it is refused — where `assertDriver` (`:766`), in the same file, over the same lease, deliberately warns and proceeds, because
"refusing would strand the one person recovering a run by hand, which is the situation this whole feature exists to leave open". `takeOverRun` never made that
exemption, so the takeover path — the escape hatch — is stricter than the path it exists to be the escape hatch for.

**3. The watchdog reads a killed run as a crashed one, because those two states are byte-identical.** `visit()` (`server/src/agents/watchdog.service.ts:337`)
takes `status === 'running' && !fresh` as its entire definition of "needs resuming", and its only stand-downs are `watchdogStoodDown({ enabled, exhausted })`
(`shared/agent.ts:727`) — a global switch and an attempt count. Neither is per-run, and neither has an input for "a person stopped this". The only way to keep
the sweeper off one run is to switch it off for every project on the machine.

**The three compose into a live-lock, which is what the filing observed.** The kill makes the run look crashed; the watchdog resumes it (`spawned resume 1/3`);
the resumed session heartbeats, so the file is fresh again (`recovered — run fresh again`) and `takeOverRun`'s refusal is re-armed for another `RUN_STALE_MS`.
The window in which `abort` would be accepted is precisely the window in which the sweeper spawns a resume, so the two never coincide by luck: with the
watchdog on, a deliberately stopped run is un-endable until somebody disables the watchdog globally, waits out fifteen minutes, and then wins a race against
the next tick.

Killing the process is not merely the only force stop available — it is the state the rest of the system punishes hardest. `POST /api/agents/pause` refuses
anything that is not `running` (`agents.service.ts:1030`ff), `resume()` refuses a fresh run with `RUN_IN_PROGRESS_CODE`, and `init` refuses any `running` run
file, fresh or stale (exit `4`), so the project is locked out of its next run for the same fifteen minutes.

The shortest statement of it: **there is no per-run fact anywhere in this system meaning "a person ended this run"** — not on the wire, not in the control
file, not in the run file, not in the watchdog's inputs. Stopping is modelled only as something a live driver does to itself, and every layer that could
enforce a stop instead infers intent from a heartbeat.

## Fix

Give the system that missing fact, in the one channel that already travels server → tool, and let each layer read it: **a stop request is a second `kind` of
control-file request; nothing resumes a run that has one; `abort` may take the lease from a dead driver on the strength of one; and a live driver learns about
it within one `watch` tick rather than at the next item boundary.** The run still ends the way every ended run ends — `abort` → `finish --status aborted` —
so no new `RunStatus` is minted and no consumer of the run vocabulary changes.

**Rejected shapes, and why.**

- **A sixth `RunStatus` (`stopped`).** `aborted` already means "a person ended this run"; a second spelling would reach every `RunStatus` exhaustiveness site,
  `aggregateRuns`, `CLAIM_FINISHED_STATUSES` and both status chips for no fact they could act on differently. Same reasoning as `crashed` not being a sixth
  status.
- **The server writing `run.json`.** Flatly out: one writer, and that writer is `orchestrate.mjs`. A stop is a browser fact that has to reach a headless
  session; the filesystem control file is the channel that already exists for exactly that.
- **`abort --force`.** A flag is available to every automated caller, including a confused `--resume` session, and it would reduce the lease to a suggestion.
  A recorded control-file request is evidence of a human act that passed the origin guard, which is exactly the evidence the tool has no other way to get.
- **The server killing the driver process.** It has no pid (see Cause) and no kill channel — it reaches the dashboard through `/api/health`,
  `/api/management` and `/api/spawn`, and nothing else. It also must not pattern-kill: the only process a run may kill is one whose pid it recorded itself.
- **Making `pause` bite mid-item.** That is what the two-gate placement deliberately rules out, and widening it would make every pause abandon a half-finished
  worktree. A stop is a different question and gets a different key.

### The change

1. **The control file learns a `kind`** — `shared/types.ts`, `server/src/orchestrator/pause-control.util.ts`, `skills/backlog-orchestrate/tools/orchestrate.mjs`.

   `PauseRequest` gains `kind?: 'pause' | 'stop'`. **Absent means `'pause'`**, so every file the current server has already written keeps meaning exactly what
   it means today. The two predicates become disjoint, on both sides of the boundary and byte-equivalently, the way `pauseRequestEffective` is already
   duplicated rather than imported (a skill's `tools/` may never import from the server):

   - `pauseRequestEffective(control, run)` gains one clause — the request's `kind` is not `'stop'`.
   - `stopRequestEffective(control, run)` is the same two clauses (`runId` pins the run; `requestedAt` post-dates `unpausedAt ?? startedAt`) plus
     `kind === 'stop'`.

   Derived on both sides, stored on neither — the rule the existing predicate's own comment gives, and for the same reason: the inputs all move underneath a
   stored verdict. One control fact per project stays one file: a stop overwrites a pause and a pause overwrites a stop, last write wins in both directions,
   and `cancel` deletes as it does now.

2. **`POST /api/agents/stop`** — `server/src/agents/agents.controller.ts`, `server/src/agents/agents.service.ts`.

   The exact sibling of `pause`: `@UseGuards(SameOriginPostGuard)`, `@HttpCode(200)`, body rebuilt field by field (`project` trimmed and required,
   `cancel === true` the only form honoured — the same strictness, for the same reason, since here too `cancel` is the direction that undoes a human's
   decision). Independent of `BM_AGENTS`, as `pause` is: recording the fact must work on a machine whose launcher is off.

   Refused, like `pause`, unless the project has a `running` run — fresh or stale alike. That is the whole point: a stale `running` run is the case this bug
   is about.

   The response is `{ stopRequested: boolean; abortSession: string | null; abortRefused: string | null }`. After the write, the route **attempts one spawn**
   through the same path `resume()` uses — `projectDispatchGate` first, then `spawn(cfg, …)` with `STOP_PROMPT = '/backlog-orchestrate --abort'`, the exact
   sibling of `RESUME_PROMPT` and, like it, a documented flag of this skill's own trigger (SKILL.md line 30), never a string this file invented. A gate refusal
   or a spawn failure is **not** an error here: the request is already on disk and the watchdog is already standing down, so the refusal rides back in
   `abortRefused` and the UI shows the one command a person can run instead. Recording the fact and ending the run are two outcomes, and only the first is
   guaranteed.

   Spawn unconditionally, **not** only for a stale run. If the real driver is still alive, the spawned session's `takeOverRun` write evicts it: its next
   command hits `assertDriver`, exit `7`, "stop immediately: write nothing more, and exit". That eviction *is* the force stop, and it is the lease working as
   designed rather than being worked around.

3. **Nothing resumes a stopped run** — `server/src/orchestrator/orchestrator.service.ts`, `watchdog.service.ts`, `agents.service.ts`, `shared/types.ts`,
   `client/src/lib/remote-run.ts`, `client/src/components/RunControls.tsx`.

   `stopRequested: boolean` joins `pauseRequested` on the runs payload — mandatory, like `pauseRequested` and `fresh`, derived at the one site that already
   derives its sibling (`orchestrator.service.ts:369-370`) from the same single control-file read, and `false` for a remote row (`remote-run.ts:36`), which is
   read-only on this machine by construction.

   **Both sides read that one field; neither re-derives it.** This is deliberately not a third input to `watchdogStoodDown`: that predicate answers "will the
   sweeper spawn", the board renders its hand-Resume on the same answer being *true*, and a stop must suppress **both** sides — so folding it in would make
   the board offer a Resume on precisely the runs a person just stopped. One boolean on the wire, read verbatim by two readers, is stronger than two
   expressions that agree.

   - `visit()`: a new early return **before** the stand-down branch and after the `fresh` branch — `if (run.stopRequested)`, `upsert` the entry, push a
     `stopped` event once per condition behind its own `entry.stoppedLogged` flag (the ring buffer cannot answer "did I already say this"), return. Add
     `'stopped'` to `WatchdogEventKind`.
   - `AgentsService.resume()`: refuse a run with `stopRequested`, uncoded 409, message naming the way out — the stop must be cancelled first. Otherwise the
     hand Resume and the stop fight each other.
   - `RunControls`: a `Stop` control beside `Pause` for a `running` run, dispatched through the existing `act` guard (bug-19's layer 1 — a ref, not state);
     when `run.stopRequested`, every Resume branch is suppressed and the head renders the request plus `Cancel stop`, and `abortRefused`'s sentence when the
     spawn did not happen.

4. **`abort` may take the lease when a stop was requested** — `orchestrate.mjs`.

   `takeOverRun(dir, run, force)` gains a **required third parameter, no default** — the rule `runClaimBlock` follows for `starting` (bug-21), and for the
   identical reason: a default would let a future caller silently opt out of the lease check. `cmdAbort` passes `stopRequestEffective(readPauseRequest(run.project), run)`;
   `cmdClaim` passes `false`, unchanged, so a resume can still never steal a live run. The refusal's message gains the way out
   ("…request a stop from the board first, then re-run `--abort`").

   This is also what un-strands the hand-run terminal: with a stop on file, `me === null` no longer refuses.

5. **A live driver notices within one tick, and kills the child it started** — `orchestrate.mjs`, `skills/backlog-orchestrate/SKILL.md`.

   New exit code **`10`**, "a stop was requested for this run", added to SKILL.md's exit-code table (line ~69) next to `6`, and to the paragraph naming the
   codes whose reaction is neither a fix nor a retry.

   - `cmdWatch`'s per-tick body, beside the `assertDriver` it already runs: on `stopRequestEffective`, **kill the child by the pid it was given** — the pid
     this very command holds in `--pid`, recorded by the dispatch that started it, never a pattern — then return `10`. This is the only place in the system
     that holds a live child's pid, which is why the kill belongs here and nowhere else.
   - The `stage` gate at `:2904` gains a second, wider clause: a **stop** refuses **every** transition, not just `preflight`/`dispatched`, with exit `10` and
     nothing written. A stop is allowed to abandon a half-finished worktree — that is the difference between it and a pause, and `abort`'s existing
     marker-preservation rule (an in-progress `phase:` marker leaves the worktree in place with an `attention` entry) is what keeps that safe.
   - SKILL.md §4 "Watch until it exits" gains the `exit 10` branch, and §10 gains a **Stopping** subsection beside *Pausing*: on a `10`, do not retry, do not
     finish the queue — go straight to `--abort`.

6. **Record the dispatched child's pid, so an abort that arrives after the driver is gone can still end it** — `orchestrate.mjs`, `shared/types.ts`.

   `RunQueueItem` gains `pid: number | null` (absent/`null` on every older run file, which must never strand anything), written by
   `stage <id> dispatched --pid <p>` through the same `applyQueueItemFields` path `--session` uses; SKILL.md §4's dispatch line passes the pid it already
   writes to `logs/<id>.pid`. `cmdAbort` then kills a recorded pid **only** when the item is non-terminal, `pidAlive(pid)` holds, and `ps -o args= -p <pid>`
   names a `claude` process — the cheap guard against the pid-reuse TOCTOU `pidAlive`'s own comment documents. Without this, a stop whose driver is already
   dead cannot reach an orphaned executor, and "force stop" would still be a half-truth.

**Interaction with bug-35.** Both touch `visit()` and `RunWatchdog`. They do not collide: bug-35 adds a rung to the stand-down ladder, this adds an earlier
return above it and a field on the run entry rather than on `RunWatchdog`. Whoever lands second re-reads `visit()` and the coupling table.

### Proof

- `orchestrate.test.mjs` — `stopRequestEffective` / `pauseRequestEffective` are disjoint, and an absent `kind` reads as `pause`; a request whose `runId` names
  another run, or which predates `unpausedAt`, is ineffective as a stop exactly as it is as a pause; `abort` succeeds against a `running`, **fresh** run whose
  lease names another session when a stop is on file, and still exits `7` when it is not; `claim` still exits `7` in both cases; `stage <id> merged` exits `10`
  writing nothing under a stop, where today only `preflight`/`dispatched` are refused, and under a *pause* still exits `6` at those two gates and `0`
  elsewhere; `watch` returns `10` and signals the pid it was given (assert against a process this test itself started — never a pattern).
- `test/watchdog-sweep.test.ts` — a crashed run with `stopRequested` spawns nothing and logs `stopped` once across several ticks; clearing the request lets
  the next tick spawn as before.
- `test/watchdog-coupling.test.tsx` — the hand-checked table gains a `stopRequested` column: for every row, `true` means the sweeper does not spawn **and** the
  detail head offers no Resume.
- `test/agents-origin-guard.test.ts` — `/api/agents/stop` joins the guarded route list (the list, never a count in prose).
- New route cases — 400 on a missing `project`; 409 when the project has no `running` run; a `running`-but-stale run is accepted; `cancel: 'true'` (the string)
  does **not** cancel; a gate refusal returns 200 with `stopRequested: true` and `abortSession: null`.
- `pnpm test` (both runners) and `pnpm run typecheck` green — the two mandatory `shared/types.ts` fields make the compiler the fixture checklist.
- In the browser (playwright MCP tools): with the stack up (`pnpm run docker:up`) open `http://127.0.0.1:5177`, go to **Runs → History**, select a project with
  a `running` run, and confirm the detail head shows a **Stop** control beside Pause; click it, confirm the head switches to the stop-requested reading with a
  **Cancel stop** control and **no Resume control**, and that it still reads that way after a poll; click **Cancel stop** and confirm the Stop control returns.
