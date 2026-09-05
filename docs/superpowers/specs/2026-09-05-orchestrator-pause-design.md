# Orchestrator pause — design

A board control that asks a running orchestrator run to stop at the next
item boundary, leave everything it has not started exactly where it is, and
end its session in a state the existing `--resume` path can pick up later
from the board. Nothing here kills a process; nothing here writes the run
file from outside `orchestrate.mjs`; nothing here changes what the watchdog
does — a paused run is not a crashed one, and it is never `running`.

## Why this exists

An orchestrator run is a headless `claude -p` session that dispatches one
headless execute session per item, then commits, reviews, verifies and
merges each before the next starts. Every one of those steps spends the
account's rolling usage window (the 5-hour and weekly limits `/usage`
shows), and a run of five items can take hours. Today there is no way to
say "finish what you are doing, then stop, and I will continue later":

| what exists | what it does | what it does not do |
|---|---|---|
| Settings → watchdog off | stops re-spawns | the run keeps dispatching |
| killing the process by hand | the run goes stale; the strip renders it crashed | leaves worktrees, branches and `phase:` markers behind, and the watchdog resumes it within ~16 minutes unless it was switched off first |
| `/backlog-orchestrate --abort`, typed in a terminal at the project root | tears down worktrees and branches, ends the run `aborted` | there is no "continue later" — the next run is a new run, and nothing about it is reachable from the board |

The case that motivated this: the usage window is nearly spent, the current
item is mid-review, and the next item should not start. Letting the run
carry on means the account limit is hit *inside* an execute session or
inside the orchestrator's own turn. The expected shape of that (reasoned,
not yet observed): the child dies with an API error and the item parks or
fails; the orchestrator's own calls fail and its process exits; `run.json`
freezes at `running`; the watchdog spawns `--resume` sessions into the same
exhausted window until its cap is reached. An account limit becomes a crash
cascade with a `fix-exhausted`-shaped tail nobody asked for.

The user's ask, in two halves: a pause "so that we could proceed
afterwards", and — as a separate feature — a check of the usage headroom
before each dispatch that pauses on its own below a configurable floor.
This document is the first half. The second is filed as an idea (§9) and is
deliberately shaped so it needs nothing here to change: the pause request is
a file the server writes, so a usage-aware trigger is a server-side sweeper
writing that same file.

Decisions taken with the user before this document (see §8 for the costs):
**soft pause only** — the in-flight item drains through merge, the next one
never starts; **manual resume from the board** — no auto-resume at a reset
time; the **controls live in the Board's run drawer and in the Runs view's
detail pane**, not on the strip or the list rows; the usage check and its
threshold are **out of this round entirely**.

## Non-goals

- **Hard pause — stopping the item in flight.** `watch` already holds the
  execute child's pid and polls it every 30s; a hard pause would have it
  SIGTERM that pid on seeing the request, leave the worktree and its
  `phase:` marker alone, and rely on `--resume`'s existing `resume-session`
  verdict to continue the execute session in place. Declined for this
  round: the soft boundary is the case the user named, and the hard path
  depends on resuming a `claude -p` session killed mid-turn, which the crash
  path exercises but nothing has exercised on purpose. The control channel
  designed here is the same one a hard pause would read; only the reader
  changes.
- **Stopping the orchestrator session itself.** The dashboard spawns it
  detached and `unref()`s it; `stopLaunch` can only signal a child still in
  its `launching` state, and no process records the session's pid
  afterwards. A pause is cooperative by construction.
- **Usage-aware auto-pause, and its threshold.** §9. Nothing in this
  document reads usage, and no threshold exists yet to configure.
- **Auto-resume when the usage window resets.** The watchdog could spawn
  `--resume` at a known `resets_at`; that needs the usage source first.
- **A server write to `run.json`.** The single-writer rule stands. The
  request lives in a file the server owns and the tool reads; the run
  file's `paused` status and `unpausedAt` stamp are written by
  `orchestrate.mjs` from inside the session, like every other field.
- **Pausing a crashed run from the drawer.** The server accepts a pause
  request for any `running` run, fresh or stale — a crashed run's eventual
  watchdog resume then pauses itself at its first boundary — but the drawer
  shows the control for a fresh run only. A crashed run's drawer is the
  fault report, and "stop when you come back" is a second-order case with
  a first-order answer already: Settings → watchdog off.

## 1. Vocabulary

- **Pause request** — the board asking a specific run to stop dispatching.
  A file the server writes (§2). Not a run state: `run.json` never carries
  it, and the tool never writes it.
- **Effective request** — a pause request that this run, right now, must
  honour: pinned to this run's `runId` and made *after* the run last began
  or resumed running (§2.3). Derived from the two files on every read, on
  both sides, never stored.
- **Item boundary** — the moment between one queue item's terminal stage
  and the next item's first stage write. `stage <id> preflight` is that
  first write; `stage <id> dispatched` is the last write before an execute
  session exists. Both are gates (§3.1).
- **pausing** — a `running`, fresh run with an effective request against
  it. The board derives it; the current item is draining.
- **`paused`** — the fifth run status, beside `running`, `done`, `aborted`
  and `failed`. The session ended cleanly at a boundary; pending items are
  still `pending` in the queue; no execute session was started for any of
  them. At most one item may sit at `preflight` with a worktree that holds
  nothing but a pre-flight answer — the dispatch gate's leftover (§6.2).
- **unpause** — the tool command a `--resume` session runs on a `paused`
  run to make it `running` again (§3.3). It stamps `unpausedAt`, which is
  what retires the request that paused it.

## 2. The control file — a second file the server owns

### 2.1 Where, and why there

`~/.backlog-manager/settings/orchestrator-control/<encodeURIComponent(project)>.json`,
one file per project, keyed exactly as `orchestrate.mjs`'s `projectDir`
keys the run-state directory — the same reversible encoding, so a human can
read which project a file belongs to and neither process needs a lookup
table. The directory is overridable with `BM_ORCH_CONTROL_HOME`, for the
reason `BM_ORCH_HOME` exists: a test process must never touch a real
machine's state. Both processes compute the path with their own copy of the
same two-line function, as they already do for `orchHome()`; neither
imports the other.

Under `settings/` rather than beside `run.json`, for a mechanical reason
first: `docker-compose.yml` mounts `~/.backlog-manager` read-only and carves
out `settings/` as the one nested read-write mount, so a control file
anywhere else would be unwritable in the compose stack, and a new directory
would mean a second nested mount for one file. The read-only mount is also
part of what makes the run file's single-writer rule mechanical rather than
polite — the server *cannot* write `run.json` in the stack — and this
design keeps that property intact by never asking for write access to the
orchestrator directory at all.

It changes one sentence that `watchdog-config.util.ts`'s header states as a
fact: "`settings/` is a directory neither `backlog.mjs` nor `orchestrate.mjs`
ever reads." After this design `orchestrate.mjs` reads one subdirectory of
it. The sentence is amended, not quietly left false — see §8.

Writes are atomic (temp file plus rename, the shape `writeRunAtomic` uses)
because the tool may read the file while the server writes it; a cancel
deletes the file. There is no `pauseRequested: false` state on disk — the
absence of a valid file is the absence of a request.

### 2.2 Shape

```json
{ "runId": "run-20260905-101500", "requestedAt": "2026-09-05T10:41:07.211Z" }
```

Nothing else. `runId` pins the request to one run; `requestedAt` orders it
against that run's own timeline. A file missing either field, or holding
anything unparseable, is treated as no request by both readers.

### 2.3 Effective request is derived

A request is **effective** for a run exactly when

    control.runId === run.runId
    && Date.parse(control.requestedAt) > Date.parse(run.unpausedAt ?? run.startedAt)

and both processes evaluate this predicate on every read. The server
annotates the runs payload with it (§4.2); the tool refuses the two gated
stage transitions on it (§3.1). Neither trusts the file's presence alone.

Why derived, and why both halves:

- The server clears the file opportunistically (§4.3), but it cannot be the
  authority on staleness, because a `--resume` typed in a terminal never
  passes through the server. A request that paused run A must not re-pause
  it after a hand-typed resume, and must not pause run B started an hour
  later. `runId` rules out B; `requestedAt > unpausedAt` rules out the
  re-pause; `requestedAt > startedAt` covers a file that somehow predates
  the run it names. Every case is decidable from the two files alone.
- This is the posture `exhausted` took after it was stored once and never
  cleared: a flag whose inputs are re-read every tick is a bug class, not a
  bug. A stored `pauseRequested` boolean would be that class again.
- A request written while a run is `paused` (only possible by hand — the
  route 409s) is inert forever: `unpause` stamps a later `unpausedAt`.

## 3. The tool — `orchestrate.mjs`

### 3.1 Two gates, in `stage`

`stage <id> preflight` and `stage <id> dispatched` refuse when the request
is effective and the call is a genuine **transition** into that stage —
the item's current stage differs from the one requested. A re-stamp of an
item already at that stage stays legal, so a later call that only adds a
field to a dispatched item can never be refused by a request that arrived
after the child was spawned.

The refusal is a new exit code, **`6`**: "a pause was requested for this
run — do not start `<id>`; run `finish --status paused` and end the
session." Nothing is written, like every other refusal. `5` is taken by
`verify`'s "nothing to prove the item with", and main's exit-code contract
(quoted verbatim by `SKILL.md`) gains the new line.

Why these two, and why in the tool:

- `preflight` is the first write of every item, so a request that arrived
  between items — the common case, since review, verify and merge are where
  a run spends most of its wall-clock — is caught before pre-flight spends
  anything: no `plan` re-gate, no question hunt, no worktree.
- `dispatched` is the last write before `claude -p` is spawned, and
  `SKILL.md` §4 already orders it that way ("record the worktree on the
  run", *then* "Dispatch the headless session"). A request that arrived
  during the pre-flight window — including while pre-flight waited on a
  best-effort question — still never starts an execute session. The
  worktree it leaves behind is handled in §6.2.
- Enforcement in the tool, not `SKILL.md`, for the reason the branch-mode
  `merged` refusal gives: the skill re-reads its own body on every one of a
  run's several hundred turns, and prose drifts across them; a refusal on a
  command the loop already calls cannot be forgotten, where a separate
  `pause-check` command could.
- Not `plan`: it is read-only, the board calls it too, and refusing a
  preview would make the launch sheet lie.
- The `--resume` path's "resume onto a leftover worktree" also calls
  `stage <id> dispatched`, and is refused too. Correct: whatever route
  reaches a dispatch during a pause is the route that must stop.

### 3.2 `finish --status paused`

`FINISH_STATUSES` gains `paused`. `finish` itself is unchanged: it sets the
status and stamps `updatedAt`. `init` needs no change either — its lock
check is `status === 'running'`, so a `paused` run is archived into `runs/`
like a `done` one, and the items it never reached are simply open items the
new run's gate finds again. `abort` on a paused run works as today: the only
worktrees it can meet are the ones parked items already keep and, after a
dispatch-gate refusal, one `preflight` item's — unmarked, so abort tears it
down like any other, and the pre-flight answer written into it goes with it.
That is abort's contract, not a new loss: abort ends a run, and a paused run
that is aborted was not going to resume.

### 3.3 `unpause`

A new command: refuses (exit `1`, nothing written) unless `status` is
`paused`; otherwise sets `status: 'running'`, stamps `unpausedAt` and
`updatedAt` to the same instant, prints `{"status":"running","unpausedAt":…}`.
`unpausedAt` is written by this command alone and is absent from a run that
has never been paused — the type is optional (§5), and old run files stay
valid without a migration.

A separate command rather than teaching `heartbeat` to flip the status:
`watch` stamps a heartbeat every 30s without looking at anything, and
`heartbeat` is called from several places in the loop. A state transition
hiding inside an unconditional stamp would let a stray heartbeat resurrect
a paused run.

### 3.4 `status`

The human line gains a suffix when a request is effective —
`pause requested at <requestedAt>` — so a person at a terminal sees what
the next boundary will do. `--json` stays the run file verbatim: the
request is not a run field, and the skill learns of it from the gate, not
from `status`.

## 4. The server

### 4.1 `POST /api/agents/pause`

Body `{ project: string, cancel?: boolean }`. Origin- and content-type-
guarded like every other agents POST; the parametrized route list in
`test/agents-origin-guard.test.ts` gains the route, and it is that list,
not a sentence in CLAUDE.md, that says which routes are guarded.

- `project` missing or empty → 400.
- No run for the project with `status === 'running'` → 409, uncoded, "no
  running run to pause". Fresh or stale both qualify (Non-goals, last
  bullet). A `paused` run cannot be paused again; a finished one has
  nothing to pause.
- Without `cancel`: write the control file for the project, pinned to that
  run's `runId`, `requestedAt` now. Idempotent — a second request rewrites
  the file, which changes nothing about its effectiveness.
- With `cancel`: delete the file if present. Idempotent — cancelling a
  request that does not exist is a 200 with nothing to undo.
- Response: `{ pauseRequested: boolean }`, the effective value after the
  write, computed by the same predicate `runs()` uses.

This is the first agents POST that never calls the dashboard, and it is
deliberately **independent of `BM_AGENTS`**: a pause request is a fact
about a run on disk, not about the dashboard's reachability, and a run
started from a terminal can be paused from the board even with agents off.
It lives under `/api/agents/` anyway, following `watchdog/config` — the
other server-write POST with no outbound call — rather than minting a
guarded route under `/api/orchestrator/`, whose contract is read-only.

### 4.2 What the runs payload gains

Every entry of `GET /api/orchestrator/runs` gains `pauseRequested: boolean`,
beside `fresh` and `pastRuns`: the §2.3 predicate evaluated against the
project's control file on that request, `false` when there is no file, an
unparseable one, or an inert one. `runs()` stays the one reader of the
orchestrator directory and reads nothing else *from it*; the control file is
this process's own, under `settings/`, so reading it here is not a second
reader of the tool's state.

### 4.3 `resume()` widens

`resume()` accepts a run whose status is `paused` in addition to a crashed
`running` one; the 409 text becomes "no crashed or paused run to resume".
The `fresh` 409 is untouched — `fresh` already requires `running`, so a
paused run can never trip it. The spawn body is byte-identical:
`RESUME_PROMPT` is still `/backlog-orchestrate --resume`, and `recovery.md`
is where the two cases part ways (§6.2).

After a successful spawn, `resume()` deletes the project's control file,
best-effort (`ENOENT` is success). This is tidiness, not correctness: the
resumed session's `unpause` retires the request by §2.3 whether or not the
file is gone.

`AgentsController.resume` still calls `noteBoardResume` and `arm()`
afterwards. Both are inert for a paused run — `noteBoardResume` looks up a
`running` run and returns without creating an entry when it finds none;
`arm()` starts nothing when no run file says `running` — and a test pins
the consequence: **a paused run never carries a `watchdog` annotation**.

### 4.4 The watchdog — no change, pinned

`WatchdogService` walks runs whose status is `running` and nothing else, so
a `paused` run is invisible to it by construction: not watched, not
resumed, not counted. Two cases are pinned by tests rather than by this
paragraph:

- a `paused` run file arms nothing and produces no spawn, exactly like
  `done`;
- a crashed run with an effective request is still resumed by the sweeper
  — the request is honoured by the resumed session at its first gate, not
  by the sweeper. The watchdog does not read the control file at all.

## 5. Shared types and the client

### 5.1 Types

`OrchestratorRun.status` gains `'paused'`; `OrchestratorRun` gains
`unpausedAt?: string`. `OrchestratorRunsPayload`'s entries gain
`pauseRequested: boolean`. Every `Record` keyed on the status union gains a
`paused` key — `RUN_STATUS_CLASS` and `RUN_STATUS_GLYPH` in
`lib/run-stage.ts`, `RunsView`'s `STATUS_ORDER`, `run-stats`' `byStatus` —
and `test/run-stage.test.ts`'s `ALL_STATUSES` grows so the compiler, not a
checklist, finds every site. `paused` sorts directly after `running` in
`STATUS_ORDER`: it is the one non-running status that still has a future.

### 5.2 Where each state is visible

Both states are derived, and both are shown wherever the run is shown. The
answer to "do I see it pausing, then paused":

| surface | pausing (`running`, fresh, effective request) | `paused` |
|---|---|---|
| Board · strip | chip: "pausing · finishes `<item>`" | paused strip: "paused · N of M done", **Resume** |
| Board · run drawer | "Pausing after `<item>`" + **Cancel** | meta line reads `paused`, **Resume** (the strip's is the no-click copy) |
| Runs · list row | `pausing` badge beside the `running` status chip | status chip reads `paused`; the row leaves the pinned region |
| Runs · detail pane | "Pausing after `<item>`" + **Cancel** | status chip `paused`, **Resume** |
| Runs · tiles | unchanged | counted as neither completed nor failed |

`<item>` is the in-flight queue entry — the one whose stage is neither
`pending` nor terminal; there is at most one, by the loop's own "one
worktree and one session in flight" rule.

### 5.3 One control set, two surfaces

`Pause`, `Cancel pause` and `Resume run` are one component, rendered by
`RunDrawer` (Board) and `RunDetail` (Runs). It takes the run's payload
entry, the resume gate, and an `onChanged` callback, and decides from the
entry alone which control to show:

- `running` and `fresh`, no effective request → **Pause**, "pause after the
  current item". Click → `POST /api/agents/pause` → `onChanged`.
- `running` and `fresh`, effective request → **"Pausing after `<item>`"**
  with **Cancel** beside it. Click → `cancel: true` → `onChanged`.
- `paused` → **Resume run**. Click → `POST /api/agents/resume` (the same
  call the crashed strip makes) → `onChanged`. Rendered only when the
  resume gate allows; otherwise the gate's reason, as the crashed strip
  does. Once clicked, and for as long as §5.6's mark is live for this
  project, the slot reads **"Resuming…"** with no button — on this
  component and on the paused strip alike — so a second click has nothing
  to land on while the first session is still on its way to `unpause`.
- crashed (`running`, not fresh), `done`, `aborted`, `failed` → nothing.
  A crashed run's resume stays where it is, on the strip, behind
  `watchdogStoodDown` and the coupling test that pins it; this component
  does not take that decision on.

Errors render inline beside the control, the way the crashed strip renders
a resume error. A component shared by two lazily-loaded views lives with
the other cross-view modules (`lib/view-keys.ts` is the precedent), never
inside either view's directory — an import between the views would undo the
chunk split.

The **resume gate** is one function too. `BoardView` today derives
`canResume` and `resumeBlockedReason` from `projectDispatchGate` in three
inline lines beside the strip; those lines move into a named function
beside `projectDispatchGate` in `shared/agent.ts`, and both views call it.
It is the environment half of the gate only — is the dashboard reachable,
can it see this project — and it says nothing about the watchdog, which is
the crashed strip's own concern.

Both views host the component rather than only the drawer because a person
watching a run watches it in the Runs view, where the per-item stage track
and the durations are; sending them back to the Board to pause it would be
the one-click cost paid twice.

### 5.4 The strip — pausing, paused

- **pausing** — a fresh strip with an effective request gains a chip:
  "pausing · finishes `<item>`". Everything else about the fresh strip is
  unchanged, including the polling that keeps it live. The strip itself
  carries no Pause control: its root is one `<button>` that opens the
  drawer, and the drawer is where the control is.
- **paused** — today `!fresh && status !== 'running'` renders nothing; a
  `paused` run now renders a **paused strip** instead: "paused · N of M
  done" with the same body-button-plus-sibling-button layout the crashed
  strip uses, the sibling being **Resume run**. No watchdog clause — the
  watchdog was never involved. The resume gate applies: with agents off
  the paused strip renders without the button and says why, exactly as
  the crashed strip does.

A paused strip leaves when the run is resumed (status `running` again) or
superseded (a new run's `init` archives it, and the payload carries the new
run). It does not age out; a paused run is waiting for a person.

### 5.5 The Runs view

- **Rows.** `RunRow` reads `row.live` — the fresh live entry, present only
  while the run is fresh — and shows a `pausing` badge beside the status
  chip when that entry's `pauseRequested` is true. Rows are `<button>`s
  that select a run; they carry no controls, for the same nested-button
  reason the strip carries none.
- **`paused` reaches the list on its own.** `RunsView` already re-fetches
  the archive listing the moment the set of fresh runs changes; a run
  pausing leaves that set, so the refresh that already covers "a run
  finished" covers "a run paused" too, and the row's status chip reads
  `paused` off the refreshed listing. Nothing new is polled.
- **The pane.** `RunDetail` already re-fetches the run file when its `live`
  prop goes `null` with the same run still selected — the transition a
  pause makes — so the pane's status chip reads `paused` from the freshest
  possible source. `RunDetail` hosts the shared control set in its head,
  beside the status chip. `RunsView` gains `useAgents()` for the resume
  gate, the same hook `BoardView` already holds; only one of the two views
  is mounted at a time, so this is not a second poll.
- `pickAuthority` and its three tiers are untouched.

### 5.6 Polling after a resume

A crashed run is `running`, so `useOrchestratorRuns` is already polling
when its Resume is clicked and simply keeps going. A `paused` run is
neither fresh nor `running`, so nothing polls it — and the resumed session
needs anywhere from a few seconds to about ninety (the measured time to a
first heartbeat) before `unpause` flips the file to `running`. Without
help, a Resume click would leave both surfaces reading `paused` until a
window focus.

`useOrchestratorRuns` therefore gains `noteResume(project)`: a transient,
in-memory mark that keeps the interval alive for that project for up to
`RESUME_POLL_GRACE_MS` (three minutes — the watchdog's own worst-case
first-heartbeat reasoning, rounded) or until the run reads `running`,
whichever is first. Both surfaces call it from the Resume click, through
`onChanged`, and both read it back to show "Resuming…" in place of the
button (§5.3). It is the one new client rule; it is derived from a click
and a clock, never stored, and it expires on its own so a resume that never
starts cannot leave a tab polling forever — or a button hidden forever.

### 5.7 Everything else

- `RunsView`/`RunDetail` print `paused` through the status chip like any
  status; `aggregateRuns` counts it as neither completed nor failed.
  `runIsLive` and `itemDurationMs` are untouched: a paused run is not live,
  and queue wait is still not work.
- `runHoldsItem` and `runClaimBlock` are untouched. Both key on `fresh`, so
  a paused run's pending items are neither held on the Board nor
  claim-blocked — they can be hand-dispatched or groomed meanwhile, and a
  later resume's `plan --ids` re-gate skips one that moved ("unknown item
  id" → `skipped`), which `SKILL.md` §3 already prescribes.
- `useOrchestratorRuns`' `anyLive` rule is untouched: `anyLive` already
  covers pausing (the run is fresh), and a paused run needs no poll until a
  resume is clicked (§5.6).
- `lib/agents.ts` gains `pauseOrchestrate(project)` and
  `cancelPauseOrchestrate(project)`, both over the one route;
  `resumeOrchestrate` is reused as is.

## 6. The skill side — publish required

### 6.1 `SKILL.md`

- §3, after `stage <id> preflight`: exit `6` → the run is pausing. Do not
  pre-flight the item; go to §10's new "Pausing" step.
- §4, after `stage <id> dispatched`: exit `6` → the same, and **leave the
  worktree and branch exactly as they are**. The worktree may carry a
  pre-flight answer written into its copy of the item file; nothing else
  has happened in it. The item's stage stays `preflight`.
- §10 gains "Pausing": `finish --status paused`, then summarise as a
  finished run would — what merged or branched, what parked and why — plus
  the pending items by name and the sentence that the run resumes from the
  board's Resume control (or `/backlog-orchestrate --resume` in a
  terminal). `--status`'s documented list gains `paused`, and the quoted
  exit-code contract gains `6`.

### 6.2 `references/recovery.md`

- `--resume` opens with `status`, as now. Three outcomes instead of two:
  `running` → `heartbeat`, unchanged; **`paused` → `unpause`**, then
  continue exactly as the running path does (reconcile, then the loop);
  anything else → refuse, unchanged. `unpause` is what makes the request
  that paused this run inert, so the resumed loop's first `preflight` is
  not refused by it.
- `reconcile`'s `inspect` verdict on an item whose **stage is `preflight`**,
  worktree present, no marker, is the dispatch gate's leftover: re-enter §4
  at "record the worktree on the run" — `stage <id> dispatched` onto the
  existing worktree and branch — and dispatch. Not a leftover to ask a
  human about, and not a worktree to unwind: the pre-flight answer in it is
  the reason it was kept.

Both are `skills/` edits and change nothing until committed, pushed and
`pnpm run plugin:sync` has run. The `.mjs` changes ship the same way.

## 7. Testing

Test *cases*, not code — the implementer owns the shape. Jest, flat in
`test/`; the tool's cases in `skills/backlog-orchestrate/tools/*.test.mjs`
under node's runner, against a temp `BM_ORCH_HOME` and a temp
`BM_ORCH_CONTROL_HOME`.

**Tool**

- effective request; `stage <id> preflight` from `pending` → exit 6,
  `run.json` byte-identical; same for `stage <id> dispatched` from
  `preflight`.
- effective request; `stage <id> dispatched` on an item already
  `dispatched` (a re-stamp) → exit 0, fields applied.
- effective request; every other stage transition → unaffected.
- request pinned to another `runId` → not effective; `requestedAt` earlier
  than `startedAt` → not effective; `requestedAt` earlier than `unpausedAt`
  → not effective; missing file, unparseable file, file missing a field →
  not effective. In every case `preflight` proceeds.
- `finish --status paused` → status `paused`, `updatedAt` moved; `init`
  afterwards archives it under `runs/` and starts a new run.
- `unpause` on `paused` → `running`, `unpausedAt === updatedAt`, printed
  line as specified; on `running`/`done`/`aborted`/`failed` → exit 1,
  nothing written.
- `status` prints the suffix when effective and not otherwise; `--json`
  carries no `pauseRequested` key.
- main's exit-code table names `6` and no other command returns it.

**Server**

- `POST /api/agents/pause` joins the origin-guard parametrized list.
- 400 on missing project; 409 on no run, on `paused`, on `done`; 200 for a
  fresh `running` run and for a stale one, file written with the run's
  `runId`, response `pauseRequested: true`.
- `cancel` deletes the file → `pauseRequested: false`; cancel with no file
  → 200, `false`.
- `runs()` annotates `pauseRequested` true only for an effective request,
  false for an inert file (other runId, earlier than `unpausedAt`).
- `resume()` accepts a `paused` run and posts the unchanged
  `RESUME_PROMPT`; still 409s on a fresh `running` run with
  `RUN_IN_PROGRESS_CODE`; deletes the control file after a successful spawn
  and tolerates its absence.
- a `paused` run's payload entry carries no `watchdog` key after a board
  resume.
- sweeper: a `paused` run file → no timer, no spawn; a crashed run with an
  effective request → spawned exactly as without one.

**Client**

- `ALL_STATUSES` includes `paused`; each status record compiles and renders
  a chip.
- the shared control set, driven by one table of payload entries: fresh
  `running` without request → Pause, click posts `{ project }` and calls
  `onChanged`; fresh `running` with request → "Pausing after `<item>`" +
  Cancel, click posts `{ project, cancel: true }`; `paused` with the gate
  open → Resume, click posts to `/api/agents/resume`; `paused` with the
  gate closed → the reason, no button; crashed, `done`, `aborted`, `failed`
  → renders nothing.
- the resume gate: one function; `BoardView` and `RunsView` both read it;
  hidden / disabled / enabled map to the same three answers
  `projectDispatchGate` gives.
- drawer and pane each render the control set for the selected run and
  reload after `onChanged`.
- strip: fresh + `pauseRequested` → pausing chip; `paused` → paused strip
  with Resume when the gate is open, the reason otherwise; `done` still
  renders nothing.
- `RunsView`: a fresh row with `pauseRequested` carries the `pausing`
  badge; a paused run's row is not pinned and keeps its place in the
  day's `startedAt` order (rows never sort by status); the tiles' by-status
  breakdown lists `paused` between `running` and `done`.
- `noteResume`: after the mark, the interval runs with nothing fresh or
  running; it stops when the run reads `running` (the ordinary rule takes
  over) and stops on its own at `RESUME_POLL_GRACE_MS` when nothing
  changes; a second mark restarts the clock; an unmarked idle board still
  installs no interval.

## 8. Decisions taken, and what they cost

- **Soft pause only.** The in-flight item drains through review, verify and
  merge — potentially its most expensive stages. A pause pressed at 95% of
  the window can still cross it. The hard pause that would prevent that is
  the one thing the design leaves room for (Non-goals, first bullet).
- **The tool reads a server-owned file.** Until now every cross-process
  file flowed one way — a skill tool writes, the server reads. This adds
  the other direction for one small file, with a second test override
  (`BM_ORCH_CONTROL_HOME`) and an amended sentence in
  `watchdog-config.util.ts`. Accepted over the alternatives: a run field the
  server would have to write (a second writer of `run.json`, the one thing
  the whole run-file design forbids) or a prompt flag (a pause is decided
  mid-run; a prompt is fixed at spawn).
- **Effectiveness is derived on both sides.** Two copies of a two-line
  predicate, pinned by tests on each side. The alternative — a stored flag
  the server clears — was the `exhausted` bug in a new coat.
- **Exit code `6`.** The contract table grows by a line and `SKILL.md`'s
  quotation follows. A reused `1` would make the skill read "bad args" on
  the one refusal it must act on differently.
- **`unpause` is its own command.** One more verb to document; in exchange
  `heartbeat` stays a pure stamp that can never change a status.
- **Controls in the drawer and the pane, not on the strip or the rows.**
  One click further than a strip button on the Board; nothing further in
  the Runs view, where the pane is already open. The fresh strip stays a
  single button; the paused strip reuses the crashed strip's two-button
  layout rather than a third one. Cost: a shared component two lazy chunks
  import, and a resume gate hoisted out of `BoardView` into `shared/agent.ts`
  — one more function to keep single.
- **The crashed run's Resume stays on the strip alone.** The pane could
  offer it behind the same `watchdogStoodDown` function, and the coupling
  table would then drive three surfaces instead of two. Declined for this
  round: it is not part of pausing, and widening the coupling test is its
  own change.
- **Three minutes of polling after a Resume click.** A resume that never
  starts (the dashboard took the spawn and the session died before its
  first command) costs a tab up to 36 requests it would not otherwise
  make. Accepted: the alternative is a paused strip that stays paused
  after a successful resume until someone refocuses the window, which
  reads as the click having done nothing.
- **Double-resume is guarded in the client, not the server.** `resume()`
  refuses a *fresh* run, and a resumed run is not fresh until its session
  stamps the file — up to ninety seconds in which a second Resume from
  another tab would spawn a second `--resume` into the same `run.json`.
  The "Resuming…" state closes the one-tab case; the two-tab case is the
  same exposure the crashed strip already has today, and a server-side
  lock would mean the server remembering something about a run between
  requests, which the watchdog's in-memory grace already is for crashed
  runs and would have to grow to cover paused ones. Left as is, named
  here so the growth is a decision when it comes and not a surprise.
- **Pause is independent of `BM_AGENTS`.** A control visible while dispatch
  controls are hidden — an asymmetry to explain once. Earned by the case it
  covers: a terminal-started run can be paused from a board whose agents
  are off, and resumed by hand.
- **`init` archives a paused run like a finished one.** A paused run
  someone forgot is superseded without ceremony when the next run starts.
  Nothing is lost — its pending items are open items the new gate finds —
  but the paused run's identity ends there, and its resume is no longer
  offered. Accepted: the alternative, refusing `init` on `paused`, would
  make "start a new run" fail because of a run nobody remembers.
- **Idempotent request and cancel.** A double click cannot 409 a person out
  of the control they were reaching for.

## 9. Filed separately — usage-aware auto-pause

The second half of the ask goes to the backlog as an idea, not a spec,
because it depends on a source this repo does not have yet. What is known:
`../claude-agents-dashboard` already fetches the account's 5-hour and
weekly utilization live (`server/lib/usage.ts`, over the CLI's OAuth token,
cached and exposed in its API payload) and keeps a history
(`.usage-history.jsonl`, `.usage-profile.json` at its repo root). Because
the pause request designed here is a file the server writes, an auto-pause
is a **server-only** trigger: a sweeper — the watchdog is the template —
reads the dashboard's usage, compares it to a configurable floor, and
writes the request. No tool change, no skill change, no second control
channel. Open questions the idea carries: where the floor lives (a
`settings/` file the server owns, like the watchdog's), whether the
dashboard's endpoint is stable enough to build on, and whether a resume
should be scheduled at the window's reset time once it is known.
