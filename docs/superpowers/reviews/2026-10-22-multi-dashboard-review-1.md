# Multi-dashboard implementation plan — review 1

Plan: `docs/superpowers/plans/2026-10-22-multi-dashboard.md` (commit `3020af8`). Spec: `docs/superpowers/specs/2026-10-22-multi-dashboard-design.md`.
Reviewer: Fable 5.1, fresh session, code read directly. Every file:line below was checked in the worktree at review time (the worktree and the indexed main
checkout are byte-identical on every file cited). Dashboard lines are in `/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard`.

## Verdict: APPROVE WITH FIXES

One Critical: the plan keeps the dashboard's silent model/effort drop for remote machines, which is the exact behaviour the spec names as the reason for its
400. Eleven Important findings, every one a text correction — most are places where the plan describes code that is not what is in the tree (a cache that
is single-slot, a payload whose `remote` is always empty, a type that lives in a different file, a guard table that asserts a different status), so an
implementer following the plan literally would either hit a wall or build the wrong gate. Nothing here changes the design.

## Checklist

1. **Coverage.** Every spec section maps to a task: Host rule (spec:25–27) → Task 5 (home-only dispatch stays as today) and Task 7; Abort routing
   (spec:34–37) → Task 7; Strategies (spec:41–48) → Task 3; Partial-data table (spec:50–57) → Task 3 (plan:219–229); No usage (spec:59–60) → Task 3/4;
   PR forced + server refuses (spec:61–62) → Tasks 5, 6; Files/picker (spec:69–70) → Tasks 4, 8; Non-goals (spec:71–80) → Task 12 names remote Jira as
   home-only; Anti-goals (spec:82–88) → Review Focus 1 and Task 3's "no suggestion without usage"; Remote BM reads (spec:99) → Task 4; Tokens (spec:101–103)
   → Task 1; Per-dashboard gate (spec:107–108) → Task 4 `statusOf`; Remote runs beside `runs` (spec:109–111) → Task 6; Usage (spec:118–119) → Task 3 (the
   plan reads `/api/account` instead of the spec's `/api/sessions` snapshot — verified equivalent: `api.ts:992` returns `{ profile, usage, usageStatus }`
   and `usage.ts` carries the same `fiveHour`/`sevenDay` windows; plan:25–43 records the choice); Settings (spec:128–133) → Task 11; Offered checks and the
   outbound list (spec:135–138) → Task 12; Per-machine models (spec:139–142) → Task 4/5 — **but the 400 is dropped, C1**; Remote starting (spec:143–149)
   → Tasks 5, 6, 10; Picker look (spec:151–160) → Tasks 8, 9; Left to builder (spec:164–174) → plan:25–43.
2. **Values.** Abort refusal copy (plan:354) matches `items-abort.service.ts:101` byte-for-byte. Strategy arithmetic (plan:219–229) is consistent with
   spec:41–46 and the partial-data table with spec:50–57. `hostIdentity` (plan:30) matches the `BM_MACHINE_NAME` else `<user>@<hostname>` rule. The
   `--merge-mode pr` literal (plan:306) matches `agents.service.ts:847`. Two values are wrong: the guard table's "415" (I3) and the timeouts (I2).
3. **Reality.** Every Create target is absent (`server/src/agents/dashboards/` does not exist; no `dashboards.json` reader; no `RunOn`, `useDashboards`,
   `MachineOffer`, `RemoteStartingService`, `OffersService` symbol anywhere in `server/src`, `client/src`, `shared`). Every Modify target exists. Anchors
   checked: `SameOriginPostGuard` at `server/src/agents/origin.guard.ts`; `authHeaders` exported at `agents.service.ts:2145`; `proveBaseBranch(base, projectPath)`
   at `base-branch.util.ts:57`; `DispatchRecord` at `dispatch-records.service.ts` (no `machine` field today — Task 7's addition is real); `StartingRunsService.mark`
   83 / `list` 97 / `sweep` 114; `OrchestratorRunsPayload` at `shared/types.ts:1825` with `runs`/`starting`/`remote`; `RemoteRun` 1912; `RUN_STALE_MS` 1609;
   `MERGE_MODES` 1124; `ProjectSummary.repo/source/interval` 377; `SYNC_INTERVALS` includes `off` (534); `pickFrom` at `shared/agent.ts:226`; `TickGroup` rendered
   in `SettingsView.tsx:224`; `claimControl` sole caller `ClaimRelease.tsx:41`; `LaunchSheet.tsx:60` seeds from `settings.dispatchDefaultModel`;
   `StartOrchestrateRequest` at `client/src/lib/agents.ts:309`. Dashboard side: `/api/configs` 239, `/api/account` 337, `/api/usage/profile` 346, `/api/spawn`
   410 (`server/index.ts`); `UsageStatus = 'ok' | 'token-expired' | 'signed-out' | 'unavailable'` (`shared/types.ts:752`); `UsageProfileResponse.exhaustAt`
   225 / `walkAbsent` 233; `.ts.net` in `request-guard.ts:19`. Three stated facts are false — I3 (guard table), I9 (`AgentOrchestrateRequest` location),
   I10 (orchestrator-starting suite shape) — and one description of the code is wrong in a way that breaks a test — I4 (`projectMap` cache).
4. **Interfaces.** Task 2 consumes Task 1's reader as spelled; Task 4 consumes Task 2's `Machine`/`Dashboards` shapes; Task 5 consumes Task 4's `OffersService`
   and `remotePath`; Tasks 8–10 consume Task 4's `MachineOffer` and Task 6's `remoteStarting` field as spelled. One return type cannot be consumed as
   described — I8 (`remotePath` returns `string | string`). One consumer sits across a module boundary the plan does not open — I5, I6.
5. **Order.** No task consumes a later task's output. Task 12's `.claude/rules/` edits come after the files its globs match are committed. The dispatch
   order at plan:306–307 is internally inconsistent — I7.
6. **Tests.** Review Focus 1–5 each have a named test (plan:150–152, 187–189, 231–233, 298–300, 332–335). Fail-before holds for every server case. Fixtures:
   the strategies table uses distinct utilisations per machine (plan:231); `byHost` is tested with ONE remote (M4); the RunOn tests do not assert the
   account line or the effort hint (M1, M2); one picker assertion is non-discriminating (M3). One test pins the wrong behaviour — C1's `gpt-9 → dropped`
   case (plan:298–299).
7. **Conventions.** No literal code; signatures, values and cases only. Size notes are soft (plan:8). 160-column wrap followed. The outbound-module count
   stays at three with `dashboards/` inside `agents/` (plan:14) and Task 12 names the destinations (spec:137–138) — sound.

## Critical

- **C1 — plan:83–84, 298–299: a remote machine's unknown model/effort is "silently dropped, as today", contradicting spec:142.** The spec says, under
  Per-machine models (spec:139–142): a remote machine's model list is read from its dashboard, the picker offers only that list, "and the server refuses
  (400) a body naming one outside the list" — and gives as the reason that the dashboard itself drops an unknown model silently
  (`claude-agents-dashboard/server/lib/spawn.ts:174–177`: a `model`/`effort` not in `MODELS`/`EFFORTS` is deleted from the spawn body and the session
  starts on the default). The plan's Global Constraint at plan:83–84 keeps that drop for every machine, and Task 5's test at plan:298–299 pins it (`model:
  'gpt-9'` → spawned on the default). Built as written, a user who picks a model Pro's dashboard does not know gets a session on the default model with no
  error and nothing in the response that says so — exactly the failure the spec was written to prevent. Home must keep the drop (anti-goal, spec:82–84:
  home-only behaviour unchanged; `agents.service.ts:617`, `:897` use `pickFrom(...) ?? DEFAULT_MODEL`). → Scope plan:83–84 to home; for a remote
  `machine`, 400 any `model` or `effort` string outside that machine's list (the list `statusOf(m.cfg)` just read), copy of the form `model <x> is not one
  <label>'s dashboard offers (…)`, and turn plan:298–299 into that 400 case plus a home case that still drops.

## Important

- **I1 — plan:306–307 (and Task 6 generally): for a remote launch the plan never says which of the existing HOME gates still run.** The dispatch order
  reads "existing prompt/finish validation → machine resolve (400) → remote 400s → findItem/deriveAction → offers 409 → existing blocks →
  remoteStarting.itemBlock → proveBaseBranch → spawn → record → markItem", and Task 6 says "the same locks" for orchestrate. Each of those "existing"
  gates today reads this machine's dashboard or this machine's state: `status()` (`agents.service.ts:330`, called at 386/497/633) fetches HOME's
  `/api/health` and feeds `projectDispatchGate(status, …)` (668) and `dispatchBlock(item, status)` (497–498) — so a remote launch is refused when HOME's
  dashboard is off even though Pro's is up; `status.spawnMaxPermission` is HOME's ceiling passed to `clampMode` (561, 610, 896); the orchestrate
  active-run lock (719–755) and the starting lock (778–780) read HOME's run files — which contradicts plan:333 ("a local running run → Pro orchestrate
  allowed"); `syncOffBlock` (542, 783) is HOME's poller, which is right (the project's tracker is this machine's). An implementer has to decide each one
  and will decide them differently from the spec. → Add a per-gate list to Task 5 and Task 6: `status()`/`projectDispatchGate`/`dispatchBlock` →
  replaced by `statusOf(m.cfg)` and the gate over THAT status; `spawnMaxPermission` → the remote's; active-run/starting locks → replaced by the offers
  409 + `remoteStarting.itemBlock` (local runs do not block, plan:333); `syncOffBlock`, `runClaimBlock`, `itemClaimBlock` → kept (they are the
  tracker's, not the dashboard's).

- **I2 — plan:67–68: "every outbound call (… spawn, stop …) has a 5 s timeout and never throws past its caller … never a 500"** misstates today's
  spawn and stop. Spawn is `SPAWN_TIMEOUT_MS = 10_000` (`agents.service.ts:91`) and by design throws 502 when the dashboard cannot be reached (1471), relays
  4xx verbatim (1488) and 502s on a missing `sessionId`; stop is `STOP_TIMEOUT_MS = 10_000` (`session-stop.util.ts:7`). Read literally, Task 5 would cut the
  home spawn to 5 s and swallow its 502 — a home-only behaviour change, which Review Focus 1 (plan:95–96) forbids. → Scope the 5 s / never-throw rule to the
  NEW reads (health, configs, account, profile, the remote board's `/api/projects`) that feed offers; say spawn and stop keep `SPAWN_TIMEOUT_MS`/
  `STOP_TIMEOUT_MS` and their 502s on every machine.

- **I3 — plan:188: "add the four POSTs to its table (cross-origin → 403, non-JSON → 415, as the existing rows assert)".** The existing rows assert 403
  three times: urlencoded POST → 403 (`test/agents-origin-guard.test.ts:165–171`), cross-origin JSON → 403 (176–182), `Origin: null` → 403 (190–196).
  There is no 415 anywhere in that suite. An implementer adding a 415 expectation gets a red test with no way to know whether the plan or the guard is
  wrong. → "cross-origin, urlencoded and `Origin: null` → 403, as the existing rows assert".

- **I4 — plan:241–242: making `projectMap(cfg)` callable with a remote `cfg` thrashes its single-slot cache.** `projectMap` keeps ONE entry,
  `this.cache`, hit only when `this.cache.url === cfg.url && now - at < PROJECT_TTL_MS` (`agents.service.ts:1499`) and overwritten unconditionally at
  1534. Every offers computation that walks N machines evicts home's map N−1 times, so home's next dispatch re-fetches `/api/configs` — and
  `test/agents-status.test.ts:126` ('fetches the heavy project list once per TTL, health every time') goes red the moment a second machine exists. Also,
  "package-visible" is not a TypeScript visibility. → Make the cache a `Map<url, { at, map }>` (one line in `projectMap`, keyed by `cfg.url`), state that
  in Task 4, and say `public` (or move `projectMap` into `OffersService` with its own per-machine cache).

- **I5 — plan:276 + plan:317: `RemoteStartingService` is created under `server/src/agents/dashboards/`, but `orchestrator.controller.ts` must read it.**
  Task 6 has the orchestrator controller set `payload.remoteStarting` from that service. `AgentsModule` already imports `OrchestratorModule`
  (`agents.module.ts:66`); an orchestrator file importing from `agents/dashboards/` closes a module cycle — the same reason `DispatchRecordsService` lives in
  `ItemsModule` and not in `agents/` (the only module edge is agents → items). → Create `RemoteStartingService` in `server/src/orchestrator/` beside
  `starting-runs.service.ts`, provide and export it from `OrchestratorModule`, inject it into `AgentsService` through the existing edge.

- **I6 — plan:332: the orchestrate 409 `a run of <repo> is live on <label>` reads remote runs from a payload where they are always empty.** `AgentsService`
  reads `this.orchestrator.runs()` (718), and `OrchestratorService.runs()` returns `remote: []` unconditionally (`orchestrator.service.ts:332`, 399);
  remote runs are spliced in only by `orchestrator.controller.ts` from `RemoteRunsService.list()`. `RemoteRunsService` is provided by `OrchestratorModule`
  but NOT exported (`orchestrator.module.ts:46–49` exports `OrchestratorService`, `StartingRunsService`, `WatchdogStateService`). Built as written the
  409 never fires. → Task 6: export `RemoteRunsService` from `OrchestratorModule`, inject it into `AgentsService`, and read `remoteRuns.list()` for the
  live-on-another-machine check (filter by `repo` case-insensitively and `fresh`, the same way `runClaimBlock` reads `RemoteRun.fresh`).

- **I7 — plan:306: "remote 400s → findItem/deriveAction" is the wrong way round for the files-backed 400.** The `<project> is files-backed, so it cannot
  run on <label>` refusal (plan:82, 296) needs the item's project, and dispatch learns it only from `findItem` (`item.projectPath`, `agents.service.ts:553`;
  `this.items.sourceOf(projectPath)`). → Move the files-backed 400 (and the "remote board does not list this repo" 400, which also needs the repo) after
  `findItem`; keep only the `machine` name-resolution 400 before it.

- **I8 — plan:254: `remotePath(...): Promise<string | MachineOffer['reason']>` — both arms are `string`.** `MachineOffer['reason']` is a string union, so a
  caller cannot tell a path from a reason without inspecting the text, and a reason that happens to look like a path becomes one. → Return a tagged
  shape, `{ path: string } | { reason: MachineOffer['reason'] }`, and say so where Task 5 consumes it (plan:296).

- **I9 — plan:317: "add `machine?` to `AgentOrchestrateRequest` in `shared/types.ts`".** That interface is declared in `server/src/agents/agents.service.ts:221`
  (imported by `agents.controller.ts:3`, used at controller 139) — it is not in `shared/types.ts`. The client's twin is `StartOrchestrateRequest` at
  `client/src/lib/agents.ts:309`, which Task 8 (plan:367) extends separately. → Point Task 6 at `agents.service.ts:221`.

- **I10 — plan:319, 335: "extend `test/orchestrator-starting.test.ts`" with a remote-run case.** That suite says, at 229–234, "No remote-run cases here any
  more (bug-57) … the proof that a remote run does NOT retire a mark lives in orchestrator-runs.test.ts's bug-57 cases", and `StartingRunsService.list`
  (97) and `sweep` (114) take no remote argument — there is nothing in that suite for a remote run to exercise. → Put the "a live `RemoteRun` for the repo
  → 409, a local running run → allowed" cases in the agents orchestrate suite that Task 6 already names (plan:332–333), and the "remote starting entry does
  not retire a local mark" proof in `test/orchestrator-runs.test.ts` beside the bug-57 cases.

- **I11 — plan:351–357 (Task 7): the no-record abort ladder is unstated.** Today, when `dispatches.get(session)` is null, the service refuses first on an
  empty `BM_MACHINE_NAME` (`items-abort.service.ts:96–99`, 409 "this server has no BM_MACHINE_NAME…") and only then compares `holder.host` (101). The plan
  adds `byHost` so a claim whose `host` matches a configured remote stops that remote's session — but it does not say whether that lookup runs before or
  after the `BM_MACHINE_NAME` check, so a home server with no `BM_MACHINE_NAME` either refuses every remote-held claim (today's order kept) or starts
  honouring `byHost` while still unable to recognise its own. → State the ladder: record with `machine` → that machine's stop; no record → `byHost(holder.host)`
  → remote stop via that `cfg`; neither → today's `BM_MACHINE_NAME` + host-equality path unchanged, including its two 409s and their copy. Say which
  branch the `test/tracker-abort.test.ts:337` and `:348` cases now land in.

## Minor

- **M1 — plan:383, spec:152:** the RunOn tests assert the two-line layout but not the account line's content (plan/email and `5 h` figure). Add one
  assertion per account state (ok, token-expired, no usage) with distinct fixture strings.
- **M2 — plan:405–406, spec:155:** no test asserts the effort hint is drawn for a machine whose list has efforts and omitted for one without.
- **M3 — plan:384:** `5 h resets in …` with an ellipsis is a non-discriminating expectation; put a fixed `resetsAt` in the fixture and assert the rendered
  relative time.
- **M4 — plan:187:** `byHost` is tested with one remote; two entries with distinct `host` values (and one lookup that misses) would discriminate a lookup
  that returns the first entry regardless.
- **M5 — plan:187:** service-level `readDashboards` unit cases (unreadable → kept, malformed entry → skipped) sit inside the routes suite; the repo keeps
  reader units beside the reader (`test/tick-breaker.test.ts` precedent). Fine either way; name the file.
- **M6 — plan:372:** `saveSuggestion` names a function that `POST /api/dashboards/settings` reaches; the route and the function should share a word.
- **M7 — plan:167:** a remote `Machine.cfg.enabled` is derived from the entry's presence, not from home's `BM_AGENTS_URL` — the plan says it implicitly;
  one sentence would stop an implementer threading `readAgentsConfig().enabled` into every remote.
- **M8 — plan:247:** "the items/registry lookup" for a project's repo is vague; the names are `ItemsService.sourceOf(projectPath)` and `repoOf` in
  `server/src/items/github.source.ts`.
- **M9 — plan:36–37:** the Settings URL-in-response reading is sound given spec:128 (the spec is internally inconsistent with spec:101's "tokens env-only",
  the plan picked the right side). Note only.
- **M10 — plan:421 (`useDashboards`, "no polling"):** a one-shot `useFetched` is fine under the `useCoalescedFetch` invariant; say `useFetched` by name
  so nobody builds a poller.

## What I checked and found sound (no finding)

- Outbound-module count stays three: `dashboards/` sits inside `agents/` (plan:14), and Task 12 adds the two new destinations to `CLAUDE.md:47` and
  `docs/subsystems/api.md:109/147/183` (spec:137–138).
- Tokens never leave the server: `BM_AGENTS_TOKEN_<NAME>` is env-only (plan:33, spec:101–103), `dashboards.json` holds url/label/host only, and the
  `GET /api/dashboards` shape (plan:181) carries no token field.
- `dashboards.json` reader/writer modelled on `tick-breaker.util.ts` (plan:120–131): unreadable → kept, never replaced; matches the tick.json invariant.
- Remote starting entries live in server memory, in the sibling field `remoteStarting`, never in `starting` (plan:315–318), so bug-57's "the starting
  pair reads `runs` alone" (`test/orchestrator-starting.test.ts:229–234`) holds.
- Remote work forced to PR: `--finish pr` on dispatch (plan:306) and `--merge-mode pr` on orchestrate (plan:331); `resolveMergeMode` already requires
  `sourceOf(project) === 'github'` (`agents.service.ts:1952–1975`), which the files-backed 400 pre-empts.
- `RemoteRun.host` addition (plan:347) is additive to `shared/types.ts:1912`; `RunDetail.tsx:101–148` reads `remote` as a boolean and is untouched.
- Strategy math (plan:219–229) vs spec:41–46 and the partial-data table vs spec:50–57: consistent, including "no confident suggestion without usage"
  (spec:86–88) → `reason: 'no usage'` and a disabled Suggest.
- Dashboard routes and fields all exist with the plan's spelling: `/api/configs`, `/api/account` (`usageStatus 'ok'`), `/api/usage/profile` (`exhaustAt`,
  `walkAbsent`, `resetsAt`), `/api/spawn`; `.ts.net` hosts pass the dashboard's request guard.
- Launch pickers still seed from Settings (`LaunchSheet.tsx:60`), the machine picker defaults to home (plan:398), and the Settings page's suggestion is the
  only persisted picker state (spec:128–133).
- `isItemId`, `proveBaseBranch`, `authHeaders`, `AgentsStatus`, `SameOriginPostGuard` all exist at the paths and with the signatures the plan uses.
