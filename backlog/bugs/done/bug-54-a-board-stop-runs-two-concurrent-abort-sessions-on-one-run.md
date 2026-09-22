---
id: bug-54
title: a board Stop runs two concurrent --abort sessions on one run
created: 2026-09-22
runner-fix: true
updated: 2026-09-22T20:06:19Z
groom-elapsed: 313
groom-tokens: 60530
started: 2026-09-22T19:52:00Z
execute-elapsed: 859
execute-tokens: 124520
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

**Chosen shape: the `abort` command excludes itself. The server's spawn stays unconditional.** Settled at groom on 2026-09-22. This replaces the A/B choice
the item was filed with, because both of those shapes gate the spawn on the server, and a server-side gate has a hole this item did not account for.

**Why not shape A (spawn only when no live driver).** Once `stopRequested` reads `true`, `RunControls.tsx` draws only the "Stopping — this run is being ended"
note: no Stop chip, and since bug-53 no Cancel either (`client/src/components/RunControls.tsx`, the `run.stopRequested` branch). Say the server skips the spawn
because `updatedAt` looked live, and the driver then dies before its next `watch` tick. That is up to 30s at `watch`'s default `--interval-ms`, and longer
if the driver is between `watch` calls, in review or in a merge. The run then stays `running` with a stop on file, the watchdog stands down on the stop, and no
surface can end it. Closing that hole needs a re-stop control on the client and a "stale stop, respawn" rule on the server. That is three layers of change
to save one redundant session. B is still rejected for the reasons given above.

**The mechanism: an abort marks the lease it takes, and a second abort from a different session refuses on that mark.** Everything lives in
`skills/backlog-orchestrate/tools/orchestrate.mjs`, inside the read-modify-write that `takeOverRun` already does when `cmdAbort` calls it. That is abort's
first write, and it comes before the session-id harvest, the child signal and the teardown. Behaviour:

1. **Mark.** When `cmdAbort` takes the lease, the lease records that it is an abort: an `aborting` field on `run.driver` whose ISO value is the lease's own
   `at`, written with the same clock reading. `claim` never sets it, and a `claim` takeover writes a lease without it. Add the optional field to the
   `driver` type in `shared/types.ts` (`driver?: { sessionId; at; aborting? }`) so the run file's shape stays declared. The server only reads the field and
   does nothing with it.
2. **Refuse.** `cmdAbort` refuses **before writing anything** when all four of these hold: the run is `running`, `run.driver.aborting` is present, that
   lease's `sessionId` is not this session's, and `isFresh(run.driver.aborting)` holds. The fourth uses `RUN_STALE_MS` and adds no new window. The exit
   code is `7` (`EXIT_FOREIGN_DRIVER`). Its meaning is already "this call was right, another session holds this run: stop and write nothing". The stderr
   sentence names the other session, when its abort started, and says outright that the run is already being ended, so do not inspect or touch any worktree.
   This refusal is independent of the stop request. The `force` escape hatch that bug-39 gave abort still overrides a *driver* lease, never an *abort*
   lease.
3. **Exemptions, each deliberate:**
   - **Same session.** `me === driver.sessionId` proceeds. An abort that lost its process mid-teardown and is re-run by the same session must be able to
     finish its own work.
   - **Hand-run terminal.** `me === null` proceeds, with the existing lease warning. SKILL.md:87's rule that a hand-run `--abort` on a stuck run is never
     refused is the reason the exemption at `takeOverRun` exists. The person at the keyboard is the authority, and nothing automated has a null identity.
   - **Stale mark.** Past `RUN_STALE_MS` the mark means an abort that died mid-way, so it no longer refuses and the next abort takes over as it does today.
4. **Already aborted.** `cmdAbort` on a run whose `status` is already `aborted` prints one line naming the run and the lease that ended it, writes nothing,
   signals nothing, runs no git, and exits `0`. Today a late second abort re-runs the teardown and `finish`. That is the late-arriving half of this bug, and
   under the mark above it is the normal fate of whichever abort comes second, once the first has finished. Every other non-`running` status (`done`,
   `failed`, `paused`) behaves exactly as it does today.

**Both orderings, under this mechanism:**

- *Driver first* (the observed case). The driver's `watch` returns `10` and its `abort` marks the lease with its own session. The spawned session's `abort`
  then gets `7` while the driver's abort is running, or the no-op `0` once it has finished. Either way it writes nothing.
- *Spawned first* (the driver is in a review or merge, with no `watch` running). The spawned `abort` takes the lease and marks it (this is bug-39's `force`
  path, unchanged). The driver's next `watch` tick or `stage` call now hits `assertDriver` and exits `7`, as it already does against a foreign lease. If
  the driver instead reaches its own `abort` (its `stage` returned `10`, which is checked after the lease), that `abort` refuses on the mark with `7`.

**Prose, two places, updated to match:**

- `skills/backlog-orchestrate/SKILL.md` §10 _Stopping_ gets one more bullet next to the four there now. An `abort` that exits `7` saying the run is already
  being aborted means another session is ending this run. Do not read, `git status` or otherwise inspect any worktree. Report that session's id and end the
  turn. Update the exit-code table's `7` row and the paragraph at `:82`–`:87` so they no longer read as mid-run-only. The sentence "it does not touch
  `--abort`" becomes: it does not stop `--abort` taking a *driver's* lease, and a live *abort's* lease is the one lease `--abort` respects.
- `skills/backlog-orchestrate/references/recovery.md` `### --abort`: the same `7` reaction. Also strengthen "Run `abort` first" to say explicitly that nothing
  under `.worktrees/` is read before `abort` has returned. In the observed run, session `a43e38ab` ran `git status` on `.worktrees/5` 5–10s before its own
  `abort`. That read is the judgment call this item is about, and the tool cannot refuse a read that happens before the tool is called.

**Server: no behaviour change.** `stop()` and `spawnAbort()` (`server/src/agents/agents.service.ts`) stay exactly as they are. The unconditional spawn is
what covers a dead driver, and after this fix a redundant spawned session costs one refused `abort` call. `STOP_PROMPT` is unchanged.

**Accepted residual.** The run file has no lock, so two aborts whose `readRun`s land in the same few milliseconds could both see no mark. In practice the two
arrive about 25s apart (15:05:19 vs about 15:05:45 in the table above), and `--abort` stays safe to run twice. Adding a lock is out of scope.

**bug-53 has landed** (`f66faf0`): the `cancel` direction is gone from `stop()`, and the controller refuses `cancel: true` before the method is reached. This
item does not touch `stop()`, so the two no longer overlap.

## Done when

- One board Stop results in exactly one `abort` that tears anything down, whichever of the driver and the spawned session gets there first. The other
  session's `abort` exits `7` (while the first is running) or `0` as a no-op (after it finished), and in both cases the run file is byte-identical and no git
  command was run.
- A stop with no live driver still ends the run through the spawned session, with the same teardown guarantees as today, and the server's spawn path is
  unchanged.
- A hand-run `--abort` (no `CLAUDE_CODE_SESSION_ID`) is never refused by the abort mark.
- An abort that died mid-teardown does not lock out the next identified abort for longer than `RUN_STALE_MS`.
- SKILL.md §10 and recovery.md's `--abort` both tell a session that got `7` from `abort` to inspect no worktree and end the turn.
- `pnpm test` is green.

## Test cases

In `skills/backlog-orchestrate/tools/orchestrate.test.mjs`. Each case sets the session identity through `CLAUDE_CODE_SESSION_ID` the way that suite's existing
lease tests already do, and puts a stop on file unless the case says otherwise:

- **Mark written.** Session `A` runs `abort` on a `running` run leased to `A`. Its first write leaves `run.driver.aborting` equal to `run.driver.at`. Then
  `claim` on a paused run leaves no `aborting` key on the lease it writes.
- **Live mark refuses.** The run file is `running`, leased `{ sessionId: A, at: now, aborting: now }`, with a fixture worktree and branch on disk. Session `B`
  runs `abort`: exit `7`, stderr names `A` and says an abort is in progress, the run file is byte-identical before and after, and the worktree directory and
  branch both still exist.
- **Live mark refuses even with a stop on file.** The same case with the stop request present still gives `7`, which proves `force` does not override an abort
  lease. The same fixture with *no* `aborting` key, i.e. a plain live driver lease, still lets `B` take over, as bug-39's existing test pins, and `B`'s lease
  now carries the mark.
- **Stale mark proceeds.** As "Live mark refuses" but with `aborting` older than `RUN_STALE_MS`: `B`'s `abort` exits `0`, the run is `aborted`, and the lease
  is `B`'s.
- **Hand-run proceeds.** As "Live mark refuses" but with `CLAUDE_CODE_SESSION_ID` unset: exit `0`, run `aborted`, and the existing lease warning on stderr.
- **Same session proceeds.** As "Live mark refuses" but run as `A`: exit `0`, run `aborted`.
- **Already aborted is a no-op.** `A`'s `abort` completes. Then `B`'s `abort` against the same run exits `0`, prints one line naming the run as already
  aborted, leaves the run file byte-identical, and changes nothing about the queue, the attention list or the lease. Replaces the old case pinning "two aborts
  both exit 0": this is how that idempotency is pinned now.
- **Spawned first, driver stands down.** Driver lease `D` is fresh and a stop is on file. `S`'s `abort` completes. Then `D`'s `watch` exits `7` (via
  `assertDriver`), and `D`'s `abort` exits `0` as the already-aborted no-op, with the run file byte-identical across both calls.
- **Spawned first, still running.** The same setup, but the file is left mid-abort: `running`, leased to `S` with a fresh mark. `D`'s `abort` exits `7` and
  writes nothing, and `D`'s `stage <id> reviewing` exits `7`, not `10`, because the lease is checked first.

In `test/agents-stop.test.ts`, which pins what the server keeps rather than what it changes:

- `stop()` on a `running`, **fresh** run whose run file names a driver still spawns exactly one session with prompt `/backlog-orchestrate --abort`. This
  guards against a later change reintroducing a server-side liveness gate without the client re-stop control that would have to come with it. If the
  existing "writes a stop pinned to the run and spawns one --abort session" case already uses such a fixture, assert it there instead of adding a case.

A prose guard is optional: if `test/` already has a suite asserting SKILL.md or recovery.md contents, add one assertion that §10 _Stopping_ names the `7`
reaction.

## Outcome

2026-09-22. Fixed as groomed: `orchestrate.mjs abort` now excludes itself, and the server's spawn stays unconditional. `takeOverRun` takes a required fourth
parameter, `aborting`: `cmdAbort` passes `true` and the lease it writes carries `driver.aborting` (equal to `driver.at`, one clock reading); `cmdClaim`
passes `false` and its lease never carries one. Before writing anything, `cmdAbort` now (a) prints one line and exits `0` on a run that is already
`aborted` — no write, no signal, no git — and (b) exits `7` on a `running` run whose lease is another identified session's abort with a mark fresher than
`RUN_STALE_MS`, with a stderr sentence naming that session and telling the caller to inspect no worktree and end the turn. A stop on file does not override
that refusal. Same session, `me === null` and a stale mark are exempt. `shared/types.ts` declares the optional field. SKILL.md (exit-code row `7`, the
lease paragraph under the table, §10 _Stopping_'s lease bullet plus a fifth bullet for the `7` reaction) and recovery.md's `### --abort` (nothing under
`.worktrees/` is read before `abort` returns; the `7` / `already aborted` reaction) say the same. No server behaviour change; `test/agents-stop.test.ts`
gained a case pinning the spawn for a fresh run with a named driver.

Also changed: the marker-preserved item's `attention` text said to remove its worktree and branch "by hand or via a fresh abort". A second abort on that run
is now a no-op, so the text says "by hand" and says why.

Not verified live: no board Stop was run against a real run in this session. The two orderings are covered by the tool tests below ("spawned abort
first", "spawned abort still running", and the driver-first case as "live mark refuses" / "already aborted is a no-op").

Verification — `pnpm test` (both runners), then `pnpm run typecheck`:

```
Test Suites: 129 passed, 129 total
Tests:       2195 passed, 2195 total
# tests 794
# pass 794
# fail 0
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
$ tsc --noEmit --tsBuildInfoFile node_modules/.cache/tsconfig.tsbuildinfo   (exit 0)
```

Contract sweep: 11 sites updated (skills/backlog-orchestrate/SKILL.md ×4 — exit `7` row, the "does not touch `--abort`" sentence, §10 _Stopping_'s "will not be refused on the lease" bullet and its "Four things" count; skills/backlog-orchestrate/references/recovery.md ×2 — "The one thing abort still refuses", and "Run `abort` first"; .claude/rules/orchestrator.md ×2 — "evicted by the abort session's own `takeOverRun` write" and `takeOverRun(dir, run, force)`; docs/subsystems/invariants.md ×2 — the unconditional-spawn reasoning and `takeOverRun(dir, run, force)`; plus the "via a fresh abort" attention text in orchestrate.mjs). Left standing on purpose: docs/subsystems/api.md's `POST /api/agents/stop` entry (still accurate — the route did not change) and docs/superpowers/ specs and plans (historical records).
Red proof: 13 tests went red with the change reverted (each production clause mutated in a file copy in turn — no mark, claim marking, no refusal, no no-op, and each of the three exemptions removed — turned all 11 tool cases red, including the amended bug-39 "abort takes the lease from a FRESH run" case; the prose guard went red against HEAD's SKILL.md and HEAD's recovery.md separately; the new agents-stop case went red with a driver-liveness gate added to `stop()`)
