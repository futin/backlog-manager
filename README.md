# backlog-manager

A Claude Code plugin that homes four backlog skills — `/backlog`,
`/backlog-capture`, `/backlog-groom`, `/backlog-execute` — plus a small local
web app that collects every registered project's backlog, across every repo
the skills have touched, into one kanban-by-type board.

The skills write items into whatever project they were run in, one Markdown
file per item under that project's own `backlog/`. Every `init` or `new` call
registers the project's absolute path in `~/.backlog-manager/registry.json`.
This app reads that registry and renders every registered project's items in
four fixed columns — bugs, ideas, tasks, out-of-scope.

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

To run the Node processes on the host instead: `pnpm run dev` (API) and
`pnpm run dev:web` (client), in separate shells. No database to start first.

### Configuration

Everything lives in `.env`; `.env.example` documents each key.

| Key | Default | Purpose |
|---|---|---|
| `PORT` | `4322` | API port, and the port the built client bundle is served from |
| `BM_REGISTRY_FILE` | `~/.backlog-manager/registry.json` | Where `backlog.mjs` writes |
| `BM_WEB_PORT` / `BM_API_PORT` | `5177` / `4322` | Host-side ports, for when something else already holds one |
| `BM_PROJECT_ROOT` | `~/Documents/custom-projects` | The tree mounted read-only into the server container |

A project outside `BM_PROJECT_ROOT` is invisible to the container and is
reported as missing on `/api/projects` rather than silently dropped from the
board — widen the mount if you keep backlogs elsewhere.

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
`BM_WEB_PORT` in `.env` — inside the compose stack they are fixed.

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
- `client/src/` — a side rail (Projects / Settings, a plain section switch),
  the board (toolbar with search plus project/status/sort selects, four fixed
  columns, a click-to-open drawer rendering the item's Markdown body), and
  Settings (five themes, density, text scale, landing section — all
  per-device, in `localStorage`, never sent to the server).
- `shared/` — `types.ts` (registry and API shapes, defined once and imported
  by both sides) and `theme.css` (the five theme palettes as CSS custom
  properties).
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
| `shared/` | Types and theme tokens shared by both |
| `backlog/` | This repo's own file-based backlog |
| `docs/superpowers/` | Design spec and implementation plan |

## Screenshot

_Not yet captured — open `http://localhost:5177` after `pnpm run docker:up`
(or `pnpm run dev` plus `pnpm run dev:web`) once the board has real items on
it, and drop the image at `docs/board.png`._
