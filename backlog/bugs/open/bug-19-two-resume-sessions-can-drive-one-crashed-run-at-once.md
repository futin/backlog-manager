---
id: bug-19
title: Two --resume sessions can drive one crashed run at once
created: 2026-09-05
tags: orchestrator, watchdog, resume
updated: 2026-09-05T20:25:15Z
groom-elapsed: 423
groom-tokens: 87417
---

## Symptom

Nothing serializes `--resume` against a single crashed run, and on
`run-20260905-113818` two live sessions were observed holding it at the same
time. CLAUDE.md already names this as the risk that `watchdogStoodDown` exists
to narrow — "`resume()` refuses a *fresh* run, not a second resume of a crashed
one, and grace is a backoff, not a lock" — this item is that risk actually
happening, twice in one afternoon, in two different shapes.

Observed on this repo's own run (queue: bug-16 merged, task-13 crashed at
`reviewing`, task-14/task-15 pending):

**Occurrence 1 — three spawns inside 10 seconds.** Three fresh sessions, all
titled `resume backlog-manager`, all carrying the prompt
`/backlog-manager:backlog-orchestrate --resume`:

| session | first user event (UTC) |
|---|---|
| `741ebf1c-dd9b-4fb7-a14a-ad279fe058b6` | 13:09:59.506Z |
| `6459b0fb-3eca-420c-a87a-016946820692` | 13:10:00.765Z |
| `063ffb0e-c0a5-404b-a207-b25d00f4f3d6` | 13:10:09.466Z |

All three died ~600ms in on `You've hit your individual spend limit … your
session limit resets 6pm (Europe/Berlin)`, so all three transcripts are
byte-identical in size (136256) and none of them ever reached a heartbeat.
Harmless only by luck: the spend limit, not the design, is what stopped three
sessions reconciling the same run file.

**Occurrence 2 — two spawns 26s apart, both live, different shapes.** At
18:01 local:

- PID `87980`, `claude -p --resume 19f8b098-e44a-4142-8b10-4c94ff1a6cf7
  --permission-mode auto`, started 18:01:14 — resumes an *existing*
  orchestrator session, no prompt.
- PID `88634`, `claude -p --session-id eeeaa7c5-… --permission-mode auto
  -n resume backlog-manager`, started 18:01:40 — a *fresh* session running the
  `--resume` trigger.

Both had PPID `56779` (the claude-agents-dashboard API process, which is the
spawner for every board-initiated session, so a shared parent is expected and
is not itself the finding). `87980` went on to reconcile, diagnose task-13 and
dispatch the reviewer; `88634` reached `status`/`heartbeat` and stood down by
hand rather than becoming a second writer. Had it not, two sessions would have
been stage-writing one `run.json` and both ending in a merge to `main` — the
exact failure the single-writer rule is built to prevent.

Two spawn shapes are visible above and it is not established which component
emits which; that mapping is part of the diagnosis, not a finding yet.

## Repro

Not yet reduced to a deterministic recipe. What is established about the
conditions:

1. A run whose `run.json` says `running` with a stale heartbeat (task-13 last
   stamped `reviewing` at 12:43:38Z; the crash sat unnoticed for ~3h20m).
2. More than one resume trigger reaches the spawn path inside the grace
   window — a board Resume click, a watchdog tick, or a dashboard-initiated
   `/backlog-orchestrate --resume`.
3. Both spawns succeed. Neither refuses on account of the other.

Two facts that narrow the search and were checked rather than assumed:

- **The grace window was configured and should have suppressed occurrence 1.**
  `~/.backlog-manager/settings/watchdog.json` at the time read
  `{"enabled":true,"tickMs":60000,"graceMs":600000,"maxAttempts":2}`. Three
  spawns in 10 seconds fits neither a 10-minute grace window nor a cap of 2.
- **In-memory watchdog state had NOT been lost to a restart.**
  `WatchdogStateService` is deliberately volatile, so a restarted server
  forgetting `lastSpawnAt` would explain everything — but the API runs in
  Docker (`backlog-manager-server-1`, `Up 5 hours` as of 18:14 local, i.e.
  continuously across the 13:10Z spawns), so `attempts` and `lastSpawnAt`
  survived the whole window. The volatility is not the explanation here.

## Affects

- `server/src/agents/watchdog.service.ts:410` — the grace check
  (`entry.lastSpawnAt !== null && Date.now() - Date.parse(entry.lastSpawnAt) < config.graceMs`)
- `server/src/agents/watchdog.service.ts:516` — where a spawn stamps
  `lastSpawnAt`, and `:519` where only a successful one increments `attempts`
- `server/src/agents/watchdog.service.ts:490` — `noteBoardResume`, which
  stamps grace but deliberately does not count against the cap
- `server/src/agents/watchdog.service.ts:60` — the comment describing the
  in-flight guard and the two-sweeps-racing-an-unwritten-`lastSpawnAt` case
- `server/src/orchestrator/watchdog-state.service.ts:85` — `attempts` /
  `lastSpawnAt` on the in-memory entry
- `shared/agent.ts` — `watchdogStoodDown`, the single predicate the strip's
  Resume control and the sweeper both read

## Cause

**Nothing anywhere serializes a resume.** Not one bug with one root: three
independent gaps, one per layer, each of which alone is enough to put two
`--resume` sessions on one crashed run. The two occurrences in the Symptom are
two different gaps firing, which is why neither explains the other.

The Symptom left two questions open. Both are now answered, and the answers are
what the fix is built on.

### Which component emits which spawn shape

`resumeSessionName` (`server/src/agents/agents.service.ts:1047`) prefixes a
watchdog-initiated session `watchdog resume <basename>` and a board-initiated
one `resume <basename>`. All three of occurrence 1's sessions were named
`resume backlog-manager`, so **the watchdog spawned none of them** — every one
came from `POST /api/agents/resume` with `origin: 'board'`, i.e. from a click.
That single fact dissolves the Symptom's "three spawns in 10 seconds fits
neither a 10-minute grace window nor a cap of 2": grace and the cap are read in
exactly one place, `visit()`'s step 4 (`watchdog.service.ts:410`), which only
ever runs inside the sweeper's own tick. Neither was violated. Neither was ever
consulted, because no board resume passes through the code that consults them.
The watchdog config was correct and irrelevant, and so was the confirmed-intact
in-memory state — both were checked in the Symptom against a suspect that was
never at the scene.

Occurrence 2's two shapes come from two different applications:

- **`claude -p --session-id <new> … -n resume backlog-manager` (PID 88634)** is
  this app: `AgentsService.spawn()` POSTs `{project, prompt, name,
  permissionMode}` to the dashboard's `/api/spawn`, the dashboard mints a fresh
  session id, and `RESUME_PROMPT` (`agents.service.ts:137`,
  `/backlog-orchestrate --resume`) is what that new session runs.
- **`claude -p --resume <existing id> --permission-mode auto` (PID 87980)** is
  **not this app at all**. It is the dashboard's own session-resume:
  `buildSpawnArgs` in `claude-agents-dashboard/server/lib/spawn.ts:211-215`
  swaps `--session-id <id>` for `--resume <id>` when its `SpawnInput.resume`
  flag is set, and this app's spawn body has no field that can set it. That
  launch resumes the *orchestrator's own crashed session* in place, appending to
  the same transcript. Nothing in `backlog-manager` requested it, nothing in
  `backlog-manager` can see it, and no lock this repo adds to its own server can
  ever refuse it — a person clicked Resume on a dead session row in a different
  app's UI.

So occurrence 2 was one backlog-manager resume racing one dashboard resume, and
the shared PPID is only both spawns having the same parent process.

### Gap 1 — the board's Resume control has no in-flight guard, and no feedback

`attemptResume` (`client/src/components/board/RunStrip.tsx:175`) fires
`resumeOrchestrate(run.project)` and returns. There is no `resuming` state: the
button is not disabled while the request is out, a second click issues a second
POST, and `aria-disabled` is driven solely by `resumeBlockedReason`, which is
about project visibility and never about a request already in flight.

The missing guard and the missing feedback are one defect, not two, and the
feedback half is what makes a person supply the clicks. A successful resume
changes nothing a person can see: the strip keeps saying `crashed` with the same
heartbeat age until the resumed session stamps its first heartbeat, and
`references/recovery.md` records that gap measured on a real run — spawned
18:57:44, first heartbeat 18:59:11, about ninety seconds of a screen that looks
identical to one where the click did nothing. Occurrence 1's spacing is that
behaviour: 13:09:59.5, then +1.3s, then +8.7s. Click, nothing happens, click
again.

This is the same FEEDBACK gap `StartingRunsService` was built for on the
orchestrate path (CLAUDE.md: "a click that silently failed looked identical to
one that worked"), reached from the resume path, which CLAUDE.md deliberately
left unmarked on the grounds that "the board is already drawing a crashed strip
for it and the screen was never blank." That reasoning is right about the screen
not being blank and wrong about it being informative: a crashed strip that
stays byte-identical after a click is exactly as unreadable as a blank one.

### Gap 2 — `AgentsService.resume()` refuses a fresh run and nothing else

`resume()` (`agents.service.ts:609`) is the one method both origins share, and
its only run-level refusal is `if (run.fresh)`. A crashed run stays crashed for
the whole ~90s a resumed session takes to reach its first heartbeat, so every
call arriving in that window sees the identical stale run and every one spawns.
The method's own doc comment states this as a deliberate asymmetry against
`orchestrate()` — "one guards against starting a run that already exists, the
other exists only because one has stopped heartbeating" — and that is correct as
far as it goes; the gap is that nothing was ever added on the other side of it.
`orchestrate()` has a lock. `resume()` has no lock of any kind.

Two things make this a race rather than merely a missing check:

- **The only clock that could have covered it is watchdog-internal.**
  `entry.lastSpawnAt` is stamped by `spawn()` (`watchdog.service.ts:516`) and by
  `noteBoardResume` (`:497`), and read by `visit()` (`:410`) alone. A board
  resume therefore *writes* the grace clock and never *reads* it. CLAUDE.md says
  this outright — "grace is a backoff, not a lock" — as a known narrowing, and
  `noteBoardResume`'s own comment describes closing exactly one instance of it
  (`arm()`'s synchronous tick finding no entry). The general case was left open.
- **The stamp lands after the await.** `AgentsController.resume` calls
  `noteBoardResume` only once `await this.agents.resume(...)` has returned, so N
  concurrent requests all complete their checks before any of them writes
  anything. Even a `resume()` that *did* read grace would let all three of
  occurrence 1 through, because there is nothing to read yet. A lock has to be
  taken synchronously, before the first `await` in the critical section, or it
  is not a lock.

### Gap 3 — the run file has no notion of who is driving it

This is the durable one, and the only one that can refuse a dashboard-initiated
resume, because it is the only layer both spawn shapes pass through.

`--resume` is not a command. `orchestrate.mjs`'s dispatch table
(`skills/backlog-orchestrate/tools/orchestrate.mjs:2494-2506`) has no `resume`
entry: `--resume` is a *prose* flow in `references/recovery.md` that a session
carries out with the ordinary commands. `init` is the only command that takes a
lock at all, and a resume never calls `init` — by design, since exit `4` is what
`init` answers for the very run file a resume exists to take over.

Everything downstream of that is a blind read-modify-write. `cmdHeartbeat`
(`:1512`) is three lines — read, re-stamp `updatedAt`, `writeRunAtomic` — and
`stage`, `attention`, `merge-mode` and `finish` are the same shape.
`writeRunAtomic` (`:373`) is atomic per write, so the file is never torn; it is
last-writer-wins across processes, so two drivers each read a copy, mutate their
own, and write over each other. The run object `cmdInit` builds (`:1274`) has no
field naming a session, and `run.json`'s single-writer guarantee is a statement
about which *program* writes it, which two instances of that program satisfy
while destroying each other's state.

`references/recovery.md` already names this hazard and mitigates it with the
only tool it has: heartbeat first, before reconcile, to shrink the window "in
which a human's resume and the watchdog's own resume can land on the same
crashed run at once." That works forward — once the run reads fresh, `resume()`
refuses further spawns — and not backward: a session already spawned re-reads
`status`, finds `running`, and proceeds. `status` only distinguishes
`running` from `done`/`aborted`/`failed`; it cannot say *someone else is
already here*, because the file does not record it.

## Fix

Three parts, one per gap, in this order. Parts 1 and 2 close every occurrence
this app can cause on its own and are small; part 3 is the only one that closes
occurrence 2's shape, and it is the one that makes the guarantee structural
rather than a pair of checks that must keep agreeing.

### 1. `RunStrip` — guard the click and say something happened

In `renderCrashedStrip` (`client/src/components/board/RunStrip.tsx`), add a
`resuming` state alongside the existing `resumeError`. `attemptResume` returns
immediately when `resuming` is true, sets it before the fetch, and clears it in
both settle paths. The button carries `aria-disabled` when
`blocked !== null || resuming`, and its label reads `Resuming…` while in flight.

Keep it disabled after a success, not just during the request: `onResumed?.()`
reloads the payload, and the run will still read `crashed` for ~90s, so
re-enabling on settle restores the exact state that produced occurrence 1.
Clear it when the payload's `updatedAt` for this run moves — the run has
heartbeated, at which point `showResume` is false anyway — or when the strip
unmounts. A stuck-disabled button is bounded by the server's own answer in part
2, which is a sentence a person can read rather than a dead control.

This does not close the gap on its own — two tabs, or a click racing a watchdog
tick, defeat it — and must not be written as if it did.

### 2. `AgentsService.resume()` — take a real lock, synchronously

Add a resume lock to `WatchdogEntry` (`server/src/orchestrator/
watchdog-state.service.ts:82`): one nullable timestamp, e.g. `resumeSpawnAt`,
distinct from `lastSpawnAt`. `AgentsService` injects `WatchdogStateService` —
the state holder, never `WatchdogService`, which would be the cycle
`noteBoardResume`'s own comment explains — and in `resume()`, after the
`run.fresh` refusal and **before any further `await`**, does one synchronous
block: `upsert(run.runId, run.project)`, refuse if `resumeSpawnAt` is within
`RUN_STALE_MS` of now, otherwise stamp it. Both callers get it: the sweeper's
`spawn()` already goes through this method.

Four decisions a later reader must not re-open:

- **`RUN_STALE_MS`, not a new number.** The lock asks "is a resume session
  believed to be alive in this run", and this app computes liveness exactly
  once. A resumed session that has not heartbeated in fifteen minutes is dead by
  the app's own definition, and a second resume is then the right answer. Do not
  mint a resume-specific window — CLAUDE.md's "the app's one freshness number,
  reused rather than joined by a second."
- **Stamp before the spawn, clear on failure.** Stamping first is the whole
  point: the check and the stamp must sit in one synchronous run of the event
  loop or concurrent requests all pass. Clearing when `spawn()` throws is
  required, not tidy — a spawn that threw started no session, and leaving the
  stamp would silence the board's only resume control for fifteen minutes
  because the dashboard was briefly down. This is the same success-versus-
  attempt split the cap already makes; grace keeps covering the failure case and
  is untouched.
- **An uncoded 409.** Per CLAUDE.md, `RUN_IN_PROGRESS_CODE` means "a run is
  alive for this project, right now", which is false here — the run is crashed
  and a resume is on its way. The two are different facts, and the strip acts
  differently on them (it treats the in-progress code as a silent success). The
  message carries everything a reader needs: the age of the resume spawn and
  that a resumed session takes about ninety seconds to heartbeat. Every other
  409 this endpoint throws is uncoded for the same reason.
- **The watchdog's second attempt may now be delayed.** With `graceMs` at ten
  minutes and the lock at fifteen, a sweeper retry at t+10m is refused, logs a
  `failed` line, does not count against the cap, and re-stamps grace — so
  attempt 2 lands near t+20m. That is correct behaviour (the first resume was
  still inside its own liveness window) and it is a visible change in Activity;
  do not "fix" it by shortening the lock.

### 3. `orchestrate.mjs` — a driver lease in the run file

The tool is the only component both spawn shapes reach, so this is the only
place a dashboard-initiated resume can be refused at all.

Add one optional run-level field, written by the single writer and read by
nobody else: `driver: { sessionId, at } | null`. **Absent means unclaimed, never
locked** — every run file already on disk lacks it, and a missing field must
never be able to strand a run.

- **New command `claim`.** Reads the run; refuses (a distinct non-zero exit,
  new, not `4`) when the run is `running`, *fresh*, and `driver.sessionId` is
  someone else's — an actively-heartbeating run already has a driver. Otherwise
  writes `driver` with this session's id and stamps `updatedAt` in the same
  atomic write, so it is the heartbeat `recovery.md` already requires at that
  point rather than a second call.
- **Every mutating command refuses a foreign live lease**: `heartbeat`, `stage`,
  `attention`, `merge-mode`, `finish`, and `watch`'s own heartbeat. Refuse only
  when `driver` is set and names another session; write nothing, exit non-zero,
  and say which session holds it.
- **Identity is `CLAUDE_CODE_SESSION_ID`**, the same id `backlog.mjs` reads for
  token accounting (`skills/backlog/tools/backlog.mjs:1192`). When it is absent
  — a hand-run terminal — commands proceed with a stderr warning that the lease
  cannot be enforced, and `claim` writes `null`. Do **not** substitute a
  synthetic per-process id: each invocation would then present a different
  identity and lock itself out of its own run on the second command.
- **`init` stamps the first driver**, since the initiating session is one.

The resulting guarantee is a deterministic single survivor, with no
cross-process locking primitive: on a crashed run both resumers may claim, the
later write wins, and the loser's very next write refuses and stops it. That is
why last-writer-wins — the property that makes gap 3 dangerous for `stage` and
`heartbeat` — is safe for `claim` specifically: exactly one of the two claims is
visible afterwards, and every subsequent write is checked against it.

Note what this does to occurrence 2 specifically: a dashboard `--resume <id>`
resumes the *same* session id, so the original driver passes its own lease and
continues; the fresh `RESUME_PROMPT` session presents a new id, claims, and
evicts it — after which PID 87980's next `stage` or `heartbeat` refuses instead
of both running to a merge. Either order leaves one driver.

`references/recovery.md` needs two edits: `claim` replaces the unconditional
`heartbeat` in the `--resume` opening sequence (same position, same purpose,
now also recording who), and a refusal on `claim` or on any later write means
*another session has taken this run over — stop immediately, write nothing,
exit*, stated in as many words. `SKILL.md` §2's pointer follows.

### Test cases

Server (`test/agents-resume.test.ts`, `test/watchdog-sweep.test.ts`):

- Two `resume()` calls issued without awaiting the first: exactly one outbound
  spawn, the second a 409 whose message names the age of the first; extend to
  three for occurrence 1's own shape.
- A spawn that throws (dashboard 502) leaves no lock: the next call spawns.
- A locked run stops being locked `RUN_STALE_MS` after the stamp.
- The sweeper's `spawn()` obeys the same lock: `attempts` unchanged, one
  `failed` Activity line, grace re-stamped.
- The existing `run.fresh` 409 with `RUN_IN_PROGRESS_CODE` is unchanged, and the
  new refusal carries no code.

Client (`test/orchestrator-strip.test.tsx`): a double click on Resume issues one
fetch; the button reads `Resuming…` and is `aria-disabled` while in flight;
it stays disabled after a success while the run still reads crashed; a failure
re-enables it and renders the error.

Tool (`skills/backlog-orchestrate/tools/orchestrate.test.mjs`, node's runner):
`claim` on an unclaimed stale run succeeds and stamps `updatedAt`; a second
`claim` under a different `CLAUDE_CODE_SESSION_ID` on that stale run succeeds
and the first session's `heartbeat`, `stage` and `finish` then each exit
non-zero having written nothing (compare the file byte-for-byte); `claim`
refuses a *fresh* run held by another id; a run file with no `driver` key
accepts every command exactly as it does today; with `CLAUDE_CODE_SESSION_ID`
unset, commands run and warn; `init` writes a driver.

In the browser (playwright MCP tools): with the stack up (`pnpm run docker:up`)
and a crashed run staged for a registered project — write a `run.json` with
`status: "running"` and an `updatedAt` over fifteen minutes old under
`$BM_ORCH_HOME`, the run-state directory the server reads — open
`http://localhost:5177`, confirm the strip renders `crashed` with a
`Resume run` button, click it twice in quick succession, and confirm the button
reads `Resuming…` and is `aria-disabled` after the first click and that
`POST /api/agents/resume` appears exactly once in the network log.
