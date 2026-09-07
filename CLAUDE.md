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

- `server/src/` — Nest: `health/`, `items/` (`/api/items`, `/api/projects`,
  `/api/items/body`, `/api/items/uncommitted` — which of one project's item
  files differ from `main`, `uncommitted.util.ts`, read per request and never
  memoised, see Invariants), `agents/` (the one outbound-calling module — status,
  plan, dispatch, orchestrate, resume, pause, and the run watchdog
  (`watchdog.service.ts`, armed only while some `run.json` says running),
  plus the local read-only `merge-check`), `orchestrator/`
  (`GET /api/orchestrator/runs` for the live board strip, plus
  `GET /api/orchestrator/archive` and `GET /api/orchestrator/archive/run`
  for run history — all three a read-only view of the run-state directory,
  current run and archived `runs/` alike — see Invariants; plus
  `watchdog-state.service.ts`, the in-memory record of what the watchdog
  did, annotated onto `/api/orchestrator/runs` as `watchdog` on crashed runs
  only, `starting-runs.service.ts`, the in-memory record of a spawn this
  server itself requested, surfaced as the payload's separate `starting`
  array so a board-started run is visible before `init` writes a run file —
  see Invariants — `watchdog-config.util.ts`, the first file the server
  writes, and `pause-control.util.ts`, the second: the pause request
  `orchestrate.mjs` reads back at its two dispatch gates, the one file in
  this system travelling server → tool, see Invariants),
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
  a toolbar Orchestrate control opening `OrchestrateSheet` — three steps
  (items / order / modes), with Start on the last one alone so it never sits
  under a scroll region whose length is the project's queue. Step 1 previews
  the queue and selects a subset of it, flagging with an `uncommitted` chip
  every row a run would not find at `main`, stating the count in the run's own
  words (`not committed on main`) and offering `deselect uncommitted (N)` —
  fed once per sheet open by `GET /api/items/uncommitted`, rendering nothing
  at all on `known: false` or a failed/malformed answer, and deliberately
  changing no default: an untouched sheet still posts no `ids` (task-32, see
  Invariants); step 2 hand-orders that selection
  with ↑/↓ and a reset (`order: string[] | null`, `null` meaning queue order,
  reconciled against the live queue every render, never stored resolved);
  step 3 holds all five pickers — permission mode, model, effort, merge mode,
  question mode, the last two seeded from Settings — plus, in merge mode, a
  setup hint fed by `GET /api/agents/merge-check`. `ids` rides along for
  `narrowed || order !== null`: a strict subset **or** a hand order, since
  choosing an order is choosing a membership, so an untouched sheet still
  starts a whole-queue run and an arranged one is pinned to exactly what it
  arranged (step 2 says so on screen, next to a note that a `runner-fix:`
  item may still hoist above the chosen order and that this screen cannot
  tell which). No server, tool or wire change: `--ids` is already run in the
  order given by both `resolveIds` and `buildGatedQueue`. And a run strip
  above the columns — `RunStrip`/`RunDrawer` — showing every project's
  orchestrator runs; a crashed run — `running`, heartbeat stale — renders
  as crashed with the watchdog's verdict and, when the watchdog is
  exhausted or off, a Resume control, a `paused` run renders a third strip
  with its own Resume (no watchdog clause — see Invariants), and a fresh run
  that has been asked to pause gains a `pausing · finishes <id>` chip; the
  drawer's head hosts `components/RunControls.tsx`, the one
  Pause / Cancel / Resume component both this surface and the Runs view's
  detail pane use — top-level, like `lib/view-keys.ts`, because the two
  hosts are separate lazy chunks), Runs (`RunsView` — aggregate stat tiles including a
  wide "machine time by stage" tile, a Today / This week / This month / All
  range control (calendar-aligned, local-time windows on a run's
  `startedAt`, `lib/run-range.ts`) that scopes the tiles, the list and the
  wide tile together, a project filter, a day-grouped run list with fresh
  live runs pinned above history (a live row whose run has been asked to
  pause carries a `pausing` badge, and the detail pane's head hosts the same
  `RunControls` the board's drawer does), a `starting` placeholder group
  above that pinned region (task-21 — `StartingRow`, project + `starting` +
  `elapsedSince`, a `<div>` and not a row button, read straight off the
  payload with no client-side collision filter for the reason the Board has
  none; it is outside `orderedRows`, the selection, both aggregates and the
  project select's options, the project filter applies to it and the range
  control deliberately does not — `inRange` keys on `startedAt` and a
  placeholder has only `requestedAt` — and it suppresses both empty states,
  which is what makes a project's first run visible before `run.json`
  exists), and a persistent detail pane carrying
  that same per-run "machine time by stage" rollup plus a full-width
  seven-node `StageTrack` per item with durations printed under each node.
  Cost rides both surfaces (task-27): the run total joins the row's foot line
  beside its wall time, the pane's head adds cost · turns · sessions, and each
  item gets its own line under its track — all of it from
  `runUsageTotals`/`itemUsageTotals`, and all of it absent rather than zeroed
  for a run that predates the recording (see Invariants).
  The whole section is bounded to one viewport on the wide layout
  (`.runs-board`, a definite `100vh / var(--font-scale)` height so the bar,
  the tiles and the two controls stay put) with the list and the pane each
  scrolling their own overflow inside it, sticky day headings, and history
  windowed to `RUNS_PAGE_SIZE` rows behind a counted `load more` at the foot
  of the list — a render decision over a corpus the client already holds
  whole, exactly as `staleDays` is: the endpoint and the hook are untouched.
  The window is sliced between `splitPinned` and `groupByDay` and nowhere
  else, so the pinned live region is never paged and a boundary falling
  mid-day extends one group rather than opening a second; selection, the
  tiles and the wide tile all read the unwindowed lists, so a window moves no
  number and a range/project change resets it without blanking a pane whose
  run is still in range. Below 700px none of the bounding applies. Fed by
  `lib/run-range.ts` and `lib/run-stats.ts`, both pure statistics
  libs, and `hooks/useOrchestratorArchive.ts`, which fetches on mount and
  window focus only — no polling interval, since history moves at run
  boundaries, not on a live heartbeat. The whole section sits behind a
  `Runs | Watchdog` mode switch (`lib/runs-mode.ts`, persisted under
  `backlog-manager.runs-mode`, unknown value → Runs; it renders
  unconditionally, last in the bar — after the range control, the project
  select and a hairline divider, so its right edge stays put when those two
  unmount in watchdog mode — because the sweeper has a phase to report
  whether or not any run has ever finished, while range and project filter
  render in runs mode alone). Watchdog mode replaces the whole body with
  `WatchdogMonitor` — three tiles (the sweeper's phase with `stateLine` and a
  depleting sweep meter, the watched count, the read-only policy), one card
  per `running` run in the live payload with a heartbeat freshness meter
  against `RUN_STALE_MS` (`freshnessFraction`, `lib/run-time.ts`) and, on a
  crashed card, attempt pips, the strip's own `watchdogClause` verbatim and
  the grace remaining (`sweepFraction`/`graceRemainingMs`,
  `lib/run-watchdog.ts`, beside the
  `WATCHDOG_KIND_GLYPH`/`WATCHDOG_KIND_TONE` records the activity badges
  read) — cards from the runs payload, `watching` only annotates, because two
  projects can share a `runId`; the skew shows in both directions, `· not yet
  watched` and a placeholder row — and the activity feed as a kind-badged
  table that takes the section's remaining viewport height. It owns the one live
  `useWatchdog()` and takes `RunsView`'s own live runs as a prop, so
  switching modes adds no request; a row click switches back to Runs on that
  run's detail), archive (`ArchiveView.tsx`: four columns —
  refactors/ideas/bugs/out-of-scope — grouped under sticky month subheaders
  keyed on `updated ?? created` (`lib/item-month.ts`), project filter and
  search only, no status or sort control; the same cards, drawer and launch
  sheet the board uses, no run strip), and Settings, whose `Orchestrator ·
  this device` group is the two run-scoped defaults the Orchestrate sheet
  seeds from (`Default merge mode`, which moved out of the Claude Agents group
  in task-19, and `Default question mode`), and whose Orchestrator
  watchdog group (`WatchdogGroup.tsx`) is the four server-side knobs and a
  `Live view` pointer — nothing else. It calls
  `hooks/useWatchdog.ts`'s `useWatchdog({ live: false })`, so it installs no
  interval and shows nothing that moves on a clock; the live half is
  Runs › Watchdog. Board and Archive share one
  persisted project filter, declared in `lib/view-keys.ts` rather than exported
  from either — they are separate lazy chunks, and an import between them would
  undo the split. Fed by `lib/agents.ts` (same-origin
  fetches), `hooks/useAgents.ts` (status poll on mount and window focus, plus
  the one re-ask a click against a project-visibility block provokes — see
  Invariants),
  and `hooks/useOrchestratorRuns.ts` (same cadence, plus a 5s poll while any
  run is fresh or still `running`, or any `starting` entry is present — a
  crashed run and an unstarted one both keep the strip polling — plus
  `noteResume`/`resuming`, which keep it polling a `paused` run for
  `RESUME_POLL_GRACE_MS` after a Resume click, since a paused run is neither
  fresh nor running and nothing else would ask again).
  `stateLine` lives in `lib/run-watchdog.ts` beside `isCrashed`/`watchdogClause`
  — the three sentences the client can print about the watchdog, in one
  module, read by both `RunStrip` and `WatchdogMonitor`; `lastReportedEntry`
  ("what is this run actually working on") lives in `lib/run-time.ts`, read
  by those same two.
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
- **A run's sidecars are archived beside its run file, under a name derived
  from the archive path and stored nowhere.** `init` moves the superseded
  run's `run.json` to `runs/<stem>.json` and everything else under `<dir>`
  into `runs/<stem>/` — one stem, one `archiveStem`, two sibling artefacts,
  which is what lets a reader find a run's evidence with no `sidecarDir`
  field recording it (the same posture as "Groomed is derived"). Before this,
  `<dir>/logs|reviews|verify|questions` were flat and keyed by ITEM id, so an
  item dispatched in two runs kept only the second's transcript, reviewer
  report and verify output; bug-2 here ran three times and task-9 in
  claude-agents-dashboard twice, and only the last of each survives. What
  moves is a **denylist of two** — `run.json` and `runs/` — never an
  allowlist of the names known today: those directories are created by
  DRIVERS following SKILL.md prose (`mkdir -p "<dir>/logs"`), so the set is
  open by construction, `prompts/` already exists on one project because a
  driver invented it, and bug-31 will document `prompts/<id>-fix-<n>.txt`
  outright — an allowlist minted today would silently drop it, which is the
  exact loss this closes. **Sidecars move first, `run.json` renames last**,
  and that order is the design: a crash between them leaves the sidecars in
  `runs/<stem>/` with `run.json` still flat and still `done`, so the next
  `init` resolves the SAME stem (`archiveStem` checks `<stem>.json` alone,
  deliberately not "either name is free"), merges what remains into the
  directory already there and completes the rename — self-repairing, where
  renaming the run file first and crashing would leave `existing === null`
  and let the next run overwrite the very evidence it was preserving. A name
  already present in the destination is skipped with a warning, never
  overwritten. The whole move is **best-effort and never fails an `init`**:
  the contract is that a bad call writes nothing and a good one ends with a
  valid `run.json`, and trading a real run for a filing error is the wrong
  way round. Moving a live child's `logs/<id>.pid` is safe for exactly one
  reason — `init` refuses any `status: "running"` run with exit `4`, fresh or
  stale, and `init` is the only command that archives anything, so by the
  time a sweep can run there is no live child and no resume still owed those
  paths. **Orphaned sidecars are a deliberate non-goal**: archiving happens
  inside `if (existing)`, so with no run file there is no run to name and
  those files can still be overwritten — inventing `runs/orphan-<newRunId>/`
  would file evidence under a run id that never produced it. On the server
  side this makes `runs/` a mixed listing for the first time, and
  `archivedRunFiles` (`orchestrator.service.ts`) is the ONE implementation of
  "which entries are run files", read by both `countPastRuns` and
  `archive()` — two expressions that merely agree are two chances to
  disagree, and here they would disagree as a doubled `pastRuns` count and an
  EISDIR warning per archived run per request. `archivedRun()` needs no
  filter: it probes the exact path `runs/<runId>.json`, which a sibling
  directory cannot answer to. Long form:
  [docs/invariants.md](docs/invariants.md).
- **A board-started run is visible before its run file exists, from server
  memory that is never written to disk.** `GET /api/orchestrator/runs` can
  only see `run.json`, and `orchestrate.mjs init` writes it in SKILL.md §2 —
  after the dashboard spawn, the session boot, a 1360-line SKILL.md read and
  the §1 `plan` turn, i.e. 1–5 minutes in which the board showed nothing and
  a click that silently failed looked identical to one that worked.
  `StartingRunsService` closes that FEEDBACK gap only; boot latency is
  unchanged and nothing here makes a run start sooner. It is a
  `Map<project, requestedAt>` in the API process, lost on restart on purpose,
  and adds **no** writer to the run file — the alternative of having the
  server call `init` itself was rejected because the spawned session would
  then hit `init` exit `4` (lock held), whose documented answer is "never
  retry, go to `--resume`". It rides the payload as a **separate top-level
  `starting` array**, never a `status: 'starting'` member of `runs`: that
  array is documented as a verbatim read of a file `orchestrate.mjs` wrote
  and is iterated by `aggregateRuns`, `ArchiveView` and `RunsView`, so a
  synthetic member would reach all of them and every exhaustiveness site,
  where a separate field reaches only what opts in. An entry dies on any of
  **three** rules: a run in the same payload matches the project AND its
  `startedAt` parses to at or after `requestedAt` — **`startedAt`, not "a
  run.json exists"**, since `cmdInit` archives the old file and writes a new
  one, so a project that has ever run always has one; or the entry is older
  than `RUN_STALE_MS`, the app's one freshness number, reused rather than
  joined by a second; or **a run for that project already reads `status:
  'running'`, fresh or crashed** (bug-21) — keyed on that status exactly,
  never on `!fresh` and never on "a run file exists", because `cmdInit`
  archives a `done`, `aborted`, `failed` or `paused` file before writing the
  next one, so a project holding any of those can legitimately start a new
  run and must keep its placeholder. Rule 3 used to be a render-time filter
  in `BoardView` guarding one thing (two strips for one project); it is
  server-side because the four gates below all need it and the server's own
  lock can read it from nowhere else. It is `mark`ed from
  `AgentsController` **after** the awaited spawn, beside `arm()` and for the
  same layering reason, so a failed spawn leaves no ghost; `runs()` calls the
  pure `list()` and `OrchestratorController.runs()` calls the mutating
  `sweep()`, the same pure/mutating seam `annotate()`/`observe()` already
  keep, both deferring to one shared predicate. Correctness never depends on
  the sweep — `list` re-applies all three rules every call, so an unswept map
  leaks at most one entry per project and never lies, which is what makes
  `AgentsService`'s own direct `runs()` calls safe without one. The board
  maps `StartingStrip` straight over `starting`, with **no client-side
  filter**: rule 3 is what rules out the collision that filter existed for —
  a placeholder drawn beside a `running` run file's own strip — and keeping a
  second expression beside it that merely agreed is the shape
  `watchdogStoodDown` and `isStale` are each one function to avoid. It is
  deliberately not a guarantee of one row per project in every case: the
  strip's list is `running || paused` while rule 3 is keyed on `running`
  alone, so a stale `paused` run plus a live starting entry renders two rows,
  which is reachable and correct — they are two different runs, and widening
  rule 3 to `paused` to suppress the second would strip the placeholder from
  a project that can legitimately start a run. `POST
  /api/agents/resume` is deliberately not marked: the run it resumes already
  reads `running`, so the board is already drawing a crashed strip for it and
  the screen was never blank.
- **A starting entry blocks what a run file blocks, on every surface**
  (bug-21). For the 1–5 minutes before `init` writes `run.json` the entry is
  the only evidence a run exists, and every gate read `payload.runs` alone —
  so a person could hand-dispatch an item the pending run was about to claim
  in its own worktree (the double execution bug-4 and bug-12 each closed),
  and a second Orchestrate press returned 200 and spawned a second session
  that died at `init` exit `4`. `runClaimBlock` (`shared/agent.ts`) takes
  `starting` as a **required third parameter, no `[]` default** — the same
  rule `isStale`/`leavesBoard` follow for `runs`, because the compile error
  at each of its four call sites (`BoardView`, `ArchiveView`, `plan`'s
  `blocked`, dispatch's 409) is the mechanism that makes the next caller
  decide instead of silently reinheriting this. The block it produces is
  **project-wide and deliberately coarse**: a `StartingRun` is `{ project,
  requestedAt }`, and even carrying the launch's `ids` would not help, since
  what a run actually queues is `buildGatedQueue`'s verdict inside the
  spawned session minutes later. A wrong allow costs a duplicated execution;
  a wrong block costs a wait bounded by the run file landing. Per-item
  wording wins over the coarse one where both could apply. The toolbar
  Orchestrate control **hides** on a starting entry rather than disabling —
  that is what preserves bug-16's `showOrchestrate` reasoning, in which a
  *rendered* toolbar button is blocked on project visibility alone. And
  `POST /api/agents/orchestrate` refuses a starting project with the **same**
  `RUN_IN_PROGRESS_CODE`, beside the `activeRun` throw and therefore still
  before `resolveIds`: it is the same lock one window earlier, and
  `OrchestrateSheet` already branches on that code to close and hand the
  screen to the `StartingStrip` — which is exactly right here.
  `runHoldsItem` deliberately does NOT gain the parameter: its caller asks
  "is a run holding THIS item", which a placeholder naming no items cannot
  answer, and the window is ≤15 minutes against a 30-day staleness
  threshold. Pinned by a test rather than left as prose.
- **Escape has one owner, and the topmost dialog is the only one that closes.**
  `hooks/useDialogEscape.ts` is a module-level LIFO stack plus a single `window`
  listener, installed on the first entry and removed with the last; all four
  dialogs (`ItemDrawer`, `LaunchSheet`, `RunDrawer`, `OrchestrateSheet`) call it
  and none binds its own listener. They used to bind four, unguarded, and two of
  them are mounted together by design — Board and Archive both keep the item
  drawer open behind the launch sheet — so one press ran both callbacks and took
  the drawer with the sheet (bug-23). Ranking is by **mount order**, a contract
  and not an accident: the entry's position is fixed for the dialog's mounted
  lifetime (registration effect keyed on `[]`, `onClose` read through a ref
  rewritten every render), because every call site passes an inline arrow and an
  effect keyed on `[onClose]` would re-push the drawer above the sheet on the
  next runs poll. Entries are removed by identity, never popped — a dialog can
  unmount from under one that is still open. Module state rather than a context,
  the shape `lib/view-keys.ts` already uses: Board and Archive are separate lazy
  chunks and four suites mount these components standalone. Knowingly out of
  scope: nothing traps focus, so a drawer opened *after* the sheet ranks above a
  sheet still painted over it — ranking by paint order would mean a z-index
  registry.
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

- **The Orchestrate sheet's `uncommitted` flag is read from git per request,
  memoised nowhere, and must never join the memo one file over.** A run gates
  every item at `main` (`BASE_REF_DEFAULT`, `orchestrate.mjs`; the board never
  passes `--base`, so that is the ref for every board-started run there will
  ever be) while the board's own scan reads the working tree, and the two
  disagree exactly when someone groomed an item and did not commit it — five
  items were skipped that way across three projects in the 2026-09-06 sweep,
  each after the person had walked away. `uncommittedItemPaths`
  (`server/src/items/uncommitted.util.ts`) is the one implementation, behind
  `GET /api/items/uncommitted`. Four things a later reader must not re-decide.
  **No memo, and specifically not `lastCommitDates`' one**: that memo is keyed
  on the mtimes of `index` and `logs/HEAD`, and an edit in the working tree —
  the exact event this reports — moves NEITHER, so the same key would answer
  "clean" forever after its first hit and reintroduce the false negative the
  feature removes. The neighbouring optimisation being visible, adjacent and
  apparently identical is why this is written down. **The question is
  "differs from `main`", never "differs from `HEAD`"**: `git status
  --porcelain` reads a tree clean whenever the item is committed on a branch
  `main` does not contain, which is one of the very cases that gets skipped.
  **Two git reads, not one** — `diff --name-only main -- backlog` for tracked
  files plus `ls-files --others --exclude-standard -- backlog` for never-tracked
  ones, because `diff` cannot see an untracked file and a brand-new item file
  is untracked; pinned by a case that also asserts the diff-only answer is
  empty. **A sibling endpoint, not a `BacklogItem` field**, for
  `merge-check`'s reason: a field would put an un-memoisable git read inside
  `scanProject`, which runs for every registered project on both `/api/items`
  and `/api/projects`. Both preconditions mirror `blobReaderAt`'s own — not
  the repo toplevel, or no `main` — and answer `known: false`, because at that
  seam the tool has no blob view either and gates the working copy, so there
  is no divergence to warn about. `known` gates the render: an absent answer
  must never read as "nothing is uncommitted", which is also why
  `fetchUncommitted` shape-guards and throws rather than letting a malformed
  200 through. **Nothing derived reads it** — `isStale`, `leavesBoard`,
  `lastTouched`, `deriveGroomed`, `runClaimBlock` are untouched, no Board card
  renders it, and it reaches no setting and no run file. **And it changes no
  default**: flagged rows stay selected and an untouched sheet still posts no
  `ids`, since `selected === null` is the difference between "drain the queue"
  and "run exactly these ids" — auto-excluding them would freeze the queue
  snapshot and have the board overrule the orchestrator's own gate on the
  strength of a preview that says outright it is not authoritative. The
  person gets a chip, the run's own words and a `deselect uncommitted (N)`
  button instead. Long form:
  [docs/invariants.md](docs/invariants.md).

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
- **Question mode is run-scoped, and it only ever takes effect in a headless
  run.** `QuestionMode` (`shared/types.ts`) is `decide | park`, with
  `isQuestionMode` as its one guard for the reason `isMergeMode` has one, and
  it travels the exact route `mergeMode` does: Settings seed
  (`orchestrateDefaultQuestionMode`, default `park`) → sheet → the spawn
  prompt's compile-time ` --question-mode decide` → `init` → one `run.json`
  field. **`park` is the default and appends nothing**, so a default run's
  prompt stays byte-identical to what shipped before the field existed —
  inverted from merge mode's silent `merge` and following the same rule, that
  whichever value is the default appends nothing. **Absent means `park`;
  present-but-invalid is a 400, never a clamp**, for `mergeMode`'s reason
  restated in this field's terms: the value is written verbatim into
  `run.json` and read out of the archive months later, so a typo resolving to
  the default would put a claim there that no caller made. **One field, not
  three** — nothing degrades or promotes a question mode mid-run the way a
  denied merge moves `merge` → `branch`, so a `questionModeEffective` would
  record a divergence that cannot occur. The two modes are **identical
  whenever `AskUserQuestion` is reachable**: the ask itself (SKILL.md §3,
  once, best-effort) is unchanged in both, and the mode governs only the
  unanswered branch — which gives the feature its one doctrine, repeated in
  the Settings hint, the sheet's hint, SKILL.md §3 and here: want control over
  a question, start the run from a harness that has `AskUserQuestion`; start
  it from the board and you are choosing between skipping the item and letting
  the runner answer. What a `decide` run settled is recorded by
  `orchestrate.mjs assume <id> --json <file>`, the one writer of
  `RunQueueItem.assumptions`, appending rather than replacing, and **the tool
  refuses it under `park`** — exit `1`, run file byte-identical — the same
  division of labour `stage <id> merged` under branch mode keeps, because
  SKILL.md is re-read on every one of a run's several hundred turns and prose
  drifts where a tool refusal does not. The converse is deliberately not
  enforced: `attention --kind needs-answers` stays legal under `decide`,
  because `decide` is permission to answer and not an obligation to invent.
  **No fourth `ATTENTION_KIND`** — that list stays the closed set of three and
  means "a human must look at this item", which a decided-and-merged item does
  not warrant; the same precedent a classifier denial already set, one entry
  below.
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
- **A `runner-fix:` item is hoisted to the front of the queue, and the marker
  is read at `<base>`.** It means "executing this item repairs machinery this
  run depends on" — a human's judgement, written during grooming, never a path
  heuristic. Presence hoists; only `false` (case-insensitively) opts out, so
  `runner-fix: yes` cannot silently do nothing. `parseItemForGate` reads it, so
  it comes off the same bytes the gate verdict did: a marker only in the
  working copy does not reorder a run whose worktree from `<base>` would not
  contain it, and an item absent from `<base>` never hoists even though its
  *title* still prints off disk. The partition is stable, outranks
  bugs-then-tasks rather than sorting inside it, and runs before `--max` is
  counted. **`--ids` is hoisted too, and that survived the list becoming a
  hand order.** The board sends `ids` for a strict subset **or** any hand
  order (`OrchestrateSheet` step 2, task-20), and exempting it would defeat
  the hoist on the one surface runs are started from. Until task-20 that list
  was only ever a selection and the rule could rest on "nobody chose this
  order"; it no longer can, and it does not need to — the hoist is for an
  item whose execution repairs machinery the rest of the run depends on,
  which is true whoever arranged the queue and however. What a person who
  just arranged one is owed is a warning, not a veto, and step 2 carries it:
  a `runner-fix:` item may still jump the line, and that screen deliberately
  cannot say which one (`BacklogItem` has no `runnerFix`, and the marker's
  authority is the blob at `<base>`, so a derived badge would be confidently
  wrong for an item marked but not yet committed). Still no server, tool or
  wire change on either side of this. Ordering alone
  buys nothing, because a run resolves everything through
  `$CLAUDE_PLUGIN_ROOT` while the merge lands in `main`: SKILL.md §9 tells a
  run that just merged a runner fix to follow the repo's copy of SKILL.md
  **and** `orchestrate.mjs` for the remainder — both or neither, since new
  prose may name a flag the old tool refuses — and to record it as a `stage`
  note, which is what `references/recovery.md` re-derives the switch from
  after a resume (session state; nothing on disk carries it). Inert for the
  *next* run until push + `pnpm run plugin:sync`.
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
  `0.0.0.0` because there the loopback *publish* is the boundary. **Both
  halves are pinned**, and asymmetrically for a reason: the dev server's bind
  is an ordinary import (`test/vite-proxy.test.ts`), while the API
  entrypoint's is read out of `server/src/main.ts`'s SOURCE
  (`test/server-bind.test.ts`) because `main.ts` calls `bootstrap()` at top
  level with no `require.main` guard, so importing it opens a real socket. The
  source test resolves the `.listen(...)` arguments through the consts they
  name and evaluates them against a fabricated `process.env`, so it asserts
  what the expression computes rather than that a `127.0.0.1` string appears
  somewhere — and a bare `app.listen(PORT)`, the refactor that silently binds
  the wildcard, fails it on the argument count.
- **The served build carries a CSP (`server/src/security.ts`); dev does
  not.** `script-src` pins the pre-paint theme script's sha256 — edit that
  script and `test/csp.test.ts` goes red until `THEME_SCRIPT_SHA256` follows.
- **Container mounts land on host paths, read-only**, because the registry
  stores absolute host paths.
- **pnpm only**, pinned by `packageManager`, enforced via corepack in the
  image.
- **`pnpm test` is the union of BOTH runners** — `scripts/test-all.mjs` runs
  `test:jest` and then `test:skills`, always both, and exits `1` if either
  failed. Do not "simplify" `test` back to bare jest: jest's `testMatch` is
  `test/**/*.test.ts(x)` and can never reach `skills/*/tools/*.test.mjs`, so
  for a long time the one word everything reaches for — a human, an
  orchestrated item's verification step (`resolveVerifyCommands` resolves to
  `['test','typecheck','build']` off `package.json`), any future CI — proved
  nothing at all about `orchestrate.mjs` (the run file's only writer) or
  `backlog.mjs` (the registry's only writer), 4,711 LOC of single-writer
  tooling that could regress past every automated gate this repo has and merge
  to `main`. `backlog/verify.json` was the rejected alternative: it closes the
  orchestrated-merge half and leaves a human's `pnpm test` false-green, and the
  human half is what the 2026-09-06 audit found. The price, measured on a
  clean tree 2026-09-07: ~143s instead of jest's ~60s, so roughly +83s on
  every orchestrated item's verification step, paid knowingly. (Grooming
  predicted ~210s against a 136s jest baseline, i.e. +54%; both absolute
  figures were taken on a loaded machine and came down, while the ratio went
  the other way — +138%, because a free machine speeds jest up far more than
  it speeds the node runner up. The absolute number is what a run actually
  pays.) The two named scripts stay the single copy of what each runner runs
  — `test-all.mjs` delegates to them
  and never re-spells `test:skills`'s glob pair, whose `scripts/*.test.mjs`
  half is the one most easily lost. Neither runner short-circuits the other,
  because a run with both broken has to report both. The script has no test of
  its own on purpose: `scripts/test-all.test.mjs` would match `test:skills`'s
  own glob and spawn the whole suite from inside the suite.
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
  so a caller-supplied one is not rejected, it is simply never read. What a
  caller can influence is enumerated by the prompt composition in
  `orchestrate()` and nowhere else — deliberately not by a count in this
  sentence, which is the shape of line that already went stale once here. The
  first influence is `ids`, the board's item
  selection, and only after `resolveIds` proves every entry both *is* an id
  (`isItemId`, `shared/agent.ts` — the same `^[a-z]+-\d+$` `backlog.mjs`
  enforces, so no whitespace, path separator, shell metacharacter or newline
  survives) and *names* an open bug or task in **this** project (a per-request
  scan scoped to `req.project`, deliberately not `findItem`'s registry-wide
  walk). 400 for a malformed list, 409 for one the files disagree with, both
  uncoded. An absent `ids` means the whole queue; an explicitly empty one is
  a 400, never "everything" — `parseIdsArg`'s own distinction in
  `orchestrate.mjs`, enforced at the only layer a browser reaches. The others
  are `mergeMode` and `questionMode`, tighter surfaces still and identical in
  shape: each appends a compile-time literal selected by a guard
  (` --merge-mode branch` by `isMergeMode`, ` --question-mode decide` by
  `isQuestionMode`), with no caller string in it at all, and each one's
  DEFAULT appends nothing — `merge` there, `park` here — so a default run's
  prompt stays byte-identical to what shipped before either field existed.
  Order is ids, then `--merge-mode`, then `--question-mode`: ids first because
  the tool reads bare tokens as ids and a flag ahead of them would swallow the
  first one, and `--question-mode` last so every prompt this endpoint composed
  before it existed stays a byte-exact prefix of what it composes now. The
  "derive, never accept" rule dispatch already follows, applied to a route
  with no item file to derive anything from at all.
- **The browser never talks to the dashboard.** Every call goes board → this
  API → dashboard; `BM_AGENTS_URL` is env-only; `BM_AGENTS` defaults to off —
  and **compose passes that one through as `${BM_AGENTS:-off}`, never as a
  literal** (bug-25, pinned by `test/compose-env.test.ts`). A literal there
  wins outright: the `environment:` block IS `process.env` in the container
  and dotenv never overwrites a key already in it, so `BM_AGENTS: 'on'` made
  the documented default unreachable from the documented Quick start —
  dispatch buttons *and* the watchdog sweeper armed, from a `cp .env.example
  .env`. `BM_AGENTS_URL` beside it stays a literal for the opposite reason:
  it is stack topology (`host.docker.internal`), not a policy default, and a
  passthrough would let a host-oriented `.env` break dispatch in the stack.
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
  than a cached list. **The toolbar's Orchestrate control re-asks on that same
  block, through that same mechanism** (bug-16): `useReverify`
  (`client/src/hooks/useReverify.ts`) is the one implementation of "ask once,
  mark `aria-busy`, act on the *fresh* answer" that both controls call, and it
  deliberately owns the mechanics only — each caller runs its own gate over the
  fresh status, because the two derive different answers
  (`dispatchGate(item, fresh)` versus `projectDispatchGate(fresh, path)`) and
  have different sibling blocks. The toolbar needs no equivalent of
  `reverifiable`'s three conditions: `showOrchestrate` *hides* the control for
  the environment ladder, for an unfiltered board and for a project with a
  fresh run, so a rendered disabled button is blocked on project visibility
  alone. It re-asks for the project the click captured, never the one the live
  `<select>` names when the answer lands. And unlike `LaunchSheet`,
  `OrchestrateSheet` re-derives no gate on open — its only server re-check is
  at Start, as an uncoded 409 — so nothing behind the control corrects a stale
  answer either way.
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
  `init` at all. That re-check is **two conditions, not one**: a *fresh* run
  file (`RUN_STALE_MS`), and — since bug-21 — a `starting` entry for the same
  project, the window in which no run file exists yet but this same process
  holds the record proving a session is booting into one. A stale run file is
  still not a refusal here, deliberately: recovering one is `--resume`/
  `--abort`'s job, and `init` is the lock that actually holds it. Both
  conditions answer 409 with the machine-readable
  `code: RUN_IN_PROGRESS_CODE`, and **those two occasions are the only ones**
  — every other 409 this endpoint can throw carries no code, because nothing
  about them needs to be told apart. One code for both is the point rather
  than an oversight: it means "a run for this project is alive right now",
  which is equally true either side of the run file landing, and
  `OrchestrateSheet`'s single branch on it (close, hand the screen to the
  strip) is the right reaction to both. Deliberately no count of this
  endpoint's 409 reasons here or in the code — that tally went stale the
  moment the starting lock landed, exactly as the origin-guard invariant's
  did.
- **A pause request lives in a server-owned file the tool reads at its two
  dispatch gates; `paused` is a fifth run status and `unpause` its only
  exit.** `POST /api/agents/pause` (`{ project, cancel? }`, origin-guarded,
  **independent of `BM_AGENTS`** and never calling the dashboard — a pause is
  a fact on this machine's disk, and gating it on that switch would mean a
  run started while agents were on could never be stopped after they were
  turned off) writes
  `~/.backlog-manager/settings/orchestrator-control/<encodeURIComponent(project)>.json`
  — `{ runId, requestedAt }`, `$BM_ORCH_CONTROL_HOME` to override. It is the
  one file travelling **server → tool**; everything else under
  `~/.backlog-manager` travels the other way, and `run.json` keeps its single
  writer untouched. Effectiveness is **derived on both sides, never stored**:
  `control.runId === run.runId && Date.parse(control.requestedAt) >
  Date.parse(run.unpausedAt ?? run.startedAt)`, every malformed shape reading
  as "no request". `orchestrate.mjs` refuses `stage <id> preflight` and
  `stage <id> dispatched` with **exit `6`** when it is effective *and the call
  is a transition* — a re-stamp of a stage the item already occupies is never
  refused, or a live `claude -p` would have no session id recorded — and the
  run then finishes `--status paused`. `6` rather than `1` because the
  reaction is a different command, not a retry. `unpause` is its own command
  and the only exit: `heartbeat` stays a pure `updatedAt` stamp that never
  touches a status, and `unpause` writes `status`, `unpausedAt` and
  `updatedAt` from one clock reading. **The watchdog needs no change** — it
  only ever walks `running` runs, which is why `paused` is a status and not a
  flag; `init` archives a paused run like a done one. Resume for a `paused`
  run is offered on **both** surfaces through one `RunControls` and one
  `resumeGate`; Resume for a **crashed** run stays on the strip alone, behind
  `watchdogStoodDown`, because only that case has automation to race.
  `noteResume` keeps the poll alive for `RESUME_POLL_GRACE_MS` after a click.
  Long form: [docs/invariants.md](docs/invariants.md).
- **A resume is serialized at three layers, and only the third one can
  refuse a resume this app never asked for** (bug-19). `--resume` is not a
  command: it is a prose flow in `references/recovery.md` carried out with
  the ordinary ones, so `init`'s lock never sees it, and a crashed run stays
  crashed for the ~90s a resumed session needs to reach its first heartbeat —
  a window in which every arriving call re-read the identical stale run and
  every one spawned (three sessions in ten seconds, `run-20260905-113818`,
  harmless only because a spend limit killed all three). (1) The board's
  Resume control carries a synchronous in-flight guard and reads `Resuming…`
  while a request is out, and `useOrchestratorRuns`' mark now ends on
  `running` **and `fresh`** rather than `running` alone — a crashed run IS
  `running`, so the mark evaporated on exactly the surface it had to hold.
  (2) `AgentsService.resume()` takes a real lock, `WatchdogEntry.resumeSpawnAt`,
  checked and stamped **synchronously** before its next `await` (a lock taken
  after an await is a check every concurrent caller passes, which is what
  `noteBoardResume`'s after-the-await placement always was), held for
  `RUN_STALE_MS` — the app's one freshness number, never a second — cleared
  when the spawn throws, and refused as an **uncoded** 409, because
  `RUN_IN_PROGRESS_CODE` means "a run is alive right now" and both callers
  treat that code as a silent success. The sweeper obeys it through the same
  method, spending no attempt; a sweeper retry at t+10m being refused until
  the 15m lock expires is correct and pinned, not a bug to shorten the lock
  over. (3) `orchestrate.mjs` records a **driver lease** — `driver:
  { sessionId, at } | null`, written by `init` and the new `claim`, read by
  every mutating command, `CLAUDE_CODE_SESSION_ID` as the identity (never a
  synthetic per-process id, which would lock a run out of its own second
  command), **absent means unclaimed, never locked**, an unidentified caller
  warns and proceeds rather than being stranded. Refusal is **exit `7`**, for
  `6`'s reason: the reaction is to stop, not to retry. `claim` refuses only a
  run that is `running`, fresh and led by another session, which is what makes
  it safe for both resumers to claim a crashed one — the later write wins, and
  the loser's very next write refuses. That is the one place last-writer-wins
  is the mechanism rather than the hazard. **`abort` and `unpause` TAKE the
  lease rather than checking it, and that is the rule, not an exception to
  paper over**: both are commands whose premise is that the previous driver is
  gone — abort ends the run, unpause is a resume session's first write on a run
  whose lease belongs to the session that paused it and exited. Guarding them
  bricked exactly what the lease exists to keep open: a crashed run refused
  every abort on its dead session's lease, and `init` then refused the project
  forever with exit `4`; a paused run's board Resume exited `7` before it ever
  reached `claim`. Taking rather than skipping is what makes the two
  order-independent — an `unpause` that left the old lease behind produces a
  fresh, foreign-led run, which is the one state `claim` refuses. The rule
  lives in the tool, never in `recovery.md`'s step order: prose read once by a
  session that then takes several hundred turns is a step that can be skipped,
  and a skipped step here is a stranded run. Layer 3 exists because layers 1 and
  2 can only refuse what this app itself spawns: occurrence 2 was one
  backlog-manager resume racing a dashboard `--resume <session id>` that
  nothing here requested, can see, or could ever refuse from its own server.
- **The sweeper's prune keeps `paused` runs, because an entry is no longer
  only its bookkeeping.** `WatchdogEntry` now carries `resumeSpawnAt`, the
  resume lock both origins take, whose lifetime is `RUN_STALE_MS` from the
  stamp and not "while the sweeper is interested". Pruning on `running` alone
  deleted that lock for a paused run on the next tick — one armed by any other
  project, since the sweep is global — and the next Resume click spawned a
  second session into a run already being resumed. A paused run is the one
  non-`running` status that can still be resumed, which is exactly the
  condition the lock exists for; every genuinely finished status still prunes
  on the next tick. The keep set is built in `sweep()`, not decided inside
  `prune()`, so retirement policy stays in the one place that reads the
  payload.
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
  says so out loud. **The Runs view says the same thing off the same
  payload** (bug-29): `mergeRuns` no longer filters the live map on `fresh`,
  so `MergedRun.live` is the DATA authority ("does the payload have an entry
  at all") while `MergedRun.isLive` stays the PRESENTATION gate ("`fresh`") —
  pinning and the `runs-row-live` accent still follow freshness and nothing
  else does. It had to be split because the two fields answer different
  questions: `status` says whether the run is over, `fresh` says whether the
  heartbeat is recent, and review or merge routinely outlast `RUN_STALE_MS`
  (57 gaps over 15 minutes across this machine's archived runs, worst two 249
  and 206 minutes). Gating the data on `fresh` handed those windows to
  `useOrchestratorArchive`, which by design never polls, while the 5s live
  poll kept arriving and being discarded — so the one surface built to watch
  a run happen froze until a reload. Both status badges (`RunsView`'s row,
  `RunDetail`'s head) read `crashed` through `runStatusChip`
  (`lib/run-stage.ts`), the one implementation of that substitution, derived
  from the live entry and never from `authority` — an archive record carries
  no `fresh` field and must keep printing its recorded status. `crashed` is
  **not** a sixth `RunStatus`: `RUN_STATUS_GLYPH`/`RUN_STATUS_CLASS` stay
  exhaustive over the five wire statuses, and the aggregate tile's `byStatus`
  substat still counts a crashed run under `running`, because that is a tally
  over the archived corpus rather than a claim about any run right now.
- **The watchdog is armed only while some `run.json` says `running`.** No
  standing interval — a `setTimeout` chain exists only while at least one
  run is `running`, fresh or crashed alike, and disarms itself the tick it
  finds none. Arms on the reads the board already makes (every
  `GET /api/orchestrator/runs` whose payload holds a `running` run), on a
  boot-time scan, on a successful `orchestrate`/`resume` spawn — the last
  two wired at controller level (`AgentsController`, not `AgentsService`:
  `WatchdogService` already injects `AgentsService` for `resume()`, so the
  reverse edge would be a cycle) — and on every `POST
  /api/agents/watchdog/config` save, which calls `arm()` and then an
  unawaited `tick()` regardless of which field changed. That fourth
  trigger earns its own call, not a footnote on the other three: `arm()`
  alone is a no-op whenever a timer is already pending, which is exactly
  the state a watchdog already watching a crashed-but-disabled run sits
  in, so flipping `enabled` back on in Settings for an already-crashed run
  would otherwise wait out the already-scheduled tick (up to a full
  `tickMs`, a minute by default) instead of acting on the save itself. The
  kicked `tick()` is unawaited so the HTTP response isn't held hostage to
  a live resume spawn that depends on a third process, the dashboard;
  firing it unconditionally, even right after `arm()` may have just
  started an identical chain, is safe rather than a double-sweep because
  `tick()`'s own in-flight guard returns the already-running sweep's
  promise instead of starting a second one. A run started by typing the
  trigger with the board never opened for its whole life is never
  watched; CLAUDE.md already says to start runs from the board, and this
  is one more reason.
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
  person wait out a grace window to be told nobody is coming. **A resume a
  person starts from the board is a spawn attempt too**
  (`WatchdogService.noteBoardResume`, called from the controller beside
  `arm()` and BEFORE it, since `arm()`'s tick reads the stamp
  synchronously): it stamps the grace clock and leaves a `spawned` line in
  Activity, and it deliberately does NOT count against the cap. Grace asks
  "is a resume session already on its way into this run", which a board
  resume is; the cap asks "how many times has the watchdog tried on its own
  before asking a human", to which a board resume is the answer rather than
  an instance — and since the Resume control renders precisely when the
  watchdog has stood down, counting hand resumes would let a person retire
  the automation using the only control the board offers them.
- **The board offers a hand resume exactly when the watchdog will not spawn
  one, and that is one function, not two agreeing expressions.**
  `watchdogStoodDown` (`shared/agent.ts`) is the single implementation:
  `RunStrip` renders its Resume control on it, and `watchdog.service.ts`'s
  `visit()` returns without spawning on it. Nothing else prevents a click and
  a tick from both driving `--resume` into one `run.json` — `resume()`
  refuses a *fresh* run, not a second resume of a crashed one, and grace is a
  backoff, not a lock; two `--resume` sessions reconcile, stage-write and
  merge against a file whose single-writer guarantee assumes one process, and
  both end in a merge to `main`. Its two inputs are single implementations
  too, for the same reason: `spawningEnabled()` (`WatchdogStateService`,
  which the sweeper calls rather than re-testing `config.enabled` itself)
  fills the wire's `enabled`, and **`exhausted` is DERIVED**
  (`watchdogExhausted`, `attempts >= maxAttempts`), never stored — it was a
  flag written once and never cleared while the sweeper re-read the config
  every tick, so raising "Give up after" in Settings, the exact action the
  strip's own "exhausted after N — resume by hand" invites, restarted the
  sweeper while the board kept the button. A stored flag whose input is
  re-read every tick is the bug class, not just that bug; this is the same
  posture as "Groomed is derived" and "Board-versus-Archive is derived".
  `WatchdogEntry.exhaustedLogged` is what remains: a once-per-condition log
  guard, cleared again the tick the derivation reads false, never a verdict.
  The rule survived a whole branch as two hand-written expressions and two
  prose sentences that merely agreed — widening the strip's half to
  `canResume === true` left all 1102 tests green — so it is now pinned by
  `test/watchdog-coupling.test.tsx` (board) and `test/watchdog-sweep.test.ts`
  (sweeper) driving both sides from one table, `test/helpers/watchdog-coupling.ts`,
  whose rows carry a hand-checked verdict so the predicate itself cannot be
  broken into a constant both halves would then agree with.
- **Every agents POST is guarded by content-type and origin**
  (`server/src/agents/origin.guard.ts`) — the one place loopback is NOT the
  access control (`plan`, `dispatch`, `orchestrate`, `resume` and
  `watchdog/config` today; `test/agents-origin-guard.test.ts`'s own
  parametrized route list is where that set actually lives, not a count in
  this sentence — a hand-maintained "the two … now three … now four"
  version of this line already went stale once, inside this same branch,
  the moment a fifth route landed). Absent `Origin` stays allowed; the
  guard compares host and port, not scheme.
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
- **A session's cost is recorded per transcript, and a transcript's identity
  is its file name, not its session id** (task-27). `orchestrate.mjs usage
  <id> --jsonl <file>` is the one writer of `RunQueueItem.usage`, called at
  inspect time (SKILL.md §5, on `stage <id> inspecting`'s own Bash
  invocation, so it costs the driver no turn) and again per retry or fix-loop
  transcript; `references/recovery.md` has a resumed driver pick up whatever
  the crashed one missed. One entry per transcript, never one summed figure —
  "the fix loop cost more than the item did" is a question an early fold
  destroys. The identity rule is the trap: `claude -p --resume` keeps the
  session id it was handed, so an item's `<id>.jsonl` and its
  `<id>-fix-1.jsonl` report the SAME session (verified against this machine's
  `task-22` pair), and keying idempotency on `sessionId` — which this task's
  own plan called for — would make a fix loop's entry overwrite the execute
  session's. Identity is `kind` + `loop`, both derived from the file name the
  caller passed and neither guessable from content, which also makes
  re-running the command over an already-recorded transcript harmless.
  **Absence is a value here, at three levels**: no result event in the
  transcript writes no entry at all (a killed session was not free, and exits
  `0` saying so); a numeric field a future CLI renames reads `null`, never
  `0`; and `usage` is optional on the queue item, so a run archived before
  this landed reads `null` from `runUsageTotals`/`itemUsageTotals`
  (`client/src/lib/run-stats.ts`) and renders nothing at all rather than
  `$0.00`. That is why nothing on the path from run file to view defaults it
  to `[]` — `RunDetail`'s row mapper passes it through undefaulted where it
  defaults `assumptions`, deliberately.

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
  another's" rule is untouched.
