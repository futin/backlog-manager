# Starting-run placeholder — make a board-started run visible immediately

**Status:** approved 2026-09-04, not yet implemented.

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

Two methods:

- `mark(project: string): void` — record `Date.now()` for that project.
- `list(realRuns: readonly OrchestratorRun[], now?: number): StartingRun[]` —
  return the live entries, **evicting on read** (no timers, no background
  work — the same "compute per request" posture the rest of this service
  keeps).

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

Eviction removes the map entry, not just the returned row — a `list` call is
the only thing that ever prunes the map, and an unpruned map is a leak.

Export the provider from `OrchestratorModule`. `AgentsModule` already imports
that module (for the `RUN_IN_PROGRESS` lock check), so no new wiring.

### 3. `server/src/orchestrator/orchestrator.service.ts`

Inject `StartingRunsService`. `runs()` returns
`{ runs, starting: this.starting.list(runs) }`.

Note the early-return path: the `catch` around `readdirSync(root)` returns
`{ runs: [] }` today for "no orchestrator directory at all". That path must
also carry `starting`, and it is the **most important** one to get right — a
project whose very first run is starting has no orchestrator directory yet, so
this is the exact shape a first-ever run takes. Pass `[]` as `realRuns` there.

### 4. `server/src/agents/agents.service.ts`

In `orchestrate()`, call `mark(project)` **after** `spawn()` resolves, never
before. A spawn that throws (dashboard down, dashboard 4xx, no session id) must
leave no ghost card behind.

Use the same `project` string the rest of the method uses — the registry path
that `OrchestratorRun.project` also carries — so the eviction match in §2 is a
plain string compare against the same value, with no second identity to keep
in step.

### 5. Client

- `client/src/hooks/useOrchestratorRuns.ts` — surface `starting` alongside
  `runs`. Polling cadence is unchanged: mount, window focus, and 5s while any
  run is fresh. **A starting entry does not currently trigger the 5s poll**,
  and it should — otherwise the placeholder sits on screen until the next
  focus event even after the real run lands. Include "has a starting entry" in
  whatever predicate decides the fast poll.
- `client/src/components/board/BoardView.tsx` — when this project has a
  starting entry and no fresh run, render the placeholder card in the strip
  slot.
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

### Agents

11. A successful `POST /api/agents/orchestrate` marks the project.
12. An `orchestrate()` whose `spawn()` rejects (dashboard 4xx, and separately
    a missing `sessionId` → 502) marks **nothing** — assert the payload's
    `starting` is empty afterwards, not merely that `mark` wasn't called.
13. A request rejected *before* spawn (the `RUN_IN_PROGRESS` 409 lock, a bad
    `mergeMode` 400) marks nothing.

### Client

14. Starting entry present, no fresh run for that project → the placeholder
    card renders, showing the project name and "starting…".
15. Starting entry present **and** a fresh run for the same project → the real
    `RunStrip` renders and the placeholder does not. (The server should
    already have evicted, but the client must not double-render if it hasn't
    yet — the two arrive in the same payload, so this is a real ordering the
    client can see.)
16. No starting entry, no fresh run → nothing renders, exactly as today.
17. The placeholder shows no progress bar and no percentage.

### Existing suites

18. Every fixture constructing an `OrchestratorRunsPayload` gains
    `starting: []`. Expect this to touch several files; a type error is the
    mechanism that finds them, so run `pnpm run typecheck` early rather than
    hunting by grep.

## Deliberate limits — state these in the code comments, not just here

- **Lost on API restart.** The real run is unaffected; this is a hint about a
  request this process made, not state anything depends on.
- **Vanishes after `RUN_STALE_MS` if `init` never lands.** A session that
  spawned but never reached `init` is a broken session, diagnosed at the
  dashboard where its transcript is, not in a card that lies about it forever.
- **Boot latency is unchanged.** Anyone reading this later looking for a
  speed-up will not find one here.

## Done when

- `pnpm test` green.
- `pnpm run typecheck` clean.
- A board-started run shows a card in the strip within one poll of pressing
  Start, and that card is replaced by the real `RunStrip` once `init` lands.
