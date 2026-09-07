# backlog-manager

Claude Code plugin repo: six backlog skills — `backlog`, `backlog-capture`,
`backlog-groom`, `backlog-execute`, `backlog-orchestrate` (drains a
project's groomed queue, one item per git worktree, each reviewed and
verified before it merges), `backlog-retro` (sweeps every orchestrator run
on the machine into a report, a pick-list of items and a record the next
sweep is measured against) — plus a local NestJS + React app that shows
every registered project's backlog on one kanban-by-type board. No
database: the registry file and each project's `backlog/` directory are the
data.

## Commands

| Task | Command |
|---|---|
| Whole stack (api + client, no db) | `pnpm run docker:up` |
| Rebuild the stack from scratch | `pnpm run docker:sync` |
| API only, on the host | `pnpm run dev` |
| Client only, on the host | `pnpm run dev:web` |
| Tests (both runners) | `pnpm test` (`scripts/test-all.mjs` — jest, then node) |
| Tests, jest only | `pnpm run test:jest` (`jest --runInBand`) |
| Skill tests | `pnpm run test:skills` (`node --test`) |
| Reinstall the plugin from the pushed HEAD | `pnpm run plugin:sync` |
| Types | `pnpm run typecheck` |
| Production build | `pnpm run build` |

Ports: API `4322`, Vite `5177` (guide-manager holds 4321/5175/5176 on this
machine). Only the host side moves, via `BM_API_PORT` / `BM_WEB_PORT` in
`.env` — inside the compose stack they are fixed.

## Layout

One line per seam. The mechanism lives in the subsystem docs linked below; the
reasoning behind the rules in the next section lives in
[docs/subsystems/invariants.md](docs/subsystems/invariants.md). The doc map is
[docs/overview.md](docs/overview.md).

- `server/src/` — Nest, every route under `/api`: `health/`, `items/` (items,
  projects, item bodies, `uncommitted`), `agents/` (the one outbound-calling
  module, plus the run watchdog), `orchestrator/` (a read-only view of the
  run-state directory, plus the in-memory watchdog and starting-run records and
  the two files the server does write), `registry/`, `static.ts` (serves
  `client/dist` only when built), `security.ts`.
  → [docs/subsystems/api.md](docs/subsystems/api.md)
- `client/src/` — React SPA: four lazy sections behind a side rail (Board, Runs,
  Archive, Settings), a run strip above the board's columns, and the
  three-step Orchestrate sheet. Every derivation has one home in `lib/`.
  → [docs/subsystems/board.md](docs/subsystems/board.md)
- `shared/` — `types.ts` (all shared shapes), `agent.ts` (`deriveAction`,
  `dispatchGate` and the run/watchdog predicates both sides must agree on),
  `theme.css` (five theme palettes).
- `skills/backlog/`, `skills/backlog-capture/`, `skills/backlog-groom/`,
  `skills/backlog-execute/`, `skills/backlog-orchestrate/`,
  `skills/backlog-retro/` — the skills this repo publishes.
  `skills/backlog/tools/backlog.mjs` is the registry's only writer;
  `skills/backlog-orchestrate/tools/orchestrate.mjs` is the run file's only
  writer. `skills/backlog-retro/tools/retro.mjs` reads the run-state
  directory, the registry and — by recorded lease id — each run's driver
  transcript, and owns `~/.backlog-manager/retro/`
  ([spec](docs/superpowers/specs/2026-09-06-backlog-retro-design.md)).
  **Start orchestrator runs from the board, not by typing the trigger into a
  terminal.**
  → [docs/subsystems/skills.md](docs/subsystems/skills.md)
- `agents/` — the plugin's own agents, one file each, discovered from this
  root-level directory by Claude Code's own convention. Currently one:
  `backlog-reviewer.md`, the reviewer `backlog-orchestrate` dispatches before
  every merge.
- `backlog/` — this repo's own backlog, self-registered like any project.
- `scripts/` — `sync-plugin.mjs` (reinstall the plugin from the pushed HEAD,
  → [docs/workflows/publishing.md](docs/workflows/publishing.md)) and
  `test-all.mjs` (`pnpm test`,
  → [docs/workflows/development.md](docs/workflows/development.md)).
- `docs/` — the reference docs; `docs/superpowers/` holds the design spec and
  implementation plans this repo was built from.

## Invariants

Each entry is the rule; its `Why:` link is the reasoning, in
[docs/subsystems/invariants.md](docs/subsystems/invariants.md). Read that
section before changing any of these — most encode a failure that already
happened.

- **`skills/` is the plugin skill root**; never duplicate it under
  `.claude/skills/` — that loads the same skills twice and drifts.
- **`~/.backlog-manager/registry.json` has exactly one writer**:
  `skills/backlog/tools/backlog.mjs` (`init`/`new` upsert, plus `unregister`,
  the one removal path). The server re-reads it per request, never writes,
  never caches. What gets written is `registryRoot(root)`, not the root
  `resolveRoot` returned (bug-17): a linked worktree registers its **main
  tree**, a bare main repo registers nothing (non-fatal stderr note), and
  `resolveRoot` itself is deliberately unchanged. The discriminator is a
  `commondir` entry in the `gitdir:` target, never "`.git` is a file".
  Why: [invariants.md](docs/subsystems/invariants.md#registryjson-has-exactly-one-writer-and-a-linked-worktree-registers-its-main-tree)
- **The orchestrator's run file has exactly one writer, one reader — the
  same relationship the registry has.**
  `skills/backlog-orchestrate/tools/orchestrate.mjs` is the writer,
  `server/src/orchestrator/` is the reader, and `run.json` lives outside the
  repo entirely, under `$BM_ORCH_HOME` or `~/.backlog-manager/orchestrator/`.
  The server re-derives that path with its own copy of the same function,
  reads it fresh on every request, never writes or caches it —
  `GET /api/orchestrator/archive` and `GET /api/orchestrator/archive/run`
  included.
  Why: [invariants.md](docs/subsystems/invariants.md#the-orchestrators-run-file-has-exactly-one-writer-one-reader--the-same-relationship-the-registry-has)
- **`~/.backlog-manager/retro/` has exactly one writer, `retro.mjs record`,
  and `backlog-retro` never writes under the run-state directory** — the
  same relationship `registry.json` and `run.json` each have with their
  writer, stated for the third directory under `~/.backlog-manager` a tool
  owns. A record is evidence, so `record` refuses to overwrite one (exit
  `2`): the fix for a wrong record is the next sweep, never an edit. `sweep`
  reads four homes and writes none of them — the run-state home, the retro
  home (for deltas), `registry.json` (for project names) and, by recorded
  lease id alone, one driver transcript per run.
  Why: [invariants.md](docs/subsystems/invariants.md#backlog-managerretro-has-exactly-one-writer-and-the-retro-never-writes-run-state)
- **A run's sidecars are archived beside its run file, under a name derived
  from the archive path and stored nowhere.** One `archiveStem` names both
  `runs/<stem>.json` and `runs/<stem>/`; there is no `sidecarDir` field. The
  mover is a denylist of two (`run.json`, `runs/`), never an allowlist;
  sidecars move first, `run.json` renames last; nothing already present is
  overwritten; the move never fails an `init`; orphaned sidecars are a
  non-goal. `archivedRunFiles` (`orchestrator.service.ts`) is the ONE
  implementation of "which entries are run files", read by both
  `countPastRuns` and `archive()`.
  Why: [invariants.md](docs/subsystems/invariants.md#a-runs-sidecars-are-archived-beside-its-run-file-task-31)
- **A board-started run is visible before its run file exists, from server
  memory that is never written to disk.** `StartingRunsService` is a
  `Map<project, requestedAt>`, lost on restart on purpose, riding the payload
  as a separate top-level `starting` array — never a `status: 'starting'`
  member of `runs`. An entry dies on three rules: a run for the project whose
  `startedAt` is at or after `requestedAt` (never "a `run.json` exists"), age
  past `RUN_STALE_MS`, or a run for that project already `running`, fresh or
  crashed. Marked from `AgentsController` after the awaited spawn; `resume`
  is deliberately not marked; the board renders `starting` with no
  client-side filter.
  Why: [invariants.md](docs/subsystems/invariants.md#a-board-started-run-is-visible-before-its-run-file-exists)
- **A starting entry blocks what a run file blocks, on every surface**
  (bug-21). `runClaimBlock` (`shared/agent.ts`) takes `starting` as a required
  third parameter, no `[]` default; the block is project-wide and deliberately
  coarse; the toolbar Orchestrate control hides on it; `POST
  /api/agents/orchestrate` refuses a starting project with the same
  `RUN_IN_PROGRESS_CODE`. `runHoldsItem` deliberately does NOT gain the
  parameter.
  Why: [invariants.md](docs/subsystems/invariants.md#a-starting-entry-blocks-what-a-run-file-blocks-bug-21)
- **Escape has one owner, and the topmost dialog is the only one that closes.**
  `hooks/useDialogEscape.ts` is a module-level LIFO stack plus a single
  `window` listener; all four dialogs call it and none binds its own (bug-23).
  Ranking is by mount order; entries are removed by identity, never popped.
  Why: [invariants.md](docs/subsystems/invariants.md#escape-has-one-owner-and-the-topmost-dialog-is-the-only-one-that-closes)
- **Item files are read-only to the server and client**; every write goes
  through the skills. Dispatch writes no item files either — the spawned
  session runs the skills, which remain the only writers.
- **Every server route lives under `/api`**; the Vite proxy has exactly one
  entry, asserted by `test/vite-proxy.test.ts`.
- **Item bodies are served through a registry-built allowlist**
  (`allow.util.ts`); a file outside every registered `backlog/` 404s.
- **Groomed is derived** (bug: Cause+Fix filled and not "unknown"; task: Plan
  non-empty), never stored; status is the directory, never frontmatter. Ideas,
  refactors and out-of-scope derive `null`, not `false` — grooming is not a
  state they have, and for the first two the state they wait in is *promoted*.
- **Board-versus-Archive is derived from `updated ?? lastCommit ?? created`
  and the run payload, never stored.** `isStale`/`leavesBoard`
  (`client/src/lib/item-stale.ts`) are the one implementation and
  `lastTouched` (`client/src/lib/item-touched.ts`) the one precedence; both
  predicates take `runs`, required, no `[]` default. Five rules no caller may
  re-decide: in progress is never stale; held by a fresh run (`runHoldsItem`)
  is never stale; done or rejected is never stale; unparseable or absent
  stamps read as fresh; a task never leaves the Board, it gains a `stale`
  marker. `staleDays` (default 30) clamps to the DEFAULT below `min`, never to
  the bound.
  Why: [invariants.md](docs/subsystems/invariants.md#board-versus-archive-is-derived-and-last-touched-has-three-rungs)
- **The middle rung of "last touched" comes from git, not the item file.**
  `lastCommit` (`server/src/items/git-dates.util.ts`) is the committer date of
  the last commit touching the file, keyed relative to the project path; every
  failure degrades to `created`, never throws. The container needs `git`
  installed and `safe.directory` in system config (Dockerfile). Memoised per
  project against the mtimes of `index` and `logs/HEAD` — the one cache in
  `items/`.
  Why: [invariants.md](docs/subsystems/invariants.md#the-middle-rung-comes-from-git-not-the-item-file)
- **The Orchestrate sheet's `uncommitted` flag is read from git per request,
  memoised nowhere, and must never join the memo one file over.**
  `uncommittedItemPaths` (`server/src/items/uncommitted.util.ts`), behind
  `GET /api/items/uncommitted`, is the one implementation. The question is
  "differs from `main`", never "differs from `HEAD`"; two git reads (`diff`
  plus `ls-files --others`), never one; a sibling endpoint, never a
  `BacklogItem` field; `known` gates the render; nothing derived reads it; it
  changes no default selection. Any surface stating a consequence must split
  it: absent from `main` is skipped, present-but-edited is executed on
  `main`'s bytes.
  Why: [invariants.md](docs/subsystems/invariants.md#the-orchestrate-sheets-uncommitted-flag-is-read-from-git-per-request-and-memoised-nowhere)
- **`refactors/` is a peer section, not a facet on ideas**: ideas are new,
  refactors are existing things that should be improved. Prefix `ref`,
  lifecycle identical to ideas (`open/` → `done/`, promotable to a task with
  `from:`, rejectable). `kind: chore | debt` is written by `backlog-capture`,
  round-tripped by the CLI as an unknown key, passed through verbatim by the
  API, and badged only for the values `REFACTOR_KINDS` lists.
  `backlog-execute` refuses the section outright.
  Why: [invariants.md](docs/subsystems/invariants.md#refactors-is-a-peer-section-not-a-facet-on-ideas)
- **`started:` and `phase:` are the lifecycle keys allowed in frontmatter,
  and neither is a status** — the `status:` ban stands. `start <id> [--as
  groom|execute]` writes `started:` (second-precision UTC) and, with `--as`,
  `phase: groom` / `phase: execute`; `stop <id>` bills
  `groom-elapsed:`/`execute-elapsed:` and `groom-tokens:`/`execute-tokens:` —
  four permanent, accumulating integer counters behind ONE billable gate —
  then removes `phase:` and, unless `--keep-started`, `started:` too. Cache reads are excluded from the token
  count; attribution is whole-session-within-the-window; an unattributable
  count writes no key, never `0`. `updated:` is stamped by every `start` and
  every `stop`, never by `move`. Written only by `start`/`stop`, which
  round-trip unknown keys and the body byte-for-byte; "in progress" is decided
  in the client.
  Why: [invariants.md](docs/subsystems/invariants.md#started-and-phase-are-the-lifecycle-keys-in-frontmatter-and-neither-is-a-status)
- **`backlog-orchestrate` is the only skill that commits or merges.** Inside a
  per-item worktree, on `backlog/<id>` alone; merged into `main` in the main
  tree, `--no-ff` only, only once the main tree is verified to have `main`
  actually checked out. No other skill touches git history at all.
  Why: [invariants.md](docs/subsystems/invariants.md#backlog-orchestrate-is-the-only-skill-that-commits-or-merges)
- **Merge mode is run-scoped: chosen per launch, defaulted from Settings, and
  carried spawn → prompt → `init` → run file.** `MergeMode` (`shared/types.ts`)
  is `merge | branch`, `isMergeMode` its one guard. The sheet sends `mergeMode`
  on **every** launch; `init` writes `mergeMode`, `mergeModeEffective` (moves
  `merge` → `branch` once, never back) and `mergeModeNote`. **Absent means
  `merge`; present-but-invalid is a 400, never a clamp.**
  Why: [invariants.md](docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400)
- **`merged` is no longer the only success exit.** `branched` is its
  branch-mode sibling and a true exit: out of `RUN_CLAIMED_STAGES`,
  `ATTENTION_RUN_STAGES` and `MACHINE_STAGES`, in
  `RECONCILE_TERMINAL_STAGES`, counted as completed by `aggregateRuns`;
  `test/agents-shared.test.ts`'s `Record<RunStage, true>` literal forces the
  classification. A `branched` stamp does not prove the run that wrote it
  executed the item.
  Why: [invariants.md](docs/subsystems/invariants.md#merged-is-not-the-only-success-exit--branched-is-its-branch-mode-sibling)
- **The tool refuses `stage <id> merged` under branch mode** — exit `1`,
  nothing written. The converse is deliberately *not* enforced: `stage <id>
  branched` is legal under `merge` mode too.
  Why: [invariants.md](docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400)
- **Question mode is run-scoped, and it only ever takes effect in a headless
  run.** `QuestionMode` (`shared/types.ts`) is `decide | park`,
  `isQuestionMode` its one guard; the default `park` appends nothing to the
  prompt. Absent means `park`; present-but-invalid is a 400, never a clamp;
  one field, not three. `orchestrate.mjs assume <id> --json <file>` is the
  one writer of `RunQueueItem.assumptions` and is refused under `park` (exit
  `1`); `attention --kind needs-answers` stays legal under `decide`. No
  fourth `ATTENTION_KIND`.
  Why: [invariants.md](docs/subsystems/invariants.md#question-mode-is-run-scoped-and-it-only-ever-takes-effect-in-a-headless-run)
- **A classifier denial degrades a run to branch mode; every other merge
  failure still parks.** Denied means the item is staged `branched`, the
  downgrade is recorded once (`merge-mode branch --note`), the queue
  continues, and there is no attention entry. A conflict, overlapping dirty
  paths and a main tree not on `main` still park. SKILL.md §2's preflight
  probe is early warning, never a guarantee — the verdict is per call.
  Why: [invariants.md](docs/subsystems/invariants.md#a-classifier-denial-degrades-the-run-every-other-merge-failure-parks)
- **Undoing an already-completed orchestrator merge is `git revert -m 1`,
  never `git reset --hard`** — proved empirically: the reset silently
  destroyed unrelated uncommitted work with no reflog entry to recover it.
  `git merge --abort` still handles an in-progress conflicted merge.
  Why: [invariants.md](docs/subsystems/invariants.md#undoing-an-already-completed-orchestrator-merge-is-git-revert--m-1-never-git-reset---hard)
- **`orchestrate.mjs` is always invoked from the project root, never from
  inside a per-item worktree.** Every command but `init` walks up from its
  cwd and **refuses** a linked worktree (exit `1`, naming the worktree and the
  project root); `init` runs the same refusal over `--project`. The
  discriminator is a `commondir` entry in the `gitdir:` target, not "`.git`
  is a file". Worktree-scoped flags (`stage --worktree`/`--branch`, `verify
  --cwd`) are exempt.
  Why: [invariants.md](docs/subsystems/invariants.md#orchestratemjs-is-always-invoked-from-the-project-root-never-from-inside-a-per-item-worktree)
- **A `runner-fix:` item is hoisted to the front of the queue, and the marker
  is read at `<base>`.** A human's judgement written during grooming, never a
  path heuristic; presence hoists, only `false` opts out; `parseItemForGate`
  reads it; the partition is stable, outranks bugs-then-tasks and runs before
  `--max`; `--ids` is hoisted too, a hand order included. SKILL.md §9: after a
  merged runner fix, follow the repo's SKILL.md **and** `orchestrate.mjs` —
  both or neither. Inert for the *next* run until push + `pnpm run
  plugin:sync`.
  Why: [invariants.md](docs/subsystems/invariants.md#a-runner-fix-item-is-hoisted-to-the-front-of-the-queue-and-the-marker-is-read-at-base)
- **Editing `skills/` changes nothing until it is committed, pushed, and
  `pnpm run plugin:sync` runs.** An install is a copy of the pushed HEAD,
  never the working tree; the sync refuses dirty/unpushed/behind states. New
  skills load on the next Claude Code restart.
  Why: [invariants.md](docs/subsystems/invariants.md#editing-skills-changes-nothing-until-commit--push--pluginsync)
- **`agents/` is part of the plugin's publish surface.** An install carries
  only what `PUBLISHED_PATHS` (`scripts/sync-plugin.mjs`) and the
  marketplace's `sparsePaths` both list. The machine-local half is declared in
  `~/.claude/settings.json` →
  `extraKnownMarketplaces.<marketplace>.source.sparsePaths`, never in
  `known_marketplaces.json` — a cache, and hand-editing it triggers the
  revert. The sync measures every published path on both sides (bug-10).
  Why: [invariants.md](docs/subsystems/invariants.md#agents-is-part-of-the-plugins-publish-surface)
- **Both processes bind `127.0.0.1` by default; loopback is the access
  control** (nothing has auth). `BM_BIND` is the single knob; compose sets
  `0.0.0.0`. Both halves are pinned: `test/vite-proxy.test.ts` imports the dev
  config, `test/server-bind.test.ts` reads `server/src/main.ts`'s SOURCE — a
  bare `app.listen(PORT)` fails it.
  Why: [invariants.md](docs/subsystems/invariants.md#loopback-bind-is-the-access-control-except-where-noted)
- **The served build carries a CSP (`server/src/security.ts`); dev does
  not.** `script-src` pins the pre-paint theme script's sha256 — edit that
  script and `test/csp.test.ts` goes red until `THEME_SCRIPT_SHA256` follows.
- **Container mounts land on host paths, read-only**, because the registry
  stores absolute host paths.
- **pnpm only**, pinned by `packageManager`, enforced via corepack in the
  image.
- **`pnpm test` is the union of BOTH runners** — `scripts/test-all.mjs` runs
  `test:jest` and then `test:skills`, always both, and exits `1` if either
  failed. Do not "simplify" `test` back to bare jest: jest's `testMatch` can
  never reach `skills/*/tools/*.test.mjs`, the whole of this repo's
  single-writer tooling. The two named scripts stay the single copy of what
  each runner runs; neither runner short-circuits the other; the script has
  no test of its own on purpose.
  Why: [invariants.md](docs/subsystems/invariants.md#pnpm-test-is-the-union-of-both-runners)
- **`allowBuilds` in `pnpm-workspace.yaml` lists `esbuild`**; a skipped build
  surfaces as Vite failing to start.
- **Editing `vite.config.ts` needs `docker compose restart client`.**
- **Backlog items move `open/` → `done/`; `out-of-scope/` is flat.**
- **Dispatch derives the action; it never accepts one.** `deriveAction`
  (`shared/agent.ts`) is the single implementation for the board's label and
  the server's validation; dispatch re-scans the file and 409s on
  disagreement. The prompt is the only client field taken outright; unknown
  `model`/`effort` drop rather than reject; the controller rebuilds the body
  field by field and checks `action` with `isAgentAction`, never a
  hand-written comparison chain. `AgentAction` has three members: `capture`
  is derived for an out-of-scope item by SECTION, before the
  `status !== 'open'` check; a `done/` item still derives `null`; capture
  spawns `backlog-capture` for a **new** item citing `from: <id>`, and
  `moveItem` still refuses every move out of `out-of-scope/`.
  Why: [invariants.md](docs/subsystems/invariants.md#dispatch-derives-the-action-it-never-accepts-one)
- **The orchestrate spawn prompt is composed server-side.**
  `ORCHESTRATE_PROMPT` (`agents.service.ts`) is the literal
  `/backlog-orchestrate`; the request body has no `prompt` field, so a
  caller-supplied one is never read. What a caller can influence is
  enumerated by the composition in `orchestrate()` and nowhere else: `ids`
  (each proven by `isItemId` and a per-project scan; 400 for a malformed
  list, 409 for a disagreeing one; absent means the whole queue, explicitly
  empty is a 400), then the compile-time literals ` --merge-mode branch` and
  ` --question-mode decide`, each appended only off its guard, each default
  appending nothing, in that order.
  Why: [invariants.md](docs/subsystems/invariants.md#the-orchestrate-spawn-prompt-is-composed-server-side)
- **The browser never talks to the dashboard.** Every call goes board → this
  API → dashboard; `BM_AGENTS_URL` is env-only; `BM_AGENTS` defaults to off —
  and **compose passes that one through as `${BM_AGENTS:-off}`, never as a
  literal** (bug-25, pinned by `test/compose-env.test.ts`). `BM_AGENTS_URL`
  beside it stays a literal: stack topology, not a policy default.
  Why: [invariants.md](docs/subsystems/invariants.md#the-browser-never-talks-to-the-dashboard)
- **A project the dashboard cannot see cannot be dispatched to.** Never
  derive a `dirName` from a path to route around this. The `dispatchGate`
  membership check is a raw string compare, deliberately not realpath.
  Why: [invariants.md](docs/subsystems/invariants.md#a-project-the-dashboard-cannot-see-cannot-be-dispatched-to)
- **An environment-level block hides the dispatch control; the per-item ones
  disable it.** With `BM_AGENTS` off the board shows no dispatch buttons — do
  not "improve" that into disabled buttons. Three per-item blocks keep their
  button, read by `DispatchButton` in this order: project visibility
  (`dispatchGate`), a local session's `started:` stamp (`progressBlock`,
  `client/src/lib/item-progress.ts` — ANY stamp, fresh or stale), an
  orchestrator claim (`runClaimBlock`). Exactly one lets the click through:
  the visibility block re-asks the status through `useReverify`
  (`client/src/hooks/useReverify.ts`), which the toolbar Orchestrate control
  shares (bug-13, bug-16); the other two keep swallowing it.
  Why: [invariants.md](docs/subsystems/invariants.md#environment-level-blocks-hide-the-dispatch-control-per-item-ones-disable-it)
- **One run per project, checked twice.** `orchestrate.mjs init` refuses
  outright on any `status: "running"` run file, fresh or stale (exit `4`;
  recover via `--resume`/`--abort`, never overwrite). `POST
  /api/agents/orchestrate` re-checks before it spawns: a *fresh* run file
  (`RUN_STALE_MS`) or a `starting` entry, both 409 with `RUN_IN_PROGRESS_CODE`
  — the only two 409s on this endpoint that carry a code. Keep no count of
  its 409 reasons anywhere.
  Why: [invariants.md](docs/subsystems/invariants.md#one-run-per-project-checked-twice)
- **A pause request lives in a server-owned file the tool reads at its two
  dispatch gates; `paused` is a fifth run status and `unpause` its only
  exit.** `POST /api/agents/pause` — origin-guarded, independent of
  `BM_AGENTS` — writes
  `~/.backlog-manager/settings/orchestrator-control/<encodeURIComponent(project)>.json`,
  the one file travelling server → tool; `run.json` keeps its single writer.
  Effectiveness is derived on both sides, never stored. `orchestrate.mjs`
  refuses `stage <id> preflight`/`dispatched` with exit `6`, only on a
  transition; `heartbeat` never touches a status; the watchdog needs no
  change; `init` archives a paused run like a done one. Resume for `paused`
  is on both surfaces (`RunControls`, `resumeGate`); Resume for a crashed run
  stays on the strip alone.
  Why: [invariants.md](docs/subsystems/invariants.md#a-pause-request-is-a-file-the-server-writes-and-the-tool-reads)
- **A resume is serialized at three layers, and only the third one can
  refuse a resume this app never asked for** (bug-19). (1) The board's Resume
  control has a synchronous in-flight guard and its mark ends on `running`
  **and `fresh`**. (2) `AgentsService.resume()` takes
  `WatchdogEntry.resumeSpawnAt` synchronously before its next `await`, holds
  it for `RUN_STALE_MS`, clears it when the spawn throws, and refuses with an
  **uncoded** 409. (3) `orchestrate.mjs` records a driver lease (`driver:
  { sessionId, at } | null`, identity `CLAUDE_CODE_SESSION_ID`, absent means
  unclaimed); refusal is exit `7`; `claim` refuses only a run that is
  `running`, fresh and led by another session; `abort` and `unpause` TAKE the
  lease rather than checking it — that is the rule, not an exception.
  Why: [invariants.md](docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers)
- **The sweeper's prune keeps `paused` runs, because an entry is no longer
  only its bookkeeping.** `resumeSpawnAt` lives for `RUN_STALE_MS`, not
  "while the sweeper is interested"; the keep set is built in `sweep()`, not
  decided inside `prune()`.
  Why: [invariants.md](docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers)
- **The watchdog spawns; it never writes the run file.** `runs()` stays the
  one reader; `WatchdogService` only ever calls `AgentsService.resume()`.
  Attempts, phase and the event log live in `WatchdogStateService`, in
  memory, lost on restart on purpose. `settings/watchdog.json`
  (`watchdog-config.util.ts`) is the server's one write, its own single
  writer, under its own nested read-write mount.
  Why: [invariants.md](docs/subsystems/invariants.md#the-watchdog-spawns-it-never-writes-the-run-file)
- **A crashed run renders as crashed, never as nothing.** The strip states
  only facts the payload carries; badges, card run bars and `runClaimBlock`
  stay freshness-based. The Runs view reads the same payload (bug-29):
  `MergedRun.live` is the data authority, `MergedRun.isLive` the presentation
  gate; both status badges read `crashed` through `runStatusChip`
  (`lib/run-stage.ts`), never from `authority`. `crashed` is **not** a sixth
  `RunStatus`.
  Why: [invariants.md](docs/subsystems/invariants.md#a-crashed-run-renders-as-crashed-never-as-nothing)
- **The watchdog is armed only while some `run.json` says `running`.** No
  standing interval — a `setTimeout` chain that disarms the tick it finds
  none. It arms on the board's own runs reads, a boot-time scan, a successful
  `orchestrate`/`resume` spawn (wired in `AgentsController`, never
  `AgentsService`) and every `POST /api/agents/watchdog/config` save, which
  calls `arm()` and then an unawaited `tick()`. A run started by typing the
  trigger with the board never opened is never watched.
  Why: [invariants.md](docs/subsystems/invariants.md#armed-idle-off)
- **`useOrchestratorRuns` polls while any run is `running`, fresh or not.**
  Why: [invariants.md](docs/subsystems/invariants.md#a-crashed-run-renders-as-crashed-never-as-nothing)
- **Any spawn attempt starts the grace clock; only a success counts against
  the cap.** `exhausted` is decided before grace. A board resume is a spawn
  attempt too (`WatchdogService.noteBoardResume`, called from the controller
  BEFORE `arm()`): grace yes, cap no.
  Why: [invariants.md](docs/subsystems/invariants.md#grace-any-attempt-starts-the-clock-only-a-success-counts)
- **The board offers a hand resume exactly when the watchdog will not spawn
  one, and that is one function, not two agreeing expressions.**
  `watchdogStoodDown` (`shared/agent.ts`) is read by `RunStrip` and by
  `watchdog.service.ts`'s `visit()`; its inputs `spawningEnabled()` and
  `watchdogExhausted` (`attempts >= maxAttempts`, DERIVED, never stored) are
  single implementations too. Pinned by `test/watchdog-coupling.test.tsx` and
  `test/watchdog-sweep.test.ts` driving both sides from one table of
  hand-checked verdicts.
  Why: [invariants.md](docs/subsystems/invariants.md#the-resume-coupling-the-board-offers-a-hand-resume-exactly-when-the-sweeper-will-not)
- **Every agents POST is guarded by content-type and origin**
  (`server/src/agents/origin.guard.ts`) — the one place loopback is NOT the
  access control. `test/agents-origin-guard.test.ts`'s route list is where
  the guarded set lives, never a count in prose. Absent `Origin` stays
  allowed; the guard compares host and port, not scheme.
  Why: [invariants.md](docs/subsystems/invariants.md#every-agents-post-is-guarded-by-content-type-and-origin)
- **The launch sheet's model/effort pickers seed from Settings, never the
  last launch** (`dispatchDefaultModel` / `dispatchDefaultEffort` in
  `client/src/lib/settings.ts`, clamped against `MODELS`/`EFFORTS`).
  Permission mode has no stored default — it comes from `plan.defaultMode`,
  clamped to the host ceiling.
  Why: [invariants.md](docs/subsystems/invariants.md#launch-sheet-modeleffort-pickers-seed-from-settings-never-the-last-launch)
- **`linkBase` becomes an href**, so `clampSettings` routes it through
  `clampOrigin` — URL-parsed, `http(s)` only. The one settings key a
  hand-edited localStorage value could turn into script execution.
- **"Queue wait is not work."** `itemDurationMs`
  (`client/src/lib/run-time.ts`) is the one implementation of "how long did
  this item take"; machine time (`runStageTotals`) excludes `pending` too;
  `MACHINE_STAGES` is the closed list of what counts.
  Why: [invariants.md](docs/subsystems/invariants.md#queue-wait-is-not-work)
- **A session's cost is recorded per transcript, and a transcript's identity
  is its file name, not its session id** (task-27). `orchestrate.mjs usage
  <id> --jsonl <file>` is the one writer of `RunQueueItem.usage`: one entry
  per transcript, never one summed figure; identity is `kind` + `loop`, both
  from the file name, never `sessionId`. Absence is a value: no result event
  writes no entry, a renamed numeric field reads `null` never `0`, and
  `usage` stays optional so an older run renders nothing rather than `$0.00`.
  Why: [invariants.md](docs/subsystems/invariants.md#a-sessions-cost-is-recorded-per-transcript-and-a-transcripts-identity-is-its-file-name)

## Conventions

- Comments explain *why*, at length, and the existing density is deliberate —
  match it rather than stripping it.
- Tests are flat in `test/`, `*.test.ts` / `*.test.tsx`; component suites opt
  into jsdom with a `@jest-environment jsdom` docblock. Skill tests live next
  to the tool they cover (`skills/*/tools/*.test.mjs`) and run under node's
  own test runner, not jest — but `pnpm test` runs both runners, via
  `scripts/test-all.mjs`. The split is which runner executes a file, not which
  ones one word covers; see the Invariants entry. Cases that pin a **skill's
  prose** rather than a tool live in `skills/backlog/tools/backlog.test.mjs`
  too (`backlog-groom`'s stamp order and its closing `Groomed on disk only`
  line, `backlog-execute`'s pre-review checks and the
  `agents/backlog-reviewer.md` half that reads them): that glob is the only one
  the node runner has, and none of those files sits beside a `tools/`
  directory. The one exception is deliberate — the `Groomed on disk only` cases
  assert `skills/backlog-orchestrate/SKILL.md`'s half of that seam too, in this
  suite rather than in `orchestrate.test.mjs`, because the rule is two skills
  agreeing on one sentence and a suite that reads only one half cannot catch
  them drifting apart; the reviewer/execute pair is the same shape. They read
  the other file, never import it — the "one skill's `tools/` may never import
  another's" rule is untouched. `backlog-retro` splits its suite in two —
  `retro.test.mjs` (the CLI, spawned as a child process) and
  `retro-lib.test.mjs` (the modules under `tools/lib/`) — and BOTH sit at the
  `tools/` level on purpose: `test:skills`'s only glob is
  `skills/*/tools/*.test.mjs`, so a file under `tools/lib/` would never be
  run, which is the same as not existing.

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
  verified: bb20a03538aca602eacbff8bed6393478115d83f
-->
