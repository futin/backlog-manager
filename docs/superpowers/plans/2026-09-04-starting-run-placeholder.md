# Starting-run placeholder — make a board-started run visible immediately

**Status:** approved 2026-09-04, not yet implemented. **Re-anchored 2026-09-05
against `fcf4680`** (the orchestrator-watchdog merge), which landed after this
plan was approved and moved three things it depends on: `runs()` became an
explicitly *pure* read with its one side effect relocated to the controller,
`arm()`/`noteBoardResume()` established the controller as where spawn-success
side effects live, and `RunStrip` stopped rendering nothing for a stale run.
The re-anchored passages are marked **▲** in §2–§5 and in the test cases. The
Problem, the Decisions and §1 are untouched by that merge and stand as
approved.

## How to read this plan

**This plan specifies behaviour and exact test *cases*. It deliberately does
NOT hand you literal implementation code.** Signatures, field names, exact
expected values and edge cases are binding; how you satisfy them is yours, and
you are expected to disagree with anything here that turns out wrong once the
code is in front of you. (Handed code gets transcribed verbatim, and a bug in
the plan then becomes a bug in the branch with nobody positioned to catch it —
test scaffolding is the worst offender, because it reads as boilerplate.)

Any size guidance below is a **soft target**, never a budget to compress a
load-bearing rule away for.

## Problem

A run started from the board takes 1–5 minutes to appear in the run strip.

`GET /api/orchestrator/runs` can only see `run.json`, and `run.json` is first
written by `orchestrate.mjs init` — SKILL.md §2. Everything before that is
invisible: the dashboard spawning `claude -p`, the session booting, the model
reading a 1360-line SKILL.md, and the §1 `plan` turn that precedes §2.

The tool is not the bottleneck. `plan --project "$PWD"` measured 0.2s on this
repo. The gap is agent boot plus model turns, and it cannot be removed from
the client side of the API at all.

So this change closes the **feedback** gap, not the latency. Boot time is
unchanged and the plan does not pretend otherwise.

## Decisions already taken (do not relitigate)

- **Server memory, surfaced as a synthetic entry** — chosen over (a) having the
  server run `init` itself before spawning, and (b) a client-only optimistic
  card.
  - (a) was rejected because the spawned session would then hit `init` exit `4`
    (lock held) and SKILL.md's answer to exit `4` is "never retry, go to
    `--resume`". Making that work needs a new adopt path in `orchestrate.mjs`
    plus changes to recovery semantics — the largest blast radius, on the most
    dangerous invariant surface in the repo.
  - (b) was rejected because it dies on page refresh and is invisible to any
    other tab and to the Runs view — precisely the moments someone walks away
    and comes back.
- **Visibility only.** `skills/backlog-orchestrate/SKILL.md` is NOT edited by
  this work. It is re-read on every one of a run's several hundred turns, so
  editing it carries a real ongoing cost and a real drift risk, and the
  placeholder covers the whole gap on its own.
- **The placeholder carries no ids and no merge mode.** The server has both in
  hand after `resolveIds`, and adding them was explicitly declined as scope.
  Do not add them "since they're free".

## Invariants this must not break

Read `CLAUDE.md` before starting. The two that bear directly:

- **The run file has exactly one writer** (`orchestrate.mjs`) **and one
  reader** (`server/src/orchestrator/`). This change adds no writer. The
  in-memory record is *not* the run file and must never be persisted to one.
- **`OrchestratorService` re-reads fresh per request and caches nothing.** The
  starting map is not a cache of run files; it is a record of a spawn this
  process itself requested. Keep that distinction visible in the comments, or
  the next reader will think the service grew a cache.
- **▲ `OrchestratorService.runs()` is a PURE read; its side effects live in
  the controller.** `fcf4680` made this explicit rather than incidental: the
  watchdog's one mutation (`WatchdogStateService.observe()`, which can arm the
  sweeper) is called from `OrchestratorController.runs()` *after* the service
  has returned a finished payload, while its pure half (`annotate()`) is
  called inside `runs()` — and the service's class comment now states the rule
  in those words. §2 and §3 below are split along exactly that seam for the
  same reason, and it is the single biggest change this re-anchor makes to the
  approved design.

## Design

### 1. `shared/types.ts`

Add:

```
StartingRun { project: string; requestedAt: string }
```

`requestedAt` is an ISO timestamp, minted server-side at the moment the spawn
resolved.

Extend `OrchestratorRunsPayload` with a **new top-level field**:

```
starting: StartingRun[]
```

**A separate array, NOT a `status: 'starting'` member of `runs`.** This is the
load-bearing structural decision and the comment on the field must say why:
`OrchestratorRun` is documented as a verbatim read of a file `orchestrate.mjs`
wrote, and `runs` is iterated by `aggregateRuns` (`client/src/lib/run-stats.ts`),
`ArchiveView` and `RunsView`. A synthetic member of that union would reach
every one of those consumers and every `RunStage`/`RunStatus` exhaustiveness
site. A separate field reaches only what opts in — which is exactly one
component.

### 2. `server/src/orchestrator/starting-runs.service.ts` (new)

An injectable holding `Map<projectPath, requestedAtMs>` — one entry per
project, so a second POST for the same project overwrites rather than
accumulating. (Two rapid POSTs before `init` is an existing race the lock
check cannot catch, because that check only fires against a *fresh*
`run.json`. Overwriting neither creates nor worsens it.)

**▲ Three methods, split pure/mutating** — the approved version had two, with
`list` evicting on read. That is a side effect inside `runs()`, which
`fcf4680` has since documented as a pure read (see the invariant above), so
the prune moves out to the controller and `list` becomes a filter:

- `mark(project: string): void` — record `Date.now()` for that project.
- `list(realRuns: readonly OrchestratorRun[], now?: number): StartingRun[]` —
  return the live entries. **Pure: it never touches the map.** This is
  `annotate()`'s counterpart, called from `OrchestratorService.runs()`.
- `sweep(realRuns: readonly OrchestratorRun[], now?: number): void` — delete
  every entry `list` would have filtered out. This is `observe()`'s
  counterpart, called from `OrchestratorController.runs()` after the payload
  is built. No timers and no background work; the prune still happens per
  request, just one layer up.

Both apply the identical rule, and that rule must have ONE implementation — a
private predicate the two share, not two expressions that agree. Same reason
`watchdogStoodDown` is one function rather than the strip's expression plus
the sweeper's: a `list` that could return an entry `sweep` would keep, or the
reverse, is the bug this shape exists to make impossible.

Eviction fires when either holds:

1. **A real run for that project has landed.** A run in `realRuns` whose
   `project` matches and whose `startedAt` parses to `>= requestedAt`.
   `startedAt`, not "a `run.json` exists": `cmdInit` archives the previous
   `run.json` into `runs/` and writes a new one, so a project that has run
   before always has a file, and mere existence would evict the placeholder
   instantly. An unparseable `startedAt` must NOT evict — treat it as no
   match.
2. **`now - requestedAt > RUN_STALE_MS`.** Reuse the constant from
   `shared/types.ts`; do not introduce a second freshness number. Its own doc
   comment claims to be the one such number in the app and this must not make
   that false.

**▲ Correctness does not depend on the prune.** `list` re-applies both rules
on every call, so an entry that never gets swept is filtered out of every
payload anyway — the map can only ever leak memory, never lie. That matters
because one caller reads without sweeping: `AgentsService` calls
`this.orchestrator.runs()` directly for the `RUN_IN_PROGRESS` lock and inside
`resume()`, bypassing the controller entirely. Do not "fix" that by sweeping
inside `runs()`; the leak is bounded by one entry per project, and the next
`GET /api/orchestrator/runs` clears it.

Export the provider from `OrchestratorModule`. `AgentsModule` already imports
that module (for the `RUN_IN_PROGRESS` lock check), so no new wiring.

### 3. `server/src/orchestrator/orchestrator.service.ts`

Inject `StartingRunsService`. `runs()` returns
`{ runs, starting: this.starting.list(runs) }` — `list`, the pure half, for
the reason §2 gives. **▲ The prune is a separate line in
`OrchestratorController.runs()`**: call `sweep(payload.runs)` there, beside
the existing `watchdogState.observe(payload)` call and for the identical
reason. Read that method's own comment first — it already explains why a
payload builder that also decides who else gets notified stops being a
function you can reason about as "just builds the response".

Note the early-return path: the `catch` around `readdirSync(root)` returns
`{ runs: [] }` today for "no orchestrator directory at all". That path must
also carry `starting`, and it is the **most important** one to get right — a
project whose very first run is starting has no orchestrator directory yet, so
this is the exact shape a first-ever run takes. Pass `[]` as `realRuns` there.

### 4. `server/src/agents/agents.controller.ts` ▲

**▲ The controller, not the service.** The approved version put `mark()` in
`AgentsService.orchestrate()`. `fcf4680` made the controller the place a
successful spawn's side effects live — `this.watchdog.arm()` sits right after
the awaited `orchestrate()` result, and the `resume` route carries
`noteBoardResume()` + `arm()` in the same position — with `AgentsController`'s
own doc comment (RULING R3) giving the reasoning. A third spawn-success side
effect landing in a different layer would put one pattern in two places.

Call `mark(project)` after `await this.agents.orchestrate(...)` returns,
beside `arm()`. **After, never before**: a spawn that throws (dashboard down,
dashboard 4xx, no session id) throws out of that `await`, so the line is never
reached and no ghost card is left behind — the controller gets that for free.
Order relative to `arm()` is immaterial (the sweeper never reads starting
entries), unlike `noteBoardResume`'s deliberate before-`arm()` placement — say
so in the comment, so the next reader does not assume a coupling that isn't
there.

`project` is the controller's own validated local (trimmed, non-empty) — the
same string it hands the service, and the registry path
`OrchestratorRun.project` also carries — so the eviction match in §2 stays a
plain string compare with no second identity to keep in step.

`AgentsController` needs `StartingRunsService` injected. `AgentsModule`
already imports `OrchestratorModule`, which must export the new provider
alongside `OrchestratorService` and `WatchdogStateService`; that module's own
comment already describes exactly this shape for the watchdog's state service.

### 5. Client

- `client/src/hooks/useOrchestratorRuns.ts` — surface `starting` alongside
  `runs`. Cadence is otherwise unchanged: mount, window focus, and 5s while
  any run is live. **A starting entry does not currently trigger the 5s
  poll**, and it should — otherwise the placeholder sits on screen until the
  next focus event even after the real run lands. ▲ That predicate is now
  `anyLive`, widened by `fcf4680` to `run.fresh || run.status === 'running'`
  so a crashed run keeps polling; OR the starting entry into that same
  expression rather than adding a second predicate beside it.
- `client/src/components/board/BoardView.tsx` — **▲ when this project has a
  starting entry and no `running` run at all, fresh or crashed.** The approved
  wording was "no fresh run" and that is now wrong: `RunStrip` returns null
  only for `!fresh && status !== 'running'`, and BoardView maps `runningRuns`,
  not `freshRuns`, so a crashed run for this project already renders a crashed
  strip. Gate on "no run in `runningRuns` for this project" and the
  placeholder can never appear beside one.

  **▲ That collision is reachable, not theoretical.** The server's pre-spawn
  lock refuses only a *fresh* run, so Orchestrate over a project whose last
  run crashed is allowed: the spawn succeeds, `mark()` fires, and the
  placeholder would sit next to the crashed strip. Worse, the spawned
  session's own `init` refuses a run file that still says `running`, stale or
  not, so no new run ever lands and eviction rule 1 never matches — the entry
  lives out the full `RUN_STALE_MS` before rule 2 clears it. The gate above is
  what makes that harmless instead of a second card lying for fifteen
  minutes.
- A small sibling to `RunStrip` (same visual frame, its own file). Shows the
  project name, "starting…", and elapsed since `requestedAt` via the existing
  `elapsedSince` (`lib/item-age.ts`) that `RunStrip` already reuses. **No
  progress bar and no percentage** — there is no progress yet, and a 0% bar
  reads as a stalled run rather than an unstarted one.

## Test cases

Flat in `test/`, `*.test.ts` / `*.test.tsx`, jsdom docblock on component
suites — the repo's existing convention.

### `test/orchestrator-starting.test.ts` (new, node env)

Against `StartingRunsService` directly, with an injected `now` where the case
needs one:

1. `mark('/p')` then `list([], now)` → one entry, `project: '/p'`,
   `requestedAt` an ISO string parsing back to the marked instant.
2. `list` with a real run for `/p` whose `startedAt` is **after**
   `requestedAt` → empty. The entry is gone from the map too: a second
   `list([], now)` still returns empty.
3. `list` with a real run for `/p` whose `startedAt` is **before**
   `requestedAt` (the previous run's archived-then-superseded file) → the
   entry **survives**. This is the case that distinguishes "a run landed" from
   "this project has run before", and it is the one a naive implementation
   gets wrong.
4. `list` with a real run for `/p` whose `startedAt` is unparseable junk →
   the entry **survives**.
5. `list([], requestedAt + RUN_STALE_MS + 1)` → empty (TTL eviction), and the
   map is pruned.
6. `list([], requestedAt + RUN_STALE_MS - 1)` → still present. Assert the
   boundary in both directions; do not test only one side.
7. `mark('/a')`, `mark('/b')`, then a real run lands for `/a` → `/b` survives.
8. `mark('/p')` twice with a gap → one entry only, carrying the **later**
   `requestedAt`.

### `test/orchestrator-runs-payload` (extend whichever suite covers `runs()`)

9. `runs()` on a **missing orchestrator directory** with a marked project →
   `{ runs: [], starting: [one entry] }`. This is a first-ever run and must
   not be swallowed by the `readdirSync` catch.
10. `runs()` with real run files present → `starting` reflects `list` run
    against those real runs, not against `[]`.
10a. **▲ `runs()` does not prune.** Mark a project, land a matching real run,
    then call `OrchestratorService.runs()` **twice**: `starting` is empty both
    times (the filter did its job) and the map still holds the entry — assert
    that through the service, e.g. a `list([])` afterwards still returning it.
    This is the case that fails if someone re-merges `sweep` back into
    `list`, and it is the whole point of the §2 split.
10b. **▲ `OrchestratorController.runs()` prunes.** Same setup through the
    controller instead → after one GET, a subsequent `list([])` returns
    empty. Pin the layer, not just the behaviour.

### Agents

11. A successful `POST /api/agents/orchestrate` marks the project.
12. An `orchestrate()` whose `spawn()` rejects (dashboard 4xx, and separately
    a missing `sessionId` → 502) marks **nothing** — assert the payload's
    `starting` is empty afterwards, not merely that `mark` wasn't called.
13. A request rejected *before* spawn (the `RUN_IN_PROGRESS` 409 lock, a bad
    `mergeMode` 400) marks nothing.

### Client

14. Starting entry present, no run at all for that project → the placeholder
    card renders, showing the project name and "starting…".
15. Starting entry present **and** a fresh run for the same project → the real
    `RunStrip` renders and the placeholder does not. (The server should
    already have evicted, but the client must not double-render if it hasn't
    yet — the two arrive in the same payload, so this is a real ordering the
    client can see.)
15a. **▲ Starting entry and a CRASHED run for the same project** (`status:
    'running'`, `fresh: false`) → the crashed `RunStrip` renders and the
    placeholder does **not**. This is the case the approved "no fresh run"
    wording got wrong, and unlike case 15 the server will NOT have evicted:
    `init` refuses a run file that still says `running`, so nothing ever
    matches eviction rule 1 and the entry survives the full `RUN_STALE_MS`.
    Reachable from the UI — the pre-spawn lock only refuses a *fresh* run.
    Without this test the board shows two cards for one project for fifteen
    minutes.
16. No starting entry and no `running` run → nothing renders, exactly as
    today.
17. The placeholder shows no progress bar and no percentage.
17a. **▲ A starting entry makes the hook poll.** With `starting` non-empty and
    `runs` empty, the 5s interval runs; with both empty it does not. Assert
    through `anyLive`'s observable effect (a second fetch after the timer
    advances), not by reaching into the predicate.

### Existing suites

18. Every fixture constructing an `OrchestratorRunsPayload` gains
    `starting: []`. **▲ Sixteen test files touch that payload as of
    `fcf4680`** — the watchdog branch added `watchdog-sweep`,
    `watchdog-state`, `run-watchdog` and grew `orchestrator-hook` — so this
    is a bigger sweep than "several files" suggested when the plan was
    approved. A type error is still the mechanism that finds them: run
    `pnpm run typecheck` early rather than hunting by grep.

## Deliberate limits — state these in the code comments, not just here

- **Lost on API restart.** The real run is unaffected; this is a hint about a
  request this process made, not state anything depends on.
- **Vanishes after `RUN_STALE_MS` if `init` never lands.** A session that
  spawned but never reached `init` is a broken session, diagnosed at the
  dashboard where its transcript is, not in a card that lies about it forever.
- **Boot latency is unchanged.** Anyone reading this later looking for a
  speed-up will not find one here.
- **▲ `POST /api/agents/resume` is out of scope.** `fcf4680` added a second
  board control that spawns a headless session with the identical invisible
  boot gap. It is deliberately not covered: the run it resumes is already
  `status: 'running'`, so the board is already rendering a crashed strip for
  it — the screen is not blank, which is the whole condition this feature
  exists for. Do not `mark()` from the resume path; a placeholder there would
  collide with the very strip that makes it unnecessary.

## Done when

- `pnpm test` green.
- `pnpm run typecheck` clean.
- A board-started run shows a card in the strip within one poll of pressing
  Start, and that card is replaced by the real `RunStrip` once `init` lands.
