# backlog-manager

Claude Code plugin repo: five backlog skills — `backlog`, `backlog-capture`,
`backlog-groom`, `backlog-execute`, `backlog-orchestrate` (drains a
project's groomed queue, one item per git worktree, each reviewed and
verified before it merges) — plus a local NestJS + React app that shows
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
| Tests | `pnpm test` (jest, `--runInBand`) |
| Skill tests | `pnpm run test:skills` |
| Reinstall the plugin from the pushed HEAD | `pnpm run plugin:sync` |
| Types | `pnpm run typecheck` |
| Production build | `pnpm run build` |

Ports: API `4322`, Vite `5177` (guide-manager holds 4321/5175/5176 on this
machine). Only the host side moves, via `BM_API_PORT` / `BM_WEB_PORT` in
`.env` — inside the compose stack they are fixed.

## Layout

- `server/src/` — Nest: `health/`, `items/` (`/api/items`, `/api/projects`,
  `/api/items/body`), `agents/` (the one outbound-calling module — status,
  plan, dispatch, orchestrate, resume, and the run watchdog
  (`watchdog.service.ts`, armed only while some `run.json` says running),
  plus the local read-only `merge-check`), `orchestrator/`
  (`GET /api/orchestrator/runs` for the live board strip, plus
  `GET /api/orchestrator/archive` and `GET /api/orchestrator/archive/run`
  for run history — all three a read-only view of the run-state directory,
  current run and archived `runs/` alike — see Invariants; plus
  `watchdog-state.service.ts`, the in-memory record of what the watchdog
  did, annotated onto `/api/orchestrator/runs` as `watchdog` on crashed runs
  only, and `watchdog-config.util.ts`, the one file the server writes),
  `registry/` (read-only view of the registry file), `static.ts` (serves
  `client/dist` only when built).
- `client/src/` — React SPA: side rail (Board / Runs / Archive / Settings —
  `SECTIONS` in `SideRail.tsx` is the one runtime list of them, and
  `resolveSection` in `App.tsx` maps a stored value that names no tab, the
  legacy `'projects'` included, onto Board), board (four
  fixed columns — refactors/ideas/bugs/tasks; out-of-scope has no Board
  column at all and belongs to Archive; stale items leave it too, see
  Invariants — card drawer,
  dispatch control opening a launch sheet onto `../claude-agents-dashboard`,
  a toolbar Orchestrate control opening `OrchestrateSheet` (previews the
  queue and selects a subset of it — `ids` rides along only for a strict
  subset, so an untouched sheet still starts a whole-queue run — plus a merge
  mode picker seeded from Settings and, in merge mode, a setup hint fed by
  `GET /api/agents/merge-check`), and a run strip
  above the columns — `RunStrip`/`RunDrawer` — showing every project's
  orchestrator runs; a crashed run — `running`, heartbeat stale — renders
  as crashed with the watchdog's verdict and, when the watchdog is
  exhausted or off, a Resume control), Runs (`RunsView` — aggregate stat tiles including a
  wide "machine time by stage" tile, a Today / This week / This month / All
  range control (calendar-aligned, local-time windows on a run's
  `startedAt`, `lib/run-range.ts`) that scopes the tiles, the list and the
  wide tile together, a project filter, a day-grouped run list with fresh
  live runs pinned above history, and a persistent detail pane carrying
  that same per-run "machine time by stage" rollup plus a full-width
  seven-node `StageTrack` per item with durations printed under each node;
  fed by `lib/run-range.ts` and `lib/run-stats.ts`, both pure statistics
  libs, and `hooks/useOrchestratorArchive.ts`, which fetches on mount and
  window focus only — no polling interval, since history moves at run
  boundaries, not on a live heartbeat), archive (`ArchiveView.tsx`: four columns —
  refactors/ideas/bugs/out-of-scope — grouped under sticky month subheaders
  keyed on `updated ?? created` (`lib/item-month.ts`), project filter and
  search only, no status or sort control; the same cards, drawer and launch
  sheet the board uses, no run strip), Settings, and an Orchestrator
  watchdog group (`WatchdogGroup.tsx`, server-side knobs and activity, via
  `hooks/useWatchdog.ts`). Board and Archive share one
  persisted project filter, declared in `lib/view-keys.ts` rather than exported
  from either — they are separate lazy chunks, and an import between them would
  undo the split. Fed by `lib/agents.ts` (same-origin
  fetches), `hooks/useAgents.ts` (status poll on mount and window focus, plus
  the one re-ask a click against a project-visibility block provokes — see
  Invariants),
  and `hooks/useOrchestratorRuns.ts` (same cadence, plus a 5s poll while any
  run is fresh or still `running` — a crashed run keeps the strip polling
  too).
- `shared/` — `types.ts` (all shared shapes), `agent.ts` (`deriveAction`,
  `dispatchGate` — see Invariants), `theme.css` (five theme palettes).
- `skills/backlog/`, `skills/backlog-capture/`, `skills/backlog-groom/`,
  `skills/backlog-execute/`, `skills/backlog-orchestrate/` — the skills this
  repo publishes. `skills/backlog/tools/backlog.mjs` is the CLI every skill
  calls and the registry's only writer;
  `skills/backlog-orchestrate/tools/orchestrate.mjs` is
  `backlog-orchestrate`'s own CLI and the run file's only writer (see
  Invariants). `skills/backlog-orchestrate/references/` holds the two parts
  its SKILL.md deliberately does **not** carry inline, because a run re-reads
  its whole body on every one of its several hundred turns: `recovery.md` (all
  of `--resume`/`--abort`, read in full before either) and `rationale.md` (the
  measurements behind the rules). **Start orchestrator runs from the board,
  not by typing the trigger into a terminal** — the board spawns `claude -p`,
  and headless sessions were measured flooring ~50k against an interactive
  session's ~68k.
- `agents/` — the plugin's own agents, one file each, discovered from this
  root-level directory by Claude Code's own convention (no
  `.claude-plugin/plugin.json` declaration needed). Currently one:
  `backlog-reviewer.md`, the read-only reviewer `backlog-orchestrate`
  dispatches before every merge. Published only because `PUBLISHED_PATHS`
  (`scripts/sync-plugin.mjs`) now names it alongside `skills/` — see
  Invariants.
- `backlog/` — this repo's own backlog, self-registered like any project.
- `scripts/sync-plugin.mjs` — reinstalls the plugin from the pushed HEAD.
- `docs/superpowers/` — design spec and implementation plan.

## Invariants

Full rationale for the longer ones: [docs/invariants.md](docs/invariants.md).
Read it before changing any of these — most encode a failure that already
happened.

- **`skills/` is the plugin skill root**; never duplicate it under
  `.claude/skills/` — that loads the same skills twice and drifts.
- **`~/.backlog-manager/registry.json` has exactly one writer**:
  `skills/backlog/tools/backlog.mjs` (`init`/`new` upsert, plus `unregister`,
  the one removal path — the upsert has no undo, and the repair for an entry
  that should never have been written has to live behind the same single
  writer, not in the server and not in a text editor). The server re-reads it
  per request, never writes, never caches. **What gets written is
  `registryRoot(root)`, not the root `resolveRoot` returned**: those are the
  same path in every case but one, and that one is bug-17 — a per-item
  orchestrator worktree registered as a standalone project (`.worktrees/bug-13`,
  name "bug-13"), a phantom entry that outlived the directory it named, since
  a worktree is deleted the moment its item merges. `resolveRoot` is not at
  fault and is deliberately unchanged: an execute session inside a worktree
  MUST resolve `backlog/` to that worktree's own copy, which is why its walk
  accepts a `.git` file at all. The registry is the one consumer of that root
  for which a worktree is the wrong answer — it stores absolute host paths the
  board, the item-body allowlist and the orchestrator all key on — so the
  mapping sits at that seam alone. A linked worktree registers its **main
  tree** rather than being refused, because the worktree's items merge back
  into it and it is almost always already registered, making the upsert a
  harmless name refresh; `null` (register nothing, non-fatal stderr note) is
  reserved for a bare main repo, where no main-tree path can be named. The
  discriminator is `linkedWorktreeInfo`, a **second copy** of
  `orchestrate.mjs`'s function — duplicated because one skill's `tools/` may
  never import another's, and keyed on a `commondir` entry in the `gitdir:`
  target, never "`.git` is a file": a submodule working tree is a file too and
  must keep registering as itself. Both suites build a real submodule so a
  future git that changes that layout fails loudly in both places.
- **The orchestrator's run file has exactly one writer, one reader — the
  same relationship the registry has.**
  `skills/backlog-orchestrate/tools/orchestrate.mjs` is the writer,
  `server/src/orchestrator/` is the reader, and `run.json` lives outside the
  repo entirely, under `$BM_ORCH_HOME` or `~/.backlog-manager/orchestrator/`.
  The server re-derives that path with its own copy of the same function
  rather than importing the `.mjs` tool, reads it fresh on every request, and
  never writes or caches it — a running orchestrator re-stamps the file on
  every heartbeat, and `GET /api/orchestrator/runs` exists to let the board
  watch that happen live. The same one reader now also covers `runs/`, the
  directory `cmdInit` archives a project's superseded `run.json` into before
  starting the next one, over two more read-only endpoints:
  `GET /api/orchestrator/archive` lists every run a project has ever
  produced, current and archived alike, tails stripped to `{cmd, ok}` and
  each entry flagged `current: boolean`; `GET /api/orchestrator/archive/run`
  serves one run file verbatim, gated by a runId regex and an
  allowlist-by-directory-listing on the project before either check touches
  the filesystem, 404 for every failure alike. Both stay as fresh-per-request
  and cache-nothing as `runs()` always has — the single-writer rule is
  unchanged; only the one reader's reach grew.
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
  (`client/src/lib/item-stale.ts`) are the one implementation, read by both
  BoardView and ArchiveView, so an item can never be in both surfaces or
  neither; `lastTouched` (`client/src/lib/item-touched.ts`) is the one
  implementation of the three-rung precedence, read by `isStale` and by
  Archive's month grouping so a column can never be ordered by a date nobody
  used to decide its contents. Five rules the predicate encodes and no caller
  may re-decide: an
  item **in progress** is never stale (`started` outranks the arithmetic); an
  item a **fresh orchestrator run holds** is never stale either, which is why
  both functions take `runs` — required, no `[]` default, because a default
  is what lets the next caller reintroduce bug-11 silently (`runHoldsItem`,
  `shared/agent.ts`, is every stage but the five true exits, so `pending` and
  `parked` both count, and it is a separate function from `runClaimBlock`
  because a parked item must stay on the Board *and* stay hand-dispatchable);
  a **done or rejected** item is never
  stale (staleness is about neglected work, and a done item is only reachable
  through the Board's own Done filter); an **unparseable or absent** pair of
  stamps reads as fresh, because a malformed file has to stay where someone
  will see it; and a **task never leaves the Board**, it gains a `stale`
  marker instead. The second rule exists because the item file cannot know:
  a run stamps `started:`/`phase:` on its own worktree's copy, so the copy the
  registry points at is silent for the whole run — the same reason
  `runClaimBlock` exists, and `ATTENTION_RUN_STAGES` moved to `shared/types.ts`
  (beside `RUN_CLAIMED_STAGES`) so a `lib/` module could read it without
  importing a React component. The window is a client setting (`staleDays`, default 30) —
  a view decision over a corpus the server already returns whole — and it is
  the one numeric setting whose clamp falls back to the DEFAULT rather than
  the nearest bound below `min`, because `0` would silently empty three
  columns.

- **The middle rung of "last touched" comes from git, not the item file.**
  `updated:` has exactly one writer (`backlog.mjs start`/`stop`) while the item
  file has several editors, so a groom session that writes Cause and Fix
  through the editor without `start --as groom` leaves the frontmatter silent —
  and ixray's bug-7 aged off the Board on a five-week-old `created:` five days
  after it was groomed. `lastCommit` (`server/src/items/git-dates.util.ts`) is
  the committer date of the last commit touching the file, read once per scan
  with `git log --name-only --relative`, keyed relative to the *project* path
  because a registered directory need not be a repo root. Every failure — no
  git, no repo, untracked file, timeout — degrades to `created`, never throws:
  an unreadable history must not 500 every project's board. **The container
  needs `git` installed and `safe.directory` in system config** (Dockerfile);
  without either the degrade path is silent and the fix is host-only, which is
  how it first shipped invisible. The result is memoised per project against
  the mtimes of `index` and `logs/HEAD` — the one cache in `items/`, and it is
  a memo rather than the stale cache `ItemsService` refuses because it is keyed
  on the files git rewrites whenever the answer can change; with neither file
  present there is no key that can move and it recomputes instead. It exists
  because the call costs 84–396ms per project and `scanProject` runs on both
  `/api/items` and `/api/projects`.

- **`refactors/` is a peer section, not a facet on ideas**: ideas are new,
  refactors are existing things that should be improved. Prefix `ref` (short
  because the card's meta line is ~118px of nowrap), lifecycle identical to
  ideas (`open/` → `done/`, promotable to a task with `from:`, rejectable).
  `kind: chore | debt` is written by `backlog-capture`, round-tripped by the
  CLI as an unknown key, passed through verbatim by the API, and badged by the
  client only for the values `REFACTOR_KINDS` lists. `backlog-execute` refuses
  the section outright — its refusal gate inspects only a task's `## Plan` and
  a bug's `## Fix`, so an id from any other section has to be turned away by
  the directory check that runs before it.
- **`started:` and `phase:` are the lifecycle keys allowed in frontmatter,
  and neither is a status** — the `status:` ban stands, unaffected by either.
  `start <id> [--as groom|execute]` writes `started:` (a second-precision UTC
  timestamp, `2026-08-28T14:03:07Z`) alone, or with a `phase: groom` /
  `phase: execute` line alongside it when `--as` is given; `stop <id>` reads
  `phase:` back to pick `groom-elapsed:` or `execute-elapsed:` and
  `groom-tokens:` or `execute-tokens:` — **four permanent, accumulating
  integer counters, two per activity**: whole seconds since `started:`, and
  the tokens the calling session spent over that same window, read out of its
  own transcript (`CLAUDE_CODE_SESSION_ID` names it; there is no hook and
  nothing new on the publish surface). Both buckets ride **one** billable
  gate, never two — the token window *is* the interval the seconds are
  computed from, so `--abandon`, a phase-less `start` and a legacy bare date
  each bill neither. Two things about the token number a later reader must
  not re-decide: **cache reads are excluded** (`input + cache_creation +
  output` only — a raw total measured 9:1 cache_read to fresh, i.e. ~90%
  re-read context floor that is near-identical for a trivial item and a hard
  one), and **attribution is whole-session-within-the-window**, not per-item
  (near-exact under `backlog-orchestrate`, where each item gets its own
  headless session; noisy for hand grooming in a shared terminal, by exactly
  as much as the unrelated work in the window). A count that cannot be
  attributed at all writes no key and says why on stderr — `0` would claim
  the work was tiny. `stop` bills
  the whole seconds since `started:` into it, then removes `phase:` and,
  unless the caller passes `--keep-started`, `started:` too. `--keep-started`
  is what `backlog-execute`'s successful archive uses: it bills the session
  exactly as a plain `stop` would, but leaves `started:` in place so the
  archived item still records when the work began. `updated:` is stamped by
  every `start` and every `stop` (both funnel through the one function that
  does it); `move` deliberately does not stamp it — a renameSync that never
  opens the file — but every skill path that moves an item calls `stop`
  immediately beforehand, so a moved item's `updated:` is never more than
  one function call older than its move. A bare `YYYY-MM-DD` `started:` from
  before this timestamp shape existed is cleared on `stop` like any other,
  but never billed — UTC midnight is not the hour anyone began work. Written
  only by `start`/`stop` — now called by both `backlog-execute` (holding the
  marker until archive) and `backlog-groom` (holding it for one groom
  session, ideas included) — which must round-trip unknown keys and the body
  byte-for-byte; "in progress" is decided in the client.
- **`backlog-orchestrate` is the only skill that commits or merges.** It
  commits inside a per-item worktree, on `backlog/<id>` alone, and merges
  that branch into `main` in the main tree, `--no-ff` only, only once the
  main tree is verified to have `main` actually checked out. No other skill
  touches git history at all. `backlog-execute`'s "never commits, never
  pushes" limit is unchanged — the reasoning behind it (staging inside a tree
  it doesn't own could sweep up unrelated work) never applied to a worktree
  built to hold nothing but this one item's diff.
- **Merge mode is run-scoped: chosen per launch, defaulted from Settings, and
  carried spawn → prompt → `init` → run file.** `MergeMode`
  (`shared/types.ts`) is `merge | branch`, with `isMergeMode` as its one guard
  for the reason `isAgentAction` has one. It rides the spawn prompt because
  `localStorage` cannot reach a headless process and the run file has a single
  writer: `orchestrateDefaultMergeMode` seeds `OrchestrateSheet`, the sheet
  sends `mergeMode` on **every** launch (inferring it server-side from an
  absent field would put one decision in two places), and `init` writes three
  fields only `orchestrate.mjs` ever touches — `mergeMode` (what was asked,
  never rewritten), `mergeModeEffective` (what the run is doing, moving
  `merge` → `branch` once and never back), `mergeModeNote` (why they differ).
  Two fields rather than one because the archive has to answer "did this run
  merge, and was that the plan?" months later. **Absent means `merge`;
  present-but-invalid is a 400, never a clamp** — deliberately unlike
  `model`/`effort`, which drop an unknown value: dropping this one resolves to
  `merge`, and merging to `main` is the irreversible direction, so a caller
  bug must not be able to select it. Absent is not a bug, it is every request
  written before the field existed.
- **`merged` is no longer the only success exit.** `branched` is its
  branch-mode sibling in the same terminal position — `StageTrack` stays seven
  nodes and the seventh just carries a different word — and the two are true
  exits alike: out of `RUN_CLAIMED_STAGES` and `ATTENTION_RUN_STAGES` (the run
  has let go, and a clean branch needs nobody), out of `MACHINE_STAGES` (a
  terminal arrival opens no span), counted as completed by `aggregateRuns`, in
  `RECONCILE_TERMINAL_STAGES`. A new stage rather than `merged` relabelled in
  the UI, for the reason `itemDurationMs` and `lastTouched` exist: an archive
  that says an item merged when `main` never received it is worse than a
  mechanical sweep. `test/agents-shared.test.ts`'s `Record<RunStage, true>`
  literal is the mechanism that forces the classification rather than leaving
  it a checklist someone forgets. **A `branched` stamp does not prove the run
  that wrote it executed the item** — `SKILL.md` §3 recognises a branch a
  *previous* run finished and left waiting on a hand-merge (an archive-move
  probe) and stages it `branched` in the current run's own file before
  pre-flight ever runs, without dispatching, reviewing or verifying it again.
- **The tool refuses `stage <id> merged` under branch mode** — exit `1`,
  nothing written. `SKILL.md` is re-read on every one of a run's several
  hundred turns and prose drifts across them; a tool refusal does not, which
  is the same division of labour `buildGatedQueue` and its rationale already
  keep. The converse is deliberately *not* enforced: `stage <id> branched` is
  legal under `merge` mode too, because that is exactly what a denied merge
  degrades an item to.
- **A classifier denial degrades a run to branch mode; every other merge
  failure still parks.** Denied means the work is green and only the last step
  of the pipeline was refused, so the item is staged `branched`, the run
  records the downgrade once (`merge-mode branch --note`), and the queue
  continues — with **no attention entry**, because `ATTENTION_KINDS` stays the
  closed set of three and that list means "a human must look at this item",
  which a reviewed branch does not warrant. One classifier verdict is one
  run-level fact, not N item-level ones. A conflict, a pre-merge refusal over
  overlapping dirty paths, and a main tree not on `main` are genuine human
  decisions and still park, still keep the worktree, still say why. The
  narrowness is the rule: it triggers on the classifier denial and nothing
  else. `SKILL.md` §2's preflight probe (`git merge --no-ff --no-edit HEAD`,
  which changes nothing that matters — no commit, no index change, no reflog
  entry, though it does refresh `.git/ORIG_HEAD` harmlessly) is early warning
  for the same failure, never a guarantee — the verdict is per call.
- **Undoing an already-completed orchestrator merge is `git revert -m 1`,
  never `git reset --hard`.** Proved empirically, not just reasoned out:
  `reset --hard` silently destroyed an unrelated, uncommitted modification in
  the main tree along with the merge it was meant to undo, with no reflog
  entry to recover it; the identical merge undone with
  `revert -m 1 --no-edit` left that modification byte-for-byte intact. An
  unattended run can never prove the user's main tree is clean at the moment
  it needs to undo something, so the noisier `git log` a revert leaves behind
  is the deliberate price of never destroying work nobody backed up.
  `git merge --abort` still handles an in-progress conflicted merge — this
  rule is only about one that already landed.
- **`orchestrate.mjs` is always invoked from the project root, never from
  inside a per-item worktree.** Every command but `init` resolves "which
  project" by walking up from its own cwd to the nearest `.git`, exactly like
  `backlog.mjs`'s identical walk — except that this one **refuses** a linked
  worktree (exit `1`, naming the worktree and the project root to re-run
  from) where `backlog.mjs`'s deliberately resolves one to itself. It used to
  resolve it too, silently keying the run under the worktree's path and
  reporting exit `3`, "no run exists," for a live run; that was bug-2. `init`
  runs the same refusal over its `--project` value, the one command that
  never walks up from cwd. The discriminator is a `commondir` entry in the
  `gitdir:` target, not "`.git` is a file" — a submodule working tree still
  resolves to itself. Worktree-scoped commands take that path as an explicit
  flag instead (`stage --worktree`/`--branch`, `verify --cwd`), never implied
  by cwd, and those flags are exempt from the check.
- **Editing `skills/` changes nothing until it is committed, pushed, and
  `pnpm run plugin:sync` runs.** An install is a copy of the pushed HEAD,
  never the working tree — git is the publishing boundary, and the sync
  refuses dirty/unpushed/behind states. New skills load on the next Claude
  Code restart.
- **`agents/` is part of the plugin's publish surface.** An install carries
  only what `PUBLISHED_PATHS` (`scripts/sync-plugin.mjs`) and the
  marketplace's own `sparsePaths` both list — Claude Code discovers a
  plugin's agents by the same directory convention it uses for skills, so an
  agent left off either list is invisible in an install even though it sits
  right there in the repo. `backlog-manager:backlog-reviewer`
  (`agents/backlog-reviewer.md`) doesn't exist post-install until both name
  `agents`; the repo only ever controls the first. **The machine-local half
  is declared in `~/.claude/settings.json` →
  `extraKnownMarketplaces.<marketplace>.source.sparsePaths`, not in
  `known_marketplaces.json`** — that file is a cache Claude Code
  re-materializes from the declaration on session start, so hand-editing it
  is not merely transient, it is what *triggers* the revert. The sync now
  measures every entry of `PUBLISHED_PATHS` on both sides (bug-10: it hashed
  `skills` alone, so an install with no `agents/` at all reported "in sync"
  and could never be repaired through the supported path) and fails loudly
  after a reinstall that still comes up short, naming that settings key.
- **Both processes bind `127.0.0.1` by default; loopback is the access
  control** (nothing has auth). `BM_BIND` is the single knob; compose sets
  `0.0.0.0` because there the loopback *publish* is the boundary.
- **The served build carries a CSP (`server/src/security.ts`); dev does
  not.** `script-src` pins the pre-paint theme script's sha256 — edit that
  script and `test/csp.test.ts` goes red until `THEME_SCRIPT_SHA256` follows.
- **Container mounts land on host paths, read-only**, because the registry
  stores absolute host paths.
- **pnpm only**, pinned by `packageManager`, enforced via corepack in the
  image.
- **`allowBuilds` in `pnpm-workspace.yaml` lists `esbuild`**; a skipped build
  surfaces as Vite failing to start.
- **Editing `vite.config.ts` needs `docker compose restart client`.**
- **Backlog items move `open/` → `done/`; `out-of-scope/` is flat.**
- **Dispatch derives the action; it never accepts one.** `deriveAction`
  (`shared/agent.ts`) is the single implementation for the board's label and
  the server's validation; dispatch re-scans the file and 409s on
  disagreement. The prompt is the only client field taken outright; unknown
  `model`/`effort` drop rather than reject. The controller rebuilds the
  dispatch body field by field — a new field reaches the service only when
  added there too — and checks `action` with `isAgentAction`, never a
  hand-written comparison chain: that chain is a second copy of the
  vocabulary, and it is the copy that goes stale.
  **`AgentAction` has three members**, and the third is why the two archives no
  longer share a branch: `deriveAction` returns `capture` for an out-of-scope
  item, checked by SECTION and BEFORE the `status !== 'open'` line that would
  otherwise swallow a `terminal` item. A `done/` item still derives `null` —
  history genuinely has no next step, where a rejection does. Capture spawns
  `backlog-capture` for a **new** item citing `from: <id>`; the original stays
  rejected and `moveItem` still refuses every move out of `out-of-scope/`.
  Archive's Out of scope column is the only surface that renders the control.
- **The orchestrate spawn prompt is composed server-side.**
  `ORCHESTRATE_PROMPT` (`agents.service.ts`) is the literal
  `/backlog-orchestrate` — `backlog-orchestrate`'s own `trigger:` — and
  `POST /api/agents/orchestrate`'s body has no `prompt` field to begin with,
  so a caller-supplied one is not rejected, it is simply never read. A caller
  can influence exactly two things in that string. The first is `ids`, the
  board's item
  selection, and only after `resolveIds` proves every entry both *is* an id
  (`isItemId`, `shared/agent.ts` — the same `^[a-z]+-\d+$` `backlog.mjs`
  enforces, so no whitespace, path separator, shell metacharacter or newline
  survives) and *names* an open bug or task in **this** project (a per-request
  scan scoped to `req.project`, deliberately not `findItem`'s registry-wide
  walk). 400 for a malformed list, 409 for one the files disagree with, both
  uncoded. An absent `ids` means the whole queue; an explicitly empty one is
  a 400, never "everything" — `parseIdsArg`'s own distinction in
  `orchestrate.mjs`, enforced at the only layer a browser reaches. The second
  is `mergeMode`, a tighter surface still: the appended text is the
  compile-time literal ` --merge-mode branch` selected by `isMergeMode`, with
  no caller string in it at all, and `merge` appends nothing so a default
  run's prompt stays byte-identical to what shipped before the field existed.
  The "derive, never accept" rule dispatch already follows, applied to a route
  with no item file to derive anything from at all.
- **The browser never talks to the dashboard.** Every call goes board → this
  API → dashboard; `BM_AGENTS_URL` is env-only; `BM_AGENTS` defaults to off.
- **A project the dashboard cannot see cannot be dispatched to.** Never
  derive a `dirName` from a path to route around this. The `dispatchGate`
  membership check is a raw string compare, deliberately not realpath.
- **An environment-level block hides the dispatch control; the per-item ones
  disable it.** With `BM_AGENTS` off the board shows no dispatch buttons — do
  not "improve" that into disabled buttons. There are three per-item blocks and
  all three keep their button: the dashboard cannot see this item's project
  (`dispatchGate`, derived from `AgentsStatus`); a local skill session already
  holds this item (`progressBlock`, `client/src/lib/item-progress.ts` — the
  only one of the three derived from the item file itself, since `started:` is
  written by `backlog.mjs start` and cleared by `stop`, and it blocks on ANY
  stamp, fresh or stale, matching `start`'s own rule); and an orchestrator run
  has already claimed this item (`runClaimBlock`, `shared/agent.ts` — read from
  the run payload, since neither the item file nor the status payload can know
  it). `DispatchButton` reads them in that order, environment first, so the
  reason it shows names the thing to fix rather than a symptom of it — and the
  file-derived block outranks the run claim because the stamp is on the copy
  the board is rendering while the claim is a fact about another worktree.
  **Exactly one of the three lets the click through: a project-visibility block
  re-asks the status** (`reverify`, the board's own `useAgents().reload`, which
  now resolves to the status it fetched) and opens the sheet if the fresh answer
  reads `enabled` — it is the only block that can be silently stale, since
  `useAgents` refetches on mount and window focus alone and a window that never
  loses focus is never asked again, while the sheet whose `plan()` would correct
  it sits behind the control the stale answer disabled (bug-13). The other two
  keep swallowing the click, and so does a visibility block accompanied by
  either — clearing one half of a doubly-blocked button changes nothing. The
  reason string states the missing path as fact and the lookback only as a
  likelihood for the same reason: no reader of it is closer to the dashboard
  than a cached list.
  `progressBlock` lives beside `isInProgress`/`progressLabel` rather than with
  the other two in `shared/`: it is built from both of them, `shared/` must not
  import from `client/`, and the block is client-only — the server's dispatch
  re-scan is unchanged, since the board is the only surface that can
  double-dispatch (bug-12).
- **One run per project, checked twice.** `orchestrate.mjs init` refuses
  outright on any `status: "running"` run file, fresh or stale — a stale one
  means a crashed run, recoverable only via `--resume`/`--abort`, never
  silently overwritten. `POST /api/agents/orchestrate` re-checks before it
  spawns anything, on the one path that reaches a run without going through
  `init` at all, but only against a *fresh* run (`RUN_STALE_MS`); it answers
  409 with a machine-readable `code: RUN_IN_PROGRESS_CODE` on that lock case
  alone — every other 409 this endpoint can throw carries no code, because
  nothing about them needs to be told apart.
- **The watchdog spawns; it never writes the run file.** `runs()` stays the
  one reader; `WatchdogService` only ever calls `AgentsService.resume()` —
  the same spawn path a board click uses — so a resumed session's own
  heartbeat is what re-stamps `run.json`, never the watchdog itself.
  Attempts, phase and the event log live in `WatchdogStateService`, in
  memory, lost on restart on purpose: a second writer beside
  `orchestrate.mjs` in the run-state directory is the one thing this
  feature must never become. `settings/watchdog.json`
  (`watchdog-config.util.ts`) is the one exception — the server's
  first-ever write, its own single writer, under its own nested read-write
  mount inside the otherwise read-only `~/.backlog-manager`.
- **A crashed run renders as crashed, never as nothing.** Supersedes the
  strip's old doctrine that a stale run must render nothing because its
  stage can't be trusted — right about the stage, wrong that the whole
  strip had to go silent; a run sat crashed for four hours behind exactly
  that silence. The strip states only facts the payload carries: heartbeat
  age, the *last reported* stage (never claimed current), and the
  watchdog's own verdict (`lib/run-watchdog.ts`'s `watchdogClause`). Badges,
  card run bars and `runClaimBlock` stay freshness-based — a crashed run
  does not stop being a live claim on its item just because the board now
  says so out loud.
- **The watchdog is armed only while some `run.json` says `running`.** No
  standing interval — a `setTimeout` chain exists only while at least one
  run is `running`, fresh or crashed alike, and disarms itself the tick it
  finds none. Arms on the reads the board already makes (every
  `GET /api/orchestrator/runs` whose payload holds a `running` run), on a
  boot-time scan, and on a successful `orchestrate`/`resume` spawn — the
  last two wired at controller level (`AgentsController`, not
  `AgentsService`: `WatchdogService` already injects `AgentsService` for
  `resume()`, so the reverse edge would be a cycle). A run started by
  typing the trigger with the board never opened for its whole life is
  never watched; CLAUDE.md already says to start runs from the board, and
  this is one more reason.
- **`useOrchestratorRuns` polls while any run is `running`, fresh or not.**
  Widened from "any run is fresh" — a crashed run's attempt counter, error
  text and the moment it goes fresh again would otherwise wait for a
  window focus, and the crashed strip would read as a screenshot instead
  of something live.
- **Any spawn attempt starts the grace clock; only a success counts against
  the cap.** A failed attempt still stamps `lastSpawnAt`, so a dashboard
  that is down is asked once per grace window, not once per tick — a retry
  storm dressed as monitoring. Only a spawn that returned a session id
  increments `attempts`, so the same downed dashboard cannot burn a
  crashed run's whole cap without a single resume ever having actually
  started. `exhausted` is decided before grace, not after, so a run on its
  last attempt reads exhausted on the very next tick rather than making a
  person wait out a grace window to be told nobody is coming.
- **Every agents POST is guarded by content-type and origin**
  (`server/src/agents/origin.guard.ts`) — the one place loopback is NOT the
  access control. Named "the two" when only `dispatch` and `orchestrate`
  spawned anything; `resume` (the watchdog's manual counterpart) made
  three, `watchdog/config` makes four — the guard itself never changed,
  only the count of routes it has to cover. Absent `Origin` stays allowed;
  the guard compares host and port, not scheme.
- **The launch sheet's model/effort pickers seed from Settings, never the
  last launch** (`dispatchDefaultModel` / `dispatchDefaultEffort` in
  `client/src/lib/settings.ts`, clamped against `MODELS`/`EFFORTS`).
  Permission mode has no stored default — it comes from `plan.defaultMode`,
  clamped to the host ceiling.
- **`linkBase` becomes an href**, so `clampSettings` routes it through
  `clampOrigin` — URL-parsed, `http(s)` only. The one settings key a
  hand-edited localStorage value could turn into script execution.
- **"Queue wait is not work."** `itemDurationMs`
  (`client/src/lib/run-time.ts`) is the one implementation of "how long did
  this item take", read by the drawer's and the pane's `RowTime`, by
  `aggregateRuns`' `avgItemWorkMs`, and by nothing else; machine time
  (`runStageTotals`) excludes `pending` too. `run-stats.ts` used to carry a
  second rule that spanned first stamp to last: real run
  `run-20260901-112815` read bug-7 as 161m in the pane and 25m in the
  drawer — the difference was the four items ahead of it in the queue.
  `MACHINE_STAGES` is the closed list of what counts.

## Conventions

- Comments explain *why*, at length, and the existing density is deliberate —
  match it rather than stripping it.
- Tests are flat in `test/`, `*.test.ts` / `*.test.tsx`; component suites opt
  into jsdom with a `@jest-environment jsdom` docblock. Skill tests live next
  to the tool they cover (`skills/*/tools/*.test.mjs`) and run under node's
  own test runner, not jest.
