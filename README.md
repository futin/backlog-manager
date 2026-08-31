# backlog-manager

A Claude Code plugin that homes four backlog skills — `/backlog`,
`/backlog-capture`, `/backlog-groom`, `/backlog-execute` — plus a small local
web app that collects every registered project's backlog, across every repo
the skills have touched, into one kanban-by-type board.

The skills write items into whatever project they were run in, one Markdown
file per item under that project's own `backlog/`. Every `init` or `new` call
registers the project's absolute path in `~/.backlog-manager/registry.json`.
This app reads that registry and renders every registered project's items in
five fixed columns — bugs, ideas, tasks, out-of-scope, refactoring.

- **No auth, no database.** The registry file and each project's `backlog/`
  directory ARE the data; there is nothing here to log into.
- **Read-only board.** Filing, grooming, and moving items all happen through
  the skills — at the CLI or inside Claude Code. The board only ever renders
  what is already on disk.

## The store format

Every registered project's backlog lives at `<project>/backlog/`, one
Markdown file per item, one directory per section:

| Section       | Prefix | Lifecycle     |
|---------------|--------|---------------|
| bugs          | bug    | open -> done  |
| ideas         | idea   | open -> done  |
| tasks         | task   | open -> done  |
| out-of-scope  | oos    | flat          |

An item's status is the directory it lives in (`open/` vs `done/`), never a
frontmatter field. `out-of-scope/` has no `open/done` split — an item lands
there once and stays; rejection is terminal.

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

Everything lives in `.env`; `.env.example` documents each key.

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

## Install the skills

The repo is its own plugin marketplace:

```
/plugin marketplace add /path/to/backlog-manager
/plugin install backlog-manager@backlog-manager-marketplace
```

That gives every project `/backlog`, `/backlog-capture`, `/backlog-groom`, and
`/backlog-execute`. `init` and `new` both register the current project in the
real registry, so a project appears on the board the first time any of the
four skills runs in it — no separate registration step.

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
| Tests (jest) | `pnpm test` |
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
skills (backlog, backlog-capture,       ->   backlog.mjs   ->   ~/.backlog-manager/registry.json
        backlog-groom, backlog-execute)                                  |
                                                                     read-only
                                                                           v
     React SPA (client/)   <->   Nest API (server/)   ->   <project>/backlog/*.md
```

- `server/src/health/` — `GET /api/health`, a plain liveness check.
- `server/src/items/` — `GET /api/items` (the whole index, every registered
  project scanned fresh on each request), `GET /api/projects` (one row per
  registered project, with open-item counts and a `missing` flag for a
  project whose `backlog/` disappeared), `GET /api/items/body?path=` (one
  item's Markdown body, resolved through an allowlist built from the
  registry — a path outside every registered project's `backlog/` 404s).
- `server/src/registry/` — read-only view of the registry file, re-read on
  every request so a capture made mid-session shows up on the next fetch.
- `server/src/agents/` — `GET /api/agents/status` (whether dispatch is on
  and whether `../claude-agents-dashboard` answered), `POST /api/agents/plan`
  (this item's next step, derived from the file, plus a composed default
  prompt), `POST /api/agents/dispatch` (spawns the session in that
  dashboard).
- `client/src/` — a side rail (Board / Archive / Settings, a plain section
  switch; Archive is a placeholder describing what will land there),
  the board (toolbar with search plus project/status/sort selects, four fixed
  columns, a click-to-open drawer rendering the item's Markdown body, plus a
  dispatch button — on the card and again in the drawer — that opens a
  launch sheet onto `../claude-agents-dashboard`), and Settings (five themes,
  density, text scale, landing section — all per-device, in `localStorage`,
  never sent to the server — plus a Claude Agents group reporting that
  dashboard's status).
- `shared/` — `types.ts` (registry and API shapes, defined once and imported
  by both sides), `agent.ts` (`deriveAction` and `dispatchGate` — the single
  implementation of what a dispatch click does and whether it may happen,
  imported by the board to label a button and by the server to validate the
  request, so a button can never promise what the API refuses) and `theme.css`
  (the five theme palettes as CSS custom properties).
- `skills/` — the four published skills; this is the plugin's skill root.
- `backlog/` — this repo's own file-based backlog, self-registered like any
  other project (see `backlog/README.md`).
- `docs/superpowers/` — the design spec and implementation plan this repo was
  built from.

## Development

```bash
pnpm test             # jest --runInBand
pnpm run test:skills  # node --test, the skills' own unit tests
pnpm run typecheck    # tsc --noEmit
pnpm run build        # nest build + vite build
```

Tests are flat in `test/`. Component suites opt into jsdom with a
`@jest-environment jsdom` docblock; everything else runs in node.

## Repo layout

| Path | Contents |
|---|---|
| `skills/` | The published skills — this is the plugin's skill root |
| `server/` | Nest API: items, projects, item bodies, the registry reader |
| `client/` | React SPA: side rail, board, drawer, settings |
| `shared/` | Types, the dispatch derivation (`agent.ts`) and theme tokens shared by both |
| `backlog/` | This repo's own file-based backlog |
| `docs/superpowers/` | Design spec and implementation plan |

## Screenshot

_Not yet captured — open `http://localhost:5177` after `pnpm run docker:up`
(or `pnpm run dev` plus `pnpm run dev:web`) once the board has real items on
it, and drop the image at `docs/board.png`._
