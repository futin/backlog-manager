# Orchestrator Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A board control that asks a running orchestrator run to stop at the
next item boundary and leave the run resumable — `paused`, a fifth run
status — with the request carried in a server-owned file the tool reads at
its two dispatch gates, and Pause / Cancel / Resume offered on both the
Board's run drawer and the Runs view's detail pane.

**Architecture:** The server writes
`~/.backlog-manager/settings/orchestrator-control/<encodeURIComponent(project)>.json`
(`{ runId, requestedAt }`) on `POST /api/agents/pause`; `orchestrate.mjs`
reads it and refuses `stage <id> preflight` / `stage <id> dispatched` with a
new exit code `6` when the request is *effective* — pinned to this run and
made after it last began or resumed running. The skill then runs
`finish --status paused`; a later `--resume` runs the new `unpause` command.
`run.json` keeps its single writer; the watchdog needs no change because a
paused run is never `running`. The client derives "pausing" from the runs
payload's new `pauseRequested` flag, renders `paused` runs on the strip and
in the Runs view, and hosts one shared `RunControls` component on both
surfaces.

**Tech Stack:** Node ESM tool (`skills/backlog-orchestrate/tools/orchestrate.mjs`,
`node --test`), NestJS server (jest + supertest), React 18 client (jest +
jsdom + @testing-library), shared TypeScript types in `shared/`. pnpm only.

**Spec:** `docs/superpowers/specs/2026-09-05-orchestrator-pause-design.md`
— section numbers below (§2.3, §5.3 …) are that document's.

## How to read this plan — tests are authoritative, code is illustrative

This repo's own rule (root `~/.claude/CLAUDE.md`, "Implementation plans
specify behaviour and exact test *cases*, never literal code") overrides the
writing-plans template's "code blocks required". Every task below gives:
exact files and line anchors, the signatures neighbouring tasks depend on,
the **behaviour**, and the **test cases with their expected values**. Where
a code block appears it shows a shape or a signature, not text to
transcribe — if the test cases and a snippet disagree, the test cases win,
and the implementer is expected to disagree with a snippet when the
codebase says otherwise. Comments in this codebase explain *why*, at
length; match that density, do not strip it.

**Commit steps** apply to hand execution. Under `backlog-orchestrate`,
`backlog-execute` never commits — skip them; the run commits once.

**Publishing.** Tasks 2 and 9 edit `skills/`. Nothing there changes until
the merge is pushed and `pnpm run plugin:sync` has run; the board spawns
runs from the *installed* plugin. Not a task in this plan — a step after
the merge.

## Global Constraints

- `run.json` has exactly one writer, `orchestrate.mjs`. No task here adds a
  server write to it, and no task adds a second reader of `orchHome()`.
- Control file: `<controlHome>/<encodeURIComponent(project)>.json`, where
  `controlHome` is `$BM_ORCH_CONTROL_HOME` or
  `~/.backlog-manager/settings/orchestrator-control`. Shape exactly
  `{ "runId": string, "requestedAt": ISO-8601 string }`. Written
  atomically (temp file + `rename`), deleted on cancel.
- Effective request, both processes, verbatim:
  `control.runId === run.runId && Date.parse(control.requestedAt) > Date.parse(run.unpausedAt ?? run.startedAt)`.
  Missing file, unparseable file, missing/non-string field, unparseable
  date → not effective. Never stored.
- Run status union: `'running' | 'done' | 'aborted' | 'failed' | 'paused'`.
  New optional run field `unpausedAt?: string`, written only by `unpause`.
- Tool exit code `6`: `stage <id> preflight` / `stage <id> dispatched`
  refused because a pause request is effective **and the call is a
  transition** (item's current stage differs). Nothing written on a `6`.
- Route: `POST /api/agents/pause`, body `{ project: string, cancel?: boolean }`,
  `200 { pauseRequested: boolean }`, origin-guarded, independent of
  `BM_AGENTS`, never calls the dashboard. 400 on missing project; 409
  `{ error: 'no running run to pause for this project' }` unless the
  project's run is `status === 'running'` (fresh or stale).
- `resume()` accepts `paused` beside crashed `running`; the 409 text
  becomes `no crashed or paused run to resume for this project`.
- Client: `RESUME_POLL_GRACE_MS = 180_000` (exported from
  `client/src/hooks/useOrchestratorRuns.ts`).
- Copy, verbatim: strip chip `pausing · finishes <id>` (or `pausing` with
  no in-flight item); control text `Pausing after <id>` (or
  `Pausing at the next boundary`); buttons `Pause` (title
  `pause after the current item`), `Cancel`, `Resume run`; placeholder
  `Resuming…`; paused strip `paused · N of M done`; Runs row badge
  `pausing`.
- Tests flat in `test/` (`*.test.ts` / `*.test.tsx`, jsdom via docblock);
  tool tests in `skills/backlog-orchestrate/tools/orchestrate.test.mjs`
  under node's runner (`pnpm run test:skills`). `pnpm test`,
  `pnpm run test:skills`, `pnpm run typecheck` must all pass at the end of
  every task.
- No `docker-compose.yml` change: `settings/` is already the read-write
  nested mount.

---

## File map

| File | Responsibility |
|---|---|
| `shared/types.ts` | status union + `unpausedAt`, payload `pauseRequested`, `PauseResult` |
| `shared/agent.ts` | `resumeGate` — the one environment-half resume gate both views read |
| `skills/backlog-orchestrate/tools/orchestrate.mjs` | `controlHome`/`controlFilePath`/`pauseRequestEffective`, two gates, `finish paused`, `unpause`, exit `6` |
| `skills/backlog-orchestrate/tools/orchestrate.test.mjs` | harness gains a throwaway `BM_ORCH_CONTROL_HOME`; the tool cases |
| `server/src/orchestrator/pause-control.util.ts` (new) | the server's read/write/clear of the control file + its copy of the predicate |
| `server/src/orchestrator/orchestrator.service.ts` | `runs()` annotates `pauseRequested` |
| `server/src/agents/agents.service.ts` | `pause()`, `resume()` widened + clears the file |
| `server/src/agents/agents.controller.ts` | `POST /api/agents/pause` |
| `client/src/hooks/useOrchestratorRuns.ts` | `noteResume` / `resuming` / `RESUME_POLL_GRACE_MS` |
| `client/src/lib/agents.ts` | `pauseOrchestrate`, `cancelPauseOrchestrate` |
| `client/src/components/RunControls.tsx` (new) | Pause / Cancel / Resume, one component, two hosts |
| `client/src/components/board/RunDrawer.tsx`, `RunStrip.tsx`, `BoardView.tsx` | drawer hosts controls; strip shows pausing chip and the paused strip |
| `client/src/components/runs/RunsView.tsx`, `RunDetail.tsx` | row `pausing` badge; pane hosts controls; `useAgents` for the gate |
| `client/src/lib/run-stage.ts`, `run-stats.ts` | `paused` in every status record |
| `client/src/styles.css` | `.runs-status-paused`, `.run-strip-pausing`, `.run-strip-paused`, `.run-controls*` |
| `skills/backlog-orchestrate/SKILL.md`, `references/recovery.md` | exit `6`, Pausing step, `unpause` on resume, preflight-leftover rule |
| `test/helpers/env.ts` | defaults `BM_ORCH_CONTROL_HOME` to a temp dir for every suite |
| `CLAUDE.md`, `docs/subsystems/invariants.md`, `watchdog-config.util.ts` header | the new invariant, the amended sentence |

---

### Task 1: Vocabulary — `paused` compiles everywhere, `pauseRequested` rides the payload, `resumeGate` is one function

**Files:**
- Modify: `shared/types.ts:597` (status union), add `unpausedAt?: string` beside `updatedAt` (~`:599`), `OrchestratorRunsPayload` `:654-656`, add `PauseResult` beside `AgentDispatchResult`
- Modify: `shared/agent.ts` — add `resumeGate` directly after `projectDispatchGate` (~`:330`)
- Modify: `client/src/lib/run-stage.ts:126-144` (`RUN_STATUS_GLYPH`, `RUN_STATUS_CLASS`)
- Modify: `client/src/components/runs/RunsView.tsx:286` (`STATUS_ORDER`)
- Modify: `client/src/lib/run-stats.ts:637-641` (`byStatus` initialiser)
- Modify: `client/src/components/board/BoardView.tsx:668-670` (call `resumeGate`)
- Modify: `client/src/styles.css:1571-1574` (add `.runs-status-paused`)
- Modify (fixtures only — add `pauseRequested: false` wherever a runs-payload entry is built with `pastRuns`): `test/archive.test.tsx`, `test/dispatch-button.test.tsx`, `test/board.test.tsx`, `test/orchestrator-drawer.test.tsx`, `test/orchestrator-strip.test.tsx`, `test/orchestrator-hook.test.tsx`, `test/orchestrator-start-ui.test.tsx`, `test/run-time-ui.test.tsx`, `test/runs-view.test.tsx`, `test/watchdog-coupling.test.tsx`, `test/agents-shared.test.ts`, `test/agents-client.test.ts`, `test/orchestrator-runs.test.ts`, `test/item-stale.test.ts`, `test/watchdog-state.test.ts`
- Test: `test/run-stage.test.ts:94-112`, `test/run-stats.test.ts:563,713`, `test/agents-shared.test.ts` (new `describe('resumeGate')`)

**Interfaces:**
- Produces:
  - `OrchestratorRun['status']` includes `'paused'`; `OrchestratorRun.unpausedAt?: string`.
  - `OrchestratorRunsPayload['runs'][number]` gains `pauseRequested: boolean` (mandatory, like `fresh`).
  - `export interface PauseResult { pauseRequested: boolean }`.
  - `export function resumeGate(status: AgentsStatus | null, projectPath: string): { canResume: boolean; blockedReason: string | null }` in `shared/agent.ts`.
  - `RUN_STATUS_GLYPH.paused === '‖'`, `RUN_STATUS_CLASS.paused === 'runs-status-paused'`.

- [ ] **Step 1: Write the failing tests**

  `test/run-stage.test.ts`: add `'paused'` to `ALL_STATUSES`; extend the
  class-literal test with `expect(RUN_STATUS_CLASS.paused).toBe('runs-status-paused')`;
  add a case: every glyph is distinct (`new Set(Object.values(RUN_STATUS_GLYPH)).size === 5`).

  `test/run-stats.test.ts:563`: expected `byStatus` becomes
  `{ done: 1, failed: 1, running: 1, aborted: 0, paused: 0 }`; `:713` gains
  `paused: 0`. Add one case: a run with `status: 'paused'` counts under
  `byStatus.paused` and is neither completed nor failed in whatever
  aggregate counters the existing suite asserts for `done`/`failed` (read
  the file's own `aggregateRuns` cases and mirror the nearest one).

  `test/agents-shared.test.ts`, new `describe('resumeGate')`, reusing the
  suite's `OK` status:
  - `resumeGate(null, '/abs/alpha')` → `{ canResume: false, blockedReason: null }`
  - `resumeGate(OK, '/abs/alpha')` → `{ canResume: true, blockedReason: null }`
  - each environment block (`enabled:false`, `reachable:false`, `spawnAvailable:false`, `remoteAnswer:false`) → `{ canResume: false, blockedReason: null }`
  - `projectPaths: ['/abs/other']` → `canResume: true`, `blockedReason` contains `/abs/alpha`
  - for every status above, the result equals
    `{ canResume: g.control !== 'hidden', blockedReason: g.control === 'disabled' ? g.reason : null }`
    with `g = projectDispatchGate(status, '/abs/alpha')` — the exact three
    lines it replaces in `BoardView.tsx:668-670`.

- [ ] **Step 2: Run them — expect compile failures on the union and `Record`s, and `resumeGate is not a function`**

  Run: `pnpm exec jest test/run-stage.test.ts test/run-stats.test.ts test/agents-shared.test.ts`

- [ ] **Step 3: Implement**

  - `shared/types.ts`: extend the union; add `unpausedAt?: string` with a
    doc comment saying who writes it (`orchestrate.mjs unpause`, nothing
    else), why it is optional (run files written before this feature), and
    what reads it (both copies of the effectiveness predicate). Add
    `pauseRequested: boolean` to the payload entry type with a comment
    pointing at spec §2.3 — derived per request, never stored. Add
    `PauseResult`.
  - `shared/agent.ts`: `resumeGate` per the table above; its doc comment
    says it is the environment half only (dashboard reachable, project
    visible) and that the watchdog half (`watchdogStoodDown`) stays the
    crashed strip's own concern.
  - `run-stage.ts`: `paused: '‖'` / `'runs-status-paused'`; `RunsView`
    `STATUS_ORDER` → `['running', 'paused', 'done', 'aborted', 'failed']`
    (the one non-running status with a future sits beside running);
    `run-stats.ts` `byStatus` initialiser gains `paused: 0`.
  - `styles.css`: `.runs-status-paused { color: var(--ink3) }` beside the
    other four (neutral: paused is neither good nor bad).
  - `BoardView.tsx:668-670` → `const { canResume, blockedReason: resumeBlockedReason } = resumeGate(agents, run.project);`
  - Every listed fixture builder: add `pauseRequested: false`. ts-jest
    treats type errors as failures, so `pnpm test` is the checklist.

- [ ] **Step 4: Run the whole suite and typecheck**

  Run: `pnpm test && pnpm run typecheck` — expected: all green; zero
  behaviour change outside the three suites edited.

- [ ] **Step 5: Commit**

  `feat(pause): paused status, pauseRequested on the payload, resumeGate`

---

### Task 2: Tool — control file read, two gates with exit `6`, `finish --status paused`, `unpause`

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs` — `orchHome` block `:112-137` (add `controlHome`, `controlFilePath`), `OrchestrateError` header `:38-50`, `cmdStage` `:1309-1400`, `FINISH_STATUSES` `:1519`, `cmdStatus` `:1569-1583`, `USAGE` `:2376-2392`, main's exit table `:2402-2427`, main dispatch `:2436-2444`
- Modify: `skills/backlog-orchestrate/tools/orchestrate.test.mjs` — `orchFixture` `:41-54`, `run` `:56-58`, plus the new cases
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs` `readRun`'s neighbours — a `readPauseRequest(project)` beside `readRun` `:337`

**Interfaces:**
- Produces (exported, tested by import like `RUN_STALE_MS` is):
  - `export function controlHome()` → `process.env.BM_ORCH_CONTROL_HOME || path.join(os.homedir(), '.backlog-manager', 'settings', 'orchestrator-control')`
  - `export function controlFilePath(root, project)` → `path.join(root, encodeURIComponent(project) + '.json')`
  - `export function pauseRequestEffective(control, run)` → boolean, the Global Constraints predicate, `false` for any malformed input
  - new command `unpause`; `finish --status paused` accepted; exit code `6`.
- Consumes: nothing from other tasks (the server's copy in Task 3 mirrors these by comment, never by import).

- [ ] **Step 1: Extend the harness**

  `orchFixture(t)` also creates `control = home + '-control'` (mkdir) and
  removes it in `t.after`; return `{ home, project, control }`. `run(cwd, home, ...args)`
  passes `BM_ORCH_CONTROL_HOME: home + '-control'` in `env` — every
  existing call keeps its signature, and no test can ever read a
  developer's real control directory (the same reason `BM_ORCH_HOME` is
  pinned there). Add `controlFile(home, project)` mirroring `runFile`, and
  a `writeControl(home, project, { runId, requestedAt })` helper.

- [ ] **Step 2: Write the failing tests** (each seeds one ready task via `seedReadyTask`, `init`s, then acts)

  Gates:
  1. effective request (`runId` = the run's, `requestedAt` = now) → `stage <id> preflight` exits **6**; stderr contains `finish --status paused` and `<id>`; `run.json` byte-identical.
  2. item staged `preflight` first, then effective request → `stage <id> dispatched --worktree /w --branch b` exits 6; byte-identical.
  3. item already `dispatched`; effective request → `stage <id> dispatched --session s1` exits **0** and `sessionId` is `s1` (a re-stamp is not a transition).
  4. effective request → `stage <id> inspecting` (from `dispatched`) exits 0.
  5. request pinned to `run-19990101-000000` → `stage <id> preflight` exits 0.
  6. `requestedAt` one hour before `startedAt` → exits 0.
  7. run file hand-edited to carry `unpausedAt` = T; request at T−1s → exits 0; request at T+1s → exits 6.
  8. no control file → 0; control file `not json` → 0; `{ "runId": "…" }` (no `requestedAt`) → 0; `requestedAt: "yesterday"` → 0.

  Finish / unpause:
  9. `finish --status paused` → `status === 'paused'`, `updatedAt` strictly later; stdout `{"status":"paused"}`. Then `init --project <project>` exits 0, archives the paused file under `runs/`, and the new `run.json` is `running`.
  10. `unpause` on a paused run → exit 0; `status === 'running'`; `unpausedAt === updatedAt`; stdout parses to `{ status: 'running', unpausedAt: <that stamp> }`.
  11. `unpause` on `running`, `done`, `aborted`, `failed` (four cases) → exit 1, byte-identical.
  12. `unpause` with no run → exit 3.
  13. after `finish --status paused` + `unpause`, an effective-looking request written *before* the unpause → `stage <id> preflight` exits 0 (the spec's "retires the request that paused it").

  Status:
  14. effective request → `status` output contains `pause requested at <requestedAt>`; without → does not; `status --json` output has no `pauseRequested` key.

  Exports:
  15. `controlHome()` with the env var deleted equals `path.join(os.homedir(), '.backlog-manager', 'settings', 'orchestrator-control')`; with it set, equals the set value. `controlFilePath('/r', '/a/b')` === `/r/%2Fa%2Fb.json`.

- [ ] **Step 3: Run them — expect failures (`6` not produced, `unpause` unknown command, `paused` rejected by `finish`)**

  Run: `node --test skills/backlog-orchestrate/tools/orchestrate.test.mjs`

- [ ] **Step 4: Implement**

  - `controlHome`, `controlFilePath` beside `orchHome`/`projectDir`, with a
    comment naming spec §2.1 and why the file is under `settings/` (the
    compose mount) and why the tool now reads a server-owned file (the one
    reverse-direction file, and the reason a run field could not carry it).
  - `readPauseRequest(project)`: read `controlFilePath(controlHome(), project)`;
    ENOENT / parse error / non-object → `null`.
  - `pauseRequestEffective(control, run)`: the predicate; guard every
    field with `typeof === 'string'` and `Number.isFinite(Date.parse(...))`.
  - `cmdStage`: **after** `findQueueItem` (the gate needs the item's current
    stage) and **before** `applyQueueItemFields`:
    `if ((stage === 'preflight' || stage === 'dispatched') && item.stage !== stage && pauseRequestEffective(readPauseRequest(run.project), run)) throw new OrchestrateError(<message>, 6)`.
    The comment explains the transition rule (a re-stamp after the child
    exists must never be refused) and why these two stages (spec §3.1).
  - `FINISH_STATUSES` gains `'paused'`; `FINISH_USAGE` text follows.
  - `cmdUnpause()`: `readRun`; if `run.status !== 'paused'` throw
    `OrchestrateError('this run is <status>, not paused — nothing to unpause', 1)`;
    else `const at = nowISO(); run.status = 'running'; run.unpausedAt = at; run.updatedAt = at;`
    write; print `JSON.stringify({ status: 'running', unpausedAt: at })`.
    Comment: why a separate command and not `heartbeat` (spec §3.3).
  - `cmdStatus`: when effective, one extra line `pause requested at <requestedAt>` after `updated:`.
  - `USAGE` gains `unpause      mark a paused run running again (a --resume session's first write)`;
    main dispatch gains `if (cmd === 'unpause') return cmdUnpause()`.
  - Exit-code contract (both the `OrchestrateError` header and main's
    table): add `6` — "`stage <id> preflight`/`dispatched` refused because
    a pause request is effective for this run; nothing written; the skill
    finishes `paused`". Keep `5`'s "no other command ever returns it"
    sentence true.

- [ ] **Step 5: Run the tool suite**

  Run: `pnpm run test:skills` — expected: all green, including every
  pre-existing case (the harness change must be invisible to them).

- [ ] **Step 6: Commit**

  `feat(orchestrate): pause gates on preflight/dispatched, finish paused, unpause`

---

### Task 3: Server — `pause-control.util.ts`, `pauseRequested` on the runs payload, the test-env guard

**Files:**
- Create: `server/src/orchestrator/pause-control.util.ts`
- Modify: `server/src/orchestrator/orchestrator.service.ts:279-293` (`runs()` annotation)
- Modify: `test/helpers/env.ts` (default `BM_ORCH_CONTROL_HOME`)
- Create: `test/pause-control.test.ts`
- Modify: `test/orchestrator-runs.test.ts` (new cases; its `writeRun` helper gains a `writeControl` sibling)

**Interfaces:**
- Produces (`pause-control.util.ts`):
  - `export interface PauseRequest { runId: string; requestedAt: string }`
  - `export function controlHome(env: NodeJS.ProcessEnv = process.env): string`
  - `export function controlFile(project: string, root: string = controlHome()): string`
  - `export function readPauseRequest(project: string, root?: string): PauseRequest | null`
  - `export function pauseRequestEffective(request: PauseRequest | null, run: Pick<OrchestratorRun, 'runId' | 'startedAt' | 'unpausedAt'>): boolean`
  - `export function writePauseRequest(project: string, runId: string, now: Date = new Date(), root?: string): PauseRequest`
  - `export function clearPauseRequest(project: string, root?: string): void`
- Produces: `OrchestratorService.runs()` entries carry `pauseRequested`.
- Consumes: `PauseResult`/payload type from Task 1.

- [ ] **Step 1: Guard every suite first**

  `test/helpers/env.ts`: after the `BM_WATCHDOG` line,
  `process.env.BM_ORCH_CONTROL_HOME ||= mkdtempSync(join(tmpdir(), 'bm-control-'))`.
  Comment: same reasoning as `BM_WATCHDOG=off` — Task 4's route WRITES this
  directory, and a suite that forgot to override it would write into the
  developer's real `~/.backlog-manager/settings/`. Per-suite overrides still
  win (`||=`).

- [ ] **Step 2: Write the failing tests**

  `test/pause-control.test.ts` (node env, temp root per case, `env` param
  passed explicitly so `process.env` is never mutated):
  - `controlHome({})` === `join(homedir(), '.backlog-manager', 'settings', 'orchestrator-control')`; `controlHome({ BM_ORCH_CONTROL_HOME: '/x' })` === `/x`.
  - `controlFile('/a/b', '/r')` === `/r/%2Fa%2Fb.json`.
  - `readPauseRequest`: no file → `null`; file `not json` → `null`, no throw; `{"runId":"r"}` → `null`; `{"runId":1,"requestedAt":"…"}` → `null`; valid → the object.
  - `pauseRequestEffective`: `null` → false; other `runId` → false; `requestedAt` < `startedAt` → false; `requestedAt` > `startedAt`, no `unpausedAt` → **true**; `requestedAt` < `unpausedAt` → false; `requestedAt` > `unpausedAt` → true; `requestedAt: 'yesterday'` → false; `startedAt` unparseable → false.
  - `writePauseRequest` creates the directory and the file, returns `{ runId, requestedAt: now.toISOString() }`, leaves no `*.tmp` sibling; a second write replaces `requestedAt`.
  - `clearPauseRequest` removes the file; calling it again does not throw.

  `test/orchestrator-runs.test.ts`:
  - fresh running fixture, no control file → entry `pauseRequested: false`.
  - control file `{ runId: fixture.runId, requestedAt: now }` → `true`.
  - control file naming another `runId` → `false`.
  - fixture with `unpausedAt` later than the file's `requestedAt` → `false`.
  - a `status: 'paused'` run → passes through with `fresh: false`, `pauseRequested: false`, and **no** `watchdog` key.
  - `pauseRequested` flips on the very next request after the file is written (never cached — mirror the existing "never caches" case).

- [ ] **Step 3: Run — expect module-not-found, then failing assertions**

  Run: `pnpm exec jest test/pause-control.test.ts test/orchestrator-runs.test.ts`

- [ ] **Step 4: Implement**

  - The util's header comment: the second file this server writes; why it
    lives under `settings/` (mount) yet is NOT a setting (a per-run control
    request); why the predicate is derived and duplicated in
    `orchestrate.mjs` by comment, like `orchHome()`; atomic write shape
    copied from `writeWatchdogConfig` (`:226-240`).
  - `runs()`: compute `const pauseRequested = pauseRequestEffective(readPauseRequest(run.project), run);`
    and spread it into the entry beside `fresh`/`pastRuns`. Amend the
    service's header sentence about reading only `orchHome()`: it now also
    reads this process's own control file, which is not a second reader of
    the tool's state.

- [ ] **Step 5: Run the suite and typecheck**

  Run: `pnpm test && pnpm run typecheck`

- [ ] **Step 6: Commit**

  `feat(server): pause-control file util and pauseRequested on the runs payload`

---

### Task 4: Server — `POST /api/agents/pause`, `resume()` accepts paused, watchdog pins

**Files:**
- Modify: `server/src/agents/agents.service.ts` — new `pause()` after `resume()` (~`:705`), widen `resume()` `:640-647`, clear the file after the spawn `:686-702`
- Modify: `server/src/agents/agents.controller.ts` — new route after `resume` (`:199-217`), same decorators as `watchdog/config` (`:333-335`: `@Post`, `@HttpCode(200)`, guard)
- Modify: `test/agents-origin-guard.test.ts:89-96` (route list + `bodyFor`)
- Modify: `test/agents-resume.test.ts` (new cases)
- Create: `test/agents-pause.test.ts` (copy the resume suite's harness `:60-120`)
- Modify: `test/watchdog-sweep.test.ts` (two cases beside `:301`)

**Interfaces:**
- Produces: `AgentsService.pause(project: string, cancel: boolean): PauseResult` (sync — no outbound call); route `POST /api/agents/pause`.
- Consumes: Task 3's util; Task 1's `PauseResult`.

- [ ] **Step 1: Write the failing tests**

  `test/agents-origin-guard.test.ts`: add `'pause'` to the route array;
  `bodyFor('pause')` → `{ project: projectPath }`. (Three guard cases per
  route come for free from the loop.)

  `test/agents-pause.test.ts` — `post = request(...).post('/api/agents/pause')`:
  1. `{}` / `{ project: '' }` / `{ project: '  ' }` → 400 `{ error: 'project is required' }`, no fetch call.
  2. no `run.json` → 409 `{ error: 'no running run to pause for this project' }`.
  3. `status: 'done'` → 409 same text; `status: 'paused'` → 409 same text.
  4. fresh `running` → 200 `{ pauseRequested: true }`; the control file exists at `controlFile(projectPath)` under the suite's temp `BM_ORCH_CONTROL_HOME`, parses to `{ runId: fixture.runId, requestedAt: <ISO> }`.
  5. stale `running` (updatedAt 20 min ago) → 200 `{ pauseRequested: true }`.
  6. `cancel: true` with a file → 200 `{ pauseRequested: false }`, file gone; `cancel: true` with no file → 200 `{ pauseRequested: false }`.
  7. second pause request → 200 true, file's `requestedAt` ≥ the first.
  8. `BM_AGENTS` unset (delete before app init) → case 4 still 200; `global.fetch` never called in this whole suite (assert the stub's call count is 0 in `afterEach`).
  9. `GET /api/orchestrator/runs` right after case 4 shows `pauseRequested: true` on that project's entry.

  `test/agents-resume.test.ts`:
  10. `status: 'paused'` run → 201 `{ sessionId: 'sess-1' }`; spawn body byte-identical to the stale-running case (`prompt: '/backlog-orchestrate --resume'`, `name: resume <basename>`, `permissionMode: 'auto'`).
  11. paused run with a control file present → after 201 the file is gone.
  12. paused run, spawn answers 429 → 429 relayed, file still present.
  13. `done` run → 409 text is now `no crashed or paused run to resume for this project` (update the existing case).
  14. after case 10, `GET /api/orchestrator/runs` entry for the project has no `watchdog` key.

  `test/watchdog-sweep.test.ts`:
  15. a `paused` run file → no spawn, phase idle, exactly one `idle` event (mirror the finished-run case at `:301`).
  16. a crashed run with an effective control file written into the suite's `BM_ORCH_CONTROL_HOME` → exactly one `/api/spawn` POST, same as without the file.

- [ ] **Step 2: Run — expect 404s on the new route and the old 409 text**

  Run: `pnpm exec jest test/agents-pause.test.ts test/agents-resume.test.ts test/agents-origin-guard.test.ts test/watchdog-sweep.test.ts`

- [ ] **Step 3: Implement**

  - `AgentsService.pause(project, cancel)`: `const run = this.orchestrator.runs().runs.find(r => r.project === project)`;
    `if (run === undefined || run.status !== 'running') throw new HttpException({ error: 'no running run to pause for this project' }, 409)`;
    `cancel ? clearPauseRequest(project) : writePauseRequest(project, run.runId)`;
    `return { pauseRequested: pauseRequestEffective(readPauseRequest(project), run) }`.
    Doc comment: the one agents POST that never calls the dashboard and is
    deliberately independent of `BM_AGENTS` (spec §4.1) — a pause request
    is a fact about a run on disk; also why it lives here and not under
    `/api/orchestrator/` (the `watchdog/config` precedent, and the guard).
  - Controller: `pause(@Body() body: { project?: unknown; cancel?: unknown } | undefined)`;
    trim/require project exactly as `resume` does; `cancel === true` is the
    only truthy form honoured (a string `'true'` is not a cancel — comment
    why: the field selects the destructive-looking direction, so it takes
    the strict form).
  - `resume()`: widen the 409 condition and text; after `const result = await this.spawn(...)`,
    `try { clearPauseRequest(project) } catch { /* tidiness, not correctness — spec §4.3 */ }`,
    then return. Comment: the resumed session's `unpause` is what actually
    retires the request.

- [ ] **Step 4: Run the suite and typecheck**

  Run: `pnpm test && pnpm run typecheck`

- [ ] **Step 5: Commit**

  `feat(server): POST /api/agents/pause; resume accepts a paused run`

---

### Task 5: Client plumbing — `noteResume` in the runs hook, pause helpers in `lib/agents.ts`

**Files:**
- Modify: `client/src/hooks/useOrchestratorRuns.ts` (`:42` signature, `:116` `anyLive`, `:136-142` interval effect, return)
- Modify: `client/src/lib/agents.ts` — add after `resumeOrchestrate` (`:306-312`)
- Test: `test/orchestrator-hook.test.tsx`, `test/agents-client.test.ts`

**Interfaces:**
- Produces:
  - `export const RESUME_POLL_GRACE_MS = 180_000`
  - `useOrchestratorRuns(): { runs; refresh: () => void; noteResume: (project: string) => void; resuming: ReadonlySet<string> }`
  - `export async function pauseOrchestrate(project: string): Promise<PauseResult>` — POST `/api/agents/pause` `{ project }`
  - `export async function cancelPauseOrchestrate(project: string): Promise<PauseResult>` — POST `/api/agents/pause` `{ project, cancel: true }`
- Consumes: `PauseResult` (Task 1).

Behaviour of the mark (spec §5.6): `noteResume(p)` records `expiresAt = Date.now() + RESUME_POLL_GRACE_MS` for `p` and calls `refresh()` at once. A mark is **live** while `Date.now() < expiresAt` and the latest payload has no run for `p` with `status === 'running'`. `anyLive` becomes `runs.some(fresh || running) || <any live mark>`; the interval effect depends on that. Marks are re-evaluated on every landed payload and on every tick; `resuming` is the set of projects with a live mark. State, not a ref: `resuming` must re-render its readers.

- [ ] **Step 1: Write the failing tests**

  `test/orchestrator-hook.test.tsx` (existing fake-timer harness; payload builders gain `pauseRequested: false` in Task 1):
  1. payload = one `paused` run; after mount (1 fetch) `noteResume(project)` → a second fetch immediately; `resuming` has the project; after 5s a third fetch; after another 5s a fourth.
  2. same, but the fetch after the mark returns the run as `running` + `fresh` → `resuming` no longer has the project; polling continues (the ordinary rule) — one more fetch after 5s.
  3. same as 1, payload stays `paused`: advance `RESUME_POLL_GRACE_MS + POLL_MS` → fetch count stops growing; `resuming` is empty; advance another 30s → still no new fetch.
  4. `noteResume` called twice, 2 minutes apart, payload paused → polling still alive at 4 minutes from the first call (the second restarted the clock), gone by 5m 10s.
  5. existing "never polls when every run has finished" stays green with no mark.
  6. `refresh` identity and `noteResume` identity are stable across renders (`useCallback`) — assert `result.current.noteResume` is the same function before and after a poll tick.

  `test/agents-client.test.ts` (mirror the file's `resumeOrchestrate` cases):
  7. `pauseOrchestrate('/p')` → one fetch to `/api/agents/pause`, method POST, JSON body `{ project: '/p' }`, resolves to the response body.
  8. `cancelPauseOrchestrate('/p')` → body `{ project: '/p', cancel: true }`.
  9. a 409 `{ error }` response rejects with `ApiError` carrying the message (same shape the file already asserts for `resumeOrchestrate`).

- [ ] **Step 2: Run — expect `noteResume is not a function`, missing exports**

  Run: `pnpm exec jest test/orchestrator-hook.test.tsx test/agents-client.test.ts`

- [ ] **Step 3: Implement**

  Keep the hook's doc comments; add one block explaining the mark (spec
  §5.6: a paused run is neither fresh nor running, nothing else would poll
  it after a Resume click, the grace is the watchdog's own first-heartbeat
  worst case, and it expires on its own so a resume that never starts
  cannot pin a tab to polling). The mark lives in `useState<Map<string, number>>`;
  a tick and a landed payload both prune it; `anyLive` reads it.

- [ ] **Step 4: Run the suite and typecheck**

  Run: `pnpm test && pnpm run typecheck`

- [ ] **Step 5: Commit**

  `feat(client): noteResume polling grace, pause/cancel API helpers`

---

### Task 6: `RunControls` — Pause / Cancel / Resume, one component

**Files:**
- Create: `client/src/components/RunControls.tsx` (top level: shared by the `board/` and `runs/` chunks, the way `lib/view-keys.ts` is shared — never inside either view's directory)
- Modify: `client/src/styles.css` — after `.run-strip-error` (`:912`): `.run-controls`, `.run-controls-btn` (reuse `.run-strip-resume`'s look — same amber outline, same `[aria-disabled="true"]` rule), `.run-controls-note`, `.run-controls-error`
- Create: `test/run-controls.test.tsx` (`@jest-environment jsdom`)

**Interfaces:**
- Produces:
  ```ts
  export type RunControlsRun = Pick<OrchestratorRun, 'status' | 'project'> & {
    fresh: boolean;
    pauseRequested: boolean;
    queue: ReadonlyArray<Pick<RunQueueItem, 'id' | 'stage'>>;
  };
  export type RunControlsChange = 'pause' | 'cancel' | 'resume';
  export function RunControls(props: {
    run: RunControlsRun;
    gate: { canResume: boolean; blockedReason: string | null };
    resuming: boolean;
    onChanged: (kind: RunControlsChange) => void;
  }): JSX.Element | null;
  export function inFlightItemId(queue: RunControlsRun['queue']): string | null;
  ```
  `inFlightItemId` = the first entry whose stage is neither `pending` nor terminal (`isTerminalStage`, the helper `RunStrip.tsx` already imports), else `null`.
- Consumes: `pauseOrchestrate`, `cancelPauseOrchestrate`, `resumeOrchestrate` (Task 5 / existing); `ApiError`, `RUN_IN_PROGRESS_CODE`.

Rendering (spec §5.3), decided from `run` alone:

| run | renders |
|---|---|
| `running`, `fresh`, `!pauseRequested` | `<button data-testid="run-controls-pause" title="pause after the current item">Pause</button>` |
| `running`, `fresh`, `pauseRequested` | note `Pausing after <id>` (or `Pausing at the next boundary`) + `<button data-testid="run-controls-cancel">Cancel</button>` |
| `paused`, `resuming` | note `Resuming…` (`data-testid="run-controls-resuming"`), no button |
| `paused`, `gate.canResume`, `blockedReason === null` | `<button data-testid="run-controls-resume">Resume run</button>` |
| `paused`, `gate.canResume`, `blockedReason !== null` | the same button with `aria-disabled="true"` and `title={blockedReason}`; click does nothing |
| `paused`, `!gate.canResume` | `null` |
| anything else (crashed, `done`, `aborted`, `failed`) | `null` |

Clicks: Pause → `pauseOrchestrate(run.project)`; Cancel → `cancelPauseOrchestrate`; Resume → `resumeOrchestrate`. On success `onChanged(kind)`. On error render the message in `.run-controls-error`; a resume rejected with `ApiError` whose `code === RUN_IN_PROGRESS_CODE` counts as success (the crashed strip's own rule at `RunStrip.tsx:183-186`).

- [ ] **Step 1: Write the failing tests** (`jest.mock('../client/src/lib/agents', …)` with the three functions as `jest.fn()`; a `payload(over)` builder off the fixture)

  1. one `it.each` over the table above asserting which testid is present and which are absent, plus the exact note text for the two note rows (the fixture's in-flight item id, and `Pausing at the next boundary` for a queue with only `pending` and terminal items).
  2. click Pause → `pauseOrchestrate` called once with the project; `onChanged` called with `'pause'`.
  3. click Cancel → `cancelPauseOrchestrate` once; `onChanged('cancel')`.
  4. click Resume → `resumeOrchestrate` once; `onChanged('resume')`.
  5. Resume rejects with `new ApiError('busy', 409, RUN_IN_PROGRESS_CODE)` (match the constructor `lib/agents.ts` actually has) → `onChanged('resume')` still called, no error text.
  6. Pause rejects with `Error('boom')` → `.run-controls-error` reads `boom`; `onChanged` not called.
  7. aria-disabled Resume click → no fetch, no `onChanged`.
  8. `inFlightItemId`: fixture queue → the dispatched item's id; all-pending → `null`; all-terminal → `null`.

- [ ] **Step 2: Run — expect module not found**

  Run: `pnpm exec jest test/run-controls.test.tsx`

- [ ] **Step 3: Implement** — one component, comments carrying the "why one component" and "why the crashed run is not this component's business" paragraphs from spec §5.3.

- [ ] **Step 4: Run the suite and typecheck**

  Run: `pnpm test && pnpm run typecheck`

- [ ] **Step 5: Commit**

  `feat(client): RunControls — pause, cancel pause, resume for a paused run`

---

### Task 7: Board — the drawer hosts the controls, the strip shows pausing and paused

**Files:**
- Modify: `client/src/components/board/RunDrawer.tsx:226` (props), `:326-330` (`.drawer-head`)
- Modify: `client/src/components/board/RunStrip.tsx` — `RunPayload` type `:54`, crashed-strip props `:137-146`, guard `:321`, fresh strip heartbeat span (~`:378`), new `renderPausedStrip`
- Modify: `client/src/components/board/BoardView.tsx:189` (hook destructure), `:295` (`runningRuns`), `:662-690` (strip props), `:773` (drawer props)
- Modify: `client/src/styles.css` — `.run-strip-pausing` beside `.run-strip-heartbeat` (`:785`), `.run-strip-paused` beside `.run-strip-crashed` (`:854`)
- Test: `test/orchestrator-drawer.test.tsx`, `test/orchestrator-strip.test.tsx`, `test/board.test.tsx`

**Interfaces:**
- Consumes: `RunControls` (Task 6), `resumeGate` (Task 1), `noteResume`/`resuming` (Task 5).
- Produces:
  - `RunDrawer` props gain `gate: { canResume: boolean; blockedReason: string | null }`, `resuming: boolean`, `onChanged: (kind: RunControlsChange) => void`.
  - `RunStrip` props gain `resuming?: boolean`; `onResumed` keeps its name and now fires for the paused strip too.
  - `RunPayload` (RunStrip's local type) gains `pauseRequested: boolean`.

Behaviour:
- **Drawer head**: `<RunControls run={run} gate={gate} resuming={resuming} onChanged={onChanged} />` between the title and the close button.
- **Fresh strip**: after the heartbeat span, when `run.pauseRequested`:
  `<span className="run-strip-pausing" data-testid="run-strip-pausing">pausing · finishes <id></span>`
  (`pausing` alone when `inFlightItemId` is `null`). Everything else unchanged.
- **Guard `:321`**: `if (!run.fresh && run.status !== 'running' && run.status !== 'paused') return null;`
  then `if (run.status === 'paused') return renderPausedStrip(...)`, then the crashed branch as today.
- **Paused strip**: `<div className="run-strip run-strip-paused" data-testid="run-strip">` with the same open `<button className="run-strip-open">` shape as the crashed strip carrying dot, project label, `<span className="run-strip-paused-label">paused</span>`, `<span className="run-strip-count">paused · {completed} of {total} done</span>` (`completed`/`total` computed exactly as the fresh strip does at `:331-332`), mode badge when `mergeModeLabel` is non-null, any resume error; then, as a **sibling**: `Resuming…` span (`data-testid="run-strip-resuming"`) when `resuming`; otherwise the Resume button only when `canResume === true`, `aria-disabled`/`title` from `resumeBlockedReason`, `onClick` → `resumeOrchestrate` → `onResumed` (reuse `attemptResume`, hoisted so both the crashed and paused strips call one function). No watchdog clause.
- **BoardView**: destructure `noteResume, resuming`; `stripRuns = runs.filter(r => r.status === 'running' || r.status === 'paused')` replaces `runningRuns` for the strip block (leave every other reader of `runningRuns` as is — check them: `:295` is used for the strips; if it is also used for card live bars, keep a separate `runningRuns` for those); per strip `const gate = resumeGate(agents, run.project)`; `canResume={gate.canResume} resumeBlockedReason={gate.blockedReason} resuming={resuming.has(run.project)} onResumed={() => { noteResume(run.project); refreshRuns(); }}`; drawer: `gate={resumeGate(agents, openRun.project)} resuming={resuming.has(openRun.project)} onChanged={(kind) => { if (kind === 'resume') noteResume(openRun.project); refreshRuns(); }}`.

- [ ] **Step 1: Write the failing tests**

  `test/orchestrator-strip.test.tsx`:
  1. fresh payload with `pauseRequested: true` → `run-strip-pausing` reads `pausing · finishes <fixture in-flight id>` (the id the existing "shows the current item's id and stage" case uses); with `false` → no such node.
  2. `status: 'paused'`, `fresh: false`, `canResume` → a `run-strip` with class `run-strip-paused`, text `paused · 3 of 5 done`-shaped (compute from the fixture the same way the existing `merged/total` case does), a `Resume run` button as a sibling of `.run-strip-open`, no `run-strip-watchdog` node.
  3. paused, `canResume={false}` → no Resume button; paused, `resumeBlockedReason="x"` → button `aria-disabled="true"` with `title="x"`.
  4. paused, `resuming` → `run-strip-resuming` reads `Resuming…`, no button.
  5. paused, click Resume → `/api/agents/resume` POST once (the crashed-strip case's fetch stub pattern), `onResumed` called.
  6. `status: 'done'`, `fresh: false` → still renders nothing.
  7. BoardView: a payload with one `paused` run → one paused strip inside `.run-strips`; with agents `enabled:false` → paused strip without a button.

  `test/orchestrator-drawer.test.tsx`:
  8. fresh run → `run-controls-pause` present inside `.drawer-head`; `pauseRequested: true` → `run-controls-cancel` and the `Pausing after <id>` note; `status: 'paused'` with an open gate → `run-controls-resume`; `status: 'done'` → none of the three.
  9. BoardView-level: open the drawer for a fresh run, click Pause → `fetch` POST `/api/agents/pause` with `{ project }`, then a runs refetch (the stub's `/api/orchestrator/runs` call count grows by one).

- [ ] **Step 2: Run — expect missing props / missing nodes**

  Run: `pnpm exec jest test/orchestrator-strip.test.tsx test/orchestrator-drawer.test.tsx test/board.test.tsx`

- [ ] **Step 3: Implement** — keep `RunStrip.tsx`'s long doc comment about the `<div>`-root split honest: it now covers two non-fresh renderings (crashed and paused), and the paused one earns its own short paragraph (why no watchdog clause, why Resume is offered without `watchdogStoodDown`: the watchdog never watched this run, spec §5.4). Update `RunStrip`'s "renders nothing" doc comment to name `paused` as the third rendering.

- [ ] **Step 4: Run the suite and typecheck**

  Run: `pnpm test && pnpm run typecheck`

- [ ] **Step 5: Commit**

  `feat(board): pause controls in the run drawer, pausing chip and paused strip`

---

### Task 8: Runs view — `pausing` badge on the row, controls in the detail pane

**Files:**
- Modify: `client/src/components/runs/RunsView.tsx` — imports `:1-14`, `LiveRun` `:132` (use `OrchestratorRunsPayload['runs'][number]`), `RunRow` `:381-418`, the component body `:429-440` (`useAgents`), `<RunDetail …>` `:819`
- Modify: `client/src/components/runs/RunDetail.tsx` — props `:141-143`, head `:341-350`
- Test: `test/runs-view.test.tsx`, `test/run-detail.test.tsx`

**Interfaces:**
- Consumes: `RunControls`, `resumeGate`, `useAgents` (`client/src/hooks/useAgents.ts:25`), `noteResume`/`resuming`.
- Produces: `RunDetail` props gain `gate`, `resuming`, `onChanged` (same shapes as `RunDrawer`'s).

Behaviour:
- **RunRow**: when `row.live?.pauseRequested` → `<span className="run-mode-badge" data-testid={\`runs-row-pausing-${run.runId}\`}>pausing</span>` right after the status chip (reusing the badge class: same register as the mode badge).
- **RunsView**: `const { status: agents } = useAgents();` `const { runs: liveRuns, refresh: refreshRuns, noteResume, resuming } = useOrchestratorRuns();`
  pass to `RunDetail`: `gate={resumeGate(agents, selectedRow.run.project)} resuming={resuming.has(selectedRow.run.project)} onChanged={(kind) => { if (kind === 'resume') noteResume(selectedRow.run.project); refreshRuns(); }}`.
  (`refreshRuns` is enough: a pause flips `pauseRequested` on the live entry; a resume is covered by `noteResume`; the archive refresh already fires when the fresh set changes.)
- **RunDetail head**: after the status chip, `<RunControls run={controlsRun} gate={gate} resuming={resuming} onChanged={onChanged} />` where `controlsRun` is `live` when non-null (it already carries `fresh` and `pauseRequested`), else `{ status: source.status, project: summary.project, queue: source.queue, fresh: false, pauseRequested: false }` — a paused or finished run has no live entry, and `RunControls` renders nothing for the finished ones anyway.
- `pickAuthority` untouched.

- [ ] **Step 1: Write the failing tests**

  Both suites `jest.mock('../client/src/lib/agents', …)`: extend the
  factory with `fetchAgentsStatus: jest.fn()` (resolving an enabled
  `AgentsStatus` whose `projectPaths` includes the fixture project),
  `pauseOrchestrate`, `cancelPauseOrchestrate`, `resumeOrchestrate` —
  without these the mocked module hands `useAgents` and `RunControls`
  `undefined`.

  `test/runs-view.test.tsx`:
  1. live fresh run with `pauseRequested: true` → the row carries `runs-row-pausing-<runId>` reading `pausing`; the same row without → no badge.
  2. archive listing with a `status: 'paused'` run and no live entry → its row's status chip reads `paused` with class `runs-status-paused`; the row is **not** in `runs-day-live`.
  3. tiles: with one paused run in scope the by-status breakdown shows `1 paused` between `running` and `done`.
  4. selecting the paused row → the pane shows `run-controls-resume` (gate open); with `fetchAgentsStatus` resolving `enabled: false` → no control.
  5. selecting a fresh live row → the pane shows `run-controls-pause`; click → `pauseOrchestrate` called with the row's project and `fetchOrchestratorRuns` called once more.

  `test/run-detail.test.tsx`:
  6. `live` fresh → `run-controls-pause` inside `.run-detail-head`; `live` with `pauseRequested: true` → `run-controls-cancel` + `Pausing after <id>`; `live === null`, summary `status: 'paused'`, gate open → `run-controls-resume`; `resuming` → `run-controls-resuming`; summary `done` → none.

- [ ] **Step 2: Run — expect missing props / undefined mocks**

  Run: `pnpm exec jest test/runs-view.test.tsx test/run-detail.test.tsx`

- [ ] **Step 3: Implement** — the `MergedRun.live` doc comment (`RunsView.tsx:107-131`) still describes the strip as "renders nothing special" for a stale run; correct it in passing (crashed and paused both render now), since this task is already editing that type.

- [ ] **Step 4: Run the suite and typecheck**

  Run: `pnpm test && pnpm run typecheck`

- [ ] **Step 5: Commit**

  `feat(runs): pausing badge on rows, pause/resume controls in the detail pane`

---

### Task 9: Skill prose — `SKILL.md` and `references/recovery.md`

**Files:**
- Modify: `skills/backlog-orchestrate/SKILL.md` — exit-code table `:98-105`; §3 after the `stage <id> preflight` block (`:355-360`); §4 after the `stage <id> dispatched` paragraph (`:572-583`); §10 `--status` sentence `:1244` and a new `### Pausing` before `### --resume and --abort` (`:1292`)
- Modify: `skills/backlog-orchestrate/references/recovery.md` — the `status`/`heartbeat` opening (`:14-30`); the `inspect` bullet (`:94-98`)

No code, no tests. Verify by reading the four edits back and by
`grep -n "finish --status" skills/backlog-orchestrate/SKILL.md` showing
every mention lists `paused`.

- [ ] **Step 1: Exit-code table** — add the row
  `| \`6\` | \`stage <id> preflight\` and \`stage <id> dispatched\` only: a pause was requested for this run — nothing written; go to §10 "Pausing" |`
  and one sentence under the table: `6` is the only code whose reaction is
  a *different finish*, which is why it is not a `1`.

- [ ] **Step 2: §3** — after the `stage <id> preflight` command block:
  "**Exit `6`** — the board asked this run to pause. Do not pre-flight the
  item, do not create anything: go straight to §10, *Pausing*."

- [ ] **Step 3: §4** — after the `--permission-mode auto` paragraph:
  "**Exit `6` here** — the pause request arrived during pre-flight. Leave
  the worktree and the branch exactly as they are (the worktree may carry
  the pre-flight answer you just wrote into it; nothing else has happened
  in it), leave the item at `preflight`, and go to §10, *Pausing*. A
  resumed run re-enters at this same dispatch line onto that worktree —
  `recovery.md` names the shape."

- [ ] **Step 4: §10** — `--status` takes `done`, `aborted`, `failed` or
  `paused`. New `### Pausing`: run `finish --status paused`; then summarise
  exactly as *Finishing* does (merged/branched, parked and why) **plus** the
  pending items by name and one sentence: the run resumes from the board's
  Resume control on the strip or in the Runs view, or by
  `/backlog-orchestrate --resume` in a terminal at the project root. The
  board's own control is what asked for this; there is nothing to ping
  about. End the turn.

- [ ] **Step 5: `recovery.md`** — the opening becomes three outcomes of
  `status`: `running` → `heartbeat` (unchanged text); **`paused` →**
  ```bash
  node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" unpause
  ```
  "the run is `running` again from this instant, and the request that
  paused it is retired by that stamp — then continue exactly as the
  running path does, `reconcile` next"; anything else → refuse, unchanged.
  The `inspect` bullet gains: "An `inspect` on an item whose **stage is
  `preflight`**, worktree present, no marker, is a paused run's
  dispatch-gate leftover: re-enter §4 at 'record the worktree on the run'
  — `stage <id> dispatched --worktree … --branch …` onto the existing
  pair — and dispatch. Not a leftover to ask about, and not a worktree to
  unwind: the pre-flight answer in it is the reason it was kept."

- [ ] **Step 6: Commit**

  `docs(skill): pause — exit 6, the Pausing step, unpause on resume`

---

### Task 10: Repo docs, the amended sentence, final verification

**Files:**
- Modify: `server/src/orchestrator/watchdog-config.util.ts:14-16` (the sentence "a directory neither `backlog.mjs` nor `orchestrate.mjs` ever reads")
- Modify: `docs/subsystems/invariants.md` — new `## A pause request is a file the server writes and the tool reads` after the run-file section (insert before `:69`), and a sentence in "The settings-file exception" (`:1249-1266`)
- Modify: `CLAUDE.md` — Layout (`agents/` list `:32-35` gains `pause`; `orchestrator/` list `:35-42` gains `pause-control.util.ts`, "the second file the server writes"; client bullets: `RunControls.tsx`, the strip's pausing chip and paused strip, `useOrchestratorRuns`'s `noteResume` at `:85`); Invariants: one new bullet after "One run per project, checked twice"

- [ ] **Step 1: `watchdog-config.util.ts` header** — "… a directory neither
  `backlog.mjs` nor `orchestrate.mjs` reads — with one exception added
  later: `orchestrator-control/`, the pause request file
  (`pause-control.util.ts`), which `orchestrate.mjs` reads at its two
  dispatch gates. Still the server's to write."

- [ ] **Step 2: `docs/subsystems/invariants.md`** — the new section carries, in this
  order and in this repo's register (the failure or reasoning behind each
  rule): where the file lives and why `settings/` (mount; a directory
  elsewhere would be unwritable in compose or need a second mount); the
  effectiveness predicate and why it is derived on both sides (a hand-typed
  `--resume` never passes the server; the `exhausted` precedent); why the
  gates are in the tool (prose drifts over hundreds of turns; the
  branch-mode `merged` refusal precedent) and why exactly `preflight` and
  `dispatched` (the transition rule, the pre-spawn ordering `SKILL.md` §4
  already keeps); exit `6` and why not `1`; `unpause` as its own command
  (heartbeat stays a pure stamp); the watchdog needs no change and is
  pinned by two tests; `init` archives `paused` like `done`; the controls
  on two surfaces through one component and one hoisted gate; Resume for a
  crashed run stays on the strip alone; `noteResume`'s three-minute grace
  and the two-tab double-resume exposure it does not close. The
  settings-file exception paragraph gains one sentence naming the
  `orchestrator-control/` subdirectory as the one thing under `settings/` a
  skill tool now reads.

- [ ] **Step 3: `CLAUDE.md`** — Layout edits above, and the invariant
  bullet: **"A pause request lives in a server-owned file the tool reads at
  its two dispatch gates; `paused` is a fifth run status and `unpause` its
  only exit."** Body: path + env; the predicate verbatim; exit `6`;
  `heartbeat` never flips a status; the watchdog ignores `paused` because
  it only ever walks `running`; the route is independent of `BM_AGENTS`;
  `init` archives `paused` like `done`; Resume for `paused` on both
  surfaces, crashed on the strip alone; `noteResume` keeps the poll alive
  for `RESUME_POLL_GRACE_MS` after a click. Pointer to
  `docs/subsystems/invariants.md` for the long form.

- [ ] **Step 4: Final verification**

  Run: `pnpm test && pnpm run test:skills && pnpm run typecheck && pnpm run build`
  Expected: all green; `build` succeeds (the CSP test pins the theme script,
  which this plan never touches).

- [ ] **Step 5: Commit**

  `docs(pause): invariants, layout, the amended settings/ sentence`

---

## Self-review notes (written with the plan)

- **Spec coverage**: §2 → Tasks 2, 3; §3 → Task 2; §4.1–4.3 → Task 4; §4.4
  → Task 4 (sweep cases); §5.1 → Task 1; §5.2 table → Tasks 7, 8 (every
  cell has a test); §5.3 → Task 6; §5.4 → Task 7; §5.5 → Task 8; §5.6 →
  Task 5; §5.7 → Task 1 (`byStatus`, `STATUS_ORDER`) and the "untouched"
  items need no task; §6 → Task 9; §7 → the test cases above; §8 →
  Task 10's invariant text.
- **One spec correction made alongside this plan**: §7's client bullet said
  a paused run "sorts after running ones and before done ones within its
  day". Rows within a day sort by `startedAt` only (`sortByStartedAtDesc`);
  the status order is the *tiles'* breakdown order. The spec bullet now says
  so, and Task 8's case 3 tests the tiles, case 2 the un-pinned row.
- **Type consistency**: `RunControlsChange` (Task 6) is the `kind` in every
  `onChanged` (Tasks 7, 8); `resumeGate`'s return shape (Task 1) is the
  `gate` prop everywhere; `pauseRequested` is mandatory on the payload
  entry (Task 1) and optional nowhere; `PauseRequest` (Task 3) is the
  server's type, the tool has no types.
