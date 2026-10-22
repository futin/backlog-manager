# Multi-dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan specifies behaviour, signatures and exact test cases — never literal code.** That overrides writing-plans' "code blocks required": handed code
> gets transcribed, and a bug in the plan becomes a bug in the branch. Where a test step lists cases, write each as its own assertion with the values given;
> where this plan and the spec disagree, the spec wins — say so in the report. Size notes here are soft.

**Goal:** One board launches card dispatches and orchestrator runs on any of several `claude-agents-dashboard` machines — home or remote — with a usage-based
suggestion the user can override, remote work always ending as a PR, and a remote card dispatch visible and stoppable here.

**Architecture:** A server-owned `dashboards.json` (one writer, the server) lists remote machines beside the env-configured home. A new
`server/src/agents/dashboards/` folder — inside `agents/`, so the outbound-calling modules stay three — reads each machine's dashboard (health, project list,
usage) and remote backlog-manager (registry + sync state), derives which machines are offered for a project and which one to suggest, and serves that from
`/api`. `AgentsService` learns to spawn on a chosen machine; dispatch records, abort and the runs payload learn the machine. The client draws a "Run on"
machine-cards group in both launch sheets, a Dashboards card on Shared Settings, and the machine on a remote card and a remote run row.

**Tech Stack:** NestJS server, React client, shared TS types, jest (+ jsdom, supertest via `listenLoopback`), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-22-multi-dashboard-design.md` — the picker's look is mock A at https://claude.ai/artifact/BYAn4vihad2VtVtr7yZnaH.

## Decisions this plan makes (the spec's "Left to the builder")

- **Settings file:** `$BM_DASHBOARDS_FILE`, else `~/.backlog-manager/settings/dashboards.json`, read per call, never cached. The strategy, threshold and
  prefer order live in it too (server-side, because the server computes the suggestion), not in the client's settings.
- **Token env var:** `BM_AGENTS_TOKEN_` + the entry's name uppercased (`Pro` → `BM_AGENTS_TOKEN_PRO`). Read per call. A missing token is not an error — the
  request goes without `Authorization`, as home's does today when `BM_AGENTS_TOKEN` is unset.
- **Remote path:** from the remote backlog-manager's `GET <bmUrl>/api/projects` — the entry whose `source === 'github'` and whose `repo` equals this
  project's repo (compared case-insensitively). Fail closed: no such entry → not offered.
- **Usage routes:** the dashboard's existing `GET /api/account` (`usage.fiveHour` / `usage.sevenDay` utilization 0–100 and `resetsAt`, plus `usageStatus`)
  and `GET /api/usage/profile` (`exhaustAt`, `walkAbsent`, `resetsAt`). No change to `claude-agents-dashboard`. Fetched on demand when offers are asked for,
  60 s TTL, one request in flight per dashboard.
- **Base proof:** this machine's clone, through the existing `proveBaseBranch` / `resolveBase` — unchanged for remote launches.
- **Defaults:** threshold 80; freshness limit 10 min; strategy 2 ties broken by prefer order.
- **Settings route serves URLs.** The spec's "the client sees names, reachability and usage figures only" is read as the launch surfaces: the Settings card
  must show and edit each entry's URLs, so `GET /api/dashboards` carries them. Tokens never appear in any response. Flag this in the Task 2 report.
- **When the picker draws.** The spec says both "not drawn whenever only one machine is offered" and "an unreachable one is drawn disabled". Read
  together: the picker draws when the offers list holds two or more machines (any tracker project with at least one remote configured, reachable or not),
  and an unreachable one is a disabled card. A files project and the zero-remotes setup get home alone from the server, so no picker. Flag this in the
  Task 8 report.
- **A local run does not block a remote orchestrate of the same project, and a remote one does not block a local one** (spec: remote runs never block local
  ones; the claim protocol keeps items disjoint).

## Global Constraints

- **Machine ids.** Home's id is the literal `home`; a remote's id is its `name`. A request with no `machine` field, or `machine: "home"`, is a home launch and
  must produce a spawn request byte-identical to today's (anti-goal: home-only behaves exactly as now). The client omits `machine` for home.
- **Remote name rule:** `^[A-Za-z][A-Za-z0-9]{0,23}$`, unique case-insensitively, never `home` in any case. At most 8 remote entries.
- **`dashboards.json` shape:** `{ "home"?: { "label"?, "account"?, "models"?, "efforts"? }, "dashboards": [ { "name", "url", "bmUrl", "host", "account"?,
  "models"?, "efforts"? } ], "order"?: string[], "strategy"?: "prefer" | "headroom" | "runway", "threshold"?: int }`.
  - `url`, `bmUrl`: http(s) origins (URL-parsed, stored as `origin`, any path/query dropped). Home's URL is `BM_AGENTS_URL` and is never stored.
  - `host`: 1–64 chars, no whitespace — must equal `BM_MACHINE_NAME` on that machine.
  - `label` (home only): trimmed, 1–24 chars; default `Home`. `account`: trimmed, 0–40 chars; absent → no account line.
  - `models` ⊆ `MODELS`, `efforts` ⊆ `EFFORTS` (`shared/agent.ts`), non-empty when present; absent → the whole list.
  - `order`: machine ids. Unknown ids are dropped at read; configured machines missing from it are appended in configured order with home first.
  - `strategy` default `prefer`; `threshold` integer 1–100, default 80 — in the FILE a non-integer reads as 80 and out-of-range clamps; in a POST body either
    is a `400`.
- **Missing file** = home only, `source: "default"`. **Unreadable file** (I/O error, not JSON, parsed non-object): `source: "unreadable"`, every remote ignored
  (home only — fail closed), every POST `409` with the file byte-identical. One writer, the server, tmp + rename, no temp file left behind. Model it on
  `server/src/tick/tick-breaker.util.ts` (`readTickFile` / `TickFileUnreadable` / `writeTickFile`).
- **Usage reading.** A machine has usage when `usageStatus === "ok"` and both 5 h and weekly `utilization` are numbers and the answer is ≤ 10 min old.
  Utilization is a percent 0–100 as the dashboard reports it; above 100 clamps to 100. *Used* = max(5 h %, week %); *headroom* = 100 − used.
- **Projection** (strategy 3): `runs-out` when `exhaustAt` is an ISO time before the weekly `resetsAt`; `safe` when `exhaustAt` is null, `walkAbsent` is
  null and `resetsAt` is in the future, or when `exhaustAt` ≥ `resetsAt`; `unknown` otherwise (a `walkAbsent` reason, a past or missing `resetsAt`, profile
  fetch failed).
- **Every outbound call** (dashboard health/configs/account/profile/spawn/stop, remote board projects) has a 5 s timeout and never throws past its caller: a
  failure is data (`unreachable — <message>`), never a 500.
- **Not-offered reasons, exact copy** (first that applies, in this order):
  1. `dashboard unreachable — <error>`
  2. `board unreachable — <error>` (remote only)
  3. `<repo> is not registered on <name>` (remote only)
  4. `sync is off for <repo> on <name>` (remote only: the remote entry's `interval` is `null` or `off`)
  5. `<name>'s dashboard does not list <path>` (the existing per-dashboard gate, against that dashboard's own project list and path)
- **Suggestion reason, exact copy:**
  - prefer: `Prefer order: <label> comes first under <T>% on both windows`
  - prefer, none under: `Prefer order: none under <T>% — <label> has the most headroom`
  - headroom: `Most headroom: <label> at <used>% used` (used rounded to an integer)
  - runway: `Least likely to run out: <label> lasts past its weekly reset`
  - runway, none safe: `Least likely to run out: no machine is projected safe — <label> by prefer order`
  - no usage anywhere: `No usage figures — <label> by default` (basis `default`)
- **400s, exact copy:** `unknown machine "<x>"`; `<label> runs tracker projects only — <project> is files-backed`; `finish must be pr on <label>`;
  `merge mode must be pr on <label>`; `model "<m>" is not in <label>'s list (<a, b>)`; `effort "<e>" is not in <label>'s list (<a, b>)`. An unknown model or
  effort string (not in `MODELS`/`EFFORTS` at all) is still silently dropped, as today — the 400 is only for a KNOWN one outside the machine's list.
- **409s, exact copy:** `<label> is not offered for <project>: <reason>`; `<id> is already starting on <label>`; `<project> is already starting on <label>`;
  `a run of <repo> is live on <label>`; `<id> was dispatched to <machine>, which is no longer configured`.
- **Remote starting** entries live `RUN_STALE_MS` (`shared/types.ts`) at most, in memory only, never on disk.
- Every new route under `/api`, behind the Host allowlist; every new POST behind `SameOriginPostGuard` (`server/src/agents/origin.guard.ts`).
- Every new client component cites its `.claude/DESIGN.md` subsection in a header comment. Comments explain why, at the repo's density. New prose wraps at
  160 columns.
- Never run the full `pnpm test` locally; run the suites each task names. `pnpm run typecheck` after every TS task.

## Review Focus

1. **The home-only setup (no `dashboards.json`, no `machine` field)** — dispatch and orchestrate must send the dashboard the exact same spawn body as before,
   and offers must return home alone so no picker draws. Tests in Tasks 5, 6 and 9.
2. **A remote dashboard or board that hangs** — offers must still answer within the timeout, with that machine not offered and the others unaffected; a
   dashboard whose usage fetch fails is offered as "usage unknown" and never suggested on usage. Tests in Tasks 3 and 4.
3. **A token leaking** — no response from `/api/dashboards*` or the runs payload contains any token value or any `BM_AGENTS_TOKEN*` value. Tests in Tasks 2
   and 4.
4. **Stop on a remote card after this server restarted** (no dispatch record) — routes to the dashboard whose `host` matches the claim, stops, then
   releases; a host matching nothing keeps today's refusal; a failed remote stop leaves the claim untouched. Test in Task 7.
5. **Switching the picker back from a remote to home** — Finish / merge mode return to what the user had before the lock, and a model/effort narrowed away
   returns to the Settings default. Test in Task 9.

---

### Task 1: Shared types and the `dashboards.json` util

**Files:**
- Modify: `shared/types.ts` (new types beside `OrchestratorRunsPayload` / `RemoteRun`; extend `AgentDispatchRequest`)
- Create: `server/src/agents/dashboards/dashboards-file.util.ts`
- Test: `test/dashboards-file.test.ts`

**Interfaces:**
- Produces (shared/types.ts):
  - `SuggestStrategy = 'prefer' | 'headroom' | 'runway'`
  - `DashboardEntry { name: string; url: string; bmUrl: string; host: string; account?: string; models?: string[]; efforts?: string[] }`
  - `HomeEntry { label?: string; account?: string; models?: string[]; efforts?: string[] }`
  - `DashboardsFile { home?: HomeEntry; dashboards: DashboardEntry[]; order?: string[]; strategy?: SuggestStrategy; threshold?: number }`
  - `MachineUsage { fiveHour: { pct: number; resetsAt: string | null }; week: { pct: number; resetsAt: string | null }; projection: 'safe' | 'runs-out' |
    'unknown'; exhaustAt: string | null; fetchedAt: string }`
  - `MachineOffer { machine: string; label: string; home: boolean; account: string | null; offered: boolean; reason: string | null; usage: MachineUsage |
    null; usageAgeMs: number | null; models: string[]; efforts: string[] }`
  - `Suggestion { machine: string; reason: string; basis: 'usage' | 'default' }`
  - `ProjectOffers { project: string; machines: MachineOffer[]; suggestion: Suggestion | null }`
  - `DashboardsView { source: 'file' | 'default' | 'unreadable'; file: string; home: { label: string; url: string; account: string | null; models: string[];
    efforts: string[]; tokenVar: 'BM_AGENTS_TOKEN'; tokenSet: boolean }; dashboards: Array<DashboardEntry & { tokenVar: string; tokenSet: boolean; models:
    string[]; efforts: string[] }>; order: string[]; strategy: SuggestStrategy; threshold: number }`
  - `RemoteStarting { kind: 'dispatch' | 'orchestrate'; project: string; machine: string; itemId: string | null; requestedAt: string }`
  - `AgentDispatchRequest.machine?: string`
- Produces (util): `dashboardsFile(env?): string`; `tokenVar(name: string): string`; `readDashboardsFile(file?): DashboardsFileRead` — a union
  `{ source: 'file' | 'default'; value: DashboardsFile (normalised) } | { source: 'unreadable'; reason: string }`; `class DashboardsFileUnreadable extends
  Error`; `writeDashboardsFile(next: DashboardsFile, file?): void` (throws `DashboardsFileUnreadable` when the current file is unreadable);
  `validateEntry(body: unknown): DashboardEntry | string` (a string is the 400 message); `normaliseOrder(order, ids): string[]`.

- [ ] **Step 1: Write the failing tests** in `test/dashboards-file.test.ts`, each its own `it`, using a temp dir and `BM_DASHBOARDS_FILE`:
  - `dashboardsFile({ BM_DASHBOARDS_FILE: '/x/d.json' })` → `/x/d.json`; with `{ HOME: '/h' }` → `/h/.backlog-manager/settings/dashboards.json`.
  - `tokenVar('Pro')` → `BM_AGENTS_TOKEN_PRO`; `tokenVar('studio2')` → `BM_AGENTS_TOKEN_STUDIO2`.
  - missing file → `source: 'default'`, `dashboards: []`, strategy `prefer`, threshold 80.
  - file `"{"` → `unreadable`, reason contains `does not parse as JSON`; file `[]` → `unreadable`; a directory at the path → `unreadable`.
  - threshold `"x"` in file → 80; `0` → 1; `250` → 100; `55.5` → 80.
  - `order: ['Pro', 'ghost']` with entries `Pro`, `Studio` → `['Pro', 'home', 'Studio']` (unknown dropped, missing appended in configured order with home
    first); absent order → `['home', 'Pro', 'Studio']`.
  - `validateEntry`: `name: '2pro'` → `name must match ^[A-Za-z][A-Za-z0-9]{0,23}$`; `name: 'HOME'` → `name "home" is reserved`; `url: 'ftp://a'` →
    `url must be an http(s) origin`; `url: 'https://a.ts.net:4173/x?y'` → stored `https://a.ts.net:4173`; `host: 'a b'` → `host must be 1–64 characters with
    no whitespace`; `models: ['gpt']` → `models must be a non-empty subset of opus, sonnet, haiku, fable`; `models: []` → same message.
  - `writeDashboardsFile` round-trips; leaves no `*.tmp` in the directory; over an unreadable file throws `DashboardsFileUnreadable` and the bytes are
    unchanged.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/dashboards-file.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** the types and the util. Follow `tick-breaker.util.ts` for the read union, the error class and tmp + rename.
- [ ] **Step 4: Run** the suite → PASS; `pnpm run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(agents): dashboards.json reader and writer`.

### Task 2: `DashboardsService` and the settings routes

**Files:**
- Create: `server/src/agents/dashboards/dashboards.service.ts`, `server/src/agents/dashboards/dashboards.controller.ts`
- Modify: `server/src/agents/config.util.ts` (export `AgentsConfig` if not already; add nothing else), the agents module (register both), `test/agents-origin-guard.test.ts`
- Test: `test/dashboards-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's util and types; `readAgentsConfig()`.
- Produces:
  - `DashboardsService.machines(): Machine[]` — home first then remotes in configured order, where `Machine { id: string; label: string; home: boolean;
    host: string | null; account: string | null; models: string[]; efforts: string[]; cfg: AgentsConfig; bmUrl: string | null }`. Home's `cfg` is
    `readAgentsConfig()`; a remote's is `{ enabled: home's enabled, url: entry.url, token: env[tokenVar(name)] ?? '' }`.
  - `DashboardsService.machine(id: string | undefined): Machine | null` — `undefined` and `home` (case-insensitive) → home; unknown → `null`.
  - `DashboardsService.byHost(host: string | undefined): Machine | null` — remotes only, exact match on `host`.
  - `DashboardsService.settings(): { order: string[]; strategy: SuggestStrategy; threshold: number }`.
  - `DashboardsService.view(): DashboardsView`.
  - Routes: `GET /api/dashboards` → `DashboardsView`. Guarded POSTs, each `@HttpCode(200)` answering the new `DashboardsView`:
    `POST /api/dashboards/entries` `{ entry, replaces?: string }` (upsert; `replaces` renames, and the old id in `order` is renamed with it);
    `POST /api/dashboards/entries/delete` `{ name }` (also drops it from `order`); `POST /api/dashboards/home` `{ label?, account?, models?, efforts? }`;
    `POST /api/dashboards/settings` `{ strategy?, threshold?, order? }`.

- [ ] **Step 1: Write the failing tests** (`listenLoopback`, temp `BM_DASHBOARDS_FILE`, env tokens set to `tok-home-123` / `tok-pro-456`):
  - GET with no file → `source: 'default'`, `home.label: 'Home'`, `home.tokenSet: true`, `dashboards: []`, `order: ['home']`.
  - POST entries `Pro` → 200; GET shows it with `tokenVar: 'BM_AGENTS_TOKEN_PRO'`, `tokenSet: true`; unset the env var → `tokenSet: false`.
  - The serialized GET body contains neither `tok-home-123` nor `tok-pro-456` (Review Focus 3).
  - Duplicate name `pro` (lower case) without `replaces` → 400 `a dashboard named "pro" already exists`; a ninth entry → 400 `at most 8 dashboards`.
  - `replaces: 'Pro'` with name `Laptop` → entry renamed and `order` follows.
  - settings: `strategy: 'fastest'` → 400 `strategy must be one of prefer, headroom, runway`; `threshold: 80.5` → 400 `threshold must be an integer 1–100`;
    `order: ['home', 'home']` → 400 `order must list configured machines once each`; `order: ['Pro', 'home']` → 200 and persisted.
  - home: `label: ''` → 400 `label must be 1–24 characters`; `models: ['opus']` → 200, GET `home.models: ['opus']`.
  - unreadable file → GET `source: 'unreadable'`, `dashboards: []`; every POST → 409 naming the file; bytes unchanged.
  - `machine(undefined)`, `machine('HOME')` → home; `machine('nope')` → `null`; `byHost('pro-mac')` → Pro; `byHost(undefined)` → `null`.
  - `agents-origin-guard.test.ts`: add the four POSTs to its table (cross-origin → 403, non-JSON → 415, as the existing rows assert).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/dashboards-routes.test.ts test/agents-origin-guard.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `guarded()` maps `DashboardsFileUnreadable` → 409 as `tick.controller.ts` does.
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(agents): dashboards settings routes`.

### Task 3: Usage reader and the suggestion

**Files:**
- Create: `server/src/agents/dashboards/usage.service.ts`, `server/src/agents/dashboards/suggest.util.ts`
- Test: `test/dashboards-usage.test.ts`, `test/dashboards-suggest.test.ts`

**Interfaces:**
- Consumes: `Machine` (Task 2), `authHeaders(cfg)` (agents.service.ts).
- Produces:
  - `UsageService.read(m: Machine, nowMs: number): Promise<{ usage: MachineUsage | null; ageMs: number | null }>` — cache keyed by `m.cfg.url`, refetched
    when older than 60 s, one in-flight promise per key; on a failed refetch the previous answer is kept and ages. Usage older than 10 min returns
    `usage: null` with its `ageMs`.
  - `suggest(input: { candidates: Array<{ machine: string; label: string; usage: MachineUsage | null }>; order: string[]; strategy: SuggestStrategy;
    threshold: number; homeOffered: boolean }): Suggestion | null` — candidates are offered machines only; pure.

- [ ] **Step 1: Write the failing tests.**
  - usage (stub `fetch`): account `{ usageStatus: 'ok', usage: { fiveHour: { utilization: 12, resetsAt: T1 }, sevenDay: { utilization: 28, resetsAt: T2 } } }`
    plus profile `{ exhaustAt: null, walkAbsent: null, resetsAt: <future> }` → pct 12 / 28, projection `safe`.
  - `usageStatus: 'signed-out'` → `usage: null`; account without `usage` (SHOW_USAGE off) → `null`; `utilization: null` on either window → `null`;
    `utilization: 130` → pct 100.
  - profile `exhaustAt` before `resetsAt` → `runs-out`; `walkAbsent: 'no-rate'` → `unknown`; profile `resetsAt` in the past with `exhaustAt: null` →
    `unknown`; profile fetch rejects but account ok → usage present, projection `unknown`.
  - two concurrent `read` calls → one `fetch` per route; a second call within 60 s → no fetch; at 61 s → refetch.
  - a fetch that never resolves → `read` settles within the 5 s timeout (fake timers) with `usage: null` (Review Focus 2).
  - an answer fetched 11 min ago with refetch failing → `usage: null`, `ageMs` ≈ 660 000.
  - suggest, with `order: ['home', 'Pro']`, threshold 80 — home used 62/41 (`used` 62), Pro 12/28:
    - prefer → `home` (first in order and under 80 on both), reason `Prefer order: Home comes first under 80% on both windows`.
    - prefer with `order: ['Pro', 'home']` → `Pro`, `Prefer order: Pro comes first under 80% on both windows`.
    - prefer, home 85/40 and Pro 90/10, order home-first → none under → most headroom: home used 85, Pro used 90 → `home`, `Prefer order: none under 80% —
      Home has the most headroom`.
    - headroom → `Pro`, `Most headroom: Pro at 28% used`; tie (both used 40) → first in order.
    - runway: home `runs-out`, Pro `safe` → `Pro`, `Least likely to run out: Pro lasts past its weekly reset`; both `runs-out` → prefer order among them,
      reason `Least likely to run out: no machine is projected safe — <label> by prefer order`; home `unknown`, Pro `runs-out` → Pro (a projection outranks
      unknown).
    - a candidate with `usage: null` is never picked on usage while another has usage; all `null` + `homeOffered` → `home`, basis `default`, `No usage
      figures — Home by default`; all null, home not offered → first offered in order, basis `default`.
    - no candidates → `null`.
- [ ] **Step 2: Run** both suites → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(agents): dashboard usage reader and machine suggestion`.

### Task 4: Offers — which machines a project can run on

**Files:**
- Create: `server/src/agents/dashboards/remote-board.util.ts`, `server/src/agents/dashboards/offers.service.ts`
- Modify: `server/src/agents/agents.service.ts` — split `status()` into `statusOf(cfg: AgentsConfig): Promise<AgentsStatus>` with `status()` =
  `statusOf(readAgentsConfig())`; `projectMap(cfg)` already takes a cfg — make it callable from the offers service (package-visible method). No behaviour
  change for home.
- Modify: `dashboards.controller.ts` — `GET /api/dashboards/offers?project=<abs path>`
- Test: `test/dashboards-offers.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3; `projectDispatchGate` (shared/agent.ts); the items/registry lookup that today gives a project's `source` and `repo`.
- Produces:
  - `remoteProject(bmUrl: string, repo: string): Promise<{ path: string; interval: SyncInterval | null } | { error: string } | null>` — `null` = not
    registered; reads `GET <bmUrl>/api/projects` (an array of `ProjectSummary`).
  - `OffersService.offers(project: string): Promise<ProjectOffers>` — files project, or no remotes: home alone, `suggestion` = home when offered (basis
    `default`, no usage fetch needed). Otherwise every machine, each with its reason (Global Constraints order) and, if offered, its usage; machines in
    `order`; `suggestion` from `suggest`.
  - `OffersService.remotePath(project: string, m: Machine): Promise<string | MachineOffer['reason']>` — used by Tasks 5–6 at launch time.

- [ ] **Step 1: Write the failing tests** (stub dashboards and remote board with in-process HTTP servers on `127.0.0.1`):
  - home-only (no file) → one machine `home`, `offered: true`, suggestion `home` basis `default`, no request to any account/profile route (Review Focus 1).
  - files project with a Pro entry → only `home` (picker not drawn).
  - Pro board lists `{ source: 'github', repo: 'Futin/backlog-manager', path: '/Users/p/bm', interval: '1m' }`, local repo `futin/backlog-manager` →
    offered (case-insensitive repo match).
  - Pro board lists the repo with `interval: 'off'` → reason `sync is off for futin/backlog-manager on Pro`.
  - Pro board lacks the repo → `futin/backlog-manager is not registered on Pro`.
  - Pro board down → `board unreachable — …`; Pro dashboard down → `dashboard unreachable — …` (checked first, so with both down the reason is the
    dashboard's).
  - Pro dashboard's `/api/configs` lacks `/Users/p/bm` → `Pro's dashboard does not list /Users/p/bm`.
  - Pro board hangs → `offers` resolves within the timeout, Pro not offered, home still offered and suggested (Review Focus 2).
  - The response JSON contains no token value (Review Focus 3).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/dashboards-offers.test.ts test/agents-status.test.ts` → new suite FAILS, `agents-status` still PASSES.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(agents): per-project machine offers`.

### Task 5: Remote card dispatch

**Files:**
- Create: `server/src/agents/dashboards/remote-starting.service.ts`
- Modify: `server/src/agents/agents.service.ts` (`dispatch`, `spawnInProject`, private `spawn`), `server/src/items/dispatch-records.service.ts`
  (`DispatchRecord.machine: string`, `'home'` for home)
- Test: `test/agents-dispatch-remote.test.ts`; extend `test/agents-dispatch.test.ts` with the byte-identical home case

**Interfaces:**
- Consumes: `DashboardsService.machine`, `OffersService.offers` / `remotePath`, `proveBaseBranch`, `finishClause`.
- Produces:
  - `RemoteStartingService.markItem(project, itemId, machine, nowMs)`, `.markProject(project, machine, nowMs)`, `.itemBlock(project, itemId, nowMs):
    RemoteStarting | null`, `.projectBlock(project, machine, nowMs): RemoteStarting | null`, `.list(input: { nowMs: number; claimedHost: (project: string,
    itemId: string) => string | null; remoteRuns: Array<{ project: string; host: string | null; startedAt: string }> }): RemoteStarting[]` — `list` also
    sweeps: an item entry dies when `claimedHost` returns that machine's host; a project entry dies when a remote run for the project with that host started
    at or after `requestedAt`; any entry dies at `RUN_STALE_MS`.
  - `spawnInProject(projectPath, opts & { machine?: Machine; remotePath?: string })` — absent `machine` keeps today's exact path.
  - `DispatchRecord.machine`.

- [ ] **Step 1: Write the failing tests:**
  - no `machine`, no file → the stub dashboard receives the same `/api/spawn` body as a recorded fixture of today's request (Review Focus 1), and the record
    has `machine: 'home'`.
  - `machine: 'Nope'` → 400 `unknown machine "Nope"`.
  - `machine: 'Pro'` on a files project → 400 `Pro runs tracker projects only — <project> is files-backed`.
  - `machine: 'Pro'`, execute, `finish: 'in-place'` → 400 `finish must be pr on Pro`; `finish` absent → spawned with the pr finish clause.
  - Pro `models: ['opus', 'sonnet']`, body `model: 'haiku'` → 400 `model "haiku" is not in Pro's list (opus, sonnet)`; `model: 'gpt-9'` → dropped, spawn
    uses `DEFAULT_MODEL` (today's behaviour).
  - Pro not offered (board down) → 409 `Pro is not offered for <project>: board unreachable — …`, no spawn.
  - success → spawn hits Pro's URL with `Authorization: Bearer tok-pro-456`, at Pro's `dirName` for the REMOTE path; record `machine: 'Pro'`; a second
    dispatch of the same item to `home` → 409 `<id> is already starting on Pro`.
  - `list` with `claimedHost` returning `pro-mac` for that item → entry gone; at `RUN_STALE_MS + 1` → gone.
  - groom and capture on Pro → no finish clause, no 400 (finish only applies to execute).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/agents-dispatch-remote.test.ts test/agents-dispatch.test.ts` → new cases FAIL.
- [ ] **Step 3: Implement.** Order in `dispatch`: existing prompt/finish validation → machine resolve (400) → remote 400s → `findItem`/`deriveAction` →
  offers 409 → existing blocks → `remoteStarting.itemBlock` (applies to EVERY machine, home included) → `proveBaseBranch` → spawn → record → `markItem`
  (remote only).
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(agents): dispatch a card to a remote machine`.

### Task 6: Remote orchestrate, the runs payload and the remote run's host

**Files:**
- Modify: `server/src/agents/agents.service.ts` (`orchestrate`), `server/src/agents/agents.controller.ts` (the orchestrate route: `watchdog.arm()` and
  `starting.mark()` only for home; `remoteStarting.markProject` for remote), `server/src/orchestrator/remote-runs.util.ts` (`RemoteRun.host`), the runs
  payload builder (`remoteStarting` sibling field), `shared/types.ts` (`AgentOrchestrateRequest.machine?`, `OrchestratorRunsPayload.remoteStarting`,
  `RemoteRun.host: string | null`)
- Test: `test/agents-orchestrate-remote.test.ts`; extend `test/remote-runs.test.ts`, `test/orchestrator-starting.test.ts`

**Interfaces:**
- Consumes: Task 5's service and `spawnInProject` shape.
- Produces: `OrchestratorRunsPayload.remoteStarting: RemoteStarting[]`; `RemoteRun.host` = the newest claim's `host` in that run, `null` when none carries
  one.

- [ ] **Step 1: Write the failing tests:**
  - no `machine` → today's spawn body and prompt flags, watchdog armed, `starting` marked (Review Focus 1).
  - `machine: 'Pro'`, `mergeMode: 'merge'` → 400 `merge mode must be pr on Pro`; `mergeMode: 'branch'` → same 400; `mergeMode` absent → `--merge-mode pr`
    in the prompt (`MERGE_MODES` is `['merge', 'branch', 'pr']`, shared/types.ts).
  - success on Pro → watchdog NOT armed, `starting` NOT marked, `remoteStarting` has `{ kind: 'orchestrate', machine: 'Pro', itemId: null }`; a second Pro
    orchestrate → 409 `<project> is already starting on Pro`; a home orchestrate of the same project → allowed.
  - a live `RemoteRun` for the repo with `host: 'pro-mac'` → Pro orchestrate 409 `a run of <repo> is live on Pro`; a local running run → Pro orchestrate
    allowed.
  - `deriveRemoteRuns`: claims with hosts `a@x` then `pro-mac` → `host: 'pro-mac'`; no host on any → `null`.
  - starting: a remote run with `host: 'pro-mac'` NEVER expires a local `starting` entry (bug-57's rule stays), and `runClaimBlock` never sees
    `remoteStarting`.
- [ ] **Step 2: Run** the three suites → new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS, plus `test/agents-plan.test.ts test/agents-resume.test.ts test/remote-runs-routes.test.ts`; typecheck.
- [ ] **Step 5: Commit** `feat(agents): orchestrate on a remote machine`.

### Task 7: Stop & release routed to the machine

**Files:**
- Modify: `server/src/agents/items-abort.service.ts`
- Test: extend `test/tracker-abort.test.ts`

**Interfaces:**
- Consumes: `DispatchRecord.machine`, `DashboardsService.machine` / `byHost`.

- [ ] **Step 1: Write the failing tests:**
  - with a record `machine: 'Pro'` → `stopDashboardSession` hits Pro's URL with Pro's token, then the claim is released with reason `aborted`.
  - no record, `holder.host: 'pro-mac'` (Pro's host) → stop on Pro, then release (Review Focus 4).
  - no record, `holder.host: 'ghost@box'` → today's refusal `<id> is held on ghost@box, not this one (<machine>)`.
  - no record, host equals `BM_MACHINE_NAME` → today's home path unchanged (working → 409).
  - Pro's stop answers 502 → 502 with `the claim is untouched`, no release call (Review Focus 4).
  - a record whose machine was since deleted from the file → 409 `<id> was dispatched to <machine>, which is no longer configured`, claim untouched.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/tracker-abort.test.ts` → new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(agents): stop a remote card on its own machine`.

### Task 8: Client lib, hooks and the `RunOn` group

**Files:**
- Create: `client/src/lib/dashboards.ts`, `client/src/hooks/useDashboards.ts`, `client/src/hooks/useOffers.ts`, `client/src/components/ui/RunOn.tsx`
- Modify: `client/src/lib/agents.ts` (`StartOrchestrateRequest.machine?`; `dispatchAgent` passes `machine` through)
- Test: `test/dashboards-client.test.ts`, `test/run-on.test.tsx`

**Interfaces:**
- Produces:
  - `fetchDashboards(): Promise<DashboardsView>`, `saveEntry(entry, replaces?)`, `deleteEntry(name)`, `saveHome(patch)`, `saveSuggestion(patch)`,
    `fetchOffers(project): Promise<ProjectOffers>`.
  - `machineLabelByHost(view: DashboardsView | null, host: string | undefined): string | null` — remotes only.
  - `lockedFor(offer: MachineOffer | null): { prOnly: boolean; models: string[]; efforts: string[] }` — `prOnly` true for any non-home machine.
  - `useDashboards(): { view, error, refresh }` (fetch on mount, no polling); `useOffers(project: string | null): { offers, error, refresh }` (fetch when
    `project` becomes non-null).
  - `<RunOn offers={ProjectOffers} value={string} onChange={(machine: string) => void} />` — draws nothing when fewer than two machines.

- [ ] **Step 1: Write the failing tests:**
  - `machineLabelByHost(view with Pro host pro-mac, 'pro-mac')` → `'Pro'`; home's host or unknown → `null`.
  - `lockedFor(home)` → `prOnly: false`; `lockedFor(Pro)` → `prOnly: true` and Pro's lists.
  - RunOn, two machines, Pro suggested: two `aria-pressed` buttons; Pro has `Suggested`, home has `home`; Pro starts pressed; each card shows `12%` / `28%`
    and `5 h resets in …`; the reason line text equals `suggestion.reason` and links to Settings; the top-right reads `usage 40 s ago` for `usageAgeMs:
    40000`.
  - RunOn, a machine `offered: false` → its button is `disabled` and shows the reason; a machine with `usage: null` shows `usage unknown`.
  - RunOn, one machine → renders nothing.
  - suggestion `null` and nothing offered → a line reading `No machine can run this project right now` and every card disabled.
- [ ] **Step 2: Run** both suites → FAIL.
- [ ] **Step 3: Implement.** Header comment cites `.claude/DESIGN.md` subsections, as `WatchdogMonitor.tsx` does.
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(client): RunOn machine cards`.

### Task 9: The picker in both launch sheets

**Files:**
- Modify: `client/src/components/board/LaunchSheet.tsx`, `client/src/components/board/OrchestrateSheet.tsx`
- Test: extend `test/launch-sheet.test.tsx`, `test/orchestrator-start-ui.test.tsx`

**Interfaces:**
- Consumes: Task 8.

- [ ] **Step 1: Write the failing tests** (stub `fetch`):
  - home-only offers → no "Run on" group, button text as today, request body has no `machine` key (Review Focus 1).
  - two machines, Pro suggested → Pro pressed; Finish (LaunchSheet, execute) / Merge mode (OrchestrateSheet) disabled at PR with hint `Required when running
    on Pro`; Model options are exactly Pro's list with hint `Pro runs opus, sonnet`; the primary button reads `Start on Pro`; the body has `machine: 'Pro'`.
  - user had Finish `in-place` and model `haiku` (Settings default `opus`), picks Pro (finish locks to pr, haiku narrowed away → `opus`), then home → Finish
    back to `in-place`, model `opus` (Review Focus 5).
  - a 409 from the server shows its message in the sheet's existing error slot, sheet stays open.
  - the launch is disabled while offers load, and when no machine is offered.
- [ ] **Step 2: Run** both suites → new cases FAIL.
- [ ] **Step 3: Implement.** The group sits at the top of the sheet, above every other field (spec, "The picker's look").
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(client): pick the machine when launching`.

### Task 10: The machine on the card and on the run row

**Files:**
- Modify: `client/src/lib/tracker.ts` (`claimControl` gains `remoteHosts: ReadonlySet<string>`; new `remoteBadge`), `client/src/components/board/ItemCard.tsx`,
  `client/src/components/board/ClaimRelease.tsx`, `client/src/lib/runs-list.ts` and `client/src/components/runs/RunDetail.tsx` (machine name on a remote
  row), the Board and Runs data paths that need `useDashboards`, and the starting-row renderers for `remoteStarting`
- Test: extend `test/tracker-lib.test.ts`, `test/runs-list.test.ts`, `test/run-detail.test.tsx`; new `test/remote-starting-ui.test.tsx`

**Interfaces:**
- Produces: `remoteBadge(item, labelByHost: (host?: string) => string | null, now): string | null` → `running on <label>` for a live claim with no `run`
  whose host maps to a remote; `claimControl(item, now, remoteHosts)` → `stop-release` when `holder.dispatched === true` OR the holder's host is in
  `remoteHosts` (no `run`).

- [ ] **Step 1: Write the failing tests:**
  - `remoteBadge`: live claim host `pro-mac` → `running on Pro`; stale → `null` (the stale label already speaks); a `run` claim → `null`; host unknown → `null`.
  - `claimControl` with `remoteHosts` `{pro-mac}` and no `dispatched` → `stop-release`; existing cases unchanged when the set is empty.
  - `mergeRuns` remote row with `host: 'pro-mac'` → row carries machine label `Pro`; `host: null` → no machine label; unmapped host → the raw host.
  - a `remoteStarting` orchestrate entry → the Runs Live list and the board's run chip read `Starting on Pro`; an item entry → that card reads `Starting on
    Pro`; neither carries controls.
- [ ] **Step 2: Run** the suites → new cases FAIL.
- [ ] **Step 3: Implement** within `.claude/DESIGN.md` (mock A's Board canvas is a starting point; the spec leaves placement to you).
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(client): show the machine on remote cards and runs`.

### Task 11: Shared Settings — the Dashboards card

**Files:**
- Create: `client/src/components/settings/DashboardsGroup.tsx`
- Modify: `client/src/components/settings/SettingsView.tsx` (Shared page only)
- Test: `test/settings-dashboards.test.tsx`

**Interfaces:**
- Consumes: Task 8's lib and `useDashboards`.

- [ ] **Step 1: Write the failing tests:**
  - home row: label, `BM_AGENTS_URL` value read-only, `BM_AGENTS_TOKEN ✓ set`, models; editable label/account/models via Save → `POST /api/dashboards/home`.
  - Add dashboard → form with Name, Dashboard URL, Board URL, Machine name (hint naming `BM_MACHINE_NAME`), models/efforts checkboxes; Save posts
    `entries`; a 400 shows its message inline; the token line reads `BM_AGENTS_TOKEN_PRO ✗ not set — add it to .env and restart` when unset.
  - move up/down posts `settings` with the new `order`; Remove posts `entries/delete` after a confirm.
  - strategy radio group of three with the Settings mock's descriptions; threshold number input posts `threshold`; out-of-range shows the server's 400.
  - `source: 'unreadable'` → every control disabled, a hint naming the file.
  - the page never renders a token value (assert the DOM lacks the stub's token string).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/settings-dashboards.test.tsx test/settings-view.test.tsx` → FAIL.
- [ ] **Step 3: Implement**, citing `.claude/DESIGN.md` in the header; follow `TickGroup.tsx` / `TrackersGroup.tsx` for the group frame.
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(client): dashboards settings card`.

### Task 12: Docs, rules, invariants

**Files:**
- Modify: `CLAUDE.md` (a headline for `dashboards.json` beside `jira.json`/`tick.json`'s; the `agents/` line names `dashboards/` and its outbound
  destinations — remote dashboards and remote boards — while the module count stays three), `docs/subsystems/invariants.md` (the reasoning entry),
  `.claude/rules/dispatch-watchdog.md` (the mechanism bullet, anchored), `docs/subsystems/api.md` (routes, outbound list), `docs/subsystems/board.md`
  (RunOn, the card badge, the Settings card), `docs/subsystems/jira.md` (one line: Jira Start stays home-only), and a new `docs/workflows/remote-machine.md`
  (set `BM_MACHINE_NAME` in the remote shell env, run `pnpm run tailnet` there, admit this board in the remote dashboard's Host allowlist and token, add
  `BM_AGENTS_TOKEN_<NAME>` here and restart)
- Test: `test/claude-rules.test.ts` (existing — it must stay green: headline byte-equal, each anchor exactly once)

- [ ] **Step 1: Write** the headline: **`~/.backlog-manager/settings/dashboards.json` has exactly one writer, the server, and a file that cannot be read is
  never replaced.** and its `Why:` link; the rule bullet in `dispatch-watchdog.md` with the mechanism (missing → home only; unreadable → home only, POSTs
  409; tokens env-only; a request without `machine` is today's home launch).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/claude-rules.test.ts` → PASS (a failure means the headline or anchor drifted — fix the text, not the test).
- [ ] **Step 3: Commit** `docs: multi-dashboard rules, invariants and setup`.

---

## Final verification

- `pnpm run typecheck` and `pnpm run build` clean.
- Run every suite the tasks named, once, together. Do not run the full `pnpm test` — CI does.
- Manual, if a second dashboard is at hand: with no `dashboards.json`, launch a dispatch and an orchestrate and see no picker; add a remote, open the
  Orchestrate sheet on a tracker project and see two cards with figures.
