# Fence audit — CLAUDE.md floor cut (2026-11-02)

Spec: [2026-11-02-claude-md-floor-design.md](../specs/2026-11-02-claude-md-floor-design.md), section "The fence audit". Plan: Task 2. Every rule leaving
`CLAUDE.md` was checked against criterion (b): does its rule file's `paths:` cover every source file a session could edit and thereby break the rule?
`#` is the bullet's position in `CLAUDE.md`'s `## Invariants` on `origin/main` at 0687dd2c; `C1`–`C3` are the `## Conventions` bullets; `L*` are the normative
sentences embedded in `## Layout`. Research was split across three readers by home rule file; the tables are theirs, the rulings below are the author's.

## Rulings over the readers' proposals

- **Keep is the error-safe direction.** A wrong `keep` costs ~230 B in every session; a wrong `fenced` drops a rule from sessions that can break it. Every `keep`
  proposal is accepted without a second pass; every `widen` glob is checked against `git ls-files` by `test/claude-rules.test.ts`.
- **#65** proposed `rehome: scripts.md`. Ruled `widen: scripts/sync-plugin.mjs` on `skills.md` instead — the rule governs `agents/**` too, which `scripts.md` does
  not fence, so `rehome`'s own condition fails.
- **L3** (`hub/` is read-only, no actions) proposed `keep`. Ruled `widen: server/src/hub/**` on `security.md` with a new bullet — one glob, one small file.
- **L11, L13, L17, L25** need no new bullet: L11 is already stated in #70 (`board.md`), L13 is an instance of L12, L17 and L25 describe a seam rather than
  constrain one, so they stay as description in the Layout line or `docs/overview.md`.
- **L2** (the three outbound-calling modules are the ONLY three) and **L24** (start orchestrator runs from the board) join the keep-list as unlinked bullets.
- **C3** (test location) stays in `CLAUDE.md`'s `## Conventions`, unchanged: it governs `skills/*/tools/*.test.mjs`, `scripts/*.test.mjs`, `package.json` and
  `jest.config.ts`, four globs over three areas.

## Applied

| rule file | globs added to `paths:` | new bullets |
| --- | --- | --- |
| board.md | `shared/agent.ts`, `shared/theme.css`, `client/index.html`, `server/src/security.ts`, `server/src/agents/agents.service.ts`, `server/src/orchestrator/remote-runs.util.ts` | #101, L12, L15 |
| dispatch-watchdog.md | `server/src/jira/prompt.util.ts`, `docker-compose.yml`, `skills/backlog-orchestrate/tools/orchestrate.mjs`, `server/src/orchestrator/watchdog-*.ts`, `server/src/orchestrator/orchestrator.controller.ts` | — |
| items.md | `server/src/agents/items-abort.*.ts`, `server/src/tracker/tracker.controller.ts`, `shared/types.ts`, `Dockerfile` | #26, L4 |
| jira.md | `docker-compose.yml`, `shared/jira-branch.ts`, `server/src/agents/session-stop.util.ts` | L23 |
| orchestrator.md | `skills/backlog-retro/tools/lib/paths.mjs`, `skills/backlog-retro/tools/lib/reviews.mjs`, `server/src/agents/agents.*.ts`, `server/src/agents/orchestrate-args.service.ts`, `server/src/tracker/map-issue.ts`, `client/src/lib/remote-starting.ts`, `client/src/components/RunControls.tsx` | L6 |
| scripts.md | `docker-compose*.yml` | #78 |
| security.md | `server/src/jira/env.util.ts`, `server/src/jira/refs.util.ts`, `server/src/hub/**` | #75, #79, L3 |
| skills.md | `server/src/tick/tick.service.ts`, `server/src/tick/tick-breaker.util.ts`, `scripts/sync-plugin.mjs` | — |
| tick.md | `skills/backlog-tick/tools/tick.mjs`, `skills/backlog-tick/tools/tick-breaker.mjs` | — |

## Audit — board.md, tests.md, the homeless five, Conventions, Layout

| # | headline (first 60 chars) | home | governed paths outside the fence (with file:line evidence for each) | resolution |
|---|---|---|---|---|
| 13 | A starting entry blocks what a run file blocks, on every sur | board.md | `shared/agent.ts:500` (`runClaimBlock`'s required `starting` param; `runHoldsItem` at :687 must NOT gain it); `server/src/agents/agents.service.ts:382,576,914` (dispatch/plan call `runClaimBlock(item, runs, starting)`; orchestrate refuses a starting project with `RUN_IN_PROGRESS_CODE`) | widen: `shared/agent.ts`, `server/src/agents/agents.service.ts` |
| 15 | Escape has one owner, and the topmost dialog is the only one | board.md | none — `client/src/hooks/useDialogEscape.ts` and every caller (`ui/Modal.tsx`, `ui/FormSheet.tsx`, `ui/Confirm.tsx`, `ui/Popover.tsx`, `ReleasesDrawer.tsx`, …) are under `client/src/` | fenced |
| 16 | ui-kit draws the version chip and the What's new drawer; thi | board.md | `shared/theme.css` — one of the two sheets the guard checks for `.uk-*` restyles / non-public `--uk-*` (`test/ui-kit-guard.test.ts:13` `SHEETS = ['client/src/styles.css', 'shared/theme.css']`) | widen: `shared/theme.css` |
| 17 | The strip's height and the well's gap are one token, `--main | board.md | none — `--main-gap` appears only in `client/src/styles.css` and `client/src/App.tsx` | fenced |
| 26 | Item bodies are served through a registry-built allowlist | items.md (proposed) | none — `server/src/items/allow.util.ts:11,23` (`buildAllowlist`, `resolveAllowed`), sole caller `server/src/items/sources/files.source.ts:56,94` | fenced |
| 43 | Board-versus-Archive is derived from `updated ?? lastCommit  | board.md | none governing — `client/src/lib/item-stale.ts`, `client/src/lib/item-touched.ts` are in fence; `runHoldsItem` (`shared/agent.ts:687`) is only consumed | fenced |
| 48 | A client poller built on `useCoalescedFetch` never has two o | board.md | none — `lib/coalesced-poll.ts`, `hooks/useCoalescedFetch.ts`, `hooks/useRefreshing.ts`, `hooks/useTrackers.ts`, `hooks/useJira.ts` all under `client/src/` | fenced |
| 70 | Settings is three pages, the page is the scope, and the rail | board.md | none — `client/src/lib/settings.ts`, `lib/sections.ts`, `SideRail.tsx`, settings pages | fenced |
| 71 | The Jira section's two pages are switched by the rail's tree | board.md | none — `lib/sections.ts`, `lib/source-page.ts`, `lib/jira-page.ts`, `hooks/useJiraPage.ts`, `App.tsx`, `JiraView`; `GET /api/jira`'s `configured` is only read | fenced |
| 72 | A source row (Files, GitHub) is drawn only while a registere | board.md | none — `hooks/ProjectsContext.tsx`, `lib/sources.ts`, `lib/source-page.ts`, `hooks/useSourcePage.ts`, `lib/view-keys.ts` | fenced |
| 73 | `contentWidth` is stamped before first paint, and the CSP ha | board.md | `client/index.html:49` (the inline script that stamps `data-width` — outside `client/src/**`); `server/src/security.ts:20` (`THEME_SCRIPT_SHA256`, must follow the script) | widen: `client/index.html`, `server/src/security.ts` |
| 75 | Container mounts land on host paths, read-only | security.md (proposed) | `server/src/jira/env.util.ts:59-75` (`BM_REPO_ROOTS` / `repoRoots()`); `server/src/jira/refs.util.ts:41` (the "not mounted into the board" vs missing distinction) | widen: `server/src/jira/env.util.ts`, `server/src/jira/refs.util.ts` |
| 78 | `allowBuilds` in `pnpm-workspace.yaml` lists `esbuild` | scripts.md (proposed) | none — `pnpm-workspace.yaml:10` is in fence (`Dockerfile:78` only comments on it) | fenced |
| 79 | Editing `vite.config.ts` needs `docker compose restart clien | security.md (proposed) | none — `vite.config.ts`, `docker-compose.yml` both in fence | fenced |
| 86 | An environment-level block hides the dispatch control; the p | board.md | `shared/agent.ts:468,528,548,570` (`dispatchGate`, `inReviewBlock`, `unvettedBlock`, `planReviewBlock` — the rungs and their order); `server/src/agents/agents.service.ts:371,545,550` (the two server ladders must keep the client's order) | widen: `shared/agent.ts`, `server/src/agents/agents.service.ts` |
| 87 | Run ▾ on a Jira card is never hidden for the dashboard's sak | board.md | none — `components/jira/JiraRunMenu.tsx`, `components/jira/JiraLaunchSheet.tsx`, `lib/jira.ts`; `projectDispatchGate` (`shared/agent.ts:398`) is only consumed | fenced |
| 94 | A crashed run renders as crashed, never as nothing. | board.md | `server/src/orchestrator/remote-runs.util.ts:276-279` (`statusOf` deliberately reports a stale remote run as `running && !fresh` so it draws as crashed, citing this rule) | widen: `server/src/orchestrator/remote-runs.util.ts` |
| 96 | `useOrchestratorRuns` polls while any run is `running`, fres | board.md | none — `client/src/hooks/useOrchestratorRuns.ts` | fenced |
| 98 | The board offers a hand resume exactly when the watchdog wil | board.md | `shared/agent.ts:889` (`watchdogStoodDown`, plus `watchdogExhausted`/`watchdogFailing`); `server/src/agents/watchdog.service.ts:489` (the sweeper's reader); `server/src/orchestrator/watchdog-state.service.ts:316` (`spawningEnabled`, a single derived implementation) | keep |
| 100 | The launch sheet's model/effort pickers seed from Settings,  | board.md | none — `client/src/lib/settings.ts` (`dispatchDefaultModel`/`Effort`, `MODELS`/`EFFORTS`, `executeDefaultFinish`), `components/board/LaunchSheet.tsx` | fenced |
| 101 | `linkBase` becomes an href | board.md (proposed) | none — `client/src/lib/settings.ts` (`clampSettings`/`clampOrigin`), `components/settings/SettingsView.tsx:578-610`, `lib/agents.ts:466` | fenced |
| 102 | "Queue wait is not work." | board.md | none governing — `client/src/lib/run-time.ts`, `lib/run-stats.ts` (`MACHINE_STAGES`, `runStageTotals`) | fenced |
| 104 | Every `.claude/rules/` file carries `paths:` and is the one  | tests.md | `CLAUDE.md` (linked headlines byte-equal, headline+link bullets); `agents/backlog-reviewer.md:130` (reviewer opens the rule files covering the diff); `skills/backlog-execute/SKILL.md:308` (contract sweep visits `.claude/rules/*.md`); `skills/backlog-orchestrate/references/questions.md:12` | keep |
| C1 | A suite that hands an app to supertest listens once, on `127 | tests.md | none — `test/helpers/app.ts:38` (`listenLoopback`), every `test/*.test.ts`, guard `test/supertest-bind.test.ts` | fenced |
| C2 | A jsdom suite's fixture dates are relative to the clock the  | tests.md | none — `test/helpers/dates.ts`, every `test/*.test.tsx`, guard `test/fixture-clock.test.ts` | fenced |
| C3 | Tests are flat in `test/` under jest and beside the tool the | tests.md | `skills/*/tools/*.test.mjs` (20 files; e.g. `skills/backlog-retro/tools/retro-lib.test.mjs` must stay at `tools/` level); `scripts/*.test.mjs` (4 files); `package.json:18` (`test:skills` glob pair); `jest.config.ts:11` (`testMatch`); `scripts/test-all.mjs:33` | keep |
| L1 | Layout: the ten write routes in `items-write.controller.ts` + `abort` are the ONLY writes to items | keep (proposal) | `server/src/items/items-write.controller.ts` (10 `@Post`), `server/src/agents/items-abort.controller.ts:20`, and any other server module (a new writer anywhere breaks it) | duplicate of #18 (KEEP) + #19 (`items.md:7`) |
| L2 | Layout: `agents/`, `tracker/`, `jira/` are the outbound-calling modules, and the ONLY three (`agents/dashboards/` not a fourth; `releases/`, `tick/` not outbound) | keep (proposal) | every `server/src/**` module (a fourth caller can appear anywhere) | keep |
| L3 | Layout: `hub/` is three read-only Lookout widgets, no actions | keep (proposal) | `server/src/hub/hub.controller.ts`, `server/src/hub/hub-widgets.ts` — no rule file's fence covers `server/src/hub/**` | keep |
| L4 | Layout: `releases/` is read-only, git only | items.md (proposal) | none — `server/src/releases/**` is in items.md's fence | fenced |
| L5 | Layout: `tick/` is read-only on `~/.backlog-manager/tick/`, not outbound | tick.md (proposal) | none — `server/src/tick/**` | duplicate of `tick.md:19-21` (#32's bullet: "only READS `$BM_TICK_HOME`", "not an outbound-calling module") + #6 |
| L6 | Layout: `orchestrator/` is a read-only view of run state; the server writes two files there, `POST /api/trackers/sync` the third | orchestrator.md (proposal) | none — `server/src/orchestrator/pause-control.util.ts`, `watchdog-config.util.ts`, `tracker-sync.controller.ts` all in fence | fenced |
| L7 | Layout: `allowed-hosts.ts` is the Host allowlist every route is gated by | security.md | — | duplicate of #69 (security.md) |
| L8 | Layout: `runGit` is the one way this server runs git | items.md | — | duplicate of #46 (KEEP, items.md) |
| L9 | Layout: every route under `/api` | keep | — | duplicate of #25 (KEEP) |
| L10 | Layout: Files and GitHub each drawn only while a registered project has that source | board.md | — | duplicate of #72 (board.md) |
| L11 | Layout: Runs is THREE pages switched by the rail's sub-nav tree alone, never an in-page control | board.md (proposal) | none — `client/src/lib/runs-mode.ts:35` (`RUNS_MODES`), `hooks/useRunsMode` | fenced |
| L12 | Layout: every derivation has one home in `lib/`; every look more than one surface draws has one home in `components/ui/` | board.md (proposal) | none — `client/src/lib/**`, `client/src/components/ui/**` | fenced |
| L13 | Layout: the tracker readings are all derived in `lib/tracker.ts`, Jira's in `lib/jira.ts` | board.md (proposal) | none — `client/src/lib/tracker.ts`, `client/src/lib/jira.ts` | fenced |
| L14 | Layout: Jira drawn only while `GET /api/jira` says configured; Board/Setup switched by the tree alone | board.md | — | duplicate of #71 (board.md) |
| L15 | Layout: every component must cite its DESIGN.md subsection in a header comment | board.md (proposal) | none — `client/src/components/**` (77 of 90 `.tsx` cite `DESIGN.md §` today; no test enforces it) | fenced |
| L16 | Layout: `.claude/rules/` hold the mechanism tier, one home per rule, headline in CLAUDE.md, every bullet anchored into invariants.md | tests.md | — (lines 41-42 and 57-59 of the Layout section) | duplicate of #104 (tests.md:7) |
| L17 | Layout: `shared/agent.ts` holds the run/watchdog predicates both sides must agree on | keep (proposal) | `shared/agent.ts` plus its client callers (`client/src/components/**`) and server callers (`server/src/agents/**`, `server/src/orchestrator/**`) | keep |
| L18 | Layout: `jira-branch.ts` is imported by server and launch sheet; `jira.mjs` keeps its one hand copy | jira.md | — | duplicate of #39 (jira.md) |
| L19 | Layout: `backlog.mjs` is the registry's only writer | skills.md | — | duplicate of #2 (KEEP, skills.md) |
| L20 | Layout: `orchestrate.mjs` is the run file's only writer | orchestrator.md | — | duplicate of #3 (orchestrator.md) |
| L21 | Layout: `retro.mjs` owns `~/.backlog-manager/retro/` | skills.md | — | duplicate of #5 (skills.md) |
| L22 | Layout: `tick.mjs` is read-only against items, run state and git, and owns `~/.backlog-manager/tick/` | skills.md | — | duplicate of #6 (skills.md: "writes no git either", run-state home read-only) |
| L23 | Layout: `jira.mjs` goes through `/api/jira` and writes no file of its own; `worktree` is git only | jira.md (proposal) | none — `skills/jira/tools/jira.mjs` is in jira.md's fence | fenced |
| L24 | Layout: start orchestrator runs from the board, not by typing the trigger into a terminal | keep (proposal) | none — a process rule for the person/session, no source file obeys it | keep |
| L25 | Layout: `agents/` is discovered from this root-level directory by Claude Code's own convention | skills.md (proposal) | none — `agents/backlog-reviewer.md` is in skills.md's fence | fenced |

Notes:

- #13 / #86: the alternative is `rehome: dispatch-watchdog.md` + widen `client/src/**`, but rehome's own definition needs the existing fence to cover everything, so I chose widen on board.md (2 globs, logged via `autopilot decide`).
- #16: `shared/theme.css` has no `--uk-*` today. It is governed only because the guard lists it, so a session adding a kit token there should see the rule.
- #43: `runHoldsItem` (`shared/agent.ts:687`) and `lastCommit` (`server/src/items/git-dates.util.ts`, which is #44's) are inputs, not obeyers, so I did not count them. Widen with `shared/agent.ts` if you count the "held by a fresh run is never stale" input.
- #73: `server/src/security.ts` is already in security.md's fence, so widening only `client/index.html` would also do if security.md gets a CSP-hash bullet (#74 is KEEP and homeless).
- #75: the two `repoRoots()` callers (`server/src/jira/jira.controller.ts:178,209`, `server/src/agents/jira-dispatch.service.ts:112`) are inside jira.md's fence and pass the roots through. `.env.example:51` is config documentation, not counted.
- #94: `server/src/orchestrator/orchestrator.service.ts:376` (`fresh`) and `watchdog-state.service.ts` (`annotate`) also feed the crashed reading. Only `remote-runs.util.ts` states the rule as its own constraint, so only it is listed (one glob `server/src/orchestrator/**` would take all three).
- #98: three areas (shared, `server/src/agents`, `server/src/orchestrator`) → keep. Otherwise widen board.md with 3 paths, or move the bullet to dispatch-watchdog.md and widen with `client/src/components/RunControls.tsx` + `server/src/orchestrator/watchdog-state.service.ts`.
- #102: `skills/backlog-retro/tools/lib/run-files.mjs:15-20` applies the same "pending is not work" rule to the retro on its own and carries it in its own comment. I treated it as a twin, not governed. If counted → widen with that file.
- #104: `CLAUDE.md` is itself a governed file and is never "read" through a glob-firing Read in the usual sense, which is one more reason for keep.
- C3: `scripts.md`'s `pnpm test` bullet already covers `package.json`/`scripts/**`. The location half still needs `skills/*/tools/**` and `jest.config.ts`, which makes keep.
- L1: the Layout's "ten … with `abort`" matches items.md's "eleven" (10 `@Post` in `items-write.controller.ts` + `abort`). The reasoning is `invariants.md#the-eleven-item-write-routes-are-guarded-refused-for-files-and-serialised-per-item` (line ~4006 names the outbound modules too).
- L2: reasoning lives at `invariants.md:3474` (inside `#the-github-token-never-leaves-the-server-and-the-poller-is-armed-only-while-something-is-connected`) and `:4006`. It is partly restated in `dispatch-watchdog.md:133` ("not a fourth") and `tick.md:21`, but no bullet states "ONLY three".
- L3: no fence covers `server/src/hub/**`. The cheapest fenced home would be adding that glob to security.md. Otherwise keep.
- L6: partly stated already by #3 (the server never writes `run.json`, `orchestrator.md`) and #89 (the server-owned pause file). The "exactly two files + trackers/sync the third" count is new. The reasoning anchor is `#the-orchestrators-run-file-has-exactly-one-writer-one-reader--the-same-relationship-the-registry-has`.
- L11: `board.md:51` (#70) already says "the same rule Runs' three pages follow". Folding it into #70 needs no new bullet. The anchor is `#settings-is-three-pages-the-page-is-the-scope`.
- L12 / L13 / L15: no invariants.md heading and no existing bullet. Each would be a new board.md bullet with no `Why:` anchor, and the test's "at most 80 words" rule for unlinked bullets applies.
- L17: partly covered by #98 ("one function, not two agreeing expressions") and #13. As a general rule it governs every caller of `shared/agent.ts` on both sides.
- L18: #39's own fence verdict applies. `shared/jira-branch.ts` is outside jira.md's fence (it is another auditor's row).
- L23: the "through `/api/jira`" half duplicates #34 and the `worktree` exception duplicates #23. Only "writes no file of its own" is new.
- L24: reasoning in `docs/subsystems/skills.md:317` and `invariants.md:2408` (under `### Armed, idle, off`, inside the resume section). Restated at `dispatch-watchdog.md:89`.
- L25: borderline normative (it reads as a description). #65 covers the publish surface, not the root-level location.

## Audit — dispatch-watchdog.md, items.md, security.md, scripts.md, tracker.md, tick.md

| # | headline (first 60 chars) | home | governed paths outside the fence (with file:line evidence for each) | resolution |
|---|---|---|---|---|
| 12 | A board-started run is visible before its run file exists, f | dispatch-watchdog.md | `server/src/orchestrator/starting-runs.service.ts:64` (the Map and its three eviction rules); `server/src/orchestrator/orchestrator.controller.ts:70` + `server/src/orchestrator/orchestrator.service.ts:418` (`starting` rides as a separate top-level array); `client/src/components/board/RunChip.tsx:73` and `client/src/components/runs/RunsView.tsx:328` (render `starting` unfiltered, no controls) | keep |
| 19 | The eleven `/api/items/*` write routes are guarded like the  | items.md | `server/src/agents/items-abort.service.ts:86,142` (the ninth route gates via `writable`, maps via `answer`, releases with `authority: 'board'`); `server/src/agents/items-abort.controller.ts:5` | widen: `server/src/agents/items-abort.*.ts` |
| 21 | An outsider's tracker issue is executable only while its bod | tracker.md | `server/src/items/sources/github.source.ts:900,968` (`pinBody`); `shared/agent.ts:548` (`unvettedBlock`); `client/src/components/board/DispatchButton.tsx:198`; `server/src/agents/agents.service.ts:380,546`; `skills/backlog-orchestrate/tools/orchestrate.mjs:2201,2254` (`unvettedGate`); `skills/backlog-tick/tools/tick.mjs` (`trackerExecuteCandidate`); `skills/backlog-execute/SKILL.md:187` | keep |
| 27 | A project's source is a committed marker, resolved per reque | items.md | `server/src/tracker/tracker.controller.ts:48,66-72` (`/api/trackers` must answer `unsupported` exactly as `/api/projects` does); `shared/types.ts:65` (`SourceKind`, the closed list that widens only with an adapter; `BacklogItem.source` required) | widen: `server/src/tracker/tracker.controller.ts`, `shared/types.ts` |
| 28 | The GitHub token never leaves the server, and the poller is  | tracker.md | `docker-compose.yml:109` (token passed as interpolation with default, never a literal); `server/src/items/sources/github.source.ts:131` (`arm()` from `GithubSource.list`); `server/src/orchestrator/tracker-sync.controller.ts:71` (`arm()` from `POST /api/trackers/sync`) | keep |
| 29 | A repo whose sync is off refuses every write path, and canno | tracker.md | `client/src/lib/tracker.ts:285` (`syncOffReason`, pinned copy); `server/src/items/sources/github.source.ts:1279` (refusal in `writeChain`); `server/src/agents/agents.service.ts:583,833,1233` (dispatch/orchestrate/resume); `server/src/agents/items-abort.service.ts:89`; `server/src/orchestrator/tracker-sync.controller.ts:23,78` (400/404/409 ladder, refuse switch-off under live run) | keep |
| 30 | The tracker, Jira and pull-request caches are the three cach | tracker.md | `server/src/jira/poller.service.ts:203` (`JiraPollerService`, the second cache); `skills/backlog-orchestrate/tools/orchestrate.mjs:1994-2024` (`polledAt` beside the queue, one re-read timed off `polledAt`); `shared/types.ts:708` (`PR_UPDATING_MS`); `server/src/orchestrator/remote-runs.service.ts` (derives from comments with no cache of its own) | keep |
| 32 | `~/.backlog-manager/settings/tick.json` has exactly one writ | tick.md | `skills/backlog-tick/tools/tick-breaker.mjs:26,62-89` (`readTickSettings`, `CAP_MIN`/`CAP_MAX` hand copy, three read outcomes); `skills/backlog-tick/tools/tick.mjs:387-388` (`decide` answers `idle` on an unreadable file) | widen: `skills/backlog-tick/tools/tick-breaker.mjs`, `skills/backlog-tick/tools/tick.mjs` |
| 33 | `~/.backlog-manager/settings/dashboards.json` has exactly on | dispatch-watchdog.md | none — writer, reader, routes and launch checks are all under `server/src/agents/` (`dashboards/dashboards-file.util.ts:244`, `dashboards.controller.ts:87`, `dashboards.service.ts:285`) | fenced |
| 38 | The board's pull-request writes are merge, auto-merge and up | tracker.md | none — `server/src/tracker/pulls.controller.ts`, `pulls.service.ts`, `github.client.ts` | fenced |
| 41 | A tracker project has no item files, and that shows up in th | items.md | `server/src/tracker/map-issue.ts:177` (`untyped`); `shared/agent.ts:135` (`deriveAction` asks nothing about source); `server/src/agents/agents.service.ts:592` + `server/src/agents/dashboard-sessions.util.ts:84` (`itemClaimBlock`); `server/src/agents/orchestrate-args.service.ts:218` (`resolveTrackerIds` emits bare digits) | keep |
| 44 | The middle rung of "last touched" comes from git, not the it | items.md | `Dockerfile:35,44` (git installed, `safe.directory` in system config) | widen: `Dockerfile` |
| 45 | The Orchestrate sheet's `uncommitted` flag is read from git  | items.md | `client/src/lib/orchestrate-draft.ts:202` (`uncommittedFates`, split by `absent`); `client/src/hooks/useOrchestrateDraft.ts:259,328` (fetch, no default-selection change); `client/src/components/board/orchestrate/ItemsStep.tsx:90-92` (`known` gates render, consequence split) | keep |
| 67 | The tailnet serve is a script, and its port is read where co | scripts.md | `docker-compose.yml:217` and `docker-compose.run.yml:25` (`${BM_WEB_PORT:-5177}`, the compose default `scripts/tailnet.mjs:61` must equal) | widen: `docker-compose*.yml` |
| 68 | Both processes bind `127.0.0.1` by default; loopback is the  | security.md | none — `server/src/main.ts:20`, `vite.config.ts:21`, `docker-compose.yml:49,206` | fenced |
| 69 | Every route is gated by a Host allowlist, because a bind is  | security.md | none — `server/src/allowed-hosts.ts:47`, `server/src/security.ts:74`, `server/src/app.module.ts:41`, `vite.config.ts:24` | fenced |
| 77 | `pnpm test` is the union of BOTH runners | scripts.md | none — `scripts/test-all.mjs`, `package.json:16-18` | fenced |
| 81 | Dispatch derives the action; it never accepts one. | dispatch-watchdog.md | `shared/types.ts:860` (`parseJiraAction`); `server/src/jira/prompt.util.ts:222` (`resolveJiraActionOrThrow`); `server/src/items/items.service.ts` (`find`, which `findItem` delegates to); `skills/backlog/tools/backlog.mjs:1295` (`moveItem` refuses moves out of `out-of-scope/`) | keep |
| 82 | `isItemId` accepts three shapes, and `#` is the one metachar | dispatch-watchdog.md | none — `shared/agent.ts:782`, `server/src/agents/orchestrate-args.service.ts:218` | fenced |
| 83 | The orchestrate and Jira spawn prompts are composed server-s | dispatch-watchdog.md | `server/src/jira/prompt.util.ts:48,162,171` (`composeJiraPrompt`, nonce framing, `JIRA_PROMPT_MAX`) | widen: `server/src/jira/prompt.util.ts` |
| 84 | The browser never talks to the dashboard. | dispatch-watchdog.md | `docker-compose.yml:69,95` (`${BM_AGENTS:-off}`, `BM_AGENTS_URL` under the second key `BM_AGENTS_DOCKER_URL`) | widen: `docker-compose.yml` |
| 85 | A project the dashboard cannot see cannot be dispatched to. | dispatch-watchdog.md | none — `shared/agent.ts:398,468` (`projectDispatchGate`/`dispatchGate`); every server caller is under `server/src/agents/` | fenced |
| 88 | One run per project, checked twice. | dispatch-watchdog.md | `skills/backlog-orchestrate/tools/orchestrate.mjs:1138` (`init` refuses any `running` run file, exit 4) | widen: `skills/backlog-orchestrate/tools/orchestrate.mjs` |
| 91 | A resume is serialized at three layers, and only the third o | dispatch-watchdog.md | `client/src/components/RunControls.tsx:97,193` (layer 1, in-flight guard and `resuming` mark); `server/src/orchestrator/watchdog-state.service.ts:108` (`WatchdogEntry.resumeSpawnAt`); `skills/backlog-orchestrate/tools/orchestrate.mjs:1021,1050,1126` (layer 3, driver lease, exit 7) | keep |
| 92 | The sweeper's prune keeps `paused` runs, because an entry is | dispatch-watchdog.md | `server/src/orchestrator/watchdog-state.service.ts:256` (`prune()` must not decide the keep set; entry carries `resumeSpawnAt`) | widen: `server/src/orchestrator/watchdog-state.service.ts` |
| 93 | The watchdog spawns; it never writes the run file. | dispatch-watchdog.md | `server/src/orchestrator/watchdog-state.service.ts:162` (`WatchdogStateService`, memory only); `server/src/orchestrator/watchdog-config.util.ts:8` (`settings/watchdog.json`, its own single writer) | widen: `server/src/orchestrator/watchdog-*.ts` |
| 95 | The watchdog is armed only while some `run.json` says `runni | dispatch-watchdog.md | `server/src/orchestrator/orchestrator.controller.ts:43` (arms on the board's runs read via `observe`); `server/src/orchestrator/watchdog-state.service.ts:392,415-417` (`setArmer`/`observe`, arms only when a run says `running`) | widen: `server/src/orchestrator/orchestrator.controller.ts`, `server/src/orchestrator/watchdog-state.service.ts` |
| 97 | Any spawn attempt starts the grace clock; a success counts a | dispatch-watchdog.md | `server/src/orchestrator/watchdog-state.service.ts:134,145,371-381` (the two counters and `stalledLogged` on `WatchdogEntry`; `annotate()` publishes `exhausted`/`failing` from one config read) | widen: `server/src/orchestrator/watchdog-state.service.ts` |
| 99 | Every agents POST is guarded by content-type and origin | dispatch-watchdog.md | none — `server/src/agents/origin.guard.ts:66` and every agents controller | fenced |

Notes:

- #12: core is `starting-runs.service.ts` in orchestrator/, but the client render constraint and the payload shape make it 4 globs; a rehome to orchestrator.md would still miss `agents.controller.ts` (the mark) and the client.
- #27: `shared/types.ts` is a hub file every area imports; widening to it fires items.md on unrelated type edits. Dropping it (treating `SourceKind` as a passing mention) leaves `widen: server/src/tracker/tracker.controller.ts`.
- #28: the `arm()` call sites count as governed because removing one leaves the poller unarmed after a connect; without them the only outside file is `docker-compose.yml`.
- #32: `TICK_HALT_LIMITS`/`TICK_CAP_LIMITS` (`shared/types.ts:2699`) and the settings mount (`docker-compose.yml:181`) are treated as passing mentions.
- #33: client `MAX_REMOTES` copy (`client/src/components/settings/DashboardsPage.tsx:78`) and the compose settings mount treated as passing.
- #45: all three outside files are client; a single `client/src/**` widen would be too broad, so this stays keep at 3 globs.
- #67: borderline — the rule is mostly the script, but its title says the port is read where compose reads it, and both compose files hold the 5177 default.
- #83: `isJiraKey` (`shared/types.ts:1005`) and `COMMIT_RULE` (`shared/agent.ts:959`, inside fence) are named validators; `isJiraKey` treated as passing.
- #84: the client is governed only negatively (no file may call the dashboard), and it has no dashboard URL to call; not counted.
- #88: `RUN_IN_PROGRESS_CODE` (`shared/types.ts:1411`) treated as a passing constant.
- #93: the compose read-write settings mount (`docker-compose.yml:168-181`) treated as passing.

## Audit — orchestrator.md, skills.md, jira.md

| # | headline (first 60 chars) | home | governed paths outside the fence (with file:line evidence for each) | resolution |
|---|---|---|---|---|
| 3 | The orchestrator's run file has exactly one writer, one reade | orchestrator.md | none — writer `skills/backlog-orchestrate/tools/orchestrate.mjs`, reader `server/src/orchestrator/**`; `server/src/agents/*` reach run state only through `OrchestratorService` (agents.service.ts:3, watchdog.service.ts:6) | fenced |
| 4 | Remote runs ride beside `runs`, never in it | orchestrator.md | `server/src/agents/agents.service.ts:343` (RUN_IN_PROGRESS_CODE lock reads `orchestrator.runs()`, must stay local-only); `server/src/agents/watchdog.service.ts:124` (watchdog must stay local-only); `client/src/components/runs/RunDetail.tsx:120` (remote row read-only, no RunControls / archive fetch); `client/src/lib/remote-run.ts:4` (remote-row readings) | keep |
| 5 | `~/.backlog-manager/retro/` has exactly one writer, `retro.mj | skills.md | none — `BM_RETRO_HOME`/retro home referenced only under `skills/backlog-retro/` | fenced |
| 6 | `~/.backlog-manager/tick/` has exactly one writer, `tick.mjs` | skills.md | `server/src/tick/tick.service.ts:14` (server reads the tick home, must write none of it); `server/src/tick/tick-breaker.util.ts:41` (`tickHome()` beside `writeTickFile`, the one server writer, which must stay on `tick.json`) | widen: `server/src/tick/tick.service.ts`, `server/src/tick/tick-breaker.util.ts` |
| 7 | A tick does at most one unit of work, only when the project i | skills.md | `shared/agent.ts:557,570` (`PLAN_REVIEW_REASON`, `planReviewBlock`, `unvettedBlock`:548); `server/src/agents/agents.service.ts:24` (plan/dispatch ladder); `client/src/components/board/DispatchButton.tsx:1` (board Run gate); `server/src/items/sources/github.source.ts:876` + `server/src/items/items-write.controller.ts:15` (mark written in the same write as the plan); `server/src/tracker/map-issue.ts:4` (label → `planReview`) | keep |
| 8 | The only `started:` marker a tick clears is the one a killed  | skills.md | none — `claimStaleLock`/`--lock-ttl`/`killed at timeout` and `backlog.mjs stop --abandon` all under `skills/` | fenced |
| 9 | A tick halt is derived from `state.json`'s `recent` and the r | skills.md | `server/src/tick/tick-breaker.util.ts:64` (server twin of `streakOf`, pinned row for row); `server/src/tick/tick.service.ts:193,207` (Reset stamp `max(now, newest at)` into `tick.json`) | widen: `server/src/tick/tick-breaker.util.ts`, `server/src/tick/tick.service.ts` |
| 10 | A run's sidecars are archived beside its run file, under a na | orchestrator.md | `skills/backlog-retro/tools/lib/paths.mjs:112` and `skills/backlog-retro/tools/lib/reviews.mjs:91` (retro re-derives `runs/<stem>/` from the archive name the way `archiveStem` mints it — a reader that must derive, never read a stored dir) | widen: `skills/backlog-retro/tools/lib/paths.mjs`, `skills/backlog-retro/tools/lib/reviews.mjs` |
| 11 | A stale-plan mark is keyed by the plan's hash, so a re-groom  | orchestrator.md | none — `stale-plans.json`, `planStale`, `--plan-stale` and the `planHash` copy orchestrate imports (`skills/backlog-orchestrate/tools/drift-lib.mjs:74`, orchestrate.mjs:40) are all in the fence | fenced |
| 14 | A launch sent to another machine rides in `remoteStarting`, n | orchestrator.md | `server/src/agents/agents.service.ts:600,638,972` (`itemBlock`/`markItem`/`projectBlock` — what a remote launch blocks); `server/src/agents/agents.controller.ts:218` (`markProject` on spawn success); `client/src/lib/remote-starting.ts:8` (board readings, never folded into `starting`) | widen: `server/src/agents/agents.*.ts`, `client/src/lib/remote-starting.ts` |
| 22 | `orchestrator:queued` is a plan, never a claim: the driver ad | orchestrator.md | `server/src/items/items-write.controller.ts:14` (`POST /api/items/queue`); `server/src/items/sources/github.source.ts:540` (`claim` removes the label on a won claim); `server/src/agents/agents.service.ts:1496` (`stop` sweeps, `unqueueFailed`); `server/src/tracker/map-issue.ts:202` (mapper sets `queued`); `client/src/components/board/ItemCard.tsx:121` + `client/src/lib/tracker.ts:327` (`queuedReading`, the only reader) | keep |
| 23 | `backlog.mjs` in a tracker project and `jira.mjs` always need | skills.md | none — `backlog.mjs`, `api-call.mjs`, `jira.mjs` all under `skills/` | fenced |
| 24 | `import` writes the marker first and deletes the files last,  | skills.md | none — `bm:imported`, `withoutResumeMarker` only in `skills/backlog/tools/{backlog,import-lib}.mjs`; server accepts any release reason | fenced |
| 31 | `~/.backlog-manager/settings/jira.json` has exactly one write | jira.md | none — `readJiraConfig`, the six writers and their routes are in `server/src/jira/`; client only calls the routes | fenced |
| 34 | The Jira token never leaves the server: the browser and `jira | jira.md | `docker-compose.yml:115-117` (the three `'${BM_JIRA_<NAME>:-}'` interpolations the rule pins through `JIRA_ENV`) | widen: `docker-compose.yml` |
| 35 | Jira's Done column is a window, not a store: a done issue who | jira.md | none — `JIRA_DONE_WINDOW_DAYS`, `mapJiraIssue` only in `server/src/jira/` | fenced |
| 36 | Every value the server puts into JQL — a key or the search te | jira.md | none — `jqlString`, `JIRA_JQL_MAX_CHARS`, `JIRA_SEARCH_MAX_CHARS` only in `server/src/jira/` | fenced |
| 37 | The board's Jira writes are assign and transition, nothing el | jira.md | none — routes in `jira-write.controller.ts`, second caller `server/src/agents/jira-dispatch.service.ts` (inside `jira-*.ts`) | fenced |
| 39 | A Jira branch name obeys one rule, in `shared/jira-branch.ts` | jira.md | `shared/jira-branch.ts:117,125` (`branchNameProblem`/`branchCarriesKey` Tables A and B, `defaultBaseProblem`, `patternProblem` — the rule's own home) | widen: `shared/jira-branch.ts` |
| 40 | A Jira session is remembered in server memory only; a restart | jira.md | `server/src/agents/session-stop.util.ts:29` (`stopDashboardSession`'s 200 / `no live session` 404 / 502 split, which decides whether Stop clears the entry) | widen: `server/src/agents/session-stop.util.ts` |
| 49 | `refactors/` is a peer section, not a facet on ideas | skills.md | `server/src/items/scan.util.ts:28` (scans `refactors/` as a section); `server/src/tracker/labels.ts:112` (refactor type label); `client/src/components/board/ItemCard.tsx:21` (`REFACTOR_KINDS` badge) | keep |
| 50 | `started:` and `phase:` are the lifecycle keys allowed in fro | skills.md | `server/src/items/parse.util.ts:35` (`status:` ban); `server/src/items/scan.util.ts:73` (reads lifecycle/counter keys); `server/src/tracker/map-issue.ts:238` + `server/src/tracker/claim.ts:198` (tracker form); `client/src/lib/item-progress.ts:15` ("in progress" decided in the client) | keep |
| 52 | On a tracker project the DRIVER owns each item's claim, and t | orchestrator.md | `skills/backlog-execute/SKILL.md:151` (execute runs no start/stop/heartbeat under the marker); `server/src/items/sources/github.source.ts:468` (same-run takeover by `run.runId`); `server/src/tracker/claim.ts:200` (released/unreleased claim read by the mapper) | keep |
| 53 | The merge happens in whichever tree holds the base, and the r | orchestrator.md | `server/src/items/base-branch.util.ts:36` (`BASE_BRANCH_SHAPE`, `resolveBase`/`assertUsableBase`); `server/src/agents/orchestrate-args.service.ts:7` (base picker lists only shape-matching names); `skills/backlog-tick/tools/tick.mjs:84` (`REF_SHAPE` hand copy) | keep |
| 54 | Merge mode is run-scoped: chosen per launch, defaulted from S | orchestrator.md | `shared/types.ts:1227` (`MergeMode`); `server/src/agents/orchestrate-args.service.ts:447` (`resolveMergeMode`: absent → merge, invalid → 400); `client/src/hooks/useOrchestrateDraft.ts:13` (sends `mergeMode` on every launch); `client/src/lib/settings.ts:16` (Settings default) | keep |
| 55 | PR mode drains onto a run branch and opens one PR per run. | orchestrator.md | `server/src/agents/orchestrate-args.service.ts:447` (`pr` → 400 for a non-github source); `shared/types.ts:1442` (`prTarget`/`prUrl` required); `client/src/lib/run-detail.ts:282` (client reads `prUrl`) | keep |
| 56 | `merged` is no longer the only success exit. | orchestrator.md | `shared/types.ts:1622,1654` (`RUN_CLAIMED_STAGES`, `ATTENTION_RUN_STAGES`); `client/src/lib/run-stats.ts:230,473` (`MACHINE_STAGES`, `aggregateRuns`); `skills/backlog-retro/tools/lib/totals.mjs:17` (`SUCCESS_STAGES` copy) | keep |
| 57 | The tool refuses `stage <id> merged` under branch mode | orchestrator.md | none — `orchestrate.mjs` only | fenced |
| 58 | Question mode is run-scoped, and it only ever takes effect in | orchestrator.md | `shared/types.ts:1211` (`QuestionMode`); `server/src/agents/orchestrate-args.service.ts:499` (`resolveQuestionMode`, absent → park, invalid → 400); `server/src/agents/agents.service.ts:1042` (`--question-mode decide` appended only for decide) | keep |
| 59 | A classifier denial degrades a run to branch mode; every othe | orchestrator.md | none — degrade/park lives in `skills/backlog-orchestrate/` (SKILL.md, references/merge-failures.md, orchestrate.mjs `merge-mode`) | fenced |
| 61 | `orchestrate.mjs` is always invoked from the project root, ne | orchestrator.md | none — refusal and `commondir` discriminator in `orchestrate.mjs` | fenced |
| 62 | A `runner-fix:` item is hoisted to the front of the queue, an | orchestrator.md | `server/src/tracker/map-issue.ts:187` (tracker form of the marker: label presence → `runnerFix`); `server/src/agents/orchestrate-args.service.ts:162` (`ids` loop must never reorder — the hoist is the tool's alone) | widen: `server/src/tracker/map-issue.ts`, `server/src/agents/orchestrate-args.service.ts` |
| 63 | Every skill CLI ends with `process.exitCode = main(...)`, nev | skills.md | none — every skill CLI is under `skills/`; `process.exit(` hits in `scripts/` and `server/src/main.ts` are not skill CLIs | fenced |
| 65 | `agents/` is part of the plugin's publish surface. | skills.md | `scripts/sync-plugin.mjs:44` (`PUBLISHED_PATHS`) and :148 (`sparsePaths` check) — nothing under `skills/` or `agents/` enforces it | rehome: scripts.md |
| 66 | A new orchestrate rule enters SKILL.md as one statement; its  | skills.md | none — `skills/backlog-orchestrate/SKILL.md` and `references/*.md` (guard is a test) | fenced |
| 89 | A pause request lives in a server-owned file the tool reads a | orchestrator.md | `server/src/agents/agents.controller.ts:328` (`POST /api/agents/pause`); `server/src/agents/agents.service.ts:1433,1452` (`pause()` → `writePauseRequest`); `client/src/components/RunControls.tsx:21` (Resume for `paused`) | widen: `server/src/agents/agents.*.ts`, `client/src/components/RunControls.tsx` |
| 90 | A stop is the control file's SECOND `kind`, and nothing resum | orchestrator.md | `server/src/agents/agents.controller.ts:368` + `server/src/agents/agents.service.ts:1486,1511` (`POST /api/agents/stop`, cancel 409, one abort spawn); `server/src/agents/watchdog.service.ts:437` (sweeper reads `stopRequested`); `client/src/components/RunControls.tsx:308` (drops Resume on a stop) | keep |
| 103 | A session's cost is recorded per transcript, and a transcript | orchestrator.md | `shared/types.ts:1917` (`usage?` stays optional); `client/src/lib/run-detail.ts:80` + `client/src/lib/run-stats.ts:4` (absence renders nothing, `null` never `0`); `skills/backlog-retro/tools/lib/driver.mjs:86` (reads per-transcript usage) | keep |

Notes:

- #3: retro (`skills/backlog-retro/tools/lib/run-files.mjs:152`) and tick (`tick.mjs:498`) read run state; their never-write half is rules #5/#6 (skills.md), and the watchdog's is dispatch-watchdog.md — so not counted here.
- #10: borderline — retro is a reader that re-derives the sidecar dir; an edit there cannot change where `init` archives, only misread it. `fenced` is defensible.
- #11: `skills/backlog/tools/drift-lib.mjs:74` is the original `planHash`, kept byte-identical with orchestrate's copy by a test; the rule never names it, so not counted.
- #14: `server/src/agents/agents.*.ts` also matches `agents.module.ts` (harmless); the narrowest file list would be three paths.
- #34: `shared/types.ts:939` `JiraStatusPayload` must stay free of email/token, but only a server edit inside the fence can fill it, so not counted.
- #37: the client modal's `useAction` (`client/src/components/jira/JiraIssueModal.tsx:51`) is named as the one-at-a-time guard; removing it does not break "assign and transition only, re-read and splice", so not counted.
- #39: the client launch sheet (`client/src/lib/jira.ts`, `JiraReposGroup.tsx`) only imports `shared/jira-branch.ts`, so not counted.
- #56: without the retro `SUCCESS_STAGES` copy this would be `widen: shared/types.ts, client/src/lib/run-stats.ts`.
- #59: `server/src/agents/merge-check.util.ts:9` mirrors the merge's command shapes for the allow-rule guess (a different rule), so not counted.
- #62: `client/src/components/board/orchestrate/OrderStep.tsx:80` only comments that it must not claim the hoist, so not counted.
- #89/#90: both would be covered by `server/src/agents/*.ts` plus `client/src/components/RunControls.tsx`. #90 also needs `watchdog.service.ts`, which makes three narrow globs, so it is `keep`.

## Keep-list

The 38 `## Invariants` bullets that stay in `CLAUDE.md`, by `#`, each headline in full, then the two new unlinked bullets. Task 3 writes exactly these.

- #1 — `skills/` is the plugin skill root
- #2 — `~/.backlog-manager/registry.json` has exactly one writer
- #4 — Remote runs ride beside `runs`, never in it
- #7 — A tick does at most one unit of work, only when the project is idle, and never executes a plan that still carries `plan-review`.
- #12 — A board-started run is visible before its run file exists, from server memory that is never written to disk.
- #18 — Item files are read-only to the server and client
- #20 — The claim protocol is one comment per session per issue, and the LOWEST live comment id wins.
- #21 — An outsider's tracker issue is executable only while its body matches a pin a groom of ours wrote.
- #22 — `orchestrator:queued` is a plan, never a claim: the driver adds it, the claim and the Stop remove it, and no reader treats it as exclusion.
- #25 — Every server route lives under `/api`
- #28 — The GitHub token never leaves the server, and the poller is armed only while something is connected.
- #29 — A repo whose sync is off refuses every write path, and cannot be switched off under a live or paused run.
- #30 — The tracker, Jira and pull-request caches are the three caches in this server whose age is a rendered value.
- #41 — A tracker project has no item files, and that shows up in three places — and dispatch is NOT one of them.
- #42 — Groomed is derived
- #45 — The Orchestrate sheet's `uncommitted` flag is read from git per request, memoised nowhere, and must never join the memo one file over.
- #46 — The server never spawns git synchronously: every git read is `runGit`, async, bounded at 10 s, and a timeout lands in the failure branch the call site already had.
- #47 — The server never writes git: every git call it makes is a read, and fetch, worktree add/remove and checkout are the session's.
- #49 — `refactors/` is a peer section, not a facet on ideas
- #50 — `started:` and `phase:` are the lifecycle keys allowed in frontmatter, and neither is a status
- #51 — `backlog-orchestrate` is the only skill that merges into a base; `backlog-execute` and `backlog-groom` commit and push their own branch only in `pr` mode, and may arm GitHub auto-merge on the PR they opened.
- #52 — On a tracker project the DRIVER owns each item's claim, and the execute session never touches the issue
- #53 — The merge happens in whichever tree holds the base, and the run removes only the tree it made.
- #54 — Merge mode is run-scoped: chosen per launch, defaulted from Settings, and carried spawn → prompt → `init` → run file.
- #55 — PR mode drains onto a run branch and opens one PR per run.
- #56 — `merged` is no longer the only success exit.
- #58 — Question mode is run-scoped, and it only ever takes effect in a headless run.
- #60 — Undoing an already-completed orchestrator merge is `git revert -m 1`, never `git reset --hard`
- #64 — Editing `skills/` changes nothing until it is committed, pushed, and `pnpm run plugin:sync` runs.
- #74 — The served build carries a CSP (`server/src/security.ts`); dev does not.
- #76 — pnpm only
- #80 — Backlog items move `open/` → `done/`; `out-of-scope/` is flat.
- #81 — Dispatch derives the action; it never accepts one.
- #90 — A stop is the control file's SECOND `kind`, and nothing resumes a stopped run
- #91 — A resume is serialized at three layers, and only the third one can refuse a resume this app never asked for
- #98 — The board offers a hand resume exactly when the watchdog will not spawn one — absent a stop request, which suppresses both sides — and that is one function, not two agreeing expressions.
- #103 — A session's cost is recorded per transcript, and a transcript's identity is its file name, not its session id
- #104 — Every `.claude/rules/` file carries `paths:` and is the one home of its rules' mechanism — never the reasoning.
- L2 (new) — `agents/`, `tracker/` and `jira/` are the server's only outbound-calling modules
- L24 (new) — Start orchestrator runs from the board, not by typing the trigger into a terminal.

## Survival check and floor, before and after

**Token survival.** Every token of four or more characters in `origin/main`'s `## Layout`, `## Invariants` and `## Conventions` (backticked spans kept
whole; 1,146 tokens) was looked up in the union of the new `CLAUDE.md`, `.claude/rules/*.md` and `docs/overview.md`. Three were not found verbatim, all link
targets the Layout move rebased from the repo root to `docs/`: `docs/subsystems/releases.md`, `docs/superpowers/specs/2026-09-06-backlog-retro-design.md` and
`docs/superpowers/specs/2026-10-22-backlog-tick-design.md` now read `subsystems/releases.md`, `superpowers/specs/…` in `docs/overview.md`. Nothing was lost.

**Floor** (`preload-audit`, uncalibrated, 3.0 B/token; confirm in a fresh session's context panel):

| Surface                 | Before   | After    | Change   |
| ----------------------- | -------- | -------- | -------- |
| `CLAUDE.md`             | 37,952 B | 18,392 B | −19,560 B (−52 %) |
| Memory-files subtotal   | 47,934 B | 28,374 B | −19,560 B |
| `CLAUDE.md`, ~tokens    | ~12,651  | ~6,131   | ~−6,520 per session |

The spec's ~11 KB target assumed 14 cross-cutting rules; the audit kept 38 + 2, so the guard's budget is 19 KB (Task 3 ruling, parked for review).
