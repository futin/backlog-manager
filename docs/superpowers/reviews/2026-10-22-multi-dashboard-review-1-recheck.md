# Multi-dashboard plan — review 1 re-check

Date: 2026-10-22. Scope: ONLY the hunks in the review-1 fix diff of `docs/superpowers/plans/2026-10-22-multi-dashboard.md` (Global Constraints lines 67–69
and 83–86; Task 2 lines 189–192; Task 4 lines 244–247, 252–253, 260; Task 5 lines 282–285, 305–306, 313–317; Task 6 lines 324–331; Task 7 lines 371–374).
Surrounding plan text and code read only to judge those. Code read in the worktree `backlog-manager-multi-dashboard`, located through the main checkout's
CodeGraph index.

## Verdict

**APPROVE WITH FIXES** — two Important findings, both in Task 5's Step 3 order (plan:313–317); every other changed line checks out against the code.

## Checked and true (changed lines only)

- plan:67–69 — `SPAWN_TIMEOUT_MS = 10_000` (agents.service.ts:91, used by the private `spawn` at 1466 with a 502 at 1471) and `STOP_TIMEOUT_MS = 10_000`
  (session-stop.util.ts:7, 502 at 26/32). The plan's "keep today's … on every machine" is consistent with both.
- plan:84–86 — `pickFrom` (shared/agent.ts:226) is called from `spawnInProject` (agents.service.ts:617–618) and `orchestrate` (897–898) exactly as the plan
  says; the spec's remote 400 rule is spec:139–142 and the plan's copy matches it.
- plan:189–190 — two remotes with distinct hosts, plus `ghost` and `undefined` → the per-key `byHost` is exercised with ≥ 2 keys, as the checklist asks.
- plan:191–192 — `test/agents-origin-guard.test.ts` rows are exactly urlencoded (165), cross-origin JSON (176) and `Origin: null` (190), each `.expect(403)`
  with `expect(sent).toEqual([])`; the earlier "415" wording is gone and the copy now matches the suite.
- plan:244–247 — `projectMap(cfg)` is `private` (agents.service.ts:1497) with the single slot `this.cache.url === cfg.url` (1499, declared at 294);
  `test/agents-status.test.ts:126` is titled "fetches the heavy project list once per TTL, health every time".
- plan:252–253 — `ItemsService.sourceOf(projectPath)` is at items.service.ts:292; `ProjectSummary.repo` / `.interval` / `.source` / `.path` are top-level
  fields (shared/types.ts, spread from `connection` at items.service.ts:164), so Task 4's fixture shape at plan:265 is the real wire shape.
- plan:282–285 — `server/src/orchestrator/starting-runs.service.ts` exists; `OrchestratorModule` exports `OrchestratorService, StartingRunsService,
  WatchdogStateService` (orchestrator.module.ts:17) and `AgentsModule` imports it (agents.module.ts:66); `server/src/orchestrator/remote-starting.service.ts`
  and `server/src/agents/dashboards/` do not yet exist (Create is right). `DispatchRecord` (dispatch-records.service.ts:29–36) has no `machine` yet.
- plan:324–331 — `AgentOrchestrateRequest` is at agents.service.ts:221 in the worktree; `OrchestratorService.runs()` answers `remote: []` on both exits
  (orchestrator.service.ts:332, 399) and the controller fills it at orchestrator.controller.ts:70; `RemoteRunsService` is NOT exported today, so "also
  export" is right; `test/orchestrator-starting.test.ts:229–235` says its remote cases moved to `orchestrator-runs.test.ts`'s bug-57 cases (2 mentions
  there). `RemoteRun` = `OrchestratorRun & { fresh; remote: true; repo }` (shared/types.ts:1912), so the `a run of <repo> is live on <label>` 409 has its
  `repo` and `project` in hand.
- plan:371–374 — the ladder matches items-abort.service.ts:80–112: stale-and-no-record (80), agents-off 409 (89), record → `stopDashboardSession` (93–94),
  else empty-`BM_MACHINE_NAME` 409 (96–98) → host-equality 409 (100–101) → `dashboardSessionStatus` (103–108) → release `aborted` (112). The two named
  suites exist at tracker-abort.test.ts:337 and 348 and sit in branch (c).

## Findings

### Important

**[I] plan:313 — a remote execute can never reach the spawn: the order runs the finish/base shape rules before the machine is resolved, and the plan never
says where a remote execute's base comes from.** `finish` absent on `machine: 'Pro'` is forced to `pr` (plan:304 "finish absent → spawned with the pr
finish clause"), but `finishClause('pr', base)` (shared/agent.ts:915–917) spells `--base <base>` out and `proveBaseBranch(undefined, …)` is a 400
(base-branch.util.ts:57–65, "is not a valid branch name"). A body that sends `base` to supply one fails today's rule 3 first — `req.base !== undefined &&
finish !== 'pr'` → 400 `base applies only to finish pr` (agents.service.ts:459–462), because `finish` is derived as `req.finish ?? 'in-place'` BEFORE
the machine is known. The word "base" appears once in the whole plan (line 10). → Resolve the machine before rules 3–4 and derive `finish = m.home ?
(req.finish ?? 'in-place') : 'pr'` there, so a remote execute is held to the same `base is required with finish pr` / proved-base rules as any `pr`
execute; make the plan:304 and plan:308 cases send `base: 'main'`; and state the base proof for a remote launch (the spec's "Left to the builder" asks the
plan to say which — the LOCAL clone's `refs/heads/<base>` via `proveBaseBranch`, which is what `item.projectPath` gives). Task 8/9's RunOn group then has
to send `base` with a remote execute whether or not Finish is drawn locked.

**[I] plan:315–316 — `dispatchBlock` against the remote's status blocks every remote launch.** `dispatchBlock(item, status)` is
`projectDispatchGate(status, item.projectPath)` (shared/agent.ts:434–450), and the gate's second rung is `status.projectPaths.includes(projectPath)`
(shared/agent.ts:369–385). `item.projectPath` is this machine's registry path; the remote's `statusOf(m.cfg).projectPaths` lists the REMOTE's paths
(`/Users/p/bm` in Task 4's fixtures). So the line as written yields `disabled` with `the dashboard does not list <local path> — …` for every remote
dispatch, a 409 the Task 5 success case (plan:308) would then fail on. → Say: for a remote launch run `projectDispatchGate(statusOf(m.cfg), remotePath)`
with the path `OffersService.remotePath` returned (or state that the offers 409 — reason 5 at plan:75 already asks this of the remote path — is the one
check and only `spawnMaxPermission` is read from the remote status); keep `dispatchBlock(item, status())` for home only.

### Minor

- plan:84–86 — "any model or effort outside that machine's list is a 400 — unknown strings included" leaves an ABSENT `model`/`effort` unstated; plan:308's
  success case sends none, which implies absent stays the default (`?? DEFAULT_MODEL`, no `--effort`), but say it, and say how a non-string (`42`, which the
  `Partial` body cannot rule out) is shown in `model "<m>"` (`JSON.stringify`, as `proveBaseBranch` does at base-branch.util.ts:62).
- plan:191–192 — the suite's `bodyFor(route)` (agents-origin-guard.test.ts:~100–125) picks a body by prefix (`/api/items/`, `/api/agents/`); a
  `/api/dashboards/...` route falls through to the dispatch body. Harmless for the three 403 rows (the guard fires before the body is read), and the
  no-origin loop is filtered to `/api/items/` (line 210), so nothing else runs — but say "no `bodyFor` branch needed" so the implementer does not widen
  that loop.
- plan:252–253 — "the repo the same way `ProjectSummary.repo` is built" means `adapter.summary(project, marker)` (items.service.ts:156–164), which also
  reads poll state; the cheaper read of the same value is the marker's `repo` via `resolveSource` as `syncOffBlock` does (poller.service.ts:518–522). Either
  is fine; say which so Task 4's offers call does not pay a summary per machine.
- plan:371 — (a) is keyed by `holder.session` (items-abort.service.ts:93 `this.dispatches.get(holder.session)`), not by item; and the stale branch at line
  80 still precedes (a)/(b), so a stale remote claim with no record is released as `stale` without asking the remote dashboard (today's
  tracker-abort.test.ts:418 behaviour). Both are right; a one-clause note keeps the implementer from "fixing" either.
- plan:373–374 — the quoted suite titles are prefixes; the exact titles are "refuses (409) a claim held on another machine, without asking the dashboard"
  (tracker-abort.test.ts:337) and "refuses (409) a claim that records no host" (348).

## Checklist pass (changed sections)

1. Coverage — the changed lines touch spec:139–142 (per-machine lists, 400), spec:144–148 (remote starting), the Goals paragraph on Stop after restart,
   and the timeout rule; each still maps to Tasks 5/6/7 and the Global Constraints. No spec section lost a task in this diff.
2. Values — every copy string in the changed lines matches the spec or the code it quotes (see "Checked and true").
3. Reality — every path, name and line number in the changed lines exists or is correctly marked Create (see above).
4. Interfaces — `remotePath` now returns `{ path } | { reason }` (plan:260) and Tasks 5–6 consume it by that name; `RemoteStartingService` is produced in
   Task 5 and consumed in Task 6; `RemoteRunsService.list()` (remote-runs.service.ts:43) is what Task 6 reads.
5. Order — Task 5's `list` input takes a structural `{ project; host; startedAt }`, so it does not depend on Task 6's `RemoteRun.host`. The one order
   problem is inside Task 5's own Step 3 (Important 1).
6. Tests — the two Important findings are each caught by an existing Task 5 case (plan:304, plan:308) failing for the wrong reason, which is why they are
   Important rather than Critical: the implementer would hit them, but would have to guess the fix.
7. Conventions — behaviour and signatures only, no literal code; 160-column wrap kept.
