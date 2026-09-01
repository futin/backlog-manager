# Orchestration archive ("Runs" section) — design

Date: 2026-09-01
Status: approved (user-reviewed via remote decision session)

## Problem

`backlog-orchestrate` already archives every superseded run —
`cmdInit` moves a finished `run.json` to
`<orchHome>/<encodedProject>/runs/<runId>.json` before starting the next
one — but nothing reads those files back. The board shows live runs only
(RunStrip + RunDrawer), the drawer is deliberately cramped, and the one
trace of history in the UI is the `pastRuns` count in the drawer's meta
line. The user wants to see what pipelines were done, with statistics
and a roomier view than the drawer.

## Decisions taken (with the user, in order)

1. **Placement**: a new top-level side-rail section, `Runs` — not the
   Archive tab (reserved for done/rejected backlog items), not a drawer
   extension.
2. **Content**: per-run detail view + stage-time breakdown + cross-run
   aggregates, all three.
3. **Live runs**: shown in the section too, pinned above history — one
   place for all orchestration; the Board strip stays the quick glance.
4. **API shape**: thin server (approach A). Server stays a dumb,
   fresh-per-request file view; statistics are derived in a tested
   client lib. Rejected: server-computed stats (every stat tweak
   becomes an API change), and fattening `GET /api/orchestrator/runs`
   (the 5s live poll would re-ship all history every tick).
5. **Layout**: hybrid of two explored variants — a master-detail split
   (run list left, persistent detail pane right) topped by an
   aggregate stat-tile header. Rejected: dense ledger table (detail
   stays as cramped as the drawer), stats-first dashboard (history
   below the fold), gantt timeline (leans hardest on stage timestamps,
   which fold on fix loops — the approximation misleads most in that
   rendering; a per-item stage bar inside the detail pane keeps the
   idea at honest fidelity).

## Non-goals

- **No retention/pruning.** Archived runs are KB-sized JSON; the user
  can delete by hand. Revisit only if a real disk problem appears.
- **No change to `orchestrate.mjs`.** The writer already does
  everything this feature needs.
- **No Archive-tab work.** It stays the placeholder reserved for
  backlog items.
- **No full timeline/gantt view.** Possible later, out of scope now.

## Data model (already exists — read-only to this feature)

- `<orchHome>/<encodeURIComponent(project)>/run.json` — the current
  (or latest finished) run. Statuses: `running`, then `finish` writes
  `done | aborted | failed`.
- `<orchHome>/<...>/runs/<runId>.json` — archived runs, written only
  by `cmdInit` when a new run supersedes a finished one. Same shape as
  `run.json`. `<runId>` is `run-YYYYMMDD-HHMMSS`, with a `-<n>` suffix
  on collision (see `archivePath`).
- Per queue item: `stage`, `stageAt` (one ISO stamp per stage — the
  **first arrival** only, per `RunQueueItem`'s own doc: a fix loop
  revisits `reviewing`/`fixing` without adding a second key, so this
  is a shape record, not an event log), `fixLoops`,
  `verification[] {cmd, ok, tail}`, `questions`, `note`,
  `permissionMode`, `sessionId`, `worktree`, `branch`.

The single-writer/single-reader invariant is unchanged in spirit and
extended in wording: `orchestrate.mjs` is the only writer of the whole
run-state directory; `server/src/orchestrator/` is its only reader and
now reads `runs/` as well as `run.json`, still fresh on every request,
still never writing or caching. CLAUDE.md's invariant bullet and
`docs/invariants.md` get that wording.

## Server

Both routes join the existing `OrchestratorController`
(`api/orchestrator`), keeping the /api prefix rule and the module's
no-RegistryModule independence (a run's project identity lives in its
own file).

### `GET /api/orchestrator/archive`

Returns every run the state directory knows about, across all
projects, flat like `/runs`:

```
{ runs: OrchestratorArchiveRun[] }
```

`OrchestratorArchiveRun` is the run file's own shape with two
differences:

- every `verification` entry is `{cmd, ok}` — `tail` is stripped
  (tails are ~90% of a run file's bytes; a 19KB real file is mostly
  test output), and
- a `current: boolean` annotation — `true` when the entry came from
  `run.json`, `false` for `runs/*.json`.

Per project directory: read `run.json` (skip-and-warn on unreadable —
the existing pattern), read every `runs/*.json` the same way, validate
each with the same plausibility check `runs()` uses, sort the
project's entries by `runId` descending (the id embeds a second-
precision timestamp, and under plain string comparison a `-2` suffix
sorts as newer than its base — correct, since the suffixed run was
archived later). No pagination:
tails are stripped and real-world volume is tens of runs.

### `GET /api/orchestrator/archive/run?project=<abs path>&runId=<id>`

One run file, verbatim (tails included), for the detail pane.

Guards, in order, before any filesystem read beyond the directory
listing:

1. `runId` must match `^run-\d{8}-\d{6}(-\d+)?$` — rejects traversal
   (`../`), separators, anything not a run id.
2. `encodeURIComponent(project)` must be **string-equal to an entry of
   `readdirSync(orchHome())`** — the same allowlist-by-listing shape
   `allow.util.ts` uses for item bodies, so an unregistered path can
   never be probed.
3. Look for `runs/<runId>.json`; if absent, serve `run.json` only when
   its own `runId` field equals the requested id.

Every failure — missing param, bad shape, unknown project, unknown
run — is the same 404, matching `GET /api/items/body`'s "the caller
has no business learning which" stance. GET with query params follows
that same endpoint's precedent; the project path already rides in
`/runs` response bodies, so it is not a secret from this client.

### Shared types (`shared/types.ts`)

- `VerificationSummary { cmd: string; ok: boolean }`
- `OrchestratorArchiveRun` — run shape with summary verifications plus
  `current: boolean`
- `OrchestratorArchivePayload { runs: OrchestratorArchiveRun[] }`

The detail endpoint returns the existing raw run shape (no `fresh`, no
`pastRuns` — those are `/runs` annotations).

## Client

### Section wiring

`SideRail.tsx` `TABS` gains `{ id: 'runs', label: 'Runs' }` (after
Board, before Archive — Board's own companions first). `Section`,
`SECTIONS`, `resolveSection`, and settings' `LANDINGS` all derive from
it; `App.tsx` renders a new lazy `RunsView` chunk with the wide wrap.

### Data

- `lib/agents.ts`: `fetchOrchestratorArchive()` and
  `fetchArchivedRun(project, runId)`, both with the same
  malformed-payload guards the existing fetchers carry ("lies quietly"
  rationale — the archive payload is held in hook state and re-read by
  every row).
- `hooks/useOrchestratorArchive.ts`: fetch on mount + window focus
  (the `useAgents` cadence — history changes rarely). No 5s poll of
  its own; live data keeps coming from `useOrchestratorRuns`.

### `RunsView` layout (the approved hybrid)

- **Header row**: title, project filter (All + one per project seen in
  either payload), and the aggregate stat tiles computed over the
  filtered scope: runs by status, items merged / queued, average item
  wall time, fix loops per merged item, verification pass rate.
- **Split** below (stacks vertically under the app's existing 700px
  breakpoint):
  - **Left — run list**, grouped by day (`startedAt`), newest first.
    A fresh `running` run is pinned at top with the live accent and
    ticks with the existing poll. Each entry: status glyph + word,
    project label, merged/total, duration (or elapsed-so-far).
    Selection is component state; default selection is the newest run
    (live one wins if present).
  - **Right — detail pane**, persistent: run header (`runId`, status
    chip, started clock, wall time), four count chips oriented at
    history rather than the drawer's live four: merged / skipped /
    attention / fix loops (a live selection may additionally show
    active + queued — those two are zero by construction on any
    finished run), then per-item rows — id, title, final stage chip (reusing `run-stage.ts` tones
    and glyphs), item wall time, a segmented per-item stage bar with a
    stage-duration caption line, fix-loop count, and the verification
    list as `<details>` (summary = cmd + ok/failed, body = tail),
    failed ones seeded open — the drawer's own one-way-seed pattern.
    Attention entries render under the items, drawer-style.
    - Archived run selected → fetch the detail endpoint (tails live
      only there); loading and error states inline in the pane.
    - Live/current run selected → render from the poll payload
      directly, no fetch (it already carries tails).

### Stats derivation (`client/src/lib/run-stats.ts`)

Pure functions, no React, jest-tested:

- `itemStageSpans(item)` — sort `stageAt` entries by timestamp; spans
  are consecutive deltas, labeled by the earlier stage; terminal stage
  gets a zero span. **Documented approximation**: `stageAt` records
  only each stage's first arrival, so a fix loop's second pass through
  `reviewing`/`fixing` is invisible — its time folds into whichever
  stage's stamp came earliest before the next recorded arrival.
  Sorting by time (never by nominal stage order) keeps every span
  non-negative regardless.
- `itemWallMs(item)` — last stamp minus first stamp; `null` when
  fewer than two stamps parse.
- `runWallMs(run, now)` — `updatedAt − startedAt` for finished runs,
  `now − startedAt` while running; `null` on unparsable stamps.
- `runStageTotals(run)` — per-stage sum of item spans.
- `aggregateRuns(runs, now)` — the tile numbers above; verification
  pass rate counts `ok` over all summary entries.

Every function tolerates missing/corrupt stamps by returning `null` /
skipping the item rather than throwing — the payload is hand-editable
JSON on disk and there is no ErrorBoundary to catch a render throw.

## Testing

Flat in `test/`, jest, per house style. Cases, not literal code:

- **Server, listing**: temp `BM_ORCH_HOME` with two project dirs —
  asserts archived + current runs appear with correct `current` flags;
  tails stripped but `cmd`/`ok` kept; unreadable/implausible files
  skipped without failing the payload; per-project descending order
  including a `-2` suffix case; missing state dir → `{ runs: [] }`.
- **Server, detail**: serves an archived run verbatim (tail present);
  serves the current run when `runId` matches `run.json`; 404 for
  `runId` of `../../run`, `run-1; rm`, empty, unknown-but-well-formed
  id, and a well-formed id under a project path that is not a listing
  entry (prefix path, realpath cousin).
- **run-stats**: spans across a normal progression; a fix-looped item
  (out-of-nominal-order stamps still yield non-negative spans); single
  stamp → wall `null`; corrupt ISO skipped; aggregate over an empty
  list; pass-rate with zero verifications.
- **RunsView**: renders list grouped and sorted; default selection;
  selecting an archived run fetches detail and renders tails; live run
  renders without a detail fetch; project filter narrows list + tiles;
  empty state ("no runs yet") when both payloads are empty.
- **Nav/settings**: rail shows four tabs; stored legacy section still
  resolves; `LANDINGS` contains `runs`.

## Docs

- CLAUDE.md: layout bullet (side rail + new section, orchestrator
  module's two extra routes), invariant bullet wording (reader covers
  `runs/`).
- `docs/invariants.md`: same wording extension.
