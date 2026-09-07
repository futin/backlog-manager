# The API

Nest, one process, every route under `/api`. It owns four things: reading the registry,
scanning each registered project's `backlog/` store, reading the orchestrator's run
state, and — behind a switch that is off by default — asking another local process to
start a Claude Code session. It writes no item file and no run file; the only bytes it
owns are two files under `~/.backlog-manager/settings/`.

> Moved here from `README.md` and `CLAUDE.md` during the docs restructure, so the prose
> is the repo's own, but nobody has yet read it back against the code — this doc is
> deliberately `unstamped` until that pass happens.

## Modules

### `items/`

`GET /api/items` — the whole index, every registered project scanned fresh on each
request. `GET /api/projects` — one row per registered project, with open-item counts and
a `missing` flag for a project whose `backlog/` disappeared. `GET /api/items/body?path=`
— one item's Markdown body, resolved through an allowlist built from the registry, so a
path outside every registered project's `backlog/` 404s.
`GET /api/items/uncommitted?project=` — which of one project's item files differ from
`main`, so the Orchestrate sheet can flag the rows whose bytes on disk are not the bytes
a run will read: `{ paths, known }`, `known: false` for every git failure alike, 404 for
an unregistered project, and nothing cached.

Two git-backed reads live here and they cache differently on purpose. The last commit
touching an item file (`git-dates.util.ts`) is memoised per project against the mtimes of
`index` and `logs/HEAD` — the files git rewrites whenever the answer can change. The
uncommitted read (`uncommitted.util.ts`) is memoised **nowhere**: a working-tree edit,
the exact event it reports, moves neither of those files, so the same key would answer
"clean" forever after its first hit.

### `registry/`

Read-only view of the registry file, re-read on every request so a capture made
mid-session shows up on the next fetch.

### `agents/`

The one module that calls anything outbound, and every POST in it is guarded by
content-type and origin:

- `GET /api/agents/status` — whether dispatch is on and whether
  `../claude-agents-dashboard` answered.
- `POST /api/agents/plan` — this item's next step, derived from the file, plus a composed
  default prompt.
- `POST /api/agents/dispatch` — spawns the session in that dashboard.
- `POST /api/agents/orchestrate` — spawns a headless `/backlog-orchestrate` run for one
  project. The prompt is composed server-side, so a caller can influence which items and
  which modes and nothing else.
- `POST /api/agents/resume` — re-spawns a run that crashed or was paused.
- `POST /api/agents/pause` — writes the pause request a live run reads back at its
  dispatch gates.
- `GET /api/agents/watchdog`, `POST /api/agents/watchdog/config` — the run watchdog's live
  state, read out of this process's own memory and the settings file it owns, plus the
  four server-side knobs behind it.
- `GET /api/agents/merge-check` — a local, read-only look at whether a project's main tree
  is in a state that can receive a merge.

`BM_AGENTS` off turns away `dispatch`, `orchestrate` and `resume` — the three that spawn
something. `status` exists to report that gate, so it answers either way, and `pause`,
`watchdog`, `watchdog/config` and `merge-check` never call the dashboard at all: two read
this process's own state, one writes its own settings file, one looks at local git.
`pause` being independent of the switch is deliberate rather than incidental — a pause is
a fact on this machine's own disk about a run that is already going, so gating it would
mean a run started while dispatch was on could never be stopped after somebody turned it
off.

The run watchdog lives here too (`watchdog.service.ts`), armed only while some `run.json`
says `running`.

### `orchestrator/`

A read-only view of the orchestrator's run-state directory:

- `GET /api/orchestrator/runs` — every project's current `run.json`, re-read fresh on
  every request, which is what lets the board watch a run's heartbeat live; plus the runs
  this server has itself just asked for and whose run file does not exist yet.
- `GET /api/orchestrator/archive` — every run a project has ever produced, current and
  archived alike.
- `GET /api/orchestrator/archive/run` — one run file verbatim, gated by an id pattern and
  an allowlist built the same way item bodies are.

`orchestrate.mjs` is that directory's only writer; this module never writes it and never
caches it. Beside those endpoints sit three pieces of state this module owns:
`watchdog-state.service.ts` (in memory — what the watchdog did, annotated onto
`/api/orchestrator/runs` as `watchdog` on crashed runs only), `starting-runs.service.ts`
(in memory — a spawn this server itself requested, surfaced as the payload's separate
`starting` array so a board-started run is visible before `init` writes a run file), and
two files it genuinely writes: `watchdog-config.util.ts`, the first file the server ever
wrote, and `pause-control.util.ts`, the second — the pause request `orchestrate.mjs` reads
back at its two dispatch gates, the one file in this system travelling server → tool.

### `health/`, `static.ts`, `security.ts`

`GET /api/health` is a plain liveness check. `static.ts` serves `client/dist` only when
it has been built — registering the static module against a missing bundle would install
a catch-all with nothing behind it. `security.ts` applies the response headers, including
the CSP whose `script-src` pins the pre-paint theme script by hash; it is configured on
the root module so every app built from `AppModule` carries it, the tests' included.

## Interfaces

- **The registry file** — read per request, never written, never cached. Its only writer
  is `skills/backlog/tools/backlog.mjs`.
- **Each project's store** — read-only, always. Every write goes through the skills.
- **The run-state directory** — read fresh per request. Its only writer is
  `skills/backlog-orchestrate/tools/orchestrate.mjs`; the server re-derives the directory
  path with its own copy of the same function rather than importing the `.mjs` tool.
- **`../claude-agents-dashboard`** — reached only from `agents/`, at an env-only URL, and
  never by the browser: every call goes board → this API → dashboard.
- **The client** — same-origin `fetch` against these routes, plus the built bundle when
  `static.ts` finds one.

## Invariants

The rules these modules are held to, and the failures behind them, are in
[invariants.md](invariants.md) — the single-writer relationships, the allowlist, the
origin guard, the derive-never-accept rule for dispatch, and the watchdog's arming
conditions. They are not restated here; one home per fact.

<!-- docs-sync:
  sources:
    - server/src
  kind: subsystem
-->
