# backlog-manager

A Claude Code plugin that homes five backlog skills — `/backlog`,
`/backlog-capture`, `/backlog-groom`, `/backlog-execute`,
`/backlog-orchestrate` — plus a small local web app that collects every
registered project's backlog, across every repo the skills have touched, into
one kanban-by-type board.

The skills write items into whatever project they were run in, one Markdown
file per item under that project's own `backlog/`. Every `init` or `new` call
registers the project's absolute path in `~/.backlog-manager/registry.json`.
This app reads that registry and renders every registered project's items in
four fixed columns — refactoring, ideas, bugs, tasks. Items that were decided
against are not on the board at all: out-of-scope is a record rather than
queue work, and it lives in Archive.

`/backlog-orchestrate` is the largest of the five and the only one that touches
git. Told to drain a project's groomed queue, it works every ready bug and task
one at a time — each in its own git worktree and its own headless
`/backlog-execute` session — then commits that item, has it reviewed and
verified, and merges it to `main` before the next one starts. Told to leave
branches instead, it stops at a reviewed `backlog/<id>` branch per item and
never touches `main` at all. A run's state lives in a `run.json` outside the
repo, under `~/.backlog-manager/orchestrator/`; the app reads that file to
render live runs, run history, and the watchdog that resumes a crashed run.

- **No auth, no database.** The registry file and each project's `backlog/`
  directory ARE the data; there is nothing here to log into.
- **The app writes no item files.** Filing, grooming, executing and moving
  items all happen through the skills — at the CLI, inside Claude Code, or in a
  session the board itself spawned. What the board can do is start that work (a
  dispatch, or an orchestrator run), pause a run, and save the run watchdog's
  own server-side settings; every item on screen is rendered from what is
  already on disk.

## The store format

Every registered project's backlog lives at `<project>/backlog/`, one
Markdown file per item, one directory per section:

| Section       | Prefix | Lifecycle     |
|---------------|--------|---------------|
| bugs          | bug    | open -> done  |
| ideas         | idea   | open -> done  |
| tasks         | task   | open -> done  |
| refactors     | ref    | open -> done  |
| out-of-scope  | oos    | flat          |

An item's status is the directory it lives in (`open/` vs `done/`), never a
frontmatter field. `out-of-scope/` has no `open/done` split — an item lands
there once and stays; rejection is terminal. Ideas and refactors are the two
sections nothing executes directly: what each waits for is to be *promoted*
into a task, which is `/backlog-groom`'s job — an idea is something new, a
refactor an existing thing that should be improved.

## Requirements

- Node 22.13+ (pnpm 11 requires it)
- pnpm 11+ (`corepack enable`, then `corepack prepare --activate` in this repo)
- Docker, if you want the containerized stack rather than running the two
  Node processes on the host

## Quick start

```bash
cp .env.example .env
pnpm run docker:up
```

That brings up two containers — the Nest API on `:4322` and the Vite dev
server on `:5177` — with no database service. Open whichever suits you:

| URL | What it is |
|---|---|
| `http://localhost:5177` | Vite dev server: hot reload, proxies `/api` through to the API container |
| `http://localhost:4322` | The API directly, and the built client bundle once `pnpm run build` has run |

`pnpm run docker:down` stops it; `pnpm run docker:sync` tears down and rebuilds
— useful after a dependency change, since `node_modules` lives in a named
volume seeded from the image rather than in the bind mount.

To run the Node processes on the host instead, install the dependencies first
— Quick start never needs this, because the image does its own install:

```bash
pnpm install
pnpm run dev      # the API, in one shell
pnpm run dev:web  # the client, in another
```

No database to start first.

### Configuration

Everything lives in `.env`, and `.env.example` documents each key — except the
last two rows below, which the server reads straight from the process
environment and `.env.example` does not carry.

| Key | Default | Purpose |
|---|---|---|
| `PORT` | `4322` | API port, and the port the built client bundle is served from |
| `BM_REGISTRY_FILE` | `~/.backlog-manager/registry.json` | Where `backlog.mjs` writes |
| `BM_BIND` | `127.0.0.1` | Interface both processes bind. Compose sets `0.0.0.0` inside the containers, where the loopback publish is the boundary |
| `BM_WEB_PORT` / `BM_API_PORT` | `5177` / `4322` | Host-side ports, for when something else already holds one |
| `BM_PROJECT_ROOT` | `~/Documents/custom-projects` | The tree mounted read-only into the server container |
| `BM_AGENTS` | off | Turns on dispatching backlog items to `../claude-agents-dashboard` |
| `BM_AGENTS_URL` | `http://127.0.0.1:4173` | The dashboard's API origin — its `PORT`, not its Vite port |
| `BM_AGENTS_TOKEN` | empty | Sent as `Authorization: Bearer …` when the dashboard sets `ANSWER_TOKEN` |
| `BM_WATCHDOG_FILE` | `~/.backlog-manager/settings/watchdog.json` | Where the server itself writes the run watchdog's own settings |
| `BM_WATCHDOG` | on | `off` disables the run watchdog entirely — the operator's kill switch, separate from its Settings toggle |
| `BM_ORCH_HOME` | `~/.backlog-manager/orchestrator/` | The orchestrator's run-state directory: `orchestrate.mjs` writes each run's `run.json` there and archives each finished run under `runs/` — its run file as `runs/<runId>.json` and its sidecars (transcripts, reviewer reports, verify output) as the sibling directory `runs/<runId>/` — and this server only ever reads it. Not in `.env.example` |
| `BM_ORCH_CONTROL_HOME` | `~/.backlog-manager/settings/orchestrator-control/` | Where this server writes a pause request, which a live run reads back at its dispatch gates — the one file travelling server to tool. Not in `.env.example` |

A project outside `BM_PROJECT_ROOT` is invisible to the container and is
reported as missing on `/api/projects` rather than silently dropped from the
board — widen the mount if you keep backlogs elsewhere.

### Dispatching to Claude (optional)

With `../claude-agents-dashboard` running, a card's button hands that item to a
real Claude Code session: an idea gets groomed into a task, an ungroomed bug
gets its Cause and Fix filled in, an ungroomed task — rare, since capture
refuses to create one without a Plan — gets one filled in, and a groomed bug
or task gets executed. The board calls this API, this API calls the
dashboard's `POST /api/spawn`, and the session shows up in the dashboard a
poll later — where you can watch it, and answer its questions from a phone if
its hooks are installed.

Off until you set `BM_AGENTS=on` (plus `BM_AGENTS_URL`, and `BM_AGENTS_TOKEN`
if the dashboard sets `ANSWER_TOKEN`). **Settings ▸ Claude Agents** reports
exactly which gate is closed and what to do about it. The action is derived
from the item file, not from the click, so an ungroomed bug cannot be executed
by asking nicely — and nothing here ever writes an item: the spawned session
runs the skills, which remain the only writers.

The board's Orchestrate control goes out the same way and through the same
switch: with `BM_AGENTS` off there is nothing to spawn a run with. Pausing or
cancelling a live run is deliberately not gated on it — a pause is a fact on
this machine's own disk and calls nothing outbound, so it keeps working after
that switch is turned off, which is what stops a run started while agents were
on from becoming unstoppable.

## Install the skills

The repo is its own plugin marketplace:

```
/plugin marketplace add /path/to/backlog-manager
/plugin install backlog-manager@backlog-manager-marketplace
```

That gives every project `/backlog`, `/backlog-capture`, `/backlog-groom`,
`/backlog-execute` and `/backlog-orchestrate`, plus the read-only reviewer
agent `backlog-manager:backlog-reviewer` that `/backlog-orchestrate` dispatches
before every merge. (An install carries `agents/` because a marketplace with no
`sparsePaths` clones the whole repo; if your own declaration in
`~/.claude/settings.json` pins that key, it has to list `agents` alongside
`skills` or the reviewer is invisible in the install.) `init` and `new` both register the current project in the
real registry, so a project appears on the board the first time any of the five
skills runs in it — no separate registration step.

If you ran these skills before this repo existed, they are still sitting in
`~/.claude/skills/` and will now load a second time alongside the plugin's
copies, which then drift apart. Remove them once the plugin is installed:

```bash
rm -rf ~/.claude/skills/backlog ~/.claude/skills/backlog-capture \
       ~/.claude/skills/backlog-groom ~/.claude/skills/backlog-execute
```

Registering a project without capturing anything:

```bash
cd /path/to/some/project
node <plugin-cache-path>/skills/backlog/tools/backlog.mjs init
```

## Commands

| Task | Command |
|---|---|
| Whole stack (api + client, no database) | `pnpm run docker:up` |
| Rebuild the stack from scratch | `pnpm run docker:sync` |
| Stop the stack | `pnpm run docker:down` |
| API only, on the host | `pnpm run dev` |
| Client only, on the host | `pnpm run dev:web` |
| Tests (both runners) | `pnpm test` |
| Tests, jest only | `pnpm run test:jest` |
| Skill tests (node:test) | `pnpm run test:skills` |
| Types | `pnpm run typecheck` |
| Production build | `pnpm run build` |

Ports: API `4322`, Vite `5177`. Only the host side moves, via `BM_API_PORT` /
`BM_WEB_PORT` in `.env` — inside the compose stack they are fixed. On the host
both processes bind `127.0.0.1`, and under compose both ports publish on
`127.0.0.1` — nothing here has auth in front of it, so loopback is the access
control. `BM_BIND` moves the bind if you really need to; reach it from another
device by putting your own `tailscale serve` in front of the loopback port
instead.

## Architecture

```
skills (backlog, backlog-capture,      ->  backlog.mjs   ->  ~/.backlog-manager/registry.json
        backlog-groom, backlog-execute)                                |
                                                                   read-only
                                                                         v
    React SPA (client/)  <->  Nest API (server/)  ---------->  <project>/backlog/*.md
                                    |     ^
                              spawns|     |read-only
                                    v     |
      skill (backlog-orchestrate)  ->  orchestrate.mjs  ->  ~/.backlog-manager/
                                                              orchestrator/run.json
                                                              orchestrator/runs/
```

- `server/src/health/` — `GET /api/health`, a plain liveness check.
- `server/src/items/` — `GET /api/items` (the whole index, every registered
  project scanned fresh on each request), `GET /api/projects` (one row per
  registered project, with open-item counts and a `missing` flag for a
  project whose `backlog/` disappeared), `GET /api/items/body?path=` (one
  item's Markdown body, resolved through an allowlist built from the
  registry — a path outside every registered project's `backlog/` 404s), and
  `GET /api/items/uncommitted?project=` (which of one project's item files
  differ from `main`, so the Orchestrate sheet can flag the rows whose bytes
  on disk are not the bytes a run will read — `{ paths, known }`,
  `known: false` for every git failure alike, 404 for an unregistered
  project, and nothing cached).
- `server/src/registry/` — read-only view of the registry file, re-read on
  every request so a capture made mid-session shows up on the next fetch.
- `server/src/agents/` — the one module that calls anything outbound, and
  every POST in it is guarded by content-type and origin: `GET
  /api/agents/status` (whether dispatch is on and whether
  `../claude-agents-dashboard` answered), `POST /api/agents/plan` (this item's
  next step, derived from the file, plus a composed default prompt), `POST
  /api/agents/dispatch` (spawns the session in that dashboard), `POST
  /api/agents/orchestrate` (spawns a headless `/backlog-orchestrate` run for
  one project — the prompt is composed server-side, so a caller can influence
  which items and which modes and nothing else), `POST /api/agents/resume`
  (re-spawns a run that crashed or was paused), `POST /api/agents/pause`
  (writes the pause request a live run reads back at its dispatch gates), `GET
  /api/agents/watchdog` and `POST /api/agents/watchdog/config` (the run
  watchdog's live state, read out of this process's own memory and the settings
  file it owns, plus the four server-side knobs behind it — this server's only
  write outside a run's pause file), and `GET /api/agents/merge-check` (a
  local, read-only look at whether a project's main tree is in a state that can
  receive a merge).

  `BM_AGENTS` off turns away `dispatch`, `orchestrate` and `resume` — the three
  that spawn something. `status` exists to report that gate, so it answers
  either way, and `pause`, `watchdog`, `watchdog/config` and `merge-check`
  never call the dashboard at all: two read this process's own state, one
  writes its own settings file, one looks at local git. `pause` being
  independent of the switch is deliberate rather than incidental — a pause is a
  fact on this machine's own disk about a run that is already going, so gating
  it would mean a run started while dispatch was on could never be stopped
  after somebody turned it off.
- `server/src/orchestrator/` — a read-only view of the orchestrator's
  run-state directory: `GET /api/orchestrator/runs` (every project's current
  `run.json`, re-read fresh on every request, which is what lets the board
  watch a run's heartbeat live — plus the runs this server has itself just
  asked for and whose run file does not exist yet), `GET
  /api/orchestrator/archive` (every run a project has ever produced, current
  and archived alike) and `GET /api/orchestrator/archive/run` (one run file
  verbatim, gated by an id pattern and an allowlist built the same way item
  bodies are). `orchestrate.mjs` is that directory's only writer; this module
  never writes it and never caches it.
- `client/src/` — a side rail (Board / Runs / Archive / Settings, a plain
  section switch),
  the board (toolbar with search plus project/status/sort selects, four fixed
  columns, a click-to-open drawer rendering the item's Markdown body, a
  dispatch button — on the card and again in the drawer — that opens a
  launch sheet onto `../claude-agents-dashboard`, an Orchestrate control that
  opens a three-step sheet for starting a run over the filtered project's
  queue — pick the items, hand-order them, then choose permission mode, model,
  effort, merge mode and question mode — and, above the columns, a strip
  carrying every project's live runs, a crashed one included, with
  Pause / Cancel / Resume in its drawer), Runs (aggregate stat tiles including
  machine time by stage, a Today / week / month / all range control, a project
  filter, a day-grouped run history with live runs pinned above it, and a
  detail pane with a seven-node stage track and per-stage timings for every
  item in the run — plus a Watchdog mode that replaces the whole body with the
  sweeper's own live state: its phase, the runs it is watching, each one's
  heartbeat freshness, and an activity feed), Archive, and Settings (five
  themes, density, text scale, landing section, the staleness window and the
  two orchestrator run defaults — all per-device, in `localStorage`, never sent
  to the server — plus a Claude Agents group reporting that dashboard's status,
  and an Orchestrator watchdog group, the one place Settings does write to the
  server: four knobs that live in `settings/watchdog.json` beside the registry
  rather than in this browser).

  The Board shows what is live: an open refactor, idea or bug nobody has
  touched inside the staleness window (30 days by default, `Settings → Board →
  Archive after`) leaves it for Archive on its own. "Touched" is the `updated:`
  stamp every `start`/`stop` writes, falling back to the last commit that
  touched the item file, and to `created` only when git can answer neither —
  that middle rung is there because a groom session which edits an item through
  the editor rather than through the CLI leaves the frontmatter silent.
  **So the first load after upgrading moves genuinely old, never-touched items
  off the Board.** Nothing is lost: grooming one refreshes the stamp and it is
  back at the next load. Two things outrank the arithmetic outright — an item a
  skill session is working right now, and an item a live orchestrator run has
  claimed — because neither is neglected, whatever its own stamps say: a run
  writes `started:` inside its own worktree, so the copy the board renders
  stays silent for the whole run. Tasks are the exception and never
  leave — a task rotting for six weeks is a fact to look at, so it keeps its
  column and gains a `stale` marker instead.

  Archive is where those land, in four columns of its own — refactoring, ideas,
  bugs, out of scope — grouped under sticky month subheaders, newest month
  first. It carries a project filter and a search box and nothing else: its
  contents are defined by staleness and rejection, not by status, so a status
  filter there would either do nothing or contradict the surface. Nothing in it
  is finished, and both halves come back by their own route — a stale item by
  dispatching a **groom**, which refreshes `updated:` and puts it back on the
  Board at the next load; a rejected one by dispatching a **capture**, which
  files a *new* item citing `from: <id>` and leaves the original rejected on
  the record. (That id keeps whatever prefix it always had — a rejection moves
  a file, it never renames one, so most rejected items are still `bug-N` or
  `task-N`.) As everywhere else, the board writes no item file; the spawned
  session does.
- `shared/` — `types.ts` (registry, API and run shapes, defined once and
  imported by both sides), `agent.ts` (the derivations both sides have to agree
  on: `deriveAction` and `dispatchGate` — what a dispatch click does and
  whether it may happen, imported by the board to label a button and by the
  server to validate the request, so a button can never promise what the API
  refuses — alongside the run-claim and watchdog predicates the board and the
  sweeper must not each re-implement) and `theme.css` (the five theme palettes
  as CSS custom properties).
- `skills/` — the five published skills; this is the plugin's skill root.
  `skills/backlog/tools/backlog.mjs` is the CLI every skill calls and the
  registry's only writer; `skills/backlog-orchestrate/tools/orchestrate.mjs` is
  the orchestrator's own CLI and the run file's only writer.
- `agents/` — the plugin's own agents, one file each, discovered from this
  root-level directory by Claude Code's own convention. Currently one:
  `backlog-reviewer.md`, the read-only reviewer `/backlog-orchestrate`
  dispatches before every merge.
- `backlog/` — this repo's own file-based backlog, self-registered like any
  other project (see `backlog/README.md`).
- `docs/superpowers/` — the design spec and implementation plan this repo was
  built from.

## Development

```bash
pnpm test             # both runners: jest, then node --test
pnpm run test:jest    # jest --runInBand alone
pnpm run test:skills  # node --test alone, the skills' own unit tests
pnpm run typecheck    # tsc --noEmit
pnpm run build        # nest build + vite build
```

Tests are flat in `test/`. Component suites opt into jsdom with a
`@jest-environment jsdom` docblock; everything else runs in node.

## Repo layout

| Path | Contents |
|---|---|
| `skills/` | The five published skills — this is the plugin's skill root |
| `agents/` | The plugin's own agents; today just the orchestrator's reviewer |
| `server/` | Nest API: items, projects, item bodies, the registry reader, the agents module and the orchestrator's run reader |
| `client/` | React SPA: side rail, board, run strip, runs, archive, settings |
| `shared/` | Types, the dispatch derivation (`agent.ts`) and theme tokens shared by both |
| `backlog/` | This repo's own file-based backlog |
| `docs/superpowers/` | Design spec and implementation plan |

## Screenshot

_Not yet captured — open `http://localhost:5177` after `pnpm run docker:up`
(or `pnpm run dev` plus `pnpm run dev:web`) once the board has real items on
it, and drop the image at `docs/board.png`._
