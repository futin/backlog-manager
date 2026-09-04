# Orchestrator watchdog — design

A server-side sweeper that notices when an orchestrator run has stopped
heartbeating, spawns `/backlog-orchestrate --resume` for it through the same
board → API → dashboard path a click uses, gives up after a bounded number
of tries, and shows every step of that on the board. Nothing here writes the
run file; nothing here changes what `--resume` does.

## Why this exists

On 2026-09-03, `run-20260903-112622` (backlog-manager, four bugs) died at its
last item and nobody knew for four hours.

| time (UTC) | what happened |
|---|---|
| 14:55 | bug-15 enters `reviewing`; the orchestrator dispatches the reviewer subagent |
| 15:02 | the subagent dies: `API Error: 529 Overloaded` |
| 15:02:41 | the orchestrator schedules `sleep 120` with `run_in_background: true`, prints a status table, ends its turn |
| 15:02:46 | the headless `claude -p` process exits — a print-mode session terminates background Bash a few seconds after its final result. `run.json` stays `status: "running"`, `updatedAt` frozen at 14:58:51 |
| 15:13 | the run crosses `RUN_STALE_MS`. `RunStrip` renders nothing for a stale run, so the board's only window onto the run **disappears** |
| 18:57 | the user types `/backlog-orchestrate --resume` in a terminal. `reconcile` → `inspect` → re-enter at Review; verdict in 4 minutes; bug-15 merged 19:31 |

Three facts the design rests on:

1. **Every existing piece worked.** Staleness was detected on time (the
   drawer would have shown a fault report — if anyone could have opened it),
   `reconcile` read the disk correctly, `--resume` finished the item in 35
   minutes of machine time. The only missing part was a *trigger*.
2. **The board hid the evidence.** `RunStrip.tsx`'s rule — a stale run
   renders nothing, because the strip cannot know how far the run really got
   — is right about the *stage* and wrong about the *fact*. "This run has not
   reported for 4h" is a fact the board could have stated.
3. **This was not a hang, and the fix must not assume one.** The process
   quit on its own believing it was waiting. A watchdog keyed on the
   heartbeat catches that case and a `kill -9`, a machine sleep, and a
   crashed session equally, because it never asks *why* the heartbeat
   stopped.

The user's ask, verbatim: "a self-recovery mechanism that verifies every N
minutes if any orchestrator is still running … monitors all orchestrators
and makes sure that nothing is blocked." Decisions taken with them before
this document (see §9 for the costs): auto-resume, capped; lives in the
board's server; visible in the UI; armed only while something is running;
knobs editable in Settings with server-enforced floors.

## Non-goals

- **Preventing the session from quitting.** A plugin `Stop` hook could refuse
  to let an orchestrator session end its turn while its run is `running`, and
  a SKILL.md rule could ban `run_in_background` inside the orchestrator. Both
  were offered and **declined for this round**: the sweep covers the outcome,
  at the cost of up to `RUN_STALE_MS` + one tick of dead time per crash. The
  incident's exact mechanism is therefore still possible; it is now bounded
  instead of prevented.
- **Fresh-but-wedged runs.** A run whose `watch` loop keeps heartbeating
  while its child makes no progress is invisible to this design. Detecting it
  needs per-stage timeouts, and every number would be a guess (bug-15's
  execute stage legitimately took 1h34m). The Runs view already prints time
  per stage; a human can read it.
- **Push notifications.** The dashboard's `POST /api/notify/event` accepts
  exactly `question | stop | permission | plan` and requires a session id.
  A "run crashed" push is a dashboard change, not a board change.
- **A durable per-run record of "auto-resumed".** That would be a write to
  `run.json`, which only `orchestrate.mjs` may make, from inside the resumed
  session. Cheap to add later as a flag on `--resume`; not needed to ship.
- **Making `RUN_STALE_MS` configurable.** It is the one freshness number,
  shared by the client, the server and `orchestrate.mjs init`'s own wording.
- The pending merge-mode design (`2026-09-04-orchestrator-merge-mode-design.md`)
  is independent. A `branched` item stage is terminal like `merged`; a run
  still ends `done`; nothing here reads item stages except to print one.

## 1. Vocabulary

- **Crashed run** — a run file with `status: "running"` whose `updatedAt` is
  at least `RUN_STALE_MS` old. Exactly the server's existing
  `fresh === false && status === 'running'`; no second threshold.
- **Armed / idle / off** — the watchdog's three phases. *Armed*: a tick is
  scheduled because at least one run file says `running` (fresh or crashed —
  a crashed run is still `running`). *Idle*: no run file says `running`; no
  timer exists. *Off*: `BM_AGENTS` is off — nothing on this server can
  spawn, so there is nothing to watch for, and no timer ever exists — or
  `BM_WATCHDOG=off` is set, the operator's kill switch (§5.1).
- **Disabled** — the Settings toggle (§5) is off. Orthogonal to the phase:
  a disabled watchdog still arms, ticks and reports the crashed run it
  *would* have resumed; it only never spawns. Watching is cheap and is what
  makes the "off — resume by hand" clause on the strip (§6.1) true rather
  than a guess.
- **Attempt** — a resume spawn that returned a session id. Only these count
  against the cap.
- **Grace** — the interval after any spawn *attempt or failure* during which
  the run is left alone. A resumed session takes roughly ninety seconds to
  reach its first `heartbeat` (measured on the incident's own resume:
  spawned 18:57:44, heartbeat 18:59:11); grace is what stops a second spawn
  landing in that window.

## 2. The sweeper — `server/src/agents/watchdog.service.ts`

Lives in `agents/` because it is outbound-calling, and `agents/` is the one
module allowed to be. Injects `AgentsService` (for `resume()`, §3),
`OrchestratorService` (for `runs()`) and `WatchdogStateService` (§4).

### 2.1 Arming

No standing interval. The sweeper is a `setTimeout` chain that exists only
while armed:

- **Arms on**: one `runs()` read at `onApplicationBootstrap`; every
  `GET /api/orchestrator/runs` whose payload contains a `running` run (the
  read the board already makes on mount, focus and its 5s poll); a
  successful `orchestrate()` or `resume()` spawn. `arm()` is idempotent — a
  no-op while already armed, and a no-op while *off*.
- **While armed**: one tick, then schedule the next `tickMs` later, *after*
  the current tick's awaits complete. A chain, not `setInterval`, so two
  ticks can never overlap by construction. The timer is `unref()`'d.
- **Disarms** when a tick finds no `running` run: the timer is cleared and
  the phase reads *idle*. A run that finishes normally therefore costs one
  extra tick, not a lifetime of them.

The stated gap: a run started by typing the trigger in a terminal while the
board stays closed for its entire life never arms the sweeper. CLAUDE.md
already says to start runs from the board; this is one more reason.

### 2.2 One tick

Read the config fresh (§5), read `runs()`, then for every run with
`status === 'running'`:

1. **Fresh** → if this run has a state entry with `attempts > 0` and no
   `recovered` mark, log `recovered` ("run fresh again — standing down") and
   mark it. Nothing else.
2. **Crashed, watchdog off** → log `disabled` once per run ("watchdog off —
   resume by hand"). Nothing else.
3. **Crashed, `attempts >= maxAttempts`** → set `exhausted`, log `exhausted`
   once. Nothing else.
4. **Crashed, inside grace** (`now - lastSpawnAt < graceMs`) → nothing.
5. **Crashed, otherwise** → `agents.resume(project, 'watchdog')`.
   - Returned a session id → `attempts += 1`, `lastSpawnAt = now`,
     `lastSessionId`, `lastError = null`; log `spawned`
     ("spawned resume 1/2 → session ce0c…").
   - Threw → `lastError = message`, `lastSpawnAt = now` (so grace backs the
     next try off), attempts unchanged; log `failed`
     ("resume failed: the dashboard cannot see this project (not counted)").

One rule covers both outcomes: **any spawn attempt starts the grace clock;
only a success counts against the cap.** A dashboard that is down for a day
must not burn the cap, and a spawn that failed must not be retried every
tick.

Entries are keyed by `runId` and pruned when that `runId` is no longer
`running` in `runs()` — the next `init` archives the file and the id
vanishes; a normal finish flips `status` to `done`. State is **in-memory
only**: a server restart forgets every attempt, so a crashed run can receive
at most `maxAttempts` more spawns after a restart. Deliberate — see §9.

### 2.3 Where each tick's cost lands

Armed and healthy: read a handful of small JSON files. Only a crashed run
triggers `status()` (dashboard health + management) and a spawn. The
dashboard is never probed by an idle or healthy watchdog.

## 3. `resume()` — one method, two callers

`AgentsService.resume(project: string, origin: 'watchdog' | 'board')`
mirrors `orchestrate()` step for step and shares its gate code rather than
copying it (the `environmentBlock` incident in that file is the reason):

1. `status()`; `!enabled` → 404, as `orchestrate()` does.
2. `projectDispatchGate(status, project)`; `hidden` → 502 when unreachable
   else 409; `disabled` → 409. Same strings, same statuses.
3. The run: `orchestrator.runs().runs.find(r => r.project === project)`.
   - none, or `status !== 'running'` → 409 `{ error: 'no crashed run to resume for this project' }`, uncoded.
   - `fresh` → 409 `{ error: 'run <runId> is alive (last heartbeat <updatedAt>) — nothing to resume', code: RUN_IN_PROGRESS_CODE }`.
     The code is reused on purpose: it means "a run is in progress" in both
     endpoints, and the strip's Resume button treats it as "refresh, the run
     recovered" exactly as `OrchestrateSheet` treats it as "close, hand the
     screen to the strip".
4. `projectMap` lookup; missing → 409 "the dashboard cannot see this
   project", the same TTL-race guard as `orchestrate()`.
5. Spawn with prompt **`RESUME_PROMPT = '/backlog-orchestrate --resume'`** —
   a constant composed server-side. The request body of the route below has
   no field that reaches this string. `permissionMode` is `'auto'` clamped
   to `spawnMaxPermission`; no `model`/`effort`; `remoteControl` omitted.
   Session name: `watchdog resume <project>` for `origin: 'watchdog'`,
   `resume <project>` for `'board'` — the dashboard's session list is the
   one durable trail this design leaves, so the name carries who asked.
   The separator is a plain space, not `·` (U+00B7): the dashboard's own
   `NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/` does not admit that
   character, and a name that fails it is not rejected but silently
   dropped to `undefined` — the exact failure mode `orchestrateSessionName`
   was already rewritten once to fix, for `:` and `/`, so this design does
   not reintroduce the same silent drop under a different character.

Callers: the sweeper (§2.2 step 5) and **`POST /api/agents/resume`**, body
`{ project }` only, `project` trimmed and required (400 when empty), guarded
by `SameOriginPostGuard` like every other agents POST. That guard's
CLAUDE.md line changes from "the two agents POSTs" to "every agents POST" —
this design adds two (`resume`, `watchdog/config`).

## 4. Watchdog state — `server/src/orchestrator/watchdog-state.service.ts`

An in-memory provider **in `orchestrator/`**, exported alongside
`OrchestratorService`. It holds data and answers reads; it never spawns.
Placement is about dependency direction: `agents/` already imports
`orchestrator/`, and `runs()` has to annotate its payload from this state,
so the state lives with the reader and the sweeper writes into it. No
module cycle, no interceptor, no new polling endpoint for the strip.

Holds:

- `phase: 'off' | 'idle' | 'armed'` plus `reason` when off (`'BM_WATCHDOG
  off'` or `'BM_AGENTS off'`, the env kill switch checked first — the
  Settings toggle is reported through `config.enabled`, not the phase), and
  `nextTickAt: string | null`.
- `entries: Map<runId, { project, attempts, lastSpawnAt, lastSessionId, lastError, exhausted, recovered }>`.
- `events`: a ring buffer of the last **50** `WatchdogEvent`s, newest first:
  `{ at, project, runId, kind, detail }` with
  `kind: 'armed' | 'idle' | 'spawned' | 'failed' | 'exhausted' | 'recovered' | 'disabled'`.
- `observe(payload)`: called by `OrchestratorController.runs()` after the
  payload is built; if any run is `running` it invokes the armer the sweeper
  registered at bootstrap. `OrchestratorService.runs()` itself stays pure.

### 4.1 What the runs payload gains

`OrchestratorRunsPayload.runs[n].watchdog?: RunWatchdog`, present **only**
when `status === 'running' && !fresh` — the one state in which it means
anything:

```ts
interface RunWatchdog {
  enabled: boolean;        // Settings toggle on AND BM_AGENTS on
  attempts: number;
  maxAttempts: number;
  lastSpawnAt: string | null;
  lastSessionId: string | null;
  lastError: string | null;
  exhausted: boolean;
}
```

A crashed run the sweeper has never touched still carries the field
(`attempts: 0`), so the strip can say "watchdog: waiting for next check"
instead of guessing.

### 4.2 `GET /api/agents/watchdog`

```ts
interface WatchdogStatus {
  phase: 'off' | 'idle' | 'armed';
  reason?: string;
  nextTickAt: string | null;
  config: WatchdogConfig;      // effective, post-clamp
  watching: string[];          // runIds currently `running`
  events: WatchdogEvent[];     // newest first, ≤ 50
}
```

Served by `AgentsController`, read-only, no guard (a GET, like `status`).

## 5. Configuration — a file the server owns

### 5.1 Why not `localStorage`, and why not env alone

Every setting the board has today is per-device `localStorage`, clamped by
`clampSettings`. The sweeper runs with no browser open; it cannot read that.
Env vars would work and add no writer, but changing one means editing `.env`
and restarting the API container, and the user asked for Settings. So:

**`~/.backlog-manager/settings/watchdog.json`**, overridable by
`BM_WATCHDOG_FILE` (the `BM_REGISTRY_FILE` pattern). The API server is its
only writer, and it is the first file the server has ever written. Read
fresh on every tick and every GET — the same no-cache posture as the
registry. Written atomically (tmp + rename) on `POST`.

One env var sits beside the file, and it is not a duplicate of the toggle:
**`BM_WATCHDOG=off`** disables the watchdog entirely — phase `off`, no
timer, no reads. The toggle is the *user's* switch and disables spawning
while watching continues (§1); the env var is the *operator's* switch and
stops the process doing anything at all. It exists for one concrete reason:
the sweeper's bootstrap scan reads `orchHome()`, which in any jest suite
that leaves `BM_ORCH_HOME` unset is the developer's real orchestrator
directory, and a crashed run sitting there would make a stubbed `fetch` see
a spawn nobody's assertions expect. The test setup sets it globally; the
watchdog's own suites unset it after pointing `BM_ORCH_HOME` at a temp dir.

`docker-compose.yml` mounts `${HOME}/.backlog-manager` read-only and must
keep doing so; it gains one nested read-write mount,
`${HOME}/.backlog-manager/settings`, with the comment on the read-only mount
amended to name the exception. A directory, not a file: bind-mounting a file
that does not exist yet makes Docker create a *directory* of that name.

### 5.2 Shape and clamps

```ts
interface WatchdogConfig {
  enabled: boolean;      // default true
  tickMs: number;        // default 60_000   floor 30_000   ceiling 600_000
  graceMs: number;       // default 600_000  floor 300_000  ceiling 3_600_000
  maxAttempts: number;   // default 2        floor 1        ceiling 5
}
```

`WATCHDOG_LIMITS` in `shared/types.ts` carries the three `{ min, max,
default }` triples; both the server clamp and the Settings controls read
them. Rules:

- Missing, unreadable or non-object file → all defaults. Same degrade shape
  as an unreadable `run.json`: a warning, never a 500.
- Each numeric field: not a finite number → default; otherwise clamped to
  `[min, max]`, **nearest bound**, not default. This is the opposite of
  `staleDays`' fallback-to-default, and for the opposite reason: a
  `staleDays` of 0 would empty three columns, whereas a `graceMs` below its
  floor is merely too eager — the floor is a safe value to land on.
- `enabled`: anything but literal `false` reads as `true`.
- The grace floor is five minutes because the measured time-to-heartbeat is
  ninety seconds *on a good day*; the incident itself was an overload event,
  and a resume spawned into the same overload can take several minutes to
  run its first command.

### 5.3 `POST /api/agents/watchdog/config`

Body: `Partial<WatchdogConfig>`. The controller rebuilds it field by field
(the same rule dispatch follows), the service merges it over the current
file contents, clamps, writes, then calls `arm()` — flipping the toggle on
while a run is crashed must act on the next tick, not the next board poll.
Returns the full `WatchdogStatus` so the Settings group redraws from one
response. Guarded by `SameOriginPostGuard`. A malformed body (not an object)
is 400; an unknown key is dropped, not rejected, matching `model`/`effort`.

## 6. Surfacing

### 6.1 The strip — crashed, not silent

`RunStrip` currently returns `null` for any `!fresh` run. New rule:

- `fresh` → unchanged.
- `!fresh && status === 'running'` → **crashed** rendering.
- `!fresh && status !== 'running'` → `null`, as today.

The crashed strip states only facts the payload carries and nothing it
would have to guess:

> **backlog-manager · crashed** — no heartbeat for 4h · last reported bug-15 at reviewing · watchdog: attempt 1/2 spawned 15:14

with the watchdog clause taking one of: `waiting for next check` (`attempts:
0`, no error), `attempt n/max spawned hh:mm`, `resume failed: <lastError>`,
`exhausted after n — resume by hand`, `off — resume by hand`. "Last
reported" is the honest phrasing for the stage: the strip's old doc comment
was right that it cannot know whether the run moved on, so it says where the
run *said* it was, not where it *is*.

A **Resume** button renders on the crashed strip only when `watchdog.exhausted`
or `!watchdog.enabled` — while the watchdog is still trying, a second spawn
is what grace exists to prevent, and a button would invite it — **and** only
when the board's own Orchestrate control is rendered for that project: the
same `projectDispatchGate` verdict, passed down from `BoardView`, because an
environment-level block hides a dispatch control rather than disabling it
(CLAUDE.md), and with `BM_AGENTS` off the route behind this button is a 404.
The text clause still renders in that case; only the control is withheld.
It posts to
`/api/agents/resume`, then `refreshRuns()`. A 409 with `RUN_IN_PROGRESS_CODE`
is treated as success (the run recovered under the click); any other error
renders inline on the strip. The click does not propagate to `onOpen`.

Clicking elsewhere on the strip opens `RunDrawer` exactly as today — the
drawer already leads with a fault report for a stale run
(`staleMinutes`, RunDrawer.tsx); it was only unreachable because the strip
that opens it had vanished.

`RunStrip`'s doc comment is rewritten. The reasoning that a stale strip
"would be presenting a guess as a fact" survives as the reason the stage is
prefixed with "last reported"; the conclusion that the strip must vanish is
replaced, and the incident is named as the reason.

### 6.2 What does not change

`BoardView`'s `freshRuns` filter, the badge map, ItemCard's run bars and
`runClaimBlock` all stay freshness-based. Their doc comments already argue
that a crashed run must not keep cards dead; this design agrees and does not
touch them.

### 6.3 Polling

`useOrchestratorRuns` polls while `runs.some(r => r.fresh)`. It becomes
`runs.some(r => r.fresh || r.status === 'running')`. Without this the crashed
strip is a screenshot: the attempt counter, the error text and the moment
the run goes fresh again would all wait for a window focus.

### 6.4 Settings — "Orchestrator watchdog · this server"

A new `SettingsGroup` below "Claude Agents · this machine", fed by a
`useWatchdog` hook (`GET /api/agents/watchdog` on mount and focus, plus a 5s
poll while `phase === 'armed'` so "next check in 42s" moves). Title says
*this server*, deliberately, against the neighbouring group's *this machine*
and *this device*: the hint states that these values live on the API host
and are shared by every device that opens this board.

Rows:

- **State** — `off — BM_AGENTS off` / `off — BM_WATCHDOG off` / `idle — no
  running run` / `armed — watching run-…112622, next check in 42s`, with
  `· resume disabled` appended to either of the last two while the toggle
  below is off.
- **Enabled** — a checkbox bound to `config.enabled`.
- **Check every** / **Leave a resumed run alone for** / **Give up after** —
  `<select>`s over fixed ladders (`30s 1m 2m 5m 10m`; `5m 10m 20m 30m 60m`;
  `1 2 3 4 5`), each ladder inside `WATCHDOG_LIMITS`, so the UI cannot even
  offer a value the server would clamp. Free-text inputs were rejected: a
  clamp the user cannot see is a setting that silently does not stick.
- **Activity** — the event list, newest first, `hh:mm · project · text`,
  empty state "nothing since the server started". This is the answer to
  "where do I see that it ran, and what went wrong".

Every save posts the one changed field and redraws from the response. Rows
are not gated on `phase`; a knob is worth setting while nothing is running.

## 7. The skill side — two edits, publish required

`skills/backlog-orchestrate/references/recovery.md`, `--resume`: after
`status` confirms the run is `running`, run `heartbeat` **before**
`reconcile` and before any inspection. Two reasons, both new with this
design: the board's watchdog stands down the instant the run reads fresh,
so an early heartbeat is what turns the crashed strip back into a live one
and cancels any second spawn grace alone would only delay; and it shrinks
the human-versus-watchdog double-resume window from ~90s to a few seconds.
`heartbeat` on a run that is not `running` is not what this step does —
`status` runs first precisely so a finished run is never re-stamped.

`SKILL.md` §10 gains one sentence: the board may spawn `--resume` on its
own for a run whose heartbeat has gone stale, so this path is entered
unattended and must stay safe to enter that way — which it is, everything
before `reconcile`'s verdicts being read-only.

Both are `skills/` edits: they change nothing until committed, pushed and
`pnpm run plugin:sync` has run. No `.mjs` changes, so the skill test suite
is untouched.

## 8. Testing

Test *cases*, not code — the implementer owns the shape. Jest, flat in
`test/`, the existing `stubDashboard` pattern for anything that spawns.

**Sweeper** (`test/watchdog-sweep.test.ts`, fake timers, `orchHome` pointed
at a temp dir with hand-written `run.json`s):

- crashed run, defaults → exactly one `/api/spawn` POST; its prompt is the
  literal `/backlog-orchestrate --resume`; `permissionMode` is `auto`
  clamped to the stub's ceiling; the entry reads `attempts: 1`.
- fresh run → no POST. `done` / `aborted` / `failed` run → no POST.
- second tick inside grace → no second POST; tick after grace → second POST,
  `attempts: 2`; third eligible tick → no POST, `exhausted: true`, one
  `exhausted` event.
- spawn returns 429 → no attempt counted, `lastError` set, next tick inside
  grace does not retry, tick after grace does.
- dashboard unreachable → same as above, `lastError` names the gate reason.
- `BM_AGENTS` off → phase `off`, reason `BM_AGENTS off`, no timer scheduled,
  no POST, no health probe made at all.
- `BM_WATCHDOG=off` → phase `off`, reason `BM_WATCHDOG off`, `arm()` a no-op.
- `enabled: false` in the file, crashed run → phase stays `armed`, no POST,
  no health probe, exactly one `disabled` event for that run across several
  ticks; `runs()` still annotates it with `enabled: false`.
- run goes fresh after a spawn → one `recovered` event; entry pruned once
  `status` is `done`.
- no `running` run → timer cleared (phase `idle`); a later `observe()` with a
  running run re-arms; `arm()` twice schedules one timer.
- a tick whose spawn is still pending when its interval elapses schedules no
  overlapping tick.
- config file changed between ticks → the next tick uses the new `graceMs`.

**`resume` route** (`test/agents-resume.test.ts`, supertest against
`AppModule`):

- empty `project` → 400. `BM_AGENTS` off → 404. no run / run `done` → 409
  without `code`. run fresh → 409 with `RUN_IN_PROGRESS_CODE`. project not
  in `projectPaths` → 409. crashed run → 200 `{ sessionId }`, one POST with
  the exact prompt and a `name` starting `resume ` (plain space — see §3).
  Cross-origin POST → the guard's rejection.

**Config** (`test/watchdog-config.test.ts`):

- missing file → defaults. each field below floor → floor; above ceiling →
  ceiling; non-numeric → default. `enabled: "no"` → `true`; `false` → `false`.
- `POST` with `{ graceMs: 1 }` → file holds `300000`, response `config.graceMs`
  is `300000`. unknown key dropped. non-object body → 400. `BM_WATCHDOG_FILE`
  honoured. write is atomic (no partial file observable — assert via a
  rename spy or by reading mid-write).

**Payload** (`test/orchestrator-runs.test.ts`, extend): `watchdog` present
only on crashed runs; absent on fresh and on finished ones.

**Strip** (`test/orchestrator-strip.test.tsx`): replace "renders no strip
for a stale run" with: stale + `running` renders `crashed`, the heartbeat
age, `last reported <id> at <stage>`, and the watchdog clause for each of
the five states; stale + `done` renders nothing; Resume button present only
for `exhausted` and `!enabled`; clicking it posts and does not call
`onOpen`; a 409 with `RUN_IN_PROGRESS_CODE` shows no error.

**Hook** (`test/orchestrator-hook.test.tsx`, extend): polls while a run is
`running` and stale; stops when it turns `done`.

**Settings** (`test/settings-watchdog.test.tsx`): state line per phase;
select ladders contain only values inside `WATCHDOG_LIMITS`; a change posts
one field and redraws from the response; activity renders newest first and
its empty state.

## 9. Decisions taken, and what they cost

- **Sweep, not prevention.** The Stop hook and the no-background rule were
  declined. Cost: the incident's mechanism can recur, bounded now to
  `RUN_STALE_MS` + `tickMs` of dead time plus one resume session's context
  floor (~50k tokens headless) per crash.
- **Auto-resume is unattended merging.** `--resume` ends in a merge to
  `main`, same as the run it resumes; the watchdog only decides *when*.
  Cost: a run the user killed by hand (not `--abort`) restarts within
  ~16 minutes. The Settings toggle is the answer; `--abort` is the correct
  way to end a run, and this makes that rule matter.
- **Idle hours are billed.** `recovery.md` already rules that a resumed
  item's dead stretch is billed into `execute-elapsed:`. The watchdog caps
  that stretch at roughly `RUN_STALE_MS` + `tickMs` instead of "whenever
  someone notices" — strictly less fabricated time than today.
- **In-memory attempt state.** A server restart forgets the cap. Cost: up
  to `maxAttempts` extra spawns per crashed run per restart. The alternative
  — a writable record beside `run.json` — would be a second writer in the
  orchestrator directory, and the whole run-file design exists to have one.
- **The first file the server writes.** `settings/watchdog.json` and its
  read-write mount end the "the server never writes" sentence in
  `docker-compose.yml`. Cost: one exception to explain, forever. The
  exception is a directory the orchestrator and the registry never read, so
  neither single-writer rule is touched.
- **No push.** A crash reaches you only if you look at the board or the
  dashboard's session list. Cost: the 4h gap can still happen while you are
  away; it just cannot happen while a browser tab is open on the board.
- **The terminal-start gap.** A run started outside the board with the board
  closed for its entire life is never watched. Accepted; the rule to start
  runs from the board predates this design.
- **Two switches after all.** The file's `enabled` is the user's and
  disables spawning; `BM_WATCHDOG=off` is the operator's and stops the
  sweeper existing. Cost: one more env var to explain. Earned by the test
  suite: without it every suite that builds `AppModule` would scan the
  developer's real orchestrator directory at bootstrap.
- **`RUN_IN_PROGRESS_CODE` reused** on `resume`'s fresh-run 409 rather than
  minting a second code. Both mean "a run is alive"; two codes for one fact
  is the drift the code exists to prevent.
