---
id: bug-54
title: a board Stop runs two concurrent --abort sessions on one run
created: 2026-09-22
---

## Symptom

One click on the board's Stop chip ends up running `/backlog-orchestrate --abort` **twice, concurrently, against the same run** — once in a session the server
spawns, and once in the driver that was already running the run. Nothing refuses the second one, because `--abort` is deliberately exempt from the lease check
that refuses every other mid-run session.

Both aborts converged on the right answer in the two runs observed, so this is not a corruption report. What it costs is a window in which one session is
reading state the other session is actively destroying, and making judgment calls on it.

Observed live on `futin/guide-manager#5`, run `run-20260922-150243`, Mac, 2026-09-22:

| t (UTC)      | driver `97b0a080`                            | spawned `a43e38ab`                                        |
| ------------ | -------------------------------------------- | --------------------------------------------------------- |
| 15:05:01.124 | —                                            | stop request written to the control file                   |
| 15:05:05     | —                                            | session born                                               |
| 15:05:14.733 | `watch` returns exit `10`                    | reading `references/recovery.md`                           |
| 15:05:19.865 | runs `abort` — worktree teardown begins      | —                                                          |
| ~15:05:40    | *(mid-removal)*                              | `git status` on `.worktrees/5` → **51 deletions**, no adds |
| 15:05:52.531 | —                                            | takes the driver lease on the run file                     |
| ~15:05:45+   | —                                            | runs its own `abort`                                       |
| 15:06:23.819 | releases item 5's claim                      | —                                                          |
| 15:06:27.647 | `abort` returns `{"status":"aborted"}`       | —                                                          |

The `51 deletions, no additions` reading is the part worth keeping. The spawned session took it as evidence about the *child's* work — it wrote "Worktree holds
only deletions (51 files, no additions/modifications) … Nothing to lose" — when in fact it was watching the other abort empty the worktree. Its conclusion
happened to match what it was going to do anyway. It did not have to.

The same pairing is visible in the previous run, `run-20260922-144041`: driver `fa6cbf89` ran `abort`, and spawned session `e623524c` released the claim. Two
runs, two double-aborts. This is every board Stop, not a race that sometimes happens.

## Repro

1. Start an orchestrator run from the board on a project whose item takes more than ~30s (so the stop lands after dispatch rather than inside it).
2. Click Stop.
3. Watch the project's Claude sessions: one new session appears running `/backlog-orchestrate --abort`, and the driver's own transcript also shows an `abort`
   invocation after its `watch` returns exit `10`.
4. Sample `git -C <project>/.worktrees/<id> status --short` during the window between the two. It reports deletions that are the teardown in progress, not
   anything the execute session did.

## Affects

- `server/src/agents/agents.service.ts:1148` — `stop(project, cancel)`
- `server/src/agents/agents.service.ts:1176` — `await this.spawnAbort(project)`, unconditional on the non-cancel path
- `server/src/agents/agents.service.ts:1191` — `spawnAbort()`
- `server/src/agents/agents.service.ts:196` — `const STOP_PROMPT = '/backlog-orchestrate --abort'`
- `skills/backlog-orchestrate/SKILL.md:82` — exit `10`'s row: "go to §10, _Stopping_"
- `skills/backlog-orchestrate/SKILL.md:799` — "Go straight to §10, _Stopping_"
- `skills/backlog-orchestrate/SKILL.md:87` — the `--abort` exemption from the lease refusal
- `skills/backlog-orchestrate/SKILL.md:1536` — §10 _Stopping_, which is `--abort`

## Cause

Two independent, individually-correct mechanisms both end the run, and neither knows about the other.

**The server side.** `stop()` writes the control file and then unconditionally awaits `spawnAbort()`, which spawns a session whose entire prompt is
`/backlog-orchestrate --abort`. This exists so that a stop still ends the run when the driver is dead — a killed driver leaves a `running` run file behind
(bug-39's shape), and nothing else would clean it up.

**The driver side.** A live driver's `watch` sees the control file and returns exit `10`, and the skill tells it — twice, at `:82` and `:799` — to go to §10
_Stopping_, which is `--abort`. That is also correct: the driver holds the worktree, the branch and the claim, and it is the session best placed to tear them
down.

**Nothing reconciles them**, and the one gate that would have is deliberately open: SKILL.md:87 states the mid-run lease prohibition "does not touch
`--abort`". So the spawned session is not refused, takes the lease (15:05:52), and proceeds — while the original driver's abort is still running.

The server cannot currently tell a live driver from a dead one at this moment. It has the run file's `driver.at`, but a driver that is *about to* handle exit
`10` looks identical to one that has stopped heartbeating, and the freshness threshold is fifteen minutes — far longer than the ~70s an abort takes.

## Fix

Decide who ends a stopped run, and make the other path conditional on the first not being there. Two shapes, and the implementer should pick one rather than
build both:

**A — the driver ends it; the server spawns only as a fallback.** `spawnAbort()` becomes conditional: spawn only when no live driver is going to see the stop.
"Live" needs a real definition here, and the fifteen-minute staleness threshold is not it — something on the order of the heartbeat interval is. If a live
driver is present, `stop()` returns having written the control file and spawned nothing, and the response says so, because a caller that is told nothing was
spawned needs to know the run is still ending.

**B — the server ends it; the driver stands down.** Exit `10`'s instruction changes from "run `--abort`" to "stop and write nothing — an abort session is
already coming". This puts the teardown in the session that did not create the worktree, which is the weaker position, and it makes the run depend on a spawn
that can be refused (agents off, project invisible to the dashboard — `spawnAbort`'s own three refusal branches at `:1198`, `:1202`, `:1210`). Those refusals
currently tell the user to run `--abort` by hand precisely because the driver might not be there; under B they would be the only path, which is worse.

A is the better shape. B is written down so the choice is visible rather than assumed.

**Either way, `--abort` must stay safe to run twice.** It already is, in the sense that both runs here converged, and the exemption at SKILL.md:87 exists for
good reasons (a hand-run `--abort` on a stuck run must never be refused). The fix is to stop *routinely* running two, not to forbid it.

**Out of scope for this item:** the Stop control's missing confirmation and its unusable `Cancel stop` — those are bug-53, which touches the same `stop()`
method. Whichever lands second should read the other's diff. bug-53 changes what the *route* accepts; this one changes what it *does*.

## Done when

- One board Stop results in exactly one `--abort` running against the run, in both the live-driver case and the dead-driver case.
- A stop with no live driver still ends the run, with the same teardown guarantees it has today.
- A stop whose spawn is refused still tells the user how to end the run by hand.
- No path reads a worktree's `git status` while another session is tearing that worktree down.

## Test cases

In `test/agents-stop.test.ts`:

- `stop()` on a project whose run file carries a driver heartbeat inside the live threshold writes the control file and does **not** call `spawn` — asserted on
  the spawn mock's call count being `0`, and on the returned `abortSession` being `null` with a reason naming the driver rather than a refusal.
- `stop()` on a project whose run file's driver heartbeat is older than the live threshold spawns exactly one session, with prompt `/backlog-orchestrate
  --abort`, and returns its session id.
- `stop()` on a project whose run file has no `driver` key at all takes the spawn path — an older run file must not be read as "a driver is live".
- The three `spawnAbort` refusal branches (agents off, gate not `enabled`, project not visible) each still return their `abortRefused` sentence when the spawn
  path is the one taken.
- `stop(cancel: true)` is untouched by all of the above — it clears the control file and spawns nothing, exactly as today.

In `skills/backlog-orchestrate/tools/orchestrate.test.mjs`:

- Two `abort` invocations against the same run file, the second starting while the first has already removed the worktree, both exit `0` and leave the run
  `aborted` with the same queue contents — the idempotency the fix relies on, pinned so a later change cannot quietly remove it.
