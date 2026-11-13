# backlog-manager

Claude Code plugin repo: nine skills, eight of them backlog skills — `backlog`, `backlog-capture`, `backlog-groom`, `backlog-execute`, `backlog-orchestrate`
(drains a project's groomed queue, one item per git worktree, each reviewed and verified before it merges), `backlog-retro` (sweeps every orchestrator run on
the machine into a report, a pick-list of items and a record the next sweep is measured against), `backlog-tick` (a dashboard job's one unattended unit per
tick: an execute to a PR, or a groom into a plan a person must approve), `backlog-review` (a grouped review of a checkout's change, also the gate's) — and
a ninth, `jira`, which reads and moves a Jira ticket through `/api/jira` —
plus a local NestJS + React app that shows every registered project's backlog on one kanban-by-type board. No database: the registry file
and each project's `backlog/` directory are the data.

## Commands

| Task                                      | Command                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Whole stack (api + client, no db)         | `pnpm run docker:up`                                               |
| Rebuild the stack from scratch            | `pnpm run docker:sync`                                             |
| Board only, built, no watchers (less RAM) | `pnpm run docker:run`                                              |
| API only, on the host                     | `pnpm run dev`                                                     |
| Client only, on the host                  | `pnpm run dev:web`                                                 |
| Tests (both runners)                      | `pnpm test` (`scripts/test-all.mjs` — jest, then node)             |
| Tests, jest only                          | `pnpm run test:jest` (`jest`, a worker per core less one)          |
| Skill tests                               | `pnpm run test:skills` (`scripts/test-tmpdir.mjs` — `node --test`) |
| Reinstall the plugin from the pushed HEAD | `pnpm run plugin:sync`                                             |
| Publish the web port to the tailnet       | `pnpm run tailnet` (`up` \| `status` \| `down`)                    |
| Types                                     | `pnpm run typecheck`                                               |
| Production build                          | `pnpm run build`                                                   |
| CI gate (every PR into `main`)            | `.github/workflows/ci.yml` → [docs/workflows/ci.md](docs/workflows/ci.md) |

**CI is the full-suite gate — never re-run the whole `pnpm test` locally just before a push.** Push and let CI run it; locally run only the suites the change
(or a merge of `main`) touched. Why: `~/.claude/session-analytics-log.md`, 2026-10-15. A docs-only or skills-only PR gets a scoped run instead, picked by
`scripts/ci-scope.mjs`; every code PR and every push to `main` still runs everything ([ci.md](docs/workflows/ci.md#scoped-checks)).
**"Touched" includes the source guards.** Many `test/` suites read the client or server tree and count symbols — `run-pulse.test.ts` pins every
`useOrchestratorRuns()` caller — so a diff that adds a caller of a shared hook, poller or helper is not covered by its own suites alone. Before pushing,
`grep -l <symbol> test/` for each symbol the diff adds a caller of, and add every hit to the scoped run. Why: `~/.claude/session-analytics-log.md`,
2026-10-29 — a new view went red in CI twice on that one guard after green local runs.

Ports: API `4322`, Vite `5177` (guide-manager holds 4321/5175/5176 on this machine). Only the host side moves, via `BM_API_PORT` / `BM_WEB_PORT` in `.env` —
inside the compose stack they are fixed. `pnpm run tailnet` reads `BM_WEB_PORT` from that same `.env` and serves the tailnet on the same number.

## Layout

One line per seam; the full description of each is in [docs/overview.md](docs/overview.md#every-seam-in-detail), the mechanism in the subsystem docs linked
there, and the reasoning behind the rules below in [docs/subsystems/invariants.md](docs/subsystems/invariants.md).

- `server/src/` — Nest, every route under `/api`, one module per directory: `health/`, `items/`, `agents/`, `tracker/`, `jira/`, `gitlab/`, `orchestrator/`,
  `hub/`, `releases/`, `tick/`, `settings/`, `registry/`; plus `static.ts`, `security.ts`, `allowed-hosts.ts`, `git-run.util.ts`, `atomic-write.util.ts`. →
  [docs/subsystems/api.md](docs/subsystems/api.md)
- `client/src/` — React SPA: Files, GitHub, Jira, Runs and Settings behind a side rail. → [docs/subsystems/board.md](docs/subsystems/board.md)
- [`.claude/DESIGN.md`](.claude/DESIGN.md) — the client's visual language. Not a `.claude/rules/` file.
- `shared/` — `types.ts` (all shared shapes), `agent.ts` (the predicates both sides must agree on), `theme.css`, `jira-branch.ts`.
- `skills/` — the nine skills this repo publishes, one directory each, with their CLIs under `tools/`.
  → [docs/subsystems/skills.md](docs/subsystems/skills.md)
- `agents/` — the plugin's own agents, one file each: `backlog-reviewer.md`.
- `.claude/rules/` — the path-scoped mechanism files, listed in the next section.
- `backlog/` — this repo's own backlog, self-registered and tracker-backed: its items are GitHub issues.
- `scripts/` — `sync-plugin.mjs`, `test-all.mjs`, `test-tmpdir.mjs`, `tailnet.mjs`, `ci-scope.mjs`. → [docs/workflows/](docs/workflows/development.md)
- `docs/` — the reference docs; `docs/superpowers/` holds the specs and plans this repo was built from.

## Rule files

Each file holds the full rule — mechanism and `Why:` link — for every rule scoped to its `paths:`, and is injected the moment a session `Read`s a file under
them. **Before editing a file under one of these globs by any route that does not `Read` it — `codegraph_explore`, `Write`, `Grep`, `Glob`, a subagent's
brief — read that rule file.**

| Rule file (in `.claude/rules/`) | paths |
| --------- | ----- |
| `board.md` | `client/src/**`, `shared/agent.ts`, `shared/theme.css`, `client/index.html`, `server/src/security.ts`, `server/src/agents/agents.service.ts`, `server/src/orchestrator/remote-runs.util.ts` |
| `dispatch-watchdog.md` | `server/src/agents/**`, `shared/agent.ts`, `server/src/jira/prompt.util.ts`, `docker-compose.yml`, `skills/backlog-orchestrate/tools/orchestrate.mjs`, `server/src/orchestrator/watchdog-*.ts`, `server/src/orchestrator/orchestrator.controller.ts` |
| `gitlab.md` | `server/src/gitlab/**` |
| `items.md` | `server/src/items/**`, `server/src/git-run.util.ts`, `server/src/releases/**`, `server/src/agents/items-abort.*.ts`, `server/src/tracker/tracker.controller.ts`, `shared/types.ts`, `Dockerfile` |
| `jira.md` | `server/src/jira/**`, `server/src/agents/jira-*.ts`, `skills/jira/**`, `docker-compose.yml`, `shared/jira-branch.ts`, `server/src/agents/session-stop.util.ts` |
| `orchestrator.md` | `skills/backlog-orchestrate/**`, `server/src/orchestrator/**`, `shared/agent.ts`, `skills/backlog-retro/tools/lib/paths.mjs`, `skills/backlog-retro/tools/lib/reviews.mjs`, `server/src/agents/agents.*.ts`, `server/src/agents/orchestrate-args.service.ts`, `server/src/tracker/map-issue.ts`, `client/src/lib/remote-starting.ts`, `client/src/components/RunControls.tsx` |
| `scripts.md` | `scripts/**`, `package.json`, `pnpm-workspace.yaml`, `docker-compose*.yml` |
| `security.md` | `server/src/*.ts`, `vite.config.ts`, `docker-compose.yml`, `server/src/jira/env.util.ts`, `server/src/jira/refs.util.ts`, `server/src/hub/**`, `server/src/gitlab/**` |
| `skills.md` | `skills/**`, `agents/**`, `server/src/tick/tick.service.ts`, `server/src/tick/tick-breaker.util.ts`, `scripts/sync-plugin.mjs` |
| `tests.md` | `test/**`, `.claude/rules/**` |
| `tick.md` | `server/src/tick/**`, `skills/backlog-tick/tools/tick.mjs`, `skills/backlog-tick/tools/tick-breaker.mjs` |
| `tracker.md` | `server/src/tracker/**` |

## Invariants

Only the rules that matter whichever file is touched live here: process rules, rules that govern code beyond any one rule file's `paths:`, and the
vocabulary skills, server and client all speak. Every other rule lives only in its rule file above. A linked entry is a HEADLINE — its mechanism is in the
rule file that fences the code it governs, its `Why:` link the reasoning. Read both before changing any of these — most encode a failure that already
happened.

- **`skills/` is the plugin skill root**; never duplicate it under `.claude/skills/` — that loads the same skills twice and drifts.
- **`~/.backlog-manager/registry.json` has exactly one writer**
  Why: [invariants.md](docs/subsystems/invariants.md#registryjson-has-exactly-one-writer-and-a-linked-worktree-registers-its-main-tree)
- **Remote runs ride beside `runs`, never in it** Why: [invariants.md](docs/subsystems/invariants.md#remote-runs-ride-beside-runs-never-in-it)
- **A tick does at most one unit of work, only when the project is idle, and never executes a plan that still carries `plan-review`.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-tick-does-one-unit-only-when-idle-and-never-executes-a-plan-that-awaits-review)
- **A board-started run is visible before its run file exists, from server memory that is never written to disk.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-board-started-run-is-visible-before-its-run-file-exists)
- **Item files are read-only to the server and client**; every write goes through the skills, and dispatch writes none — the spawned session runs them.
  **A TRACKER project's items are what this server writes** (task-46), only through the eleven routes below — never a file, on any path — **plus a Jira
  issue's assignee and status, through `/api/jira/issue/assign` and `/issue/transition`, and an open PR's merge, auto-merge and update-branch, through
  `/api/prs/*`.**
- **The claim protocol is one comment per session per issue, and the LOWEST live comment id wins.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-claim-protocol-lowest-live-comment-id-wins)
- **An outsider's tracker issue is executable only while its body matches a pin a groom of ours wrote.**
  Why: [invariants.md](docs/subsystems/invariants.md#an-outsiders-tracker-issue-is-executable-only-while-its-body-matches-a-pin-a-groom-of-ours-wrote)
- **`orchestrator:queued` is a plan, never a claim: the driver adds it, the claim and the Stop remove it, and no reader treats it as exclusion.**
  Why: [invariants.md](docs/subsystems/invariants.md#orchestratorqueued-is-a-plan-never-a-claim)
- **Every server route lives under `/api`**; the Vite proxy has exactly one entry, asserted by `test/guards/vite-proxy.test.ts`.
- **The GitHub token never leaves the server, and the poller is armed only while something is connected.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-github-token-never-leaves-the-server-and-the-poller-is-armed-only-while-something-is-connected)
- **The GitLab token never leaves the server, never follows a redirect, and the poller is armed only while a mapped repo is on the site.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-gitlab-token-never-leaves-the-server-never-follows-a-redirect-and-the-poller-is-armed-only-while-a-mapped-repo-is-on-the-site)
- **A repo whose sync is off refuses every write path, and cannot be switched off under a live or paused run.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-repo-whose-sync-is-off-refuses-every-write-path-and-cannot-be-switched-off-under-a-live-or-paused-run)
- **The tracker, Jira, pull-request and GitLab caches are the four caches in this server whose age is a rendered value.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-tracker-jira-pull-request-and-gitlab-caches-are-the-four-caches-in-this-server-whose-age-is-a-rendered-value)
- **A tracker project has no item files, and that shows up in three places — and dispatch is NOT one of them.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-tracker-project-has-no-item-files-and-that-shows-up-in-three-places)
- **Groomed is derived** (bug: Cause+Fix filled and not a deferral — `unknown`, `Not decided`, `TBD`, …; task: Plan non-empty), never stored; status is the
  directory, never frontmatter. Ideas, refactors and out-of-scope derive `null`, not `false` — grooming is not a state they have, and for the first two the
  state they wait in is _promoted_.
- **The Orchestrate sheet's `uncommitted` flag is read from git per request, memoised nowhere, and must never join the memo one file over.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-orchestrate-sheets-uncommitted-flag-is-read-from-git-per-request-and-memoised-nowhere)
- **The server never spawns git synchronously: every git read is `runGit`, async, bounded at 10 s, and a timeout lands in the failure branch the call site
  already had.** Why: [invariants.md](docs/subsystems/invariants.md#the-server-never-spawns-git-synchronously-in-a-request-path)
- **The server never writes git: every git call it makes is a read, and fetch, worktree add/remove and checkout are the session's.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-server-never-writes-git)
- **`refactors/` is a peer section, not a facet on ideas** Why: [invariants.md](docs/subsystems/invariants.md#refactors-is-a-peer-section-not-a-facet-on-ideas)
- **`started:` and `phase:` are the lifecycle keys allowed in frontmatter, and neither is a status**
  Why: [invariants.md](docs/subsystems/invariants.md#started-and-phase-are-the-lifecycle-keys-in-frontmatter-and-neither-is-a-status)
- **`backlog-orchestrate` is the only skill that merges into a base; `backlog-execute` and `backlog-groom` commit and push their own branch only in `pr` mode, and may arm GitHub auto-merge on the PR they opened.**
  Why: [invariants.md](docs/subsystems/invariants.md#backlog-orchestrate-is-the-only-skill-that-merges-into-a-base-execute-and-groom-commit-and-push-only-in-pr-mode-and-may-arm-github-auto-merge)
- **On a tracker project the DRIVER owns each item's claim, and the execute session never touches the issue**
  Why: [invariants.md](docs/subsystems/invariants.md#the-driver-owns-a-tracker-items-claim-for-the-whole-item)
- **The merge happens in whichever tree holds the base, and the run removes only the tree it made.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made)
- **Merge mode is run-scoped: chosen per launch, defaulted from Settings, and carried spawn → prompt → `init` → run file.**
  Why: [invariants.md](docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400)
- **PR mode drains onto a run branch and opens one PR per run.**
  Why: [invariants.md](docs/subsystems/invariants.md#pr-mode-drains-onto-a-run-branch-and-opens-one-pr-per-run)
- **`merged` is no longer the only success exit.**
  Why: [invariants.md](docs/subsystems/invariants.md#merged-is-not-the-only-success-exit--branched-is-its-branch-mode-sibling)
- **Question mode is run-scoped, and it only ever takes effect in a headless run.**
  Why: [invariants.md](docs/subsystems/invariants.md#question-mode-is-run-scoped-and-it-only-ever-takes-effect-in-a-headless-run)
- **Undoing an already-completed orchestrator merge is `git revert -m 1`, never `git reset --hard`**
  Why: [invariants.md](docs/subsystems/invariants.md#undoing-an-already-completed-orchestrator-merge-is-git-revert--m-1-never-git-reset---hard)
- **Editing `skills/` changes nothing until it is committed, pushed, and `pnpm run plugin:sync` runs.**
  Why: [invariants.md](docs/subsystems/invariants.md#editing-skills-changes-nothing-until-commit--push--pluginsync)
- **pnpm only**, pinned by `packageManager`, enforced via corepack in the image.
- **Backlog items move `open/` → `done/`; `out-of-scope/` is flat.**
- **Dispatch derives the action; it never accepts one.** Why: [invariants.md](docs/subsystems/invariants.md#dispatch-derives-the-action-it-never-accepts-one)
- **A stop is the control file's SECOND `kind`, and nothing resumes a stopped run**
  Why: [invariants.md](docs/subsystems/invariants.md#a-stop-is-the-control-files-second-kind-and-nothing-resumes-a-stopped-run)
- **A resume is serialized at three layers, and only the third one can refuse a resume this app never asked for**
  Why: [invariants.md](docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers)
- **The board offers a hand resume exactly when the watchdog will not spawn one — absent a stop request, which suppresses both sides — and that is one function,
  not two agreeing expressions.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-resume-coupling-the-board-offers-a-hand-resume-exactly-when-the-sweeper-will-not)
- **A session's cost is recorded per transcript, and a transcript's identity is its file name, not its session id**
  Why: [invariants.md](docs/subsystems/invariants.md#a-sessions-cost-is-recorded-per-transcript-and-a-transcripts-identity-is-its-file-name)
- **Every `.claude/rules/` file carries `paths:` and is the one home of its rules' mechanism — never the reasoning.**
  Why: [invariants.md](docs/subsystems/invariants.md#path-scoped-clauderules-reach-a-headless-run-in-a-linked-worktree-task-35)
- **`agents/`, `tracker/`, `jira/` and `gitlab/` are the server's only outbound-calling modules**; `agents/dashboards/` is part of `agents/`, not a fifth, and
  `releases/` and `tick/` call out to nothing.
- **Start orchestrator runs from the board, not by typing the trigger into a terminal.**

## Conventions

- Comments explain _why_, at length, and the existing density is deliberate — match it rather than stripping it.
- **A PR title must pass `ci / pr-title`** (it becomes the squash commit — `main` merges squash-only): `feat|fix|perf` (`!` allowed) or
  `docs|chore|test|refactor|ci|build`, optional lowercase `(scope)`, `: `, a description. `feat`/`fix`/`perf` cut a release (`.github/workflows/release.yml`).
- **A PR body is `.github/pull_request_template.md` — read it before `gh pr create` and pass the filled copy with `--body-file`.** `--body` bypasses the
  template, and Claude Code's own `## Summary` / `## Test plan` default is not this repo's shape. A `feat`/`fix`/`perf` body without `## What's new` fails
  `ci / pr-title` (its lines become the release notes, [ci.md](docs/workflows/ci.md#releases)). Why: #448 was the 4th or 5th PR opened with the default
  body, because only the title was a written rule here.
- **Jest suites sit one level down in `test/<feature>/`; node suites sit beside the tool they cover, and the node globs do not descend, so a node suite one
  level deeper never runs**
  Why: [invariants.md](docs/subsystems/invariants.md#where-a-test-file-sits-decides-which-runner-executes-it)

<!-- docs-sync:
  sources:
    - server/src
    - client/src
    - shared
    - skills
    - agents
    - scripts
    - test
    - package.json
    - docker-compose.yml
    - vite.config.ts
    - pnpm-workspace.yaml
  kind: index
  verified: 5a74ebf0f276cf9103c7a744f913c01f02e178f5
-->
