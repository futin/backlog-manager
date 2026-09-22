# backlog-manager

Claude Code plugin repo: six backlog skills — `backlog`, `backlog-capture`, `backlog-groom`, `backlog-execute`, `backlog-orchestrate` (drains a project's
groomed queue, one item per git worktree, each reviewed and verified before it merges), `backlog-retro` (sweeps every orchestrator run on the machine into a
report, a pick-list of items and a record the next sweep is measured against) — plus a local NestJS + React app that shows every registered project's backlog on
one kanban-by-type board. No database: the registry file and each project's `backlog/` directory are the data.

## Commands

| Task                                      | Command                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| Whole stack (api + client, no db)         | `pnpm run docker:up`                                   |
| Rebuild the stack from scratch            | `pnpm run docker:sync`                                 |
| API only, on the host                     | `pnpm run dev`                                         |
| Client only, on the host                  | `pnpm run dev:web`                                     |
| Tests (both runners)                      | `pnpm test` (`scripts/test-all.mjs` — jest, then node) |
| Tests, jest only                          | `pnpm run test:jest` (`jest --runInBand`)              |
| Skill tests                               | `pnpm run test:skills` (`node --test`)                 |
| Reinstall the plugin from the pushed HEAD | `pnpm run plugin:sync`                                 |
| Publish the web port to the tailnet       | `pnpm run tailnet` (`up` \| `status` \| `down`)        |
| Types                                     | `pnpm run typecheck`                                   |
| Production build                          | `pnpm run build`                                       |

Ports: API `4322`, Vite `5177` (guide-manager holds 4321/5175/5176 on this machine). Only the host side moves, via `BM_API_PORT` / `BM_WEB_PORT` in `.env` —
inside the compose stack they are fixed. `pnpm run tailnet` reads `BM_WEB_PORT` from that same `.env` and serves the tailnet on the same number.

## Layout

One line per seam. The mechanism lives in the subsystem docs linked below; the reasoning behind the rules in the next section lives in
[docs/subsystems/invariants.md](docs/subsystems/invariants.md). The doc map is [docs/overview.md](docs/overview.md).

- `server/src/` — Nest, every route under `/api`: `health/`, `items/` (items, projects, item bodies, `uncommitted`, the read-only claim lookup, the item-source
  adapters, and — since task-46 — the seven guarded write routes in `items-write.controller.ts`, which are the ONLY writes this server makes to anybody's
  items), `agents/` (the
  dashboard calls, plus the run watchdog), `tracker/` (the GitHub client, the issue poller and its in-memory cache, the label bootstrap and the read-only
  `trackers` route) — those two are the outbound-calling modules, and the ONLY two — `orchestrator/` (a read-only view of the run-state directory, plus the
  in-memory watchdog and starting-run records, the remote-run derivation over the tracker cache, and the two files the server does write), `registry/`, `static.ts` (serves `client/dist` only when built),
  `security.ts`, `allowed-hosts.ts` (the Host allowlist every route is gated by). → [docs/subsystems/api.md](docs/subsystems/api.md)
- `client/src/` — React SPA: four lazy sections behind a side rail (Board, Runs, Archive, Settings), one run chip in the board's band, and the three-step
Orchestrate sheet. Runs is TWO pages under one rail entry — History (a figure strip, a 420 px Live+History list column, one always-visible detail sheet — and,
  on a board 1400 px or wider, that strip standing as a 320 px right rail instead) and

  Watchdog — switched by the rail's sub-nav tree alone, never by an in-page control. Every derivation has one home in `lib/`, and every look more than one
  surface draws has one home in `components/ui/`. A connected tracker adds three readings and no new surface: the band's poll-age line, the card's
  `untyped`/assignee/link-out, and the item modal's age beside the cached body — all derived in `lib/tracker.ts`, plus the read-only `Trackers` card on Shared
  Settings. → [docs/subsystems/board.md](docs/subsystems/board.md)
- [`.claude/DESIGN.md`](.claude/DESIGN.md) — the client's visual language: §1–7 copied from the dashboard, §8 how this board applies it; every component must
  cite its subsection in a header comment. Not a `.claude/rules/` file — those hold the mechanism tier for a path scope, every bullet anchored into
  `invariants.md`.
- `shared/` — `types.ts` (all shared shapes), `agent.ts` (`deriveAction`, `dispatchGate` and the run/watchdog predicates both sides must agree on), `theme.css`
  (five theme palettes).
- `skills/backlog/`, `skills/backlog-capture/`, `skills/backlog-groom/`, `skills/backlog-execute/`, `skills/backlog-orchestrate/`, `skills/backlog-retro/` — the
  skills this repo publishes. `skills/backlog/tools/backlog.mjs` is the registry's only writer; `skills/backlog-orchestrate/tools/orchestrate.mjs` is the run
  file's only writer. `skills/backlog-retro/tools/retro.mjs` reads the run-state directory, the registry and — by recorded lease id — each run's driver
  transcript, and owns `~/.backlog-manager/retro/` ([spec](docs/superpowers/specs/2026-09-06-backlog-retro-design.md)). **Start orchestrator runs from the
  board, not by typing the trigger into a terminal.** → [docs/subsystems/skills.md](docs/subsystems/skills.md)
- `agents/` — the plugin's own agents, one file each, discovered from this root-level directory by Claude Code's own convention. Currently one:
  `backlog-reviewer.md`, the reviewer `backlog-orchestrate` dispatches before every merge.
- `.claude/rules/` — nine path-scoped files, injected into a session the moment it reads a file under their `paths:` glob. Each is the ONE home of the
  mechanism text for the rules scoped to its paths; CLAUDE.md keeps each rule's headline, `docs/subsystems/invariants.md` its reasoning. Guarded by
  `test/claude-rules.test.ts`: bullets only, each anchored exactly once, one home per anchor, headlines byte-equal with the ones below.
- `backlog/` — this repo's own backlog, self-registered like any project.
- `scripts/` — `sync-plugin.mjs` (reinstall the plugin from the pushed HEAD, → [docs/workflows/publishing.md](docs/workflows/publishing.md)), `test-all.mjs`
  (`pnpm test`, → [docs/workflows/development.md](docs/workflows/development.md)) and `tailnet.mjs` (`pnpm run tailnet` — the `tailscale serve` wrapper).
- `docs/` — the reference docs; `docs/superpowers/` holds the design spec and implementation plans this repo was built from.

## Invariants

Each entry is a rule's HEADLINE. Its mechanism lives in the `.claude/rules/*.md` file scoped to the files it governs — loaded the moment a session reads one
of them, and to be opened by hand before editing through any other route (`Write`, `codegraph_explore`) — and its `Why:` link is the reasoning, in
[docs/subsystems/invariants.md](docs/subsystems/invariants.md). Read both before changing any of these — most encode a failure that already happened.

- **`skills/` is the plugin skill root**; never duplicate it under `.claude/skills/` — that loads the same skills twice and drifts.
- **`~/.backlog-manager/registry.json` has exactly one writer**
  Why: [invariants.md](docs/subsystems/invariants.md#registryjson-has-exactly-one-writer-and-a-linked-worktree-registers-its-main-tree)
- **The orchestrator's run file has exactly one writer, one reader — the same relationship the registry has.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-orchestrators-run-file-has-exactly-one-writer-one-reader--the-same-relationship-the-registry-has)
- **Remote runs ride beside `runs`, never in it** Why: [invariants.md](docs/subsystems/invariants.md#remote-runs-ride-beside-runs-never-in-it)
- **`~/.backlog-manager/retro/` has exactly one writer, `retro.mjs record`, and `backlog-retro` never writes under the run-state directory**
  Why: [invariants.md](docs/subsystems/invariants.md#backlog-managerretro-has-exactly-one-writer-and-the-retro-never-writes-run-state)
- **A run's sidecars are archived beside its run file, under a name derived from the archive path and stored nowhere.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-runs-sidecars-are-archived-beside-its-run-file-task-31)
- **A board-started run is visible before its run file exists, from server memory that is never written to disk.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-board-started-run-is-visible-before-its-run-file-exists)
- **A starting entry blocks what a run file blocks, on every surface**
  Why: [invariants.md](docs/subsystems/invariants.md#a-starting-entry-blocks-what-a-run-file-blocks-bug-21)
- **Escape has one owner, and the topmost dialog is the only one that closes.**
  Why: [invariants.md](docs/subsystems/invariants.md#escape-has-one-owner-and-the-topmost-dialog-is-the-only-one-that-closes)
- **Item files are read-only to the server and client**; every write goes through the skills. Dispatch writes no item files either — the spawned session runs
  the skills, which remain the only writers. **A TRACKER project's items are the one thing this server writes** (task-46), and only through the seven routes
  below — never a file, on any path.
- **The seven `/api/items/*` write routes are guarded like the agents POSTs, refused for a `files` project, and serialised per item.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-seven-item-write-routes-are-guarded-refused-for-files-and-serialised-per-item)
- **The claim protocol is one comment per session per issue, and the LOWEST live comment id wins.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-claim-protocol-lowest-live-comment-id-wins)
- **`backlog.mjs` in a tracker project needs the stack up, and says so with exit `5`.**
  Why: [invariants.md](docs/subsystems/invariants.md#backlogmjs-in-a-tracker-project-needs-the-stack-up)
- **`import` writes the marker first and deletes the files last, and the `bm:imported` footer is its idempotency key.**
  Why: [invariants.md](docs/subsystems/invariants.md#import-writes-the-marker-first-and-deletes-the-files-last)
- **Every server route lives under `/api`**; the Vite proxy has exactly one entry, asserted by `test/vite-proxy.test.ts`.
- **Item bodies are served through a registry-built allowlist** (`allow.util.ts`); a file outside every registered `backlog/` 404s.
- **A project's source is a committed marker, resolved per request, and an `unsupported` one never falls back to `files`.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-projects-source-is-a-committed-marker-resolved-per-request-and-an-unsupported-one-never-falls-back-to-files)
- **The GitHub token never leaves the server, and the poller is armed only while something is connected.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-github-token-never-leaves-the-server-and-the-poller-is-armed-only-while-something-is-connected)
- **The tracker cache is the one cache in this server whose age is a rendered value.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-tracker-cache-is-the-one-cache-in-this-server-whose-age-is-a-rendered-value)
- **A tracker project has no item files, and that shows up in three places — and dispatch is NOT one of them.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-tracker-project-has-no-item-files-and-that-shows-up-in-three-places)
- **Groomed is derived** (bug: Cause+Fix filled and not "unknown"; task: Plan non-empty), never stored; status is the directory, never frontmatter. Ideas,
  refactors and out-of-scope derive `null`, not `false` — grooming is not a state they have, and for the first two the state they wait in is _promoted_.
- **Board-versus-Archive is derived from `updated ?? lastCommit ?? created` and the run payload, never stored.**
  Why: [invariants.md](docs/subsystems/invariants.md#board-versus-archive-is-derived-and-last-touched-has-three-rungs)
- **The middle rung of "last touched" comes from git, not the item file.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-middle-rung-comes-from-git-not-the-item-file)
- **The Orchestrate sheet's `uncommitted` flag is read from git per request, memoised nowhere, and must never join the memo one file over.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-orchestrate-sheets-uncommitted-flag-is-read-from-git-per-request-and-memoised-nowhere)
- **`refactors/` is a peer section, not a facet on ideas** Why: [invariants.md](docs/subsystems/invariants.md#refactors-is-a-peer-section-not-a-facet-on-ideas)
- **`started:` and `phase:` are the lifecycle keys allowed in frontmatter, and neither is a status**
  Why: [invariants.md](docs/subsystems/invariants.md#started-and-phase-are-the-lifecycle-keys-in-frontmatter-and-neither-is-a-status)
- **`backlog-orchestrate` is the only skill that commits or merges — and, for a TRACKER project only, the only one that pushes.**
  Why: [invariants.md](docs/subsystems/invariants.md#backlog-orchestrate-is-the-only-skill-that-commits-or-merges)
- **On a tracker project the DRIVER owns each item's claim, and the execute session never touches the issue**
  Why: [invariants.md](docs/subsystems/invariants.md#the-driver-owns-a-tracker-items-claim-for-the-whole-item)
- **The merge happens in whichever tree holds the base, and the run removes only the tree it made.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made)
- **Merge mode is run-scoped: chosen per launch, defaulted from Settings, and carried spawn → prompt → `init` → run file.**
  Why: [invariants.md](docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400)
- **`merged` is no longer the only success exit.**
  Why: [invariants.md](docs/subsystems/invariants.md#merged-is-not-the-only-success-exit--branched-is-its-branch-mode-sibling)
- **The tool refuses `stage <id> merged` under branch mode**
  Why: [invariants.md](docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400)
- **Question mode is run-scoped, and it only ever takes effect in a headless run.**
  Why: [invariants.md](docs/subsystems/invariants.md#question-mode-is-run-scoped-and-it-only-ever-takes-effect-in-a-headless-run)
- **A classifier denial degrades a run to branch mode; every other merge failure still parks.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-classifier-denial-degrades-the-run-every-other-merge-failure-parks)
- **Undoing an already-completed orchestrator merge is `git revert -m 1`, never `git reset --hard`**
  Why: [invariants.md](docs/subsystems/invariants.md#undoing-an-already-completed-orchestrator-merge-is-git-revert--m-1-never-git-reset---hard)
- **`orchestrate.mjs` is always invoked from the project root, never from inside a per-item worktree.**
  Why: [invariants.md](docs/subsystems/invariants.md#orchestratemjs-is-always-invoked-from-the-project-root-never-from-inside-a-per-item-worktree)
- **A `runner-fix:` item is hoisted to the front of the queue, and the marker is read at `<base>`.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-runner-fix-item-is-hoisted-to-the-front-of-the-queue-and-the-marker-is-read-at-base)
- **Every skill CLI ends with `process.exitCode = main(...)`, never `process.exit(main(...))`.**
  Why: [invariants.md](docs/subsystems/invariants.md#every-skill-cli-exits-through-processexitcode-never-processexit)
- **Editing `skills/` changes nothing until it is committed, pushed, and `pnpm run plugin:sync` runs.**
  Why: [invariants.md](docs/subsystems/invariants.md#editing-skills-changes-nothing-until-commit--push--pluginsync)
- **`agents/` is part of the plugin's publish surface.** Why: [invariants.md](docs/subsystems/invariants.md#agents-is-part-of-the-plugins-publish-surface)
- **The tailnet serve is a script, and its port is read where compose reads it.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-tailnet-serve-is-a-script-and-its-port-is-read-where-compose-reads-it)
- **Both processes bind `127.0.0.1` by default; loopback is the access control**
  Why: [invariants.md](docs/subsystems/invariants.md#loopback-bind-is-the-access-control-except-where-noted)
- **Every route is gated by a Host allowlist, because a bind is no defence against DNS rebinding**
  Why: [invariants.md](docs/subsystems/invariants.md#every-route-is-gated-by-a-host-allowlist)
- **Settings is two pages, the page is the scope, and the rail is the only thing that switches them.**
  Why: [invariants.md](docs/subsystems/invariants.md#settings-is-two-pages-the-page-is-the-scope)
- **`contentWidth` is stamped before first paint, and the CSP hash travels with the script that stamps it.**
  Why: [invariants.md](docs/subsystems/invariants.md#contentwidth-is-stamped-before-first-paint-and-the-csp-hash-travels-with-it)
- **The served build carries a CSP (`server/src/security.ts`); dev does not.** `script-src` pins the pre-paint theme script's sha256 — edit that script and
  `test/csp.test.ts` goes red until `THEME_SCRIPT_SHA256` follows.
- **Container mounts land on host paths, read-only**, because the registry stores absolute host paths.
- **pnpm only**, pinned by `packageManager`, enforced via corepack in the image.
- **`pnpm test` is the union of BOTH runners** Why: [invariants.md](docs/subsystems/invariants.md#pnpm-test-is-the-union-of-both-runners)
- **`allowBuilds` in `pnpm-workspace.yaml` lists `esbuild`**; a skipped build surfaces as Vite failing to start.
- **Editing `vite.config.ts` needs `docker compose restart client`.**
- **Backlog items move `open/` → `done/`; `out-of-scope/` is flat.**
- **Dispatch derives the action; it never accepts one.** Why: [invariants.md](docs/subsystems/invariants.md#dispatch-derives-the-action-it-never-accepts-one)
- **`isItemId` accepts three shapes, and `#` is the one metacharacter among them.**
  Why: [invariants.md](docs/subsystems/invariants.md#isitemid-accepts-three-shapes)
- **The orchestrate spawn prompt is composed server-side.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-orchestrate-spawn-prompt-is-composed-server-side)
- **The browser never talks to the dashboard.** Why: [invariants.md](docs/subsystems/invariants.md#the-browser-never-talks-to-the-dashboard)
- **A project the dashboard cannot see cannot be dispatched to.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-project-the-dashboard-cannot-see-cannot-be-dispatched-to)
- **An environment-level block hides the dispatch control; the per-item ones disable it.**
  Why: [invariants.md](docs/subsystems/invariants.md#environment-level-blocks-hide-the-dispatch-control-per-item-ones-disable-it)
- **One run per project, checked twice.** Why: [invariants.md](docs/subsystems/invariants.md#one-run-per-project-checked-twice)
- **A pause request lives in a server-owned file the tool reads at its two dispatch gates; `paused` is a fifth run status and `unpause` its only exit.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-pause-request-is-a-file-the-server-writes-and-the-tool-reads)
- **A stop is the control file's SECOND `kind`, and nothing resumes a stopped run**
  Why: [invariants.md](docs/subsystems/invariants.md#a-stop-is-the-control-files-second-kind-and-nothing-resumes-a-stopped-run)
- **A resume is serialized at three layers, and only the third one can refuse a resume this app never asked for**
  Why: [invariants.md](docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers)
- **The sweeper's prune keeps `paused` runs, because an entry is no longer only its bookkeeping.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers)
- **The watchdog spawns; it never writes the run file.** Why: [invariants.md](docs/subsystems/invariants.md#the-watchdog-spawns-it-never-writes-the-run-file)
- **A crashed run renders as crashed, never as nothing.** Why: [invariants.md](docs/subsystems/invariants.md#a-crashed-run-renders-as-crashed-never-as-nothing)
- **The watchdog is armed only while some `run.json` says `running`.** Why: [invariants.md](docs/subsystems/invariants.md#armed-idle-off)
- **`useOrchestratorRuns` polls while any run is `running`, fresh or not**
  Why: [invariants.md](docs/subsystems/invariants.md#a-crashed-run-renders-as-crashed-never-as-nothing)
- **Any spawn attempt starts the grace clock; a success counts against the attempt cap and a refusal against the refusal ceiling, which is the same number.**
  Why: [invariants.md](docs/subsystems/invariants.md#grace-any-attempt-starts-the-clock-only-a-success-counts)
- **The board offers a hand resume exactly when the watchdog will not spawn one — absent a stop request, which suppresses both sides — and that is one function,
  not two agreeing expressions.**
  Why: [invariants.md](docs/subsystems/invariants.md#the-resume-coupling-the-board-offers-a-hand-resume-exactly-when-the-sweeper-will-not)
- **Every agents POST is guarded by content-type and origin**
  Why: [invariants.md](docs/subsystems/invariants.md#every-agents-post-is-guarded-by-content-type-and-origin)
- **The launch sheet's model/effort pickers seed from Settings, never the last launch**
  Why: [invariants.md](docs/subsystems/invariants.md#launch-sheet-modeleffort-pickers-seed-from-settings-never-the-last-launch)
- **`linkBase` becomes an href**, so `clampSettings` routes it through `clampOrigin` — URL-parsed, `http(s)` only. The one settings key a hand-edited
  localStorage value could turn into script execution.
- **"Queue wait is not work."** Why: [invariants.md](docs/subsystems/invariants.md#queue-wait-is-not-work)
- **A session's cost is recorded per transcript, and a transcript's identity is its file name, not its session id**
  Why: [invariants.md](docs/subsystems/invariants.md#a-sessions-cost-is-recorded-per-transcript-and-a-transcripts-identity-is-its-file-name)
- **Every `.claude/rules/` file carries `paths:` and is the one home of its rules' mechanism — never the reasoning.**
  Why: [invariants.md](docs/subsystems/invariants.md#path-scoped-clauderules-reach-a-headless-run-in-a-linked-worktree-task-35)

## Conventions

- Comments explain _why_, at length, and the existing density is deliberate — match it rather than stripping it.
- **A suite that hands an app to supertest listens once, on `127.0.0.1`, via `listenLoopback` (`test/helpers/app.ts`)**
  Why: [invariants.md](docs/subsystems/invariants.md#a-supertest-suite-listens-once-on-127001-through-listenloopback)
- **A jsdom suite's fixture dates are relative to the clock the assertion runs under**
  Why: [invariants.md](docs/subsystems/invariants.md#a-fixture-date-is-relative-to-the-clock-the-assertion-runs-under)
- **Tests are flat in `test/` under jest and beside the tool they cover under node; the node globs do not descend, so a suite one level deeper never runs**
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
  verified: d3dbf8855e78b4ae70c792eeb7696167a44ce8a4
-->
