# The board (client)

A React SPA in four sections behind a side rail — Board, Runs, Archive, Settings — each
its own lazy chunk. The server returns whole corpora, so most of what appears on screen
is decided here: whether an item is groomed, whether it belongs on the Board or in
Archive, how long an item's work took, what a run cost. Those derivations live in
`client/src/lib/` as one implementation each, so two surfaces cannot disagree about the
same item.

> Moved here from `README.md` and `CLAUDE.md` during the docs restructure, so the prose
> is the repo's own, but nobody has yet read it back against the code — this doc is
> deliberately `unstamped` until that pass happens.

## Mechanism

### The rail

Board / Runs / Archive / Settings, a plain section switch. `SECTIONS` in `SideRail.tsx`
is the one runtime list of them, and `resolveSection` in `App.tsx` maps a stored value
that names no tab — the legacy `'projects'` included — onto Board, so an upgrade never
opens on a blank main area.

### Board

Toolbar with search plus project/status/sort selects, four fixed columns
(refactors/ideas/bugs/tasks), and a click-to-open drawer rendering the item's Markdown
body. Out-of-scope has no Board column at all; it belongs to Archive.

A dispatch control — on the card and again in the drawer — opens a launch sheet onto
`../claude-agents-dashboard`. A toolbar Orchestrate control opens `OrchestrateSheet`,
three steps with Start on the last one alone so it never sits under a scroll region whose
length is the project's queue:

1. **Items.** Previews the queue and selects a subset of it, flagging with an
   `uncommitted` chip every row whose file on disk is not the file at `main`, and
   splitting the two fates that has — absent from `main` is skipped in the run's own words
   (`not committed on main`), present-but-stale is gated and run on `main`'s bytes — plus
   a `deselect uncommitted (N)` control. Fed once per sheet open by
   `GET /api/items/uncommitted`, rendering nothing at all on `known: false` or a
   failed/malformed answer, and deliberately changing no default: an untouched sheet still
   posts no `ids`.
2. **Order.** Hand-orders that selection with ↑/↓ and a reset (`order: string[] | null`,
   `null` meaning queue order, reconciled against the live queue every render, never
   stored resolved). The screen says a `runner-fix:` item may still hoist above the chosen
   order, and that it cannot tell which.
3. **Modes.** All five pickers — permission mode, model, effort, merge mode, question
   mode, the last two seeded from Settings — plus, in merge mode, a setup hint fed by
   `GET /api/agents/merge-check`.

Above the columns, a run strip (`RunStrip`/`RunDrawer`) showing every project's
orchestrator runs. A crashed run — `running`, heartbeat stale — renders as crashed with
the watchdog's verdict and, when the watchdog is exhausted or off, a Resume control; a
`paused` run renders its own strip with its own Resume; a fresh run that has been asked to
pause gains a `pausing · finishes <id>` chip. The drawer's head hosts `RunControls.tsx`,
the one Pause / Cancel / Resume component both this surface and the Runs detail pane use —
top-level, like `lib/view-keys.ts`, because the two hosts are separate lazy chunks.

### What leaves the Board

An open refactor, idea or bug nobody has touched inside the staleness window (30 days by
default, `Settings → Board → Archive after`) leaves it for Archive on its own. "Touched"
is the `updated:` stamp every `start`/`stop` writes, falling back to the last commit that
touched the item file, and to `created` only when git can answer neither — that middle
rung is there because a groom session which edits an item through the editor rather than
through the CLI leaves the frontmatter silent.

So the first load after upgrading moves genuinely old, never-touched items off the Board.
Nothing is lost: grooming one refreshes the stamp and it is back at the next load. Two
things outrank the arithmetic outright — an item a skill session is working right now, and
an item a live orchestrator run has claimed — because neither is neglected, whatever its
own stamps say: a run writes `started:` inside its own worktree, so the copy the board
renders stays silent for the whole run. Tasks are the exception and never leave — a task
rotting for six weeks is a fact to look at, so it keeps its column and gains a `stale`
marker instead.

### Archive

Where those land, in four columns of its own — refactoring, ideas, bugs, out of scope —
grouped under sticky month subheaders, newest month first. It carries a project filter and
a search box and nothing else: its contents are defined by staleness and rejection, not by
status, so a status filter there would either do nothing or contradict the surface.

Nothing in it is finished, and both halves come back by their own route — a stale item by
dispatching a **groom**, which refreshes `updated:` and puts it back on the Board at the
next load; a rejected one by dispatching a **capture**, which files a *new* item citing
`from: <id>` and leaves the original rejected on the record. (That id keeps whatever prefix
it always had — a rejection moves a file, it never renames one.) As everywhere else, the
board writes no item file; the spawned session does.

### Runs

Aggregate stat tiles including a wide "machine time by stage" tile, a Today / This week /
This month / All range control (calendar-aligned, local-time windows on a run's
`startedAt`) that scopes the tiles, the list and the wide tile together, a project filter,
and a day-grouped run history with fresh live runs pinned above it. Above that pinned
region sits a `starting` placeholder group, read straight off the payload, which is what
makes a project's first run visible before `run.json` exists. A persistent detail pane
carries the per-run stage rollup plus a full-width seven-node `StageTrack` per item with
durations under each node. Cost rides both surfaces: the run total joins the row's foot
line beside its wall time, the pane's head adds cost · turns · sessions, and each item gets
its own line under its track — absent rather than zeroed for a run that predates the
recording.

The section is bounded to one viewport on the wide layout, with the list and the pane each
scrolling their own overflow, sticky day headings, and history windowed behind a counted
`load more` — a render decision over a corpus the client already holds whole, exactly as
the staleness window is. Below 700px none of the bounding applies.

Behind a `Runs | Watchdog` mode switch, Watchdog mode replaces the whole body with
`WatchdogMonitor`: three tiles (the sweeper's phase, the watched count, the read-only
policy), one card per `running` run with a heartbeat freshness meter and, on a crashed
card, attempt pips, the strip's own verdict verbatim and the grace remaining, plus an
activity feed. It owns the one live `useWatchdog()` and takes the Runs view's own live runs
as a prop, so switching modes adds no request.

### Settings

Five themes, density, text scale, landing section, the staleness window and the two
orchestrator run defaults — all per-device, in `localStorage`, never sent to the server.
Plus a Claude Agents group reporting the dashboard's status, and an Orchestrator watchdog
group: the one place Settings writes to the server, four knobs that live in
`settings/watchdog.json` beside the registry rather than in this browser.

## Interfaces

- `lib/agents.ts` — same-origin fetches against `/api`.
- `hooks/useAgents.ts` — status poll on mount and window focus, plus the one re-ask a
  click against a project-visibility block provokes.
- `hooks/useOrchestratorRuns.ts` — the same cadence, plus a 5s poll while any run is fresh
  or still `running`, or any `starting` entry is present, plus a grace window after a
  Resume click.
- `hooks/useOrchestratorArchive.ts` — mount and window focus only; history moves at run
  boundaries, not on a heartbeat.
- [`shared/`](../../shared/agent.ts) — the derivations the server needs too, beside the
  wire types. `shared/` never imports from `client/`.

## Invariants

The rules this surface is held to — one implementation per derivation, board-versus-archive
being derived and never stored, the three per-item dispatch blocks and which one lets a
click through, the dialog escape stack, "queue wait is not work" — are in
[invariants.md](invariants.md), with the failure each one encodes. Not restated here.

<!-- docs-sync:
  sources:
    - client/src
    - shared/types.ts
  kind: subsystem
-->
