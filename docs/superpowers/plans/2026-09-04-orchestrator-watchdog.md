# Orchestrator Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an orchestrator run's heartbeat goes stale, the board's own server notices within a minute, spawns `/backlog-orchestrate --resume` for it through the existing dashboard path, gives up after a bounded number of tries, and shows every step of that on the board and in Settings.

**Architecture:** An in-memory state provider in `orchestrator/` records what the watchdog knows and annotates it onto the runs payload the board already polls. A sweeper in `agents/` — the one outbound-calling module — arms itself only while some `run.json` says `running`, ticks on a self-rescheduling `setTimeout`, and calls a new `AgentsService.resume()` that mirrors `orchestrate()`'s gates and composes a constant prompt. Knobs live in a server-owned JSON file edited from Settings; the run file keeps its single writer.

**Tech Stack:** NestJS (server), React + Vite (client), jest `--runInBand` for server/client/shared, node's own test runner for `skills/*/tools/*.test.mjs` (untouched by this plan — no `.mjs` changes).

**Spec:** [docs/superpowers/specs/2026-09-04-orchestrator-watchdog-design.md](../specs/2026-09-04-orchestrator-watchdog-design.md) — read it before Task 1. Every "why" in this plan is short because the spec carries the long version.

## PLAN CONVENTION — READ THIS FIRST

**This plan deliberately contains no literal implementation code, and no
literal test code.** That is an intentional override of the writing-plans
template, not an omission, and it is not a defect to be "fixed" by filling
code in.

Each step states **behaviour, exact signatures, and exact expected values**.
Test steps give a **table of cases**: the input, the exact assertion, and the
exact expected value. You write the test body and the implementation.

Why: handed code gets transcribed verbatim, so a bug in the plan becomes a bug
in the branch with nobody positioned to catch it — test scaffolding worst of
all, because it reads as boilerplate. You are expected to disagree with this
plan where it is wrong. Say so rather than transcribing it.

Line-number references are from HEAD at `e14b1cc` and will drift; treat them
as "look here first", not as coordinates. Size targets in this plan are soft.

## Global Constraints

- **`orchestrate.mjs` is the run file's only writer.** Nothing in this plan writes `run.json`, anything under `orchHome()`, or anything the container mounts read-only. The one new server write is `settings/watchdog.json`, and Task 1 is where that exception is made and explained.
- **The resume prompt is a compile-time constant**: `RESUME_PROMPT = '/backlog-orchestrate --resume'`. `POST /api/agents/resume` has one body field, `project`, and no task adds another.
- **One freshness number.** "Crashed" is `status === 'running' && !fresh` with `fresh` exactly as `OrchestratorService.runs()` computes it from `RUN_STALE_MS`. No task introduces a second threshold.
- **Any spawn attempt starts the grace clock; only a success counts against the cap.** Gate failures and HTTP failures set `lastError` and `lastSpawnAt`, never `attempts`.
- **In-memory state.** Attempts, phase and events die with the process, on purpose (spec §9). No task persists them.
- **`RUN_IN_PROGRESS_CODE` is reused** for `resume`'s fresh-run 409 and stays the only coded 409 on either endpoint.
- **Clamp to the nearest bound, never to the default** for `tickMs`/`graceMs`/`maxAttempts` — the opposite of `staleDays`, for the reason spec §5.2 gives.
- **Tests never touch the developer's real orchestrator directory.** `BM_WATCHDOG=off` is set for the whole jest run (Task 4); the sweep suite alone turns it on, with `BM_ORCH_HOME` pointed at a temp dir first.
- **Comments explain *why*, at length.** Match the surrounding density; do not strip it, and do not write comments that only restate the line below them.
- **Tests are flat in `test/`**, `*.test.ts` / `*.test.tsx`; component suites need a `@jest-environment jsdom` docblock.
- **pnpm only.** `pnpm test -- <pattern>`, `pnpm run typecheck`, `pnpm run build`.
- **Editing `skills/` changes nothing** until committed, pushed, and `pnpm run plugin:sync` has run (Task 8).

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `server/src/orchestrator/watchdog-config.util.ts` | Resolve the settings file path, read it with defaults on every failure, clamp every field, write it atomically. Pure fs + env; no Nest. |
| `server/src/orchestrator/watchdog-state.service.ts` | `WatchdogStateService`: phase, per-run entries, the 50-event ring buffer, `annotate()` for the runs payload, `observe()` for arming. Holds data; never spawns. |
| `server/src/agents/watchdog.service.ts` | `WatchdogService`: the sweeper. `arm`/`disarm`/`tick`, bootstrap scan, the `setTimeout` chain. |
| `client/src/lib/run-watchdog.ts` | `isCrashed(run)` and `watchdogClause(w)` — the five strip phrasings as one pure function. |
| `client/src/hooks/useWatchdog.ts` | Fetch `GET /api/agents/watchdog` on mount/focus, poll while armed, save a config patch. |
| `client/src/components/settings/WatchdogGroup.tsx` | The "Orchestrator watchdog · this server" group. |
| `test/helpers/env.ts` | jest `setupFiles` entry: `BM_WATCHDOG=off` unless a suite already set it. |
| `test/watchdog-config.test.ts`, `test/watchdog-state.test.ts`, `test/watchdog-sweep.test.ts`, `test/agents-resume.test.ts`, `test/watchdog-routes.test.ts`, `test/run-watchdog.test.ts`, `test/settings-watchdog.test.tsx` | One suite per unit above; cases listed in each task. |

**Modified**

| File | Change |
|---|---|
| `shared/types.ts` | `WatchdogConfig`, `WATCHDOG_LIMITS`, `DEFAULT_WATCHDOG_CONFIG`, `WatchdogPhase`, `WatchdogEventKind`, `WatchdogEvent`, `WATCHDOG_EVENT_CAP`, `RunWatchdog`, `WatchdogStatus`; `watchdog?: RunWatchdog` on the runs payload entry. |
| `server/src/orchestrator/orchestrator.module.ts` | Provide + export `WatchdogStateService`. |
| `server/src/orchestrator/orchestrator.service.ts` | `runs()` annotates each entry via `state.annotate()`. |
| `server/src/orchestrator/orchestrator.controller.ts` | `runs()` calls `state.observe(payload)` before returning it. |
| `server/src/agents/agents.service.ts` | `RESUME_PROMPT`, `resume(project, origin)`, `resumeSessionName`. |
| `server/src/agents/agents.controller.ts` | `POST resume`, `GET watchdog`, `POST watchdog/config`. |
| `server/src/agents/agents.module.ts` | Provide `WatchdogService`. |
| `jest.config.ts` | `setupFiles` → `test/helpers/env.ts`. |
| `client/src/lib/agents.ts` | `resumeOrchestrate`, `fetchWatchdog`, `updateWatchdogConfig`. |
| `client/src/hooks/useOrchestratorRuns.ts` | Poll while any run is `running`, fresh or not. |
| `client/src/components/board/RunStrip.tsx` | Crashed rendering; Resume control. |
| `client/src/components/board/BoardView.tsx` | Strips for `running` runs; `canResume` per strip. |
| `client/src/components/settings/SettingsView.tsx` | Mount `WatchdogGroup`. |
| `client/src/styles.css` | `.run-strip-crashed`, `.run-strip-watchdog`, `.run-strip-resume`, `.watchdog-events`. |
| `test/orchestrator-strip.test.tsx`, `test/orchestrator-hook.test.tsx`, `test/orchestrator-runs.test.ts` | Existing expectations that change. |
| `docker-compose.yml`, `.env.example`, `README.md` | The read-write `settings/` mount; `BM_WATCHDOG_FILE`, `BM_WATCHDOG`. |
| `skills/backlog-orchestrate/references/recovery.md`, `skills/backlog-orchestrate/SKILL.md` | Heartbeat first on `--resume`; one sentence on unattended entry. |
| `CLAUDE.md`, `docs/invariants.md` | Layout bullets; four new invariants, one amended. |

---

### Task 1: Vocabulary and the settings file

**Files:**
- Modify: `shared/types.ts` (after `OrchestratorRunsPayload`, ~546)
- Create: `server/src/orchestrator/watchdog-config.util.ts`
- Modify: `docker-compose.yml` (~69-76), `.env.example` (append), `README.md` (env table ~78-88)
- Test: `test/watchdog-config.test.ts`

**Interfaces produced** (every later task spells these exactly):

- `interface WatchdogConfig { enabled: boolean; tickMs: number; graceMs: number; maxAttempts: number }`
- `const WATCHDOG_LIMITS = { tickMs: { min: 30_000, max: 600_000, default: 60_000 }, graceMs: { min: 300_000, max: 3_600_000, default: 600_000 }, maxAttempts: { min: 1, max: 5, default: 2 } } as const`
- `const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = { enabled: true, tickMs: 60_000, graceMs: 600_000, maxAttempts: 2 }`
- `type WatchdogPhase = 'off' | 'idle' | 'armed'`
- `type WatchdogEventKind = 'armed' | 'idle' | 'spawned' | 'failed' | 'exhausted' | 'recovered' | 'disabled'`
- `interface WatchdogEvent { at: string; project: string | null; runId: string | null; kind: WatchdogEventKind; detail: string }`
- `const WATCHDOG_EVENT_CAP = 50`
- `interface RunWatchdog { enabled: boolean; attempts: number; maxAttempts: number; lastSpawnAt: string | null; lastSessionId: string | null; lastError: string | null; exhausted: boolean }`
- `interface WatchdogStatus { phase: WatchdogPhase; reason?: string; nextTickAt: string | null; config: WatchdogConfig; watching: string[]; events: WatchdogEvent[] }`
- `OrchestratorRunsPayload.runs` element type gains `watchdog?: RunWatchdog`.
- `watchdogFile(env = process.env): string` — `env.BM_WATCHDOG_FILE` or `join(homedir(), '.backlog-manager', 'settings', 'watchdog.json')`.
- `watchdogEnvOff(env = process.env): boolean` — true iff `(env.BM_WATCHDOG ?? '').trim().toLowerCase() === 'off'`. The operator's and the test suite's kill switch; spec §5.1 amended to name it.
- `clampWatchdogConfig(raw: unknown): WatchdogConfig`
- `readWatchdogConfig(file = watchdogFile()): WatchdogConfig`
- `writeWatchdogConfig(patch: unknown, file = watchdogFile()): WatchdogConfig` — returns the effective config after the write.

- [ ] **Step 1: Write the failing tests** — `test/watchdog-config.test.ts`, node environment, a `mkdtempSync` dir per case, `BM_WATCHDOG_FILE` pointed inside it and restored in `afterEach`.

| # | Input | Assertion |
|---|---|---|
| 1 | `clampWatchdogConfig(undefined)` | deep-equals `DEFAULT_WATCHDOG_CONFIG` |
| 2 | `clampWatchdogConfig(42)`, `clampWatchdogConfig('x')`, `clampWatchdogConfig(null)` | each deep-equals the defaults |
| 3 | `{ tickMs: 1 }` | `tickMs` is `30_000`; the other three fields are defaults |
| 4 | `{ tickMs: 10_000_000 }` | `tickMs` is `600_000` |
| 5 | `{ graceMs: 1 }` / `{ graceMs: 99_999_999 }` | `300_000` / `3_600_000` |
| 6 | `{ maxAttempts: 0 }` / `{ maxAttempts: 9 }` / `{ maxAttempts: 2.7 }` | `1` / `5` / `2` (non-integer → default; say so in a comment: an attempt count is a count) |
| 7 | `{ tickMs: 'soon' }`, `{ tickMs: NaN }`, `{ tickMs: Infinity }` | `tickMs` is `60_000` |
| 8 | `{ enabled: false }` / `{ enabled: 'no' }` / `{ enabled: 0 }` / `{}` | `false` / `true` / `true` / `true` |
| 9 | `readWatchdogConfig()` with no file on disk | defaults; nothing written; no `console.warn` |
| 10 | file holds `not json` | defaults; exactly one `console.warn` naming the path |
| 11 | file holds `{ "graceMs": 900000, "junk": 1 }` | `graceMs` `900_000`, rest defaults, no `junk` on the result |
| 12 | `writeWatchdogConfig({ graceMs: 1 })` with no file | file now exists, parses to `{ enabled: true, tickMs: 60000, graceMs: 300000, maxAttempts: 2 }` exactly (no extra keys); return value equals that object; the parent `settings/` directory was created |
| 13 | file holds `{ "tickMs": 120000 }`, then `writeWatchdogConfig({ enabled: false })` | file holds `tickMs 120000` **and** `enabled false` — merge, not replace |
| 14 | `writeWatchdogConfig({ tickMs: 90_000 })` | no `*.tmp` sibling remains in the directory afterwards |
| 15 | `watchdogFile({})` | ends with `/.backlog-manager/settings/watchdog.json`; `watchdogFile({ BM_WATCHDOG_FILE: '/x/y.json' })` is `/x/y.json` |
| 16 | `watchdogEnvOff({ BM_WATCHDOG: 'off' })` / `' OFF '` / `'on'` / `{}` | `true` / `true` / `false` / `false` |

- [ ] **Step 2: Run and confirm failure** — `pnpm test -- watchdog-config`

- [ ] **Step 3: Add the types and constants to `shared/types.ts`** — next to `OrchestratorRunsPayload`, with doc comments in the file's register: why `WATCHDOG_LIMITS` lives in `shared/` (both the server clamp and the Settings ladders read it, so neither can drift), why `RunWatchdog` is optional on the payload entry (present only where it means something — a crashed run), and why the event cap is a number here rather than a server constant (the Settings list is sized to it).

- [ ] **Step 4: Write `watchdog-config.util.ts`** — the five functions above. Read fresh on every call, never cached, for the reason `config.util.ts`'s header gives. `writeWatchdogConfig` reads the current file, spreads the rebuilt patch over it, clamps, `mkdirSync(dir, { recursive: true })`, writes `<file>.tmp`, `renameSync`. The header comment must say this is **the first file the server writes**, why it is a directory the registry and the orchestrator never read, and why nearest-bound clamping is right here where `staleDays` clamps to default.

- [ ] **Step 5: The compose mount** — add `- ${HOME}/.backlog-manager/settings:${HOME}/.backlog-manager/settings` (read-write) directly under the existing `:ro` mount of `${HOME}/.backlog-manager`, and amend that mount's comment: read-only *except* `settings/`, the one directory the server writes, holding one file; a nested mount of a directory, not the file, because a bind-mounted path that does not exist yet becomes a directory. `.env.example`: a commented `# BM_WATCHDOG_FILE=` block and a `# BM_WATCHDOG=off` block, each with the two-sentence "why" the file's other keys carry. `README.md` env table: two rows, `BM_WATCHDOG_FILE` (default `~/.backlog-manager/settings/watchdog.json`) and `BM_WATCHDOG` (default on; `off` disables the run watchdog entirely).

- [ ] **Step 6: Green** — `pnpm test -- watchdog-config && pnpm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts server/src/orchestrator/watchdog-config.util.ts test/watchdog-config.test.ts docker-compose.yml .env.example README.md
git commit -m "feat(watchdog): vocabulary, clamped settings file, and its mount"
```

---

### Task 2: Watchdog state, annotated onto the runs payload

**Files:**
- Create: `server/src/orchestrator/watchdog-state.service.ts`
- Modify: `server/src/orchestrator/orchestrator.module.ts`, `orchestrator.service.ts` (`runs()` ~175-225), `orchestrator.controller.ts` (`runs()` ~16-19)
- Test: `test/watchdog-state.test.ts` (new), `test/orchestrator-runs.test.ts` (extend)

**Interfaces consumed:** everything from Task 1, plus `readAgentsConfig` (`server/src/agents/config.util.ts`).

**Interfaces produced:**

- `interface WatchdogEntry { runId: string; project: string; attempts: number; lastSpawnAt: string | null; lastSessionId: string | null; lastError: string | null; exhausted: boolean; recovered: boolean; disabledLogged: boolean }`
- `class WatchdogStateService` with:
  - `phase: WatchdogPhase` (initial `'idle'`), `reason: string | undefined`, `nextTickAt: string | null`
  - `setPhase(phase: WatchdogPhase, reason?: string, nextTickAt?: string | null): void`
  - `entry(runId: string): WatchdogEntry | undefined`
  - `upsert(runId: string, project: string): WatchdogEntry` — creates zeroed entry if absent
  - `prune(keep: ReadonlySet<string>): void` — drops entries whose `runId` is not in `keep`
  - `push(event: Omit<WatchdogEvent, 'at'>, at: Date = new Date()): void` — ring buffer, `WATCHDOG_EVENT_CAP`
  - `events(): WatchdogEvent[]` — newest first
  - `spawningEnabled(): boolean` — `!watchdogEnvOff() && readAgentsConfig().enabled && readWatchdogConfig().enabled`, read fresh
  - `annotate(run: OrchestratorRun & { fresh: boolean }): RunWatchdog | undefined` — `undefined` unless `status === 'running' && !fresh`; otherwise built from `entry(run.runId)` (zeroes when none), `enabled: spawningEnabled()`, `maxAttempts: readWatchdogConfig().maxAttempts`
  - `setArmer(fn: () => void): void`, `observe(payload: OrchestratorRunsPayload): void` — calls the armer iff any run has `status === 'running'` and an armer is registered
  - `status(config: WatchdogConfig, watching: string[]): WatchdogStatus`

- [ ] **Step 1: Write the failing tests**

`test/watchdog-state.test.ts` — construct the service directly (`new WatchdogStateService()`), `BM_AGENTS`/`BM_WATCHDOG`/`BM_WATCHDOG_FILE` set per case and restored:

| # | Setup | Assertion |
|---|---|---|
| 1 | fresh service | `phase` is `'idle'`, `events()` is `[]`, `nextTickAt` is `null` |
| 2 | `push` 55 events | `events().length` is `50`; `events()[0]` is the 55th pushed; the first five pushed are gone |
| 3 | `upsert('r1','/p')` twice | same object both times; `attempts 0`, `exhausted false`, `recovered false`, `disabledLogged false` |
| 4 | entries `r1`, `r2`; `prune(new Set(['r2']))` | `entry('r1')` undefined, `entry('r2')` defined |
| 5 | `annotate` on a fresh running run | `undefined` |
| 6 | `annotate` on a `done` run with `fresh: false` | `undefined` |
| 7 | `annotate` on `running`, `fresh: false`, no entry, `BM_AGENTS=on`, no `BM_WATCHDOG`, no file | `{ enabled: true, attempts: 0, maxAttempts: 2, lastSpawnAt: null, lastSessionId: null, lastError: null, exhausted: false }` |
| 8 | same, `BM_AGENTS` unset | `enabled false` |
| 9 | same, `BM_AGENTS=on`, `BM_WATCHDOG=off` | `enabled false` |
| 10 | same, file `{ "enabled": false, "maxAttempts": 4 }` | `enabled false`, `maxAttempts 4` |
| 11 | entry with `attempts 1`, `lastSessionId 'sess-1'`, `exhausted true` | `annotate` reflects all three |
| 12 | `observe` with no armer set | does not throw |
| 13 | `setArmer(spy)`; `observe({ runs: [done run] })` | spy not called |
| 14 | `setArmer(spy)`; `observe({ runs: [running fresh run] })` | spy called once |
| 15 | `setArmer(spy)`; `observe({ runs: [running stale run] })` | spy called once — crashed is still running |

`test/orchestrator-runs.test.ts` — extend with the app:

| # | run.json on disk | Assertion on `GET /api/orchestrator/runs` |
|---|---|---|
| 16 | fixture as-is (`updatedAt` 2026-08-31 → stale) with `status: 'running'` | the entry has `watchdog` with `attempts 0` and `exhausted false` |
| 17 | `updatedAt` = now | no `watchdog` key on the entry |
| 18 | `status: 'done'`, old `updatedAt` | no `watchdog` key |

- [ ] **Step 2: Run and confirm failure** — `pnpm test -- watchdog-state orchestrator-runs`

- [ ] **Step 3: Write the service.** `@Injectable()`. The header comment carries spec §4's placement argument verbatim in spirit: this lives with the *reader* because `runs()` has to annotate from it and `agents/` already imports `orchestrator/`; the sweeper writes into it; it never spawns. `annotate()`'s comment says why the field is absent on fresh and finished runs.

- [ ] **Step 4: Wire it.** `OrchestratorModule` provides and exports it. `OrchestratorService` injects it and, in `runs()`, sets `watchdog` on each pushed entry only when `annotate()` returns a value (spread `...(w ? { watchdog: w } : {})`, so a fresh run's entry has no key at all — case 17 asserts on key absence, not `undefined`). `OrchestratorController.runs()` builds the payload, calls `state.observe(payload)`, returns it — with a comment: this is the one side effect on a read path, it is in-memory, and it is how a board-opened run arms a sweeper that would otherwise only learn of it at the next spawn.

- [ ] **Step 5: Green** — `pnpm test -- watchdog-state orchestrator-runs && pnpm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add server/src/orchestrator test/watchdog-state.test.ts test/orchestrator-runs.test.ts
git commit -m "feat(watchdog): in-memory state, annotated onto the runs payload"
```

---

### Task 3: `resume()` and `POST /api/agents/resume`

**Files:**
- Modify: `server/src/agents/agents.service.ts` (`orchestrate()` ~337-500 is the model; `orchestrateSessionName` ~730)
- Modify: `server/src/agents/agents.controller.ts` (after `orchestrate` route)
- Modify: `client/src/lib/agents.ts` (after `startOrchestrate` ~276)
- Test: `test/agents-resume.test.ts`

**Interfaces consumed:** `OrchestratorService.runs()` with `fresh`; `projectDispatchGate`, `clampMode` (`shared/agent.ts`); `RUN_IN_PROGRESS_CODE`.

**Interfaces produced:**

- `const RESUME_PROMPT = '/backlog-orchestrate --resume'` (module constant beside `ORCHESTRATE_PROMPT`, same comment style — what a caller can influence: nothing).
- `AgentsService.resume(project: string, origin: 'watchdog' | 'board'): Promise<AgentDispatchResult>`
- `function resumeSessionName(projectPath: string, origin: 'watchdog' | 'board'): string` — `watchdog resume · <basename>` / `resume · <basename>`, the same `basename` `orchestrateSessionName` uses.
- Client: `resumeOrchestrate(project: string): Promise<AgentDispatchResult>` posting `{ project }`.

- [ ] **Step 1: Write the failing tests** — `test/agents-resume.test.ts`, supertest against `AppModule`, `stubDashboard` in the shape `test/orchestrator-start.test.ts` uses (management lists the registered project; spawn answers `{ sessionId: 'sess-1' }`), `BM_ORCH_HOME` a temp dir, `BM_AGENTS=on`, `BM_WATCHDOG=off`.

| # | Setup | Expected |
|---|---|---|
| 1 | body `{}` / `{ project: '' }` / `{ project: '   ' }` | 400 `{ error: 'project is required' }`; no fetch at all |
| 2 | `BM_AGENTS` unset | 404 `{ error: 'not found' }` |
| 3 | dashboard health fetch rejects (unreachable) | 502; no spawn |
| 4 | project not in management's list | 409 whose `error` is `projectDispatchGate`'s own wording for the visibility case (assert equality against a call to that function, not a string literal) |
| 5 | no `run.json` for the project | 409 `{ error: 'no crashed run to resume for this project' }`, **no** `code` |
| 6 | run `status: 'done'` | same 409 as 5 |
| 7 | run `running`, `updatedAt` = now | 409 with `code: RUN_IN_PROGRESS_CODE`; `error` contains the runId and the `updatedAt` string; no spawn |
| 8 | run `running`, `updatedAt` 20 minutes ago | 200 `{ sessionId: 'sess-1' }`; exactly one POST to `/api/spawn`; its JSON body has `prompt` exactly `/backlog-orchestrate --resume`, `name` exactly `resume · <basename of project>`, `permissionMode` `'auto'` when the ceiling is `auto` |
| 9 | as 8, dashboard ceiling `acceptEdits` | `permissionMode` is `'acceptEdits'` |
| 10 | as 8, body also carries `prompt: 'rm -rf /'`, `ids: ['x']`, `model: 'opus'` | spawn body has none of `ids`/`model`; `prompt` is still the constant |
| 11 | as 8, request `Origin: http://evil.example` | the guard's rejection, no spawn (mirror the assertion `test/agents-origin-guard.test.ts` makes) |
| 12 | spawn answers 429 `{ error: 'busy' }` | 429 `{ error: 'busy' }` |
| 13 | `agents.resume(project, 'watchdog')` called directly on the service | spawn `name` is `watchdog resume · <basename>` |

- [ ] **Step 2: Run and confirm failure** — `pnpm test -- agents-resume`

- [ ] **Step 3: Implement `resume()`** in the order spec §3 lists: `status()` → 404; `projectDispatchGate` → 502/409 with the same branching `orchestrate()` uses (copy the *calls*, share the helpers, do not paraphrase the strings); find the run → 409 uncoded / 409 coded; `projectMap` → 409; `spawn()` with `RESUME_PROMPT`, `resumeSessionName`, `permissionMode: clampMode('auto', status.spawnMaxPermission)`, no `model`/`effort`/`remoteControl`. The doc comment says why the fresh-run 409 reuses `RUN_IN_PROGRESS_CODE` (both mean "a run is alive"; two codes for one fact is the drift the code exists to prevent) and why the run check is stricter than `orchestrate()`'s (that one refuses a *fresh* run; this one *requires* a stale one).

- [ ] **Step 4: Controller route** — `@UseGuards(SameOriginPostGuard) @Post('resume')`, body typed `{ project?: unknown } | undefined`, trim, 400 on empty, call `resume(project, 'board')`. Comment: one field, rebuilt, nothing else read — the same posture `orchestrate` takes toward `prompt`.

- [ ] **Step 5: Client helper** — `resumeOrchestrate` beside `startOrchestrate`, same `unwrap` shape.

- [ ] **Step 6: Green** — `pnpm test -- agents-resume agents-origin-guard && pnpm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add server/src/agents/agents.service.ts server/src/agents/agents.controller.ts client/src/lib/agents.ts test/agents-resume.test.ts
git commit -m "feat(agents): resume a crashed run through the dashboard spawn path"
```

---

### Task 4: The sweeper

**Files:**
- Create: `server/src/agents/watchdog.service.ts`, `test/helpers/env.ts`
- Modify: `server/src/agents/agents.module.ts`, `jest.config.ts`
- Test: `test/watchdog-sweep.test.ts`

**Interfaces consumed:** `WatchdogStateService` (Task 2), `AgentsService.resume` (Task 3), `readWatchdogConfig`, `watchdogEnvOff`, `readAgentsConfig`, `OrchestratorService.runs()`.

**Interfaces produced:**

- `class WatchdogService implements OnApplicationBootstrap, OnApplicationShutdown` with public `arm(): void`, `disarm(): void`, `tick(): Promise<void>`, `status(): WatchdogStatus`, `armed: boolean` (getter).
- Off means `watchdogEnvOff() || !readAgentsConfig().enabled`; `reason` is `'BM_WATCHDOG off'` or `'BM_AGENTS off'` respectively, the env check first.

- [ ] **Step 1: The jest guard first** — `test/helpers/env.ts` sets `process.env.BM_WATCHDOG ??= 'off'`; `jest.config.ts` gains `setupFiles: ['<rootDir>/test/helpers/env.ts']` (append if a `setupFiles` array already exists). A comment in the helper: the sweeper's bootstrap scan reads `orchHome()`, which for any suite that leaves `BM_ORCH_HOME` unset is the developer's real directory, and a crashed run there would make a stubbed `fetch` see a spawn nobody's assertions expect. Run the whole suite once: `pnpm test` — green before anything else changes.

- [ ] **Step 2: Write the failing tests** — `test/watchdog-sweep.test.ts`. Build the Nest app from `AppModule` (so bootstrap wiring is exercised) with `BM_ORCH_HOME` a temp dir, `BM_WATCHDOG_FILE` inside it, `BM_AGENTS=on`, `BM_WATCHDOG` **deleted** in `beforeEach` (so this suite alone is on), dashboard stubbed as in Task 3. Write `run.json` files by hand with `updatedAt` chosen relative to `Date.now()`. Drive the sweeper by resolving `WatchdogService` from the module and calling `tick()` directly for policy cases; use `jest.useFakeTimers()` + `advanceTimersByTimeAsync` only for the scheduling cases (create the app *after* enabling fake timers, and `useRealTimers` in `afterEach`).

| # | Setup | After | Assertion |
|---|---|---|---|
| 1 | one crashed run (updatedAt −20m) | `tick()` | exactly one `/api/spawn` POST; prompt `/backlog-orchestrate --resume`; `name` starts `watchdog resume ·`; `permissionMode` `'auto'`; state entry `attempts 1`, `lastSessionId 'sess-1'`, `lastError null`; one `spawned` event whose `detail` contains `1/2` and `sess-1` |
| 2 | one fresh running run | `tick()` | no spawn; `armed` true; `nextTickAt` non-null |
| 3 | one `done` run | `tick()` | no spawn; `armed` false; phase `'idle'`; one `idle` event |
| 4 | no run.json at all | `tick()` | as 3 |
| 5 | crashed run | `tick()` twice back to back | one spawn total (grace) |
| 6 | crashed run; first `tick()`; then set the entry's `lastSpawnAt` 11 minutes back | `tick()` | second spawn; `attempts 2` |
| 7 | as 6, then push `lastSpawnAt` back again | `tick()` | **no** third spawn; `exhausted true`; exactly one `exhausted` event; a further `tick()` adds no second `exhausted` event |
| 8 | crashed run; spawn stub answers 429 `{ error: 'busy' }` | `tick()` | no `attempts`; `lastError 'busy'`; `lastSpawnAt` set; one `failed` event whose `detail` contains `busy` and `not counted` |
| 9 | as 8 | `tick()` again immediately | no second spawn attempt (grace applies to failures) |
| 10 | crashed run; health fetch rejects | `tick()` | no spawn; `lastError` is the gate's unreachable wording; `attempts 0`; one `failed` event |
| 11 | crashed run; `BM_AGENTS` unset | `arm()` then `tick()` | phase `'off'`, `reason 'BM_AGENTS off'`; no fetch of any kind; no timer (`armed` false) |
| 12 | crashed run; `BM_WATCHDOG=off` | `arm()` | phase `'off'`, `reason 'BM_WATCHDOG off'`; `arm()` was a no-op |
| 13 | crashed run; file `{ "enabled": false }` | `tick()` ×3 | phase `'armed'`; no spawn; no health fetch; exactly one `disabled` event for that run; `GET /api/orchestrator/runs` entry has `watchdog.enabled false` |
| 14 | crashed run; `tick()` spawns; then rewrite run.json with `updatedAt` = now | `tick()` | one `recovered` event; no spawn; entry still present (run still `running`) |
| 15 | as 14, then rewrite with `status: 'done'` | `tick()` | entry pruned (`state.entry(runId)` undefined); phase `'idle'` |
| 16 | fake timers; one fresh running run; app created | advance `60_000` | `runs()` was read again (spy on `OrchestratorService.runs` or count `readFileSync` via a wrapped fs — pick one and say which) — i.e. the chain rescheduled |
| 17 | fake timers; file `{ "tickMs": 30000 }` written *between* ticks | advance `30_000` | a tick ran — the new interval was honoured |
| 18 | `arm()` called twice while armed | — | one pending timer; second call a no-op; only one `armed` event |
| 19 | spawn stub returns a promise that stays pending; `tick()` started; `tick()` called again | — | the second call returns the **same** promise (no overlapping work); resolve the stub → exactly one spawn |
| 20 | `onApplicationShutdown()` while armed | — | `armed` false; no timer fires after (advance `120_000`, no further `runs()` read) |
| 21 | two projects: one crashed, one fresh | `tick()` | exactly one spawn, for the crashed project; `status().watching` lists both runIds |
| 22 | `status()` while armed | — | `phase 'armed'`, `config` equals the clamped file contents, `events` newest first, `nextTickAt` parses to within `tickMs` of now |

- [ ] **Step 3: Run and confirm failure** — `pnpm test -- watchdog-sweep`

- [ ] **Step 4: Implement the service.** Structure:
  - `onApplicationBootstrap`: `state.setArmer(() => this.arm())`, then `this.arm()`.
  - `arm()`: compute off-ness; if off → `state.setPhase('off', reason, null)`, return. If a timer or in-flight tick exists → return. Else `state.setPhase('armed')`, push `armed`, `void this.tick()`.
  - `tick()`: if `inFlight` → return it. Otherwise set `inFlight` to the body's promise; the body: clear any pending timer; read config; read runs; `running = runs.filter(status === 'running')`; `state.prune(new Set(running runIds))`; if none → `disarm()` + push `idle` + return. For each running run apply spec §2.2 steps 1–5 in order, awaiting `agents.resume(run.project, 'watchdog')` and catching **everything** (an `HttpException` carries its `{ error }` body — read the message from `getResponse()` when it is one, else `message(e)` from `agents.service.ts`). After the loop, if still armed: `timer = setTimeout(() => void this.tick(), config.tickMs)`, `timer.unref()`, `state.setPhase('armed', undefined, nextTickAt ISO)`. `finally`: `inFlight = null`.
  - `disarm()`: clear timer, `timer = null`, `state.setPhase('idle')`.
  - `status()`: `state.status(readWatchdogConfig(), watching)` where `watching` is the runIds of the last tick's running runs (keep them on the service).
  - Header comment: the armed/idle/off model and *why there is no standing interval* (the user's requirement — an idle watchdog costs nothing and is observably idle); why a `setTimeout` chain and not `setInterval` (no overlap by construction); why grace applies to failures; why attempts count successes only; why state is in-memory (spec §9). Reference the incident run id.

- [ ] **Step 5: Wire** — `AgentsModule.providers` gains `WatchdogService`. Nothing else instantiates it; the bootstrap hook does the rest.

- [ ] **Step 6: Green** — `pnpm test -- watchdog-sweep && pnpm test && pnpm run typecheck` (the full run proves the jest guard keeps every other suite unchanged)

- [ ] **Step 7: Commit**

```bash
git add server/src/agents/watchdog.service.ts server/src/agents/agents.module.ts test/watchdog-sweep.test.ts test/helpers/env.ts jest.config.ts
git commit -m "feat(watchdog): armed-only sweeper that resumes crashed runs, capped"
```

---

### Task 5: The two watchdog routes and the client helpers

**Files:**
- Modify: `server/src/agents/agents.controller.ts`
- Modify: `client/src/lib/agents.ts`
- Create: `client/src/hooks/useWatchdog.ts`
- Test: `test/watchdog-routes.test.ts`

**Interfaces consumed:** `WatchdogService.status()`, `arm()`; `writeWatchdogConfig`.

**Interfaces produced:**

- `GET /api/agents/watchdog` → `WatchdogStatus`.
- `POST /api/agents/watchdog/config`, body `Partial<WatchdogConfig>` → `WatchdogStatus`. Guarded by `SameOriginPostGuard`.
- Client: `fetchWatchdog(): Promise<WatchdogStatus>`, `updateWatchdogConfig(patch: Partial<WatchdogConfig>): Promise<WatchdogStatus>`.
- `useWatchdog(): { status: WatchdogStatus | null; error: string | null; reload: () => Promise<void>; save: (patch: Partial<WatchdogConfig>) => Promise<void> }`, `WATCHDOG_POLL_MS = 5_000`.

- [ ] **Step 1: Write the failing tests** — `test/watchdog-routes.test.ts`, same app setup as Task 4's suite (`BM_WATCHDOG` deleted, temp `BM_ORCH_HOME` and `BM_WATCHDOG_FILE`).

| # | Request | Expected |
|---|---|---|
| 1 | `GET /api/agents/watchdog`, no runs, `BM_AGENTS=on` | 200; `phase 'idle'`; `config` equals defaults; `watching []`; `events` contains the boot `idle` event |
| 2 | `GET`, `BM_AGENTS` unset | `phase 'off'`, `reason 'BM_AGENTS off'` |
| 3 | `POST /api/agents/watchdog/config` `{ graceMs: 1 }` | 200; response `config.graceMs 300000`; the file on disk agrees |
| 4 | `POST` `{ enabled: false }` then `GET` | both show `enabled false`; other fields unchanged |
| 5 | `POST` `{ unknownKey: 1 }` | 200; file has no `unknownKey`; config unchanged |
| 6 | `POST` with body `"x"` / `[]` / `null` | 400 `{ error: 'bad body' }`; file untouched |
| 7 | `POST` `{ enabled: true }` while one crashed run exists and the file previously said `enabled: false` | the response's `phase` is `'armed'` and a spawn was made — the save armed and ticked |
| 8 | `POST` with `Origin: http://evil.example` | the guard's rejection; file untouched |
| 9 | `GET` after Task 4's case-1 scenario (one spawn) | `events[0].kind` is `'spawned'` |

Hook (`test/orchestrator-hook.test.tsx` style, jsdom, fake timers) — put these in the same file under a second `describe`, or a sibling `test/watchdog-hook.test.tsx`; say which in the commit:

| # | Sequence | Assertion |
|---|---|---|
| 10 | mount with `phase 'armed'` | one fetch on mount; another after `5_000`ms |
| 11 | mount with `phase 'idle'` | one fetch on mount; none after `5_000`ms |
| 12 | `window` focus event | one more fetch |
| 13 | `save({ tickMs: 120000 })` | one POST with exactly that body; `status` replaced by the POST's response without an extra GET |
| 14 | fetch rejects | `status` stays `null`, `error` is a non-empty string, nothing thrown |

- [ ] **Step 2: Run and confirm failure** — `pnpm test -- watchdog-routes`

- [ ] **Step 3: Routes.** Controller constructor gains `private readonly watchdog: WatchdogService`. `GET` returns `watchdog.status()`. `POST` checks `typeof body === 'object' && body !== null && !Array.isArray(body)` else 400 `{ error: 'bad body' }`; rebuilds `{ enabled, tickMs, graceMs, maxAttempts }` from the body field by field (undefined stays out); `writeWatchdogConfig(patch)`; `watchdog.arm()`; returns `watchdog.status()`. Comment: why it arms (the toggle flipping on while a run is crashed must act now, not at the next board poll), why unknown keys drop (the `model`/`effort` rule), and that the CLAUDE.md line about "the two agents POSTs" is now four — Task 9 rewrites it.

- [ ] **Step 4: Client helpers and hook.** `fetchWatchdog`/`updateWatchdogConfig` via `unwrap`. `useWatchdog` mirrors `useAgents` (mount + focus) plus the armed-only poll pattern from `useOrchestratorRuns` (interval exists only while `status?.phase === 'armed'`), and `save` sets `status` from the POST response. A `mountedRef` guard as `useOrchestratorRuns` has.

- [ ] **Step 5: Green** — `pnpm test -- watchdog-routes watchdog-hook && pnpm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add server/src/agents/agents.controller.ts client/src/lib/agents.ts client/src/hooks/useWatchdog.ts test/watchdog-routes.test.ts test/watchdog-hook.test.tsx
git commit -m "feat(watchdog): status and config routes, client helpers and hook"
```

---

### Task 6: The board — a crashed strip instead of a vanished one

**Files:**
- Create: `client/src/lib/run-watchdog.ts`
- Modify: `client/src/hooks/useOrchestratorRuns.ts` (~103-134)
- Modify: `client/src/components/board/RunStrip.tsx` (doc comment ~40-75, the early return ~74, render ~90-160)
- Modify: `client/src/components/board/BoardView.tsx` (`freshRuns` ~270, strip render ~618-634, `orchestrateGate` ~417)
- Modify: `client/src/styles.css`
- Test: `test/run-watchdog.test.ts` (new), `test/orchestrator-strip.test.tsx`, `test/orchestrator-hook.test.tsx`

**Interfaces consumed:** `RunWatchdog`, `resumeOrchestrate`, `ApiError` (`client/src/lib/agents.ts`), `RUN_IN_PROGRESS_CODE`, `projectDispatchGate`, `elapsedSince` (`lib/item-age.ts`).

**Interfaces produced:**

- `isCrashed(run: { status: OrchestratorRun['status']; fresh: boolean }): boolean`
- `watchdogClause(w: RunWatchdog | undefined, now?: number): string` — exactly one of:
  - `'watchdog: waiting for next check'` — `w` defined, `attempts 0`, `lastError null`, `enabled true`, not exhausted
  - `'watchdog: attempt N/M spawned HH:MM'` — `attempts > 0`, `lastError null`, not exhausted (`HH:MM` local time of `lastSpawnAt`)
  - `'watchdog: resume failed: <lastError>'` — `lastError` non-null, not exhausted, enabled
  - `'watchdog: exhausted after N — resume by hand'` — `exhausted`
  - `'watchdog: off — resume by hand'` — `enabled false` (wins over everything but `exhausted`)
  - `''` when `w` is undefined (a crashed run the server has not annotated — should not happen; render nothing rather than a wrong clause)
- `RunStrip` props become `{ run: RunPayload; onOpen: (run: RunPayload) => void; canResume?: boolean; resumeBlockedReason?: string | null; onResumed?: () => void }`.

- [ ] **Step 1: Write the failing tests**

`test/run-watchdog.test.ts` (node): one row per clause above, plus `isCrashed` on the four combinations of `{ status running|done } × { fresh true|false }` — true only for running+stale. `HH:MM` case: pass a fixed `lastSpawnAt` and assert the string contains the local `HH:MM` of that instant (compute expected with `toLocaleTimeString` in the test, not a literal).

`test/orchestrator-strip.test.tsx` — **replace** `renders no strip for a stale run` (~69) with:

| # | `runPayload({...})` | Assertion |
|---|---|---|
| 1 | `fresh: false`, `status: 'running'`, `watchdog: { enabled: true, attempts: 0, maxAttempts: 2, lastSpawnAt: null, lastSessionId: null, lastError: null, exhausted: false }` | `run-strip` present; has class `run-strip-crashed`; text contains `crashed`, `no heartbeat for`, `last reported task-14 at reviewing` (the fixture's first non-terminal item), `watchdog: waiting for next check`; **no** `Resume` button |
| 2 | as 1, `attempts 1`, `lastSpawnAt` set | text contains `attempt 1/2 spawned`; no Resume button |
| 3 | as 1, `lastError 'busy'` | text contains `resume failed: busy` |
| 4 | as 1, `exhausted true`, `attempts 2`, `canResume` | text contains `exhausted after 2 — resume by hand`; a button named `Resume run` present and enabled |
| 5 | as 1, `enabled false`, `canResume` | text contains `off — resume by hand`; Resume button present |
| 6 | as 4 but `canResume` false | no Resume button |
| 7 | as 4, `canResume`, `resumeBlockedReason 'the dashboard cannot see this project'` | Resume button present, `disabled`, `title` equals the reason |
| 8 | `fresh: false`, `status: 'done'` | container empty |
| 9 | `fresh: false`, `status: 'aborted'` / `'failed'` | container empty |
| 10 | `fresh: true` | no `run-strip-crashed` class; no `crashed` text — today's rendering unchanged (the existing `3/6` case still passes) |
| 11 | case 4; click Resume; `fetch` stub answers 200 `{ sessionId: 's' }` | one POST to `/api/agents/resume` with body `{ project: fixture.project }`; `onResumed` called once; `onOpen` **not** called |
| 12 | case 4; click Resume; stub answers 409 `{ error: 'alive', code: 'run-in-progress' }` | no error text rendered; `onResumed` called |
| 13 | case 4; click Resume; stub answers 502 `{ error: 'dashboard down' }` | text `dashboard down` appears inside the strip; `onResumed` not called |
| 14 | click anywhere on a crashed strip except the button | `onOpen` called with the run |

BoardView cases in the same file (it already renders `BoardView` with stubs):

| # | `runs` payload | Assertion |
|---|---|---|
| 15 | one running stale run for `/abs/alpha`, agents status `enabled` with `projectPaths: ['/abs/alpha']` | a `run-strip-crashed` strip renders; the existing case at ~236/270 that asserts a stale run pins/badges nothing **still passes** — cards are untouched |
| 16 | as 15, `projectPaths: []` | strip renders; its Resume button (with `exhausted true`) is `disabled` with the gate's reason |
| 17 | as 15, agents status `enabled: false` | strip renders; no Resume button |
| 18 | one running stale run and one fresh run, different projects | two strips |

`test/orchestrator-hook.test.tsx` — extend:

| # | Sequence | Assertion |
|---|---|---|
| 19 | payload `{ status 'running', fresh false }` | a fetch fires after `5_000`ms (polls while crashed) |
| 20 | then the stub returns `{ status 'done', fresh false }` | no fetch after the next `5_000`ms |

- [ ] **Step 2: Run and confirm failure** — `pnpm test -- run-watchdog orchestrator-strip orchestrator-hook`

- [ ] **Step 3: `run-watchdog.ts`.** Two pure functions, header comment: one implementation of the five phrasings so the strip and any later surface cannot disagree; why `off` outranks a pending attempt but not `exhausted`.

- [ ] **Step 4: The hook.** `anyFresh` becomes `anyLive = runs.some((run) => run.fresh || run.status === 'running')`; rename the variable and rewrite the block comment: a crashed strip without a poll is a screenshot — the attempt counter, the error, and the recovery would all wait for a focus event.

- [ ] **Step 5: `RunStrip`.** Replace the early return with `if (!run.fresh && run.status !== 'running') return null;`. Branch the render on `isCrashed(run)`: a `crashed` strip keeps the outer `<button className="run-strip run-strip-crashed" data-testid="run-strip">` (so `onOpen` and the drawer keep working), shows the project label, the word `crashed`, `no heartbeat for <elapsedSince(updatedAt)>`, `last reported <id> at <stage>` when a non-terminal item exists (else `all items at rest` — say so plainly), the `watchdogClause`, and, when `canResume`, a nested control for Resume. **A button cannot nest in a button**: render the Resume control as a `<span role="button" tabIndex={0} aria-label="Resume run">` that stops propagation on click and handles Enter/Space, or restructure the crashed strip's root as a `<div>` with an inner open-button — pick one, and make case 14 pass either way. `aria-disabled` + `title` for the blocked case. Click → `resumeOrchestrate(run.project)`; on success or on `ApiError` with `code === RUN_IN_PROGRESS_CODE` → `onResumed?.()`; any other error → local state rendered as `<span className="run-strip-error">`. Rewrite the file-level doc comment per spec §6.1 (keep the "guess as a fact" reasoning for the *stage* prefix; replace the vanish conclusion; name `run-20260903-112622`).

- [ ] **Step 6: `BoardView`.** Add `const runningRuns = runs.filter((run) => run.status === 'running');` beside `freshRuns` (which stays, for badges/claims — its comment at ~254 gets one sentence on why a second list exists). The strip block maps `runningRuns`. Per strip: `gate = agents === null ? null : projectDispatchGate(agents, run.project)`; `canResume = gate !== null && gate.control !== 'hidden'`; `resumeBlockedReason = gate?.control === 'disabled' ? gate.reason : null`; `onResumed={refreshRuns}`. Update the block comment at ~618-624 ("RunStrip filters its own staleness") to describe the new split.

- [ ] **Step 7: Styles.** `.run-strip-crashed` — a distinct tone from live (use the existing attention/alert variables the stage chips for `parked` use; check `styles.css` for the theme tokens rather than inventing a colour); `.run-strip-watchdog` for the clause; `.run-strip-resume` for the control, with `[aria-disabled="true"]` dimmed; `.run-strip-error`. Every theme in `shared/theme.css` must still read; do not hard-code hex.

- [ ] **Step 8: Green** — `pnpm test -- run-watchdog orchestrator-strip orchestrator-hook && pnpm run typecheck`

- [ ] **Step 9: Commit**

```bash
git add client/src/lib/run-watchdog.ts client/src/hooks/useOrchestratorRuns.ts client/src/components/board/RunStrip.tsx client/src/components/board/BoardView.tsx client/src/styles.css test/run-watchdog.test.ts test/orchestrator-strip.test.tsx test/orchestrator-hook.test.tsx
git commit -m "feat(board): render a crashed run as crashed, with the watchdog's verdict"
```

---

### Task 7: Settings — "Orchestrator watchdog · this server"

**Files:**
- Create: `client/src/components/settings/WatchdogGroup.tsx`
- Modify: `client/src/components/settings/SettingsView.tsx` (~191, after `<AgentsGroup />`)
- Modify: `client/src/styles.css` (`.watchdog-events`)
- Test: `test/settings-watchdog.test.tsx`

**Interfaces consumed:** `useWatchdog` (Task 5), `WATCHDOG_LIMITS`, `WatchdogStatus`, `SettingsGroup`/`SettingsRow` (`SettingsRow.tsx`), `formatSpanCompact` (`lib/run-time.ts`).

**Interfaces produced:**

- `TICK_LADDER = [30_000, 60_000, 120_000, 300_000, 600_000]`, `GRACE_LADDER = [300_000, 600_000, 1_200_000, 1_800_000, 3_600_000]`, `ATTEMPT_LADDER = [1, 2, 3, 4, 5]` — exported from `WatchdogGroup.tsx` for the test.
- `stateLine(status: WatchdogStatus, now?: number): string` — exported pure helper:
  - `'off — BM_AGENTS off'` / `'off — BM_WATCHDOG off'` (the `reason`)
  - `'idle — no running run'`
  - `'armed — watching <runIds joined by ", ">, next check in <N>s'`
  - either of the last two gets `' · resume disabled'` appended when `config.enabled` is false.

- [ ] **Step 1: Write the failing tests** — `test/settings-watchdog.test.tsx`, jsdom, render `SettingsView` inside `SettingsProvider` as `test/settings-view.test.tsx` does, with `fetch` stubbed per URL (`/api/agents/status` → the existing default; `/api/agents/watchdog` → a `WatchdogStatus` per case).

| # | Status stub | Assertion |
|---|---|---|
| 1 | `phase 'idle'`, defaults | group titled `Orchestrator watchdog · this server` present; state row reads `idle — no running run`; the hint names `~/.backlog-manager/settings/watchdog.json` and says the values are shared by every device |
| 2 | `phase 'off'`, `reason 'BM_AGENTS off'` | state row `off — BM_AGENTS off`; the three selects and the checkbox are still rendered (not gated) |
| 3 | `phase 'armed'`, `watching ['run-a']`, `nextTickAt` 42s ahead, `config.enabled false` | `armed — watching run-a, next check in 42s · resume disabled` |
| 4 | every value of the three ladders | each is `>= min` and `<= max` of its `WATCHDOG_LIMITS` entry — assert programmatically over the exported arrays |
| 5 | defaults | the `Check every` select shows `1m`, `Leave a resumed run alone for` shows `10m`, `Give up after` shows `2` |
| 6 | `config.tickMs 45_000` (not on the ladder) | the select still shows `45s` as its selected option — an extra option, never a silent snap to a neighbour |
| 7 | change `Give up after` to `3` | exactly one POST to `/api/agents/watchdog/config` with body `{ maxAttempts: 3 }`; afterwards the select shows the POST response's value |
| 8 | uncheck `Enabled` | one POST `{ enabled: false }` |
| 9 | `events` with three entries | the Activity list renders three rows, first row is `events[0]`, each row contains the local `HH:MM` of `at`, the project's basename, and `detail` |
| 10 | `events []` | Activity shows `nothing since the server started` |
| 11 | `/api/agents/watchdog` rejects | the group renders with a one-line unavailable notice and no controls throw |

- [ ] **Step 2: Run and confirm failure** — `pnpm test -- settings-watchdog`

- [ ] **Step 3: Build the group.** Rows in spec §6.4's order: State, Enabled, Check every, Leave a resumed run alone for, Give up after, Activity. Labels on the selects via `aria-label` matching the row names. Ladder options render through `formatSpanCompact` (`30s`, `1m`, `2m`, …). The header comment explains *this server* against the neighbours' *this machine*/*this device*, and why selects rather than number fields (a clamp the user cannot see is a setting that silently does not stick). Mount `<WatchdogGroup />` directly after `<AgentsGroup />`.

- [ ] **Step 4: Green** — `pnpm test -- settings-watchdog settings-view && pnpm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add client/src/components/settings/WatchdogGroup.tsx client/src/components/settings/SettingsView.tsx client/src/styles.css test/settings-watchdog.test.tsx
git commit -m "feat(settings): orchestrator watchdog group with knobs and activity"
```

---

### Task 8: The skill side — heartbeat first on `--resume`

**Files:**
- Modify: `skills/backlog-orchestrate/references/recovery.md` (the `### --resume` section, ~11-20)
- Modify: `skills/backlog-orchestrate/SKILL.md` (`### --resume and --abort`, ~1091)

No tests: prose only, no `.mjs` change. Verification is reading the result against spec §7.

- [ ] **Step 1: `recovery.md`.** Insert, before the `reconcile` block, a step that runs `orchestrate.mjs status` and then — only when it prints `running` — `orchestrate.mjs heartbeat`, and explain in the file's own voice: the board's watchdog stands down the instant the run reads fresh, so this is what turns the crashed strip live again and cancels a second spawn that grace alone would only delay; it also shrinks the human-versus-watchdog double-resume window from about ninety seconds (the measured gap on `run-20260903-112622`'s own resume) to a few. State that `status` runs first so a finished run is never re-stamped. Keep `reconcile`'s "read-only" sentence intact after it.

- [ ] **Step 2: `SKILL.md` §10.** One sentence after the pointer to `recovery.md`: the board may spawn `--resume` itself for a run whose heartbeat has gone stale, so this path is entered unattended and must stay safe to enter that way — which it is, everything before `reconcile`'s verdicts being read-only. Do not add more; the skill body is re-read every turn (see `rationale.md`).

- [ ] **Step 3: Commit** (publishing — commit, push, `pnpm run plugin:sync` — is the user's call, per the invariant; say so in the handoff)

```bash
git add skills/backlog-orchestrate/references/recovery.md skills/backlog-orchestrate/SKILL.md
git commit -m "docs(orchestrate): heartbeat before reconcile on --resume"
```

---

### Task 9: Documentation and the final gate

**Files:**
- Modify: `CLAUDE.md` (Layout ~31-33 and ~58-70; Invariants — new bullets after "One run per project, checked twice", amend ~403)
- Modify: `docs/invariants.md` (new section before "Queue wait is not work", ~749)

- [ ] **Step 1: `CLAUDE.md` Layout.** `agents/` bullet: "status, plan, dispatch, orchestrate, resume, and the run watchdog (`watchdog.service.ts`, armed only while some run.json says running)". `orchestrator/` bullet: add "`watchdog-state.service.ts` — the in-memory record of what the watchdog did, annotated onto `/api/orchestrator/runs` as `watchdog` on crashed runs only — and `watchdog-config.util.ts`, the one file the server writes". Client bullet: after the run strip description, "a crashed run (running, heartbeat stale) renders as crashed with the watchdog's verdict and, when the watchdog is exhausted or off, a Resume control"; Settings gains "and an Orchestrator watchdog group (`WatchdogGroup.tsx`, server-side knobs and activity, via `hooks/useWatchdog.ts`)".

- [ ] **Step 2: `CLAUDE.md` Invariants.** Add, each in the existing register, with the "why" in one or two sentences and a pointer to `docs/invariants.md`:
  - **The watchdog spawns; it never writes the run file.** `runs()` stays the one reader; attempt state is in-memory and lost on restart on purpose; `settings/watchdog.json` is the server's one write, its own single writer, under its own read-write mount.
  - **A crashed run renders as crashed, never as nothing.** Supersedes the strip's silence rule; the strip states heartbeat age, *last reported* stage and the watchdog's verdict — facts, not guesses. Badges, card bars and `runClaimBlock` stay freshness-based.
  - **The watchdog is armed only while some `run.json` says `running`.** Arms on the reads the board already makes, on spawn success, and on a boot scan; a terminal-started run with the board closed is never watched.
  - **`useOrchestratorRuns` polls while any run is `running`, fresh or not.**
  - **Any spawn attempt starts the grace clock; only a success counts against the cap.**
  - Amend ~403: "**Every agents POST is guarded by content-type and origin**" (dispatch, orchestrate, resume, watchdog/config).

- [ ] **Step 3: `docs/invariants.md`.** New section `## The watchdog spawns; it never writes the run file` carrying the incident table from the spec's "Why this exists", the armed/idle/off model, the grace rule, the in-memory decision and its restart cost, the settings-file exception and why it is a directory mount, and the declined prevention layer named as declined. Reference the spec file.

- [ ] **Step 4: Final gate** — `pnpm test && pnpm run typecheck && pnpm run build`. All three green before the commit.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/invariants.md
git commit -m "docs: watchdog invariants — spawns never writes, crashed never silent"
```

---

## Self-Review

**Spec coverage:** §1 vocabulary → Task 1 types, Task 4 phase rules. §2.1 arming → Task 4 steps 4–5, Task 2 `observe`. §2.2 tick → Task 4 cases 1–15, 21. §2.3 cost → Task 4 case 13 (no probe when disabled) and case 2 (no spawn when fresh). §3 `resume()` → Task 3. §4 state + §4.1 payload → Task 2. §4.2 `GET watchdog` → Task 5. §5.1 file + mount → Task 1 steps 4–5. §5.2 clamps → Task 1 cases 1–8. §5.3 `POST config` → Task 5 cases 3–8. §6.1 strip → Task 6. §6.2 unchanged surfaces → Task 6 case 15. §6.3 polling → Task 6 cases 19–20. §6.4 Settings → Task 7. §7 skill → Task 8. §8 test list → distributed. §9 → Task 9 docs. No gaps found.

**Two things the spec did not anticipate,** added here: (1) a bootstrap scan under jest would read the developer's real orchestrator directory in every suite that leaves `BM_ORCH_HOME` unset, so `BM_WATCHDOG=off` exists as an env kill switch and a jest `setupFiles` default (Task 4 step 1; spec §5.1 amended in the same commit as this plan); (2) a `<button>` cannot contain a `<button>`, so the strip's Resume control needs the structural decision Task 6 step 5 names.

**Placeholder scan:** no TBD, no "handle edge cases", no "similar to Task N". Every test step names its cases and expected values. Code blocks are commands and commit messages only, per the convention at the top.

**Type consistency:** `WatchdogConfig`, `WATCHDOG_LIMITS`, `DEFAULT_WATCHDOG_CONFIG`, `WatchdogPhase`, `WatchdogEventKind`, `WatchdogEvent`, `WATCHDOG_EVENT_CAP`, `RunWatchdog`, `WatchdogStatus`, `WatchdogEntry`, `WatchdogStateService` (`setPhase`, `entry`, `upsert`, `prune`, `push`, `events`, `spawningEnabled`, `annotate`, `setArmer`, `observe`, `status`), `WatchdogService` (`arm`, `disarm`, `tick`, `status`, `armed`), `watchdogFile`, `watchdogEnvOff`, `clampWatchdogConfig`, `readWatchdogConfig`, `writeWatchdogConfig`, `RESUME_PROMPT`, `resume`, `resumeSessionName`, `resumeOrchestrate`, `fetchWatchdog`, `updateWatchdogConfig`, `useWatchdog`, `WATCHDOG_POLL_MS`, `isCrashed`, `watchdogClause`, `stateLine`, `TICK_LADDER`, `GRACE_LADDER`, `ATTEMPT_LADDER`, `canResume`, `resumeBlockedReason`, `onResumed` are spelled identically in every task that mentions them. `resume`'s second parameter is the literal union `'watchdog' | 'board'` in Tasks 3 and 4 alike.
