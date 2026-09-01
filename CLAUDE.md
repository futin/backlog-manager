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
  plan, dispatch, orchestrate), `orchestrator/` (`GET /api/orchestrator/runs`
  for the live board strip, plus `GET /api/orchestrator/archive` and
  `GET /api/orchestrator/archive/run` for run history — all three a
  read-only view of the run-state directory, current run and archived
  `runs/` alike — see Invariants), `registry/` (read-only view of the
  registry file), `static.ts` (serves `client/dist` only when built).
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
  subset, so an untouched sheet still starts a whole-queue run), and a run strip
  above the columns — `RunStrip`/`RunDrawer` — showing every project's
  orchestrator runs), Runs (`RunsView` — aggregate stat tiles, a project
  filter, a day-grouped run list with fresh live runs pinned above history,
  and a persistent detail pane with per-item stage-time bars and
  verification output; fed by `lib/run-stats.ts`, a pure statistics lib, and
  `hooks/useOrchestratorArchive.ts`, which fetches on mount and window focus
  only — no polling interval, since history moves at run boundaries, not on
  a live heartbeat), archive (`ArchiveView.tsx`: four columns —
  refactors/ideas/bugs/out-of-scope — grouped under sticky month subheaders
  keyed on `updated ?? created` (`lib/item-month.ts`), project filter and
  search only, no status or sort control; the same cards, drawer and launch
  sheet the board uses, no run strip), Settings. Board and Archive share one
  persisted project filter, declared in `lib/view-keys.ts` rather than exported
  from either — they are separate lazy chunks, and an import between them would
  undo the split. Fed by `lib/agents.ts` (same-origin
  fetches), `hooks/useAgents.ts` (status poll on mount and window focus),
  and `hooks/useOrchestratorRuns.ts` (same cadence, plus a 5s poll while any
  run is fresh).
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
  `skills/backlog/tools/backlog.mjs` (`init`/`new` upsert). The server
  re-reads it per request, never writes, never caches.
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
- **Board-versus-Archive is derived from `updated ?? created`, never
  stored.** `isStale`/`leavesBoard` (`client/src/lib/item-stale.ts`) are the
  one implementation, read by BoardView now and by Archive later, so an item
  can never be in both surfaces or neither. Four rules the predicate encodes
  and no caller may re-decide: an item **in progress** is never stale
  (`started` outranks the arithmetic); a **done or rejected** item is never
  stale (staleness is about neglected work, and a done item is only reachable
  through the Board's own Done filter); an **unparseable or absent** pair of
  stamps reads as fresh, because a malformed file has to stay where someone
  will see it; and a **task never leaves the Board**, it gains a `stale`
  marker instead. The window is a client setting (`staleDays`, default 30) —
  a view decision over a corpus the server already returns whole — and it is
  the one numeric setting whose clamp falls back to the DEFAULT rather than
  the nearest bound below `min`, because `0` would silently empty three
  columns.

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
  `phase:` back to pick `groom-elapsed:` or `execute-elapsed:` — two
  permanent, accumulating integer-seconds counters, one per activity — bills
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
  marketplace's own `sparsePaths` (`known_marketplaces.json`, machine-local)
  both list — Claude Code discovers a plugin's agents by the same directory
  convention it uses for skills, so an agent left off either list is
  invisible in an install even though it sits right there in the repo.
  `backlog-manager:backlog-reviewer` (`agents/backlog-reviewer.md`) doesn't
  exist post-install until both name `agents`; the repo only ever controls
  the first.
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
  so a caller-supplied one is not rejected, it is simply never read. The one
  thing a caller can put into that string is `ids`, the board's item
  selection, and only after `resolveIds` proves every entry both *is* an id
  (`isItemId`, `shared/agent.ts` — the same `^[a-z]+-\d+$` `backlog.mjs`
  enforces, so no whitespace, path separator, shell metacharacter or newline
  survives) and *names* an open bug or task in **this** project (a per-request
  scan scoped to `req.project`, deliberately not `findItem`'s registry-wide
  walk). 400 for a malformed list, 409 for one the files disagree with, both
  uncoded. An absent `ids` means the whole queue; an explicitly empty one is
  a 400, never "everything" — `parseIdsArg`'s own distinction in
  `orchestrate.mjs`, enforced at the only layer a browser reaches. The
  "derive, never accept" rule dispatch already follows, applied to a route
  with no item file to derive anything from at all.
- **The browser never talks to the dashboard.** Every call goes board → this
  API → dashboard; `BM_AGENTS_URL` is env-only; `BM_AGENTS` defaults to off.
- **A project the dashboard cannot see cannot be dispatched to.** Never
  derive a `dirName` from a path to route around this. The `dispatchGate`
  membership check is a raw string compare, deliberately not realpath.
- **An environment-level block hides the dispatch control; the per-item ones
  disable it.** With `BM_AGENTS` off the board shows no dispatch buttons — do
  not "improve" that into disabled buttons. There are two per-item blocks and
  both keep their button: the dashboard cannot see this item's project
  (`dispatchGate`, derived from `AgentsStatus`), and an orchestrator run has
  already claimed this item (`runClaimBlock`, `shared/agent.ts` — read from the
  run payload, since neither the item file nor the status payload can know it).
  `DispatchButton` reads them in that order, environment first, so the reason
  it shows names the thing to fix rather than a symptom of it.
- **One run per project, checked twice.** `orchestrate.mjs init` refuses
  outright on any `status: "running"` run file, fresh or stale — a stale one
  means a crashed run, recoverable only via `--resume`/`--abort`, never
  silently overwritten. `POST /api/agents/orchestrate` re-checks before it
  spawns anything, on the one path that reaches a run without going through
  `init` at all, but only against a *fresh* run (`RUN_STALE_MS`); it answers
  409 with a machine-readable `code: RUN_IN_PROGRESS_CODE` on that lock case
  alone — every other 409 this endpoint can throw carries no code, because
  nothing about them needs to be told apart.
- **The two agents POSTs are guarded by content-type and origin**
  (`server/src/agents/origin.guard.ts`) — the one place loopback is NOT the
  access control. Absent `Origin` stays allowed; the guard compares host and
  port, not scheme.
- **The launch sheet's model/effort pickers seed from Settings, never the
  last launch** (`dispatchDefaultModel` / `dispatchDefaultEffort` in
  `client/src/lib/settings.ts`, clamped against `MODELS`/`EFFORTS`).
  Permission mode has no stored default — it comes from `plan.defaultMode`,
  clamped to the host ceiling.
- **`linkBase` becomes an href**, so `clampSettings` routes it through
  `clampOrigin` — URL-parsed, `http(s)` only. The one settings key a
  hand-edited localStorage value could turn into script execution.

## Conventions

- Comments explain *why*, at length, and the existing density is deliberate —
  match it rather than stripping it.
- Tests are flat in `test/`, `*.test.ts` / `*.test.tsx`; component suites opt
  into jsdom with a `@jest-environment jsdom` docblock. Skill tests live next
  to the tool they cover (`skills/*/tools/*.test.mjs`) and run under node's
  own test runner, not jest.
