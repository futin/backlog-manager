# Fence re-check — CLAUDE.md headroom (2026-11-13)

Follows [2026-11-02-claude-md-floor-fence-audit.md](2026-11-02-claude-md-floor-fence-audit.md). `CLAUDE.md` stood at 19,401 B against the guard's
`CLAUDE_MD_BUDGET = 19 * 1024` = 19,456 B (`test/guards/claude-rules.test.ts:99`) — 55 B of headroom, so the next cross-cutting rule would turn CI red. The
guard's own message says the cheaper move is a rule down a tier, never compressed wording, and its comment names the 11-02 keep-list as the first place to
look. Every `## Invariants` bullet in `CLAUDE.md` on `main` at 9a9e217a was re-checked against criterion (b) as the code stands today: which files can break
the rule, and do they all sit under its home rule file's `paths:` — or would after widening that `paths:` by one or two globs, each a tracked file?

`#` is the bullet's position in `## Invariants` at 9a9e217a (40 bullets: the 11-02 keep-list less #74, plus the GitLab token bullet and the GitLab-widened caches
and outbound-modules bullets that landed since). `11-02 #N` is that audit's row for the same rule. Keep stays the error-safe direction: a wrong `keep` costs a
few hundred bytes in every session, a wrong `fenced` drops a rule from sessions that can break it — when unsure, keep.

## Rulings

- **Four bullets move to tier two only**: #12 (GitLab token), #34 (stop), #35 (resume serialized), #36 (hand resume). Each is already in its rule file
  byte-equal (the guard's subset check), so the move is deleting the `CLAUDE.md` copy and widening `paths:` until every obeyer is fenced.
- **The 11-02 widens since then changed two answers.** `orchestrator.md` gained `server/src/agents/agents.*.ts` and `client/src/components/RunControls.tsx`
  on 11-02, which took #34 from three missing globs to one; `dispatch-watchdog.md` gained `server/src/orchestrator/watchdog-*.ts`, which took #35's layer 2
  inside the fence and left only the client's layer 1 outside.
- **#36 widens `board.md`, not a rehome to `dispatch-watchdog.md`.** The rehome needs fewer globs (`client/src/components/RunControls.tsx` alone), but the
  bullet's "never" half governs `client/src/components/runs/WatchdogMonitor.tsx` — it must never call the predicate itself — and only `board.md`'s
  `client/src/**` keeps that file fenced. Two server globs on `board.md` cover the sweeper side.
- **Cost of the widens**: sessions that read `watchdog.service.ts`, `watchdog-state.service.ts`, `RunControls.tsx`, `useOrchestratorRuns.ts` or
  `docker-compose.yml` now also load the widened rule file. Every one of those files already fires at least one sibling rule file, and the five are named
  files, not globs over a tree.
- **The intro paragraph** re-described all nine skills (≈ 900 B). It is now two lines; the skill listing carries each description, and
  `docs/subsystems/skills.md:3` and `docs/overview.md:141` carry the list. No guard reads that paragraph (`grep -n CLAUDE.md test/ scripts/` — only
  `test/guards/claude-rules.test.ts:46`, which reads from `## Invariants` down, the `## Rule files` table and the byte count).

## Applied

| rule file | globs added to `paths:` | bullets leaving `CLAUDE.md` |
| --- | --- | --- |
| board.md | `server/src/agents/watchdog.service.ts`, `server/src/orchestrator/watchdog-state.service.ts` | #36 |
| dispatch-watchdog.md | `client/src/components/RunControls.tsx`, `client/src/hooks/useOrchestratorRuns.ts` | #35 |
| gitlab.md | `docker-compose.yml` | #12 |
| orchestrator.md | `server/src/agents/watchdog.service.ts` | #34 |

## Audit

| # | headline (first 60 chars) | home | governed paths outside the fence (file:line) | resolution |
|---|---|---|---|---|
| 1 | `skills/` is the plugin skill root | — | a layout/process rule: a session creating `.claude/skills/` anywhere breaks it; no source file obeys it | keep |
| 2 | `~/.backlog-manager/registry.json` has exactly one writer | skills.md | `server/src/registry/registry.service.ts:11` reads it, and any server module could add a write (same shape as #19) | keep |
| 3 | Remote runs ride beside `runs`, never in it | orchestrator.md | 11-02 #4 still holds: `client/src/components/runs/RunsView.tsx:511`, `client/src/hooks/useOrchestratorRuns.ts:112`, `client/src/lib/runs-list.ts:87` all hold `remote` beside `runs`; `server/src/agents/watchdog.service.ts` must stay local-only | keep |
| 4 | A tick does at most one unit of work, only when the project i | skills.md | 11-02 #7: `shared/agent.ts:566` (`planReviewBlock`), `client/src/components/board/DispatchButton.tsx:1`, `server/src/items/sources/github.source.ts:5`, `server/src/tracker/map-issue.ts:4` | keep |
| 5 | A board-started run is visible before its run file exists, f | dispatch-watchdog.md | 11-02 #12: `server/src/orchestrator/orchestrator.service.ts:338`, `client/src/components/board/RunChip.tsx:73`, `client/src/components/runs/RunsView.tsx:335`, `client/src/lib/runs-list.ts:357` — four globs, three areas | keep |
| 6 | Item files are read-only to the server and client | — | every `server/src/**` and `client/src/**` file (a write can appear anywhere); the eleven routes span `server/src/items/` and `server/src/agents/` | keep |
| 7 | The claim protocol is one comment per session per issue, and | tracker.md | `server/src/items/sources/github.source.ts` (claim), `skills/backlog-orchestrate/tools/orchestrate.mjs` (driver) — server, skills | keep |
| 8 | An outsider's tracker issue is executable only while its bod | tracker.md | 11-02 #21: `shared/agent.ts:557` (`unvettedBlock`), `server/src/items/sources/github.source.ts:901` (`pinBody`), `orchestrate.mjs`, `tick.mjs` | keep |
| 9 | `orchestrator:queued` is a plan, never a claim: the driver ad | orchestrator.md | 11-02 #22: `server/src/items/sources/github.source.ts:884`, `client/src/lib/tracker.ts:344`, `client/src/components/board/ItemCard.tsx:185`, `client/src/lib/live-bar.ts:178` | keep |
| 10 | Every server route lives under `/api` | — | every controller in `server/src/**` plus `vite.config.ts` | keep |
| 11 | The GitHub token never leaves the server, and the poller is | tracker.md | `docker-compose.yml:109`; `arm()` at `server/src/items/sources/github.source.ts:132` and `server/src/orchestrator/tracker-sync.controller.ts:71`; "the browser never talks to `api.github.com`" governs every `client/src/**` file | keep |
| 12 | The GitLab token never leaves the server, never follows a re | gitlab.md | `docker-compose.yml:123` (`BM_GITLAB_TOKEN: '${BM_GITLAB_TOKEN:-}'`) only. The header (`server/src/gitlab/gitlab.client.ts:109`), `redirect: 'manual'` (:110) and every `arm()` (`gitlab.controller.ts:31`, `poller.service.ts:145,161,200` — `onReposChanged` is registered inside the poller) are in the fence; `client/src/lib/service-status.ts:100` only names the variable | **widen: `docker-compose.yml`** → move |
| 13 | A repo whose sync is off refuses every write path, and canno | tracker.md | 11-02 #29: `client/src/lib/tracker.ts:285`, `server/src/items/sources/github.source.ts:1278`, `server/src/agents/agents.service.ts:406`, `server/src/agents/items-abort.service.ts:79` | keep |
| 14 | The tracker, Jira, pull-request and GitLab caches are the fou | tracker.md | `server/src/jira/`, `server/src/gitlab/poller.service.ts:70`, `orchestrate.mjs:2037` (`polledAt`), `client/src/lib/tracker.ts:37`, `client/src/lib/jira.ts:468` | keep |
| 15 | A tracker project has no item files, and that shows up in th | items.md | 11-02 #41: `server/src/tracker/map-issue.ts`, `shared/agent.ts:138` (`deriveAction`), `server/src/agents/agents.service.ts`, `server/src/agents/orchestrate-args.service.ts` | keep |
| 16 | Groomed is derived | — | `shared/agent.ts:162`, `shared/types.ts:217`, `client/src/lib/run-stage.ts:83`, `skills/backlog/tools/backlog.mjs:673`, `skills/backlog/tools/drift-lib.mjs:18` | keep |
| 17 | The Orchestrate sheet's `uncommitted` flag is read from git p | items.md | the bullet's "any surface stating a consequence must split it" and "nothing derived reads it" govern an open set of client files — today `client/src/lib/orchestrate-draft.ts`, `client/src/hooks/useOrchestrateDraft.ts`, `client/src/components/board/orchestrate/ItemsStep.tsx`, `OrderStep.tsx`, `OrchestrateSheet.tsx` | keep |
| 18 | The server never spawns git synchronously: every git read is | items.md | `runGit(` is called from six server modules: `releases/releases.service.ts:38`, `gitlab/mapping.util.ts:22`, `agents/orchestrate-args.service.ts:399`, `tracker/origin.util.ts:81`, `jira/refs.util.ts:44`, `items/` | keep |
| 19 | The server never writes git: every git call it makes is a re | security.md | every `server/src/**` module (same six callers as #18) | keep |
| 20 | `refactors/` is a peer section, not a facet on ideas | skills.md | 11-02 #49: `server/src/items/scan.util.ts:28`, `client/src/components/board/ItemCard.tsx:21`, `server/src/tracker/labels.ts` | keep |
| 21 | `started:` and `phase:` are the lifecycle keys allowed in fro | skills.md | 11-02 #50: `server/src/items/parse.util.ts`, `server/src/tracker/map-issue.ts`, `client/src/lib/item-progress.ts` | keep |
| 22 | `backlog-orchestrate` is the only skill that merges into a ba | orchestrator.md | `skills/backlog-execute/**`, `skills/backlog-groom/**`, `skills/backlog-tick/**` and any new skill — the fence holds only `skills/backlog-orchestrate/**` | keep (unsure — see notes) |
| 23 | On a tracker project the DRIVER owns each item's claim, and t | orchestrator.md | 11-02 #52: `skills/backlog-execute/SKILL.md`, `server/src/items/sources/github.source.ts`, `server/src/tracker/claim.ts` | keep |
| 24 | The merge happens in whichever tree holds the base, and the r | orchestrator.md | 11-02 #53: `server/src/items/base-branch.util.ts:52` (`BASE_BRANCH_SHAPE`), `skills/backlog-tick/tools/tick.mjs:84` (`REF_SHAPE` twin) | keep (unsure — see notes) |
| 25 | Merge mode is run-scoped: chosen per launch, defaulted from S | orchestrator.md | 11-02 #54: `shared/types.ts`, `client/src/hooks/useOrchestrateDraft.ts`, `client/src/lib/settings.ts` | keep |
| 26 | PR mode drains onto a run branch and opens one PR per run. | orchestrator.md | `shared/types.ts` (`prTarget`/`prUrl`), `client/src/lib/run-detail.ts`, `client/src/components/runs/RunDetail.tsx` | keep — `shared/types.ts` is a hub file; widening `orchestrator.md` (30 KB) to it fires on every type edit |
| 27 | `merged` is no longer the only success exit. | orchestrator.md | 11-02 #56: `shared/types.ts`, `client/src/lib/run-stats.ts`, `skills/backlog-retro/tools/lib/totals.mjs` | keep |
| 28 | Question mode is run-scoped, and it only ever takes effect in | orchestrator.md | `client/src/components/board/orchestrate/ModesStep.tsx`, `client/src/hooks/useOrchestrateDraft.ts`, `client/src/lib/settings.ts`, `client/src/components/settings/SettingsView.tsx`, `shared/types.ts` | keep |
| 29 | Undoing an already-completed orchestrator merge is `git rever | orchestrator.md | a process rule for whichever session undoes a merge; no source file obeys it | keep |
| 30 | Editing `skills/` changes nothing until it is committed, push | skills.md | process rule (commit, push, `pnpm run plugin:sync`) | keep |
| 31 | pnpm only | — | `package.json`, `Dockerfile`, every doc and command | keep |
| 32 | Backlog items move `open/` → `done/`; `out-of-scope/` is fla | — | `skills/backlog/tools/backlog.mjs`, `server/src/items/scan.util.ts` | keep |
| 33 | Dispatch derives the action; it never accepts one. | dispatch-watchdog.md | 11-02 #81: `shared/types.ts:968` (`parseJiraAction`), `server/src/jira/jira.controller.ts:6`, `server/src/jira/links.store.ts:6`, `skills/backlog/tools/backlog.mjs` | keep |
| 34 | A stop is the control file's SECOND `kind`, and nothing resu | orchestrator.md | `server/src/agents/watchdog.service.ts:443` (`if (run.stopRequested)`, the sweeper's half) only. In fence: `agents.service.ts:1555-1564` and `agents.controller.ts` (`agents.*.ts`), `server/src/orchestrator/pause-control.util.ts:187` and `orchestrator.service.ts:411`, `client/src/components/RunControls.tsx:308`, `orchestrate.mjs:391`. `shared/types.ts:1596` (`stopRequested`/`abortRefused` on the answer type) and `client/src/lib/remote-run.ts:38` (`stopRequested: false` on a remote row) are passing | **widen: `server/src/agents/watchdog.service.ts`** → move |
| 35 | A resume is serialized at three layers, and only the third o | dispatch-watchdog.md | layer 1 only: `client/src/components/RunControls.tsx:193` (`busy`, the synchronous in-flight flag) and `client/src/hooks/useOrchestratorRuns.ts:72` (the mark ends on `running && fresh`). Layer 2 `server/src/agents/agents.service.ts:1332-1359` and `server/src/orchestrator/watchdog-state.service.ts:108` (`resumeSpawnAt`), layer 3 `orchestrate.mjs`, and the 409 swallow at `watchdog.service.ts:676` are in fence; `RESUME_LOCKED_CODE` (`shared/types.ts:1670`) is a passing constant | **widen: `client/src/components/RunControls.tsx`, `client/src/hooks/useOrchestratorRuns.ts`** → move |
| 36 | The board offers a hand resume exactly when the watchdog wil | board.md | `server/src/agents/watchdog.service.ts:486-489` (the sweeper's reader and its three inputs) and `server/src/orchestrator/watchdog-state.service.ts:316` (`spawningEnabled`, one derived implementation). In fence: `shared/agent.ts:843,875,918`, `client/src/components/RunControls.tsx:395` (the one client reader), `client/src/components/runs/WatchdogMonitor.tsx` (must never call it) | **widen: `server/src/agents/watchdog.service.ts`, `server/src/orchestrator/watchdog-state.service.ts`** → move |
| 37 | A session's cost is recorded per transcript, and a transcrip | orchestrator.md | 11-02 #103: `shared/types.ts:2166` (`usage?`), `client/src/lib/run-detail.ts:80`, `skills/backlog-retro/tools/lib/driver.mjs` | keep |
| 38 | Every `.claude/rules/` file carries `paths:` and is the one h | tests.md | 11-02 #104: `CLAUDE.md` itself, `agents/backlog-reviewer.md`, `skills/backlog-execute/SKILL.md` | keep |
| 39 | `agents/`, `tracker/`, `jira/` and `gitlab/` are the server's | — | every `server/src/**` module (a fifth caller can appear anywhere) | keep |
| 40 | Start orchestrator runs from the board, not by typing the tri | — | process rule for the person and the session | keep |

## Notes

- **#22 (unsure).** The "execute and groom commit and push only in `pr` mode" half is mechanism in `skills/backlog-execute/` and `skills/backlog-groom/`; the
  "only skill that merges" half governs any skill a session writes next. Fencing it needs `skills/**` on `orchestrator.md`, which fires 30 KB on every skill
  edit — and `skills.md` (`skills/**`) is the wrong home for its mechanism. Kept.
- **#24 (unsure).** The bullet's mechanism text (`orchestrator.md:83-93`) is all `orchestrate.mjs merge-check` / `cleanup`. 11-02 tied it to
  `BASE_BRANCH_SHAPE` (`server/src/items/base-branch.util.ts:52`) and its `tick.mjs:84` twin, but that is the #343 base-shape rule, which the bullet does not
  state. If those are passing, #24 is already `fenced`; the 11-02 reading was kept rather than overturned on one reader's opinion.
- **#11 vs #12.** Same shape, different answers: the GitHub bullet says the browser never talks to `api.github.com`, which governs the whole client; the GitLab
  bullet has no client half, and its `arm()` sites all live under `server/src/gitlab/`.
- **#3.** This change's widen of `orchestrator.md` with `server/src/agents/watchdog.service.ts` (for #34) takes one of #3's outside files in, but the client half —
  every consumer that could fold `remote` into `runs` — stays an open set.

## Floor

| Surface | Before | After | Change |
| --- | --- | --- | --- |
| `CLAUDE.md` | 19,401 B | 17,942 B | −1,459 B |
| headroom under 19,456 B | 55 B | 1,514 B | |
