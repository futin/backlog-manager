# The API

Nest, one process, every route under `/api`. It owns five things: reading the registry, listing each registered project's items through whichever source owns
them (the files on disk, or a polled GitHub repo), reading the orchestrator's run state, polling the trackers projects are connected to, and — behind a switch
that is off by default — asking another local process to start a Claude Code session. It writes no item file and no run file; the only bytes it owns are two
files under `~/.backlog-manager/settings/`.

## Modules

### `items/`

`GET /api/items` — the whole index, every registered project scanned fresh on each request; every row carries a `source` naming the adapter that produced it.
`GET /api/projects` — one row per registered project, with open-item counts, a `missing` flag for a project whose `backlog/` disappeared, and that project's
`source`. `GET /api/items/body?path=` — one item's Markdown body, resolved through an allowlist built from the registry, so a path outside every registered
project's `backlog/` 404s. `GET /api/items/uncommitted?project=` — which of one project's item files differ from `main`, so the Orchestrate sheet can flag the
rows whose bytes on disk are not the bytes a run will read: `{ paths, known }`, `known: false` for every git failure alike — and for a tracker project, where
the question has no meaning — 404 for an unregistered project, and nothing cached.

A project's source is resolved per request from its own committed `backlog/source.json` (`sources/resolve.util.ts`), never cached and never stored — the same
rule the registry read follows, for the same reason. No marker means `files`, the implicit source, which never has to be registered for that to work; a
`{"kind":"github","repo":"owner/name"}` marker resolves to the GitHub adapter (task-45). A marker that is present and cannot be honoured — malformed, no string
`kind`, or a kind with no adapter here — resolves `unsupported`: the project contributes **no items** and exactly one error (prefixed with the marker's path,
like every scan error), and its `/api/projects` row reads `source: 'unsupported'` with zero counts and `missing: false`. It never reads as `files`; a tracker
project whose marker this build cannot read would otherwise render a stale clone's files as ghosts. A project with no store at all still reads `missing: true`
and `source: null`. `ItemsService` dispatches over the registered adapters and refuses two claiming one kind at boot.

Two git-backed reads live here and they cache differently on purpose. The last commit touching an item file (`git-dates.util.ts`) is memoised per project
against the mtimes of `index` and `logs/HEAD` — the files git rewrites whenever the answer can change. The uncommitted read (`uncommitted.util.ts`) is memoised
**nowhere**: a working-tree edit, the exact event it reports, moves neither of those files, so the same key would answer "clean" forever after its first hit.

Two adapters are registered (`sources/files.source.ts`, `sources/github.source.ts`). `GET /api/items/body` dispatches on the ref's SHAPE, in `ItemsService` and
nowhere else: a `gh:<owner>/<repo>#<n>` URN goes to the GitHub adapter, anything else is a filesystem path and goes to files. `ItemsService.find` makes the
identical dispatch for the agents routes (task-46), which is why `AgentsService.findItem` is now a one-line delegate rather than a private second copy of the
files adapter. The GitHub adapter answers both from the poller's cache and makes no network call of its own; a URN naming a repo no registered project is
connected to answers `null`, so the route 404s. Each adapter also answers `summary(project, marker)` — the four connection fields (`repo`, `polledAt`, `access`,
`detail`) on `ProjectSummary`, four `null`s from files. `GET /api/items/uncommitted` answers `known: false` for a tracker project: the question has no meaning
where there are no item files.

#### The write side (task-46, spec §6.2)

Seven POST routes under `/api/items/`, in `items-write.controller.ts`, each a thin pass-through to one `ItemWriter` method:

| Route       | Body                                                      | Does                                                                                                                                                 | Answers                                        |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `create`    | `project, section, title, body, kind?, runnerFix?, from?` | labels from the section (`type:*`), `kind:*` and `runner-fix`; `from` prepends `_From #n._`; `out-of-scope` creates untyped and closes `not_planned` | 201 `{ id, urn, url, number }`                 |
| `state`     | `project, id, status, outcome?`                           | posts `outcome` as a comment FIRST, then closes `completed`/`not_planned`. Labels and claims untouched                                               | 200 `{ id, status, url }`                      |
| `claim`     | `project, id, phase, session, run?`                       | the claim protocol (§6.3); `run` is a `ClaimRun` validated field by field, and a live claim carrying the SAME `run.runId` is taken over, not contested | 200 `{ commentId, record }` / 409 `{ holder }` |
| `release`   | `project, id, commentId, session, reason, counters?, runId?` | edits `released` into the claim, writes `counters` verbatim, removes `in-progress`; `runId` (bug-42) is the RUN asserting it owns the claim, which is what lets an abort session release a live claim it does not hold | 200 `{ commentId, record }`                    |
| `heartbeat` | `project, id, commentId, state?, finished?`               | re-stamps `heartbeat`; carries the opaque `ClaimState` (read tolerantly by the remote-run assembly). `finished` (task-48) is also accepted on a RELEASED claim, where it sets `finished` alone | 200 `{ commentId, record }`                    |
| `body`      | `project, id, body, ifUpdatedAt, runnerFix?`              | one fresh `GET`, then `PATCH` only if the stamp matches; `runnerFix` adds/removes the `runner-fix` label AFTER the patch, and ABSENT leaves it alone | 200 `{ id, updatedAt }` / 409 `{ updatedAt }`  |
| `comment`   | `project, id, body`                                       | appends a comment                                                                                                                                    | 201 `{ commentId, url }`                       |

Every one carries `@UseGuards(SameOriginPostGuard)`, imported from `agents/` — these create and close issues with a credential the browser never sees, which is
a larger consequence than the dispatch route the guard was written for. A JSON POST with no `Origin` still passes, because `backlog.mjs` in API mode is exactly
that caller.

`ItemsService.writerFor(projectPath)` is the one gate: registry compare (raw string, never realpath), `resolveSource` per request, then the adapter's `writer` —
answering `unregistered` (404), `files` (400, `this project's items are files — the skills write them directly`), `unsupported` (400, `resolveSource`'s own
reason) or the call. None of those four makes a network request. `FilesSource` has no writer at all. Refusals travel as values (`WriteRefusal`) and the
controller alone maps them: `no-token` 503 · `not-found` 404 · `conflict` 409 · `rate-limited` 429 · anything else 502.

Writes to one item are serialised in-process (`Map<urn, Promise>`), and every response is absorbed into the poller's cache so the next board read shows it —
`polledAt` is NOT moved, because nothing was polled. `GET /api/items/claim?project=&id=` is the eighth route and a READ, unguarded like every other GET,
answering who holds one item out of the cache; `backlog.mjs stop` needs it because `start` ran in a different process.

### `tracker/`

The second outbound-calling module, and the only other one. `github.client.ts` is a thin client over `fetch` with no Nest decorators — one constant host
(`api.github.com`), rate-limit headers recorded from every response including a `304`, and no throw on any status: every failure is a value the poller turns
into an `access` state. `poller.service.ts` is a `setTimeout` chain in the watchdog's shape, armed only while a registered project resolves to `github` and
`BM_GITHUB_TOKEN` is set; each tick makes two conditional requests per connected repo (issues, then every comment in the repo, each paginated to the end and
each with its OWN high-water mark — sharing one mark was a task-46 defect that hid every claim older than the newest issue — the second had no reader at all in
phase 2 and is what the claim protocol maps from since task-46), paginates the first sync to the end, upserts by issue number against an inclusive `since`,
drops pull requests, and sleeps a rate-limited repo until its reset. The eight labels in `labels.ts` are created on a repo's first successful sync if any is
missing — the module's one write to GitHub. `map-issue.ts` is the pure issue → `BacklogItem` mapping (spec §5.3). `GET /api/trackers` is read-only and carries
the platform's `hasToken`/`login`, its rate limit, and one row per registered project — **never the token**, which is read per call from the environment and
leaves this process in no payload, log line or URL.

### `registry/`

Read-only view of the registry file, re-read on every request so a capture made mid-session shows up on the next fetch.

### `agents/`

The one module that calls anything outbound, and every POST in it is guarded by content-type and origin:

- `GET /api/agents/status` — whether dispatch is on and whether `../claude-agents-dashboard` answered.
- `POST /api/agents/plan` — this item's next step, derived from the file, plus a composed default prompt.
- `POST /api/agents/dispatch` — spawns the session in that dashboard.
- `POST /api/agents/orchestrate` — spawns a headless `/backlog-orchestrate` run for one project. The prompt is composed server-side, so a caller can influence
  which items, which modes and which base branch, and nothing else. A TRACKER project is accepted since task-47: `resolveIds` proves its ids against
  `ItemsService` rather than against a directory scan, accepts `#31` / the URN / a bare `31`, and **emits bare digits alone**, so the prompt never carries a
  `#`.
- `POST /api/agents/resume` — re-spawns a run that crashed or was paused.
- `POST /api/agents/pause` — writes the pause request a live run reads back at its dispatch gates.
- `POST /api/agents/stop` — writes a STOP request to the same one control file (`kind: 'stop'`) and then attempts one `/backlog-orchestrate --abort` spawn.
  Accepts a `running` run fresh or stale alike; the body says what landed (`stopRequested`) and, separately, what became of the spawn (`abortSession` /
  `abortRefused`), because only the first of the two is guaranteed.
- `GET /api/agents/watchdog`, `POST /api/agents/watchdog/config` — the run watchdog's live state, read out of this process's own memory and the settings file it
  owns, plus the four server-side knobs behind it.
- `GET /api/agents/merge-check` — a local, read-only look at whether a project's main tree is in a state that can receive a merge.
- `GET /api/agents/branches?project=` — that project's local branch names, for the Orchestrate sheet's base picker. Read per request, cached nowhere, and
  deliberately not annotated with which tree holds which branch: the sheet needs names, and where a branch is checked out is a question the run answers at merge
  time.

`BM_AGENTS` off turns away `dispatch`, `orchestrate` and `resume` — the three that spawn something. `status` exists to report that gate, so it answers either
way, and `pause`, `watchdog`, `watchdog/config` and `merge-check` never call the dashboard at all: two read this process's own state, one writes its own
settings file, one looks at local git. `pause` being independent of the switch is deliberate rather than incidental — a pause is a fact on this machine's own
disk about a run that is already going, so gating it would mean a run started while dispatch was on could never be stopped after somebody turned it off.

The run watchdog lives here too (`watchdog.service.ts`), armed only while some `run.json` says `running`.

### `orchestrator/`

A read-only view of the orchestrator's run-state directory:

- `GET /api/orchestrator/runs` — every project's current `run.json`, re-read fresh on every request, which is what lets the board watch a run's heartbeat live;
  plus the runs this server has itself just asked for and whose run file does not exist yet (`starting`); plus, in a separate `remote` array (task-48), the
  runs other machines drove on a tracker project, derived from the poller's cached claim comments by `remote-runs.service.ts` — never members of `runs`, so
  this machine's lock and watchdog never see them, and dropped whenever a local run file carries the same `runId`.
- `GET /api/orchestrator/archive` — every run a project has ever produced, current and archived alike.
- `GET /api/orchestrator/archive/run` — one run file verbatim, gated by an id pattern and an allowlist built the same way item bodies are.

`orchestrate.mjs` is that directory's only writer; this module never writes it and never caches it. Beside those endpoints sit three pieces of state this module
owns: `watchdog-state.service.ts` (in memory — what the watchdog did, annotated onto `/api/orchestrator/runs` as `watchdog` on crashed runs only),
`remote-runs.service.ts` with its pure half `remote-runs.util.ts` (no state at all — other machines' runs, re-derived per request from the poller's cached
claim comments into the payload's separate `remote` array), `starting-runs.service.ts` (in memory — a spawn this server itself requested, surfaced as the payload's separate `starting` array so a board-started run is
visible before `init` writes a run file), and two files it genuinely writes: `watchdog-config.util.ts`, the first file the server ever wrote, and
`pause-control.util.ts`, the second — the pause request `orchestrate.mjs` reads back at its two dispatch gates, the one file in this system travelling server →
tool.

### `health/`, `static.ts`, `security.ts`, `allowed-hosts.ts`

`GET /api/health` is a plain liveness check. `static.ts` serves `client/dist` only when it has been built — registering the static module against a missing
bundle would install a catch-all with nothing behind it. `security.ts` is the one applier of both pieces of request-and-response middleware this app has
(`applySecurityMiddleware`): the Host gate first, then the CSP whose `script-src` pins the pre-paint theme script by hash. It is configured on the root module
so every app built from `AppModule` carries both, the tests' included, and ahead of the static module so both reach the served `index.html`.

`allowed-hosts.ts` is that gate: `isAllowedHost` refuses any `Host` header that is not an IP literal, `localhost`, a `.ts.net` name or an entry in
`BM_ALLOWED_HOSTS`, with 403 and `{ error }`. It answers the question the origin guard cannot — which host was this request _addressed_ to — and so closes DNS
rebinding, which satisfies that guard with two matching lies. Global rather than scoped to `agents/`, because the read routes are exposed to the same page.

## Interfaces

- **The registry file** — read per request, never written, never cached. Its only writer is `skills/backlog/tools/backlog.mjs`.
- **Each project's store** — read-only, always. Every write goes through the skills. Its `backlog/source.json`, when present, names the tracker that owns its
  items ([spec](../superpowers/specs/2026-09-17-tracker-backed-backlog-design.md)).
- **The run-state directory** — read fresh per request. Its only writer is `skills/backlog-orchestrate/tools/orchestrate.mjs`; the server re-derives the
  directory path with its own copy of the same function rather than importing the `.mjs` tool.
- **`../claude-agents-dashboard`** — reached only from `agents/`, at an env-only URL, and never by the browser: every call goes board → this API → dashboard.
- **`api.github.com`** — reached only from `tracker/`, with a token read per call from `BM_GITHUB_TOKEN`, and never by the browser: every call goes board → this
  API → GitHub, and the token reaches no payload.
- **The client** — same-origin `fetch` against these routes, plus the built bundle when `static.ts` finds one.

## Invariants

The rules these modules are held to, and the failures behind them, are in [invariants.md](invariants.md) — the single-writer relationships, the allowlist, the
origin guard, the derive-never-accept rule for dispatch, and the watchdog's arming conditions. They are not restated here; one home per fact.

<!-- docs-sync:
  sources:
    - server/src
  kind: subsystem
  verified: d3dbf8855e78b4ae70c792eeb7696167a44ce8a4
-->
