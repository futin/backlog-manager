# backlog-manager

A Claude Code plugin that homes six backlog skills — `/backlog`,
`/backlog-capture`, `/backlog-groom`, `/backlog-execute`,
`/backlog-orchestrate`, and `/backlog-retro`, which sweeps every orchestrator
run on the machine into one report of what the pipeline cost, where the time
went and how much of it was rework — plus a small local web app that collects every
registered project's backlog, across every repo the skills have touched, into
one kanban-by-type board.

The skills write items into whatever project they were run in, one Markdown
file per item under that project's own `backlog/`. Every `init` or `new` call
registers the project's absolute path in `~/.backlog-manager/registry.json`.
This app reads that registry and renders every registered project's items in
four fixed columns — refactoring, ideas, bugs, tasks. Items that were decided
against are not on the board at all: out-of-scope is a record rather than
queue work, and it lives in Archive.

`/backlog-orchestrate` is the largest of the six and the only one that touches
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

**Docs.** [`docs/overview.md`](docs/overview.md) is the map and the one place that
lists them all: the architecture in brief, the rationale behind the rules
([`docs/subsystems/invariants.md`](docs/subsystems/invariants.md)), and the two
procedures — [running the app](docs/workflows/development.md) and
[publishing a skill edit](docs/workflows/publishing.md).

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
`/backlog-execute`, `/backlog-orchestrate` and `/backlog-retro`, plus the read-only reviewer
agent `backlog-manager:backlog-reviewer` that `/backlog-orchestrate` dispatches
before every merge. (An install carries `agents/` because a marketplace with no
`sparsePaths` clones the whole repo; if your own declaration in
`~/.claude/settings.json` pins that key, it has to list `agents` alongside
`skills` or the reviewer is invisible in the install.) `init` and `new` both register the current project in the
real registry, so a project appears on the board the first time a skill files or
scaffolds an item in it — no separate registration step.

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
                                                        |     orchestrator/run.json
                                                   read-only  orchestrator/runs/
                                                        v
      skill (backlog-retro)        ->  retro.mjs      ->  ~/.backlog-manager/retro/
```

Four seams, one doc each:

- [**The API**](docs/subsystems/api.md) — Nest, every route under `/api`. Reads the
  registry, each project's store and the orchestrator's run state; the only thing here
  that can spawn a session, and only when `BM_AGENTS` says so.
- [**The board**](docs/subsystems/board.md) — the React SPA: four lazy sections behind a
  side rail, with most of what you see derived in the browser from whole corpora.
- [**The skills**](docs/subsystems/skills.md) — the six published skills, their three
  CLIs, and the reviewer agent the orchestrator dispatches before a merge.
- [**Invariant rationale**](docs/subsystems/invariants.md) — the rules all three are held
  to, and the failure each one encodes.

[`docs/overview.md`](docs/overview.md) is the map, and the one place that lists every doc.

One behaviour worth knowing before it surprises you: an open refactor, idea or bug nobody
has touched inside the staleness window (30 days by default, `Settings → Board → Archive
after`) leaves the Board for Archive on its own — so the first load after upgrading moves
genuinely old, never-touched items across. Nothing is lost: grooming one puts it back at
the next load, and a task never leaves at all. How "touched" is decided, and the two
things that outrank it, are in
[the board doc](docs/subsystems/board.md#what-leaves-the-board).


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

Ports, binds, what the container mounts and the failure modes each of those has
are in [`docs/workflows/development.md`](docs/workflows/development.md).

## Repo layout

| Path | Contents |
|---|---|
| `skills/` | The six published skills — the plugin's skill root ([doc](docs/subsystems/skills.md)) |
| `agents/` | The plugin's own agents; today just the orchestrator's reviewer ([doc](docs/subsystems/skills.md)) |
| `server/` | Nest API — items, projects, item bodies, the registry reader, the agents module, the run reader ([doc](docs/subsystems/api.md)) |
| `client/` | React SPA — side rail, board, run strip, runs, archive, settings ([doc](docs/subsystems/board.md)) |
| `shared/` | Types, the derivations both sides must agree on (`agent.ts`), theme tokens |
| `backlog/` | This repo's own file-based backlog |
| `scripts/` | `sync-plugin.mjs` ([doc](docs/workflows/publishing.md)) and `test-all.mjs` ([doc](docs/workflows/development.md)) |
| `docs/` | The reference docs — start at [`overview.md`](docs/overview.md); `superpowers/` is the design spec and implementation plans |

## Screenshot

_Not yet captured — open `http://localhost:5177` after `pnpm run docker:up`
(or `pnpm run dev` plus `pnpm run dev:web`) once the board has real items on
it, and drop the image at `docs/board.png`._

<!-- docs-sync:
  sources:
    - server/src
    - client/src
    - shared
    - skills
    - agents
    - scripts
    - package.json
    - docker-compose.yml
    - Dockerfile
    - vite.config.ts
    - .env.example
    - pnpm-workspace.yaml
  kind: readme
  verified: bb20a03538aca602eacbff8bed6393478115d83f
-->
