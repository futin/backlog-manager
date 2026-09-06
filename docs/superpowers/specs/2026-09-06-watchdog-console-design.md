# Watchdog console — design

Two changes to the Runs section, both presentation, neither touching the
server, the wire, or the sweeper. First, the `Runs | Watchdog` view switch
moves to the far right of the bar so it stops moving when the mode changes.
Second, Runs › Watchdog stops being three blocks of prose: the sweeper's state
becomes three tiles, each watched run becomes a card with a freshness meter,
and the activity feed becomes a table with the `kind` column it has always
carried on the wire and never printed.

Supersedes `2026-09-05-watchdog-monitor-design.md` §2 for the switch's
position and §3.1–3.4 for the monitor's presentation. Everything that
document decided about *what* the monitor reports — rows from the runs
payload, `watching` as annotation, the skew rendered both ways, the
click-through to Runs detail, persistence of the mode — stands unchanged.

The three candidate treatments, drawn on the app's own tokens with live
clocks, are in `2026-09-06-watchdog-console-mockup.html` beside this file.
This document specifies **B · Console**, the one adopted; A and C are kept
there as the record of what was weighed.

## Why this exists

**The switch jumps.** `.board-tools` is right-anchored (`margin-left: auto`)
and the mode switch was its *first* child. Choosing Watchdog unmounts the
range control and the project select beside it, the cluster shrinks to the
switch alone, and the switch slides right by the width of the two controls
that just left — under the pointer that just clicked it. Choosing Runs
slides it back. The fix is order, not layout: as the *last* child, the
switch's right edge is pinned by the bar and the two filters come and go on
its left.

**The monitor reads as a dump.** Task-18 moved the watchdog's live surface to
Runs and deliberately kept it plain — "a monitor read at a glance while
something is going wrong, not a dashboard". The plainness overshot: a state
sentence, a config sentence, a hint, a stack of five-field buttons and a
`<ul>` of sentences. Nothing on it encodes state in *form*, so a crashed run
and a healthy one differ by one word and one border colour, and the one fact
a person watching a live run most wants — how close is this run to being
called crashed — is not on the page at all, even though every input to it
is: `updatedAt`, `RUN_STALE_MS`, and a clock. The feed likewise prints
`detail` and drops `kind`, so a `failed` line and a `recovered` line are the
same grey until read.

## Non-goals

- **No server change, no wire change.** `GET /api/agents/watchdog` and
  `GET /api/orchestrator/runs` are read exactly as they are; no field is
  added, no endpoint. `useWatchdog` and `useOrchestratorRuns` are untouched.
- **No wording change to `stateLine` or `watchdogClause`.** They are the
  sentences two surfaces print, and this design prints them verbatim — the
  monitor says *more* around them, never something *else*.
- **No heartbeat-cadence tick on the meter.** The mockup's "beat due at
  9.5m" mark has no source of truth: the 9.5-minute figure is prose in
  `RUN_STALE_MS`'s comment, and the tool's `watch` actually stamps every
  30s. A tick drawn from a number nothing enforces would be decoration that
  looks like a fact.
- **No durable events, no Settings link, no knob duplication.** Inherited
  from the 2026-09-05 design's non-goals, all still in force.
- **No timeline.** Candidate C's lanes chart is not built here; if the bad
  days keep coming it is a separate idea layered on top of this design.

## 1. Vocabulary

- **Freshness fraction** — how far a run's heartbeat age has travelled
  toward `RUN_STALE_MS`: `0` the instant after a heartbeat, `1` at or past
  the stale line. Derived every render against `now`, never stored.
- **Sweep fraction** — how much of the sweeper's current tick remains,
  `1` just after a tick, `0` when the next is due. Derived from
  `nextTickAt` and `config.tickMs`.
- **Grace remaining** — for a crashed run the sweeper has already spawned
  for, how long until it may spawn again: `lastSpawnAt + graceMs − now`,
  floored at zero.
- **Kind badge** — a chip printing a `WatchdogEventKind` as glyph plus
  word, toned by what the kind means for a person.

## 2. The bar — `RunsView.tsx`

The `runs-mode` segmented control becomes the **last** child of
`.board-tools`. The range control and the project select keep their
existing condition (`mode === 'runs' && merged.length > 0`) and stay ahead
of it. A hairline divider — `<span class="board-tools-divider"
aria-hidden="true" data-testid="runs-tools-divider">` — renders as the last child of that same conditional
fragment, so it appears exactly when the filters do and watchdog mode never
shows an orphan rule beside a lone switch. Its purpose is grouping: three
controls in one row, two of which scope history and one of which picks the
surface, should not read as a single instrument.

`RUNS_MODES`, `MODE_BUTTON`, the test ids and the `aria` semantics are
unchanged; only DOM order and the one new inert span.

## 3. The monitor — `WatchdogMonitor.tsx`

Props, the `useWatchdog()` ownership, the `useNow(…, 5_000)` gate and its
two conditions, the `status === null` unavailable notice, the
`running`/`orphans` derivation and the `onSelectRun` click-through are
exactly as today. What changes is everything rendered from them.

### 3.1 Head — three tiles

A three-column grid (`.watchdog-tiles`) of `.runs-tile` elements, reusing
the Runs-mode tile classes (`runs-tile-value`, `runs-tile-label`,
`runs-tile-substat`) rather than minting a second tile idiom.

**Sweeper.** Label `sweeper`. Value: a lamp (`.watchdog-lamp`, cyan and
ringed while `armed`, neutral while `idle`, hollow while `off`) beside the
phase word. Below it `stateLine(status, now)` verbatim, carrying test id
`watchdog-state-line` as today. While `armed` and `sweepFraction` is
non-null, a thin depleting bar (`watchdog-sweep`, `role="meter"`,
`aria-valuenow` = whole seconds to the next tick, `aria-valuemax` =
`tickMs / 1000`, `aria-label` "time to next sweep") whose fill width is the
fraction; `idle` and `off` render no bar.

**Watching.** Label `watching`. Value: the count of `running` runs in the
payload (test id `watchdog-watching`), with the word `running runs`
(singular for one). Substat, in this order: `N crashed` (amber with the `⚠`
glyph while N > 0, muted ink and no glyph at zero — the tile must not cry
wolf on a healthy afternoon), `N fresh`, and `N not yet watched` only when
N > 0. While
`off`: value `—` and the substat `nothing is watched while off`.

**Policy.** Label `policy`. Three label/value rows — `check every`
`formatSpanCompact(tickMs)`, `leave alone for` `formatSpanCompact(graceMs)`,
`give up after` `maxAttempts` — carrying test id `watchdog-config-line` on
the tile, the same vocabulary the old sentence used so its meaning survives
the shape change. Beneath, the hint `Configure in Settings › Orchestrator
watchdog.` word for word.

### 3.2 Watched runs — cards

Container `watchdog-rows`, omitted entirely while `off`, exactly as today.
One `<button>` per running run, in payload order, test id `watchdog-row`,
classes `watchdog-row-ok` / `watchdog-row-crashed`. A card reads, top to
bottom:

- **Head**: `projectLabel(run.project)`, `runId`, the skew chip `· not yet
  watched` when `watching` lacks the id, and at the right edge the verdict
  (`watchdog-verdict`): `ok` for a fresh run, `crashed` for `isCrashed`,
  each preceded by an `aria-hidden` glyph (`●` / `⚠`) in a *sibling* span,
  so the verdict element's own text stays exactly the one word the existing
  tests match.
- **Item**: `lastReportedEntry(run.queue)` as `bug-16 · dispatched`, or
  `between items`.
- **Meter** (`watchdog-meter`, `role="meter"`): `aria-valuenow` = whole
  seconds of heartbeat age, `aria-valuemax` = `RUN_STALE_MS / 1000`,
  `aria-valuetext` = the heartbeat sentence; fill width =
  `freshnessFraction × 100%`, cyan on a fresh card, amber and full on a
  crashed one. Under it, left: `heartbeat 4s ago` (the existing sentence;
  `heartbeat unknown` for an unparsable stamp, in which case the meter is
  omitted); right: `stale at 15m` on a fresh card, `past the 15m stale
  line` on a crashed one. The `15m` prints from `RUN_STALE_MS`, not a
  literal.
- **Watchdog line**, crashed cards only, from `run.watchdog`: attempt pips
  (`watchdog-attempts`, `maxAttempts` dots with `attempts` of them filled,
  `aria-label` "attempt A of M"), then `watchdogClause(run.watchdog, now)`
  verbatim in `watchdog-clause` — prefix and all, because it is the one
  sentence the strip also prints and the two must never disagree — then
  `→ session <lastSessionId>` when non-null, then `leave alone Nm more`
  (`watchdog-grace`) while `graceRemainingMs` is positive. A crashed run
  the server has not annotated yet (`run.watchdog` undefined) renders the
  verdict alone: the clause is `''` today and stays so.

Orphan placeholders (`watchdog-row-missing`, `<id> — not in the runs
payload`) and both empty states (`no running run` / `nothing running in the
runs payload yet`) are unchanged in copy and position.

### 3.3 Activity — table

A `<table data-testid="watchdog-events">` replaces the `<ul>`. Header row:
`time`, `kind`, `project`, `run`, `what the sweeper did`. One `<tr>` per
event, newest first as the payload arrives: `<time dateTime>` with
`formatClock(at) ?? '—:—'`; the kind badge; `projectLabel(project)` or `—`;
`runId` or `—`; `detail`. The kind badge (`.watchdog-kind`) prints
`WATCHDOG_KIND_GLYPH[kind]` (`aria-hidden`) and the kind word, toned by
`WATCHDOG_KIND_TONE[kind]`.

The heading `Activity` and the hint (`watchdog-events-hint`, naming
`WATCHDOG_EVENT_CAP` and the restart) are kept; so is the empty copy
`nothing since the server started` (`watchdog-events-empty`), rendered in
place of the table.

### 3.4 Layout and styling

`.runs-board` bounds the section to one viewport on the wide layout, and the
monitor now honours that the way Runs mode does: `.watchdog-monitor` is the
flex child that absorbs the remaining height (`flex: 1 1 auto; min-height:
0`), the activity block is a column flex that passes it down, and the table
wrapper scrolls its own overflow (`overflow: auto`) under a sticky header —
replacing the fixed `max-height: 220px` of the old list. Below 700px none of
the bounding applies, exactly as for `.runs-split`.

Tiles: `.watchdog-tiles` is `1.2fr 1fr 1.5fr`, two columns below 900px with
the policy tile spanning, one column below 700px. Cards:
`repeat(auto-fit, minmax(300px, 1fr))`. Meter: a 6px track on `--steel` with
a hairline, fill in `--cyan`, `--amber` on a crashed card, `transition: width
5s linear` so the 5s re-render glides rather than steps. Kind badges reuse
the stage-chip idiom (mono, uppercase, 9px, bordered pill) with tone classes
`watchdog-kind-live` (cyan), `-done` (green), `-bad` (red), `-warn` (amber),
`-muted` (ink). The old `.watchdog-state`, `.watchdog-config`,
`.watchdog-row-*` and `.watchdog-events*` rules are replaced, not kept
beside the new ones. No new tokens.

## 4. Library additions

Three pure functions, each taking an explicit `now`, each returning `null`
for input it cannot read rather than guessing:

- `freshnessFraction(updatedAt: string, now: number): number | null` —
  `client/src/lib/run-time.ts`, beside `runIsLive`, which already reads
  `RUN_STALE_MS` from the same import. `null` for an unparsable stamp;
  otherwise `(now − updatedAt) / RUN_STALE_MS` clamped to `[0, 1]`, so a
  stamp slightly in the future reads `0` rather than negative.
- `sweepFraction(status: WatchdogStatus, now: number): number | null` —
  `client/src/lib/run-watchdog.ts`, beside `stateLine`. `null` unless
  `phase === 'armed'`, `nextTickAt` parses and `config.tickMs` is a positive
  finite number; otherwise `(nextTickAt − now) / tickMs` clamped to `[0, 1]`
  (an overdue tick reads `0`, not negative).
- `graceRemainingMs(w: RunWatchdog, config: Pick<WatchdogConfig, 'graceMs'>,
  now: number): number | null` — same file. `null` when `lastSpawnAt` is
  `null` or unparsable; otherwise `max(0, lastSpawnAt + graceMs − now)`.

Two records, also in `run-watchdog.ts`:

- `WATCHDOG_KIND_GLYPH: Record<WatchdogEventKind, string>` — `spawned ●`,
  `recovered ✓`, `failed ✕`, `exhausted ⚠`, `disabled ‖`, `armed ◉`,
  `idle ○`. The app's own status vocabulary (`RUN_STATUS_GLYPH`) extended to
  the seven kinds, so no mark is colour alone.
- `WATCHDOG_KIND_TONE: Record<WatchdogEventKind, 'live' | 'done' | 'bad' |
  'warn' | 'muted'>` — `spawned live`, `recovered done`, `failed bad`,
  `exhausted warn`, `disabled warn`, `armed muted`, `idle muted`. Amber for
  both kinds that end in "resume by hand", because amber means a human must
  act.

Both are `Record`s over the union so adding an eighth kind fails to compile
until it is classified, the mechanism `RUN_STATUS_GLYPH` already relies on.

## 5. Documents

- `CLAUDE.md` Layout, the Runs entry: the mode switch is described as
  rendering *after* the range control and project select, last in the bar
  so it never moves when they leave, with the divider; the Watchdog-mode
  sentence describes three tiles, one card per `running` run with a
  freshness meter, and a kind-badged activity table, keeping the
  rows-from-payload / `watching`-annotates clause verbatim. The three lib
  functions are named beside `stateLine` and `lastReportedEntry` in the
  same paragraph.
- `2026-09-05-watchdog-monitor-design.md`: a leading italic note on §2 and
  §3 — superseded on 2026-09-06 by this document for the switch's position
  and the monitor's presentation; §2's persistence rule and §3.2's join
  rules stand.
- No new invariant. The three fractions follow the posture the Invariants
  already state for `exhausted`, groomed and Board-versus-Archive: derived
  every read, never stored.

## 6. Testing

Component suites keep the `@jest-environment jsdom` docblock and the
existing fetch stubs. Test ids are kept wherever the element's meaning
survives (`watchdog-state-line`, `watchdog-config-line`, `watchdog-rows`,
`watchdog-row`, `watchdog-verdict`, `watchdog-row-missing`,
`watchdog-rows-empty`, `watchdog-events`, `watchdog-events-hint`,
`watchdog-events-empty`) so the seventeen existing monitor tests are
adjusted, not discarded.

**`run-time.test.ts`** (extended, `freshnessFraction`): age 0 → `0`; 38s
→ `38000 / RUN_STALE_MS`; exactly `RUN_STALE_MS` → `1`; 22m → `1`; a stamp
30s in the future → `0`; `'garbage'` → `null`.

**`run-watchdog.test.ts`** (extended): `sweepFraction` — armed with 42s
left of a 60s tick → `0.7`; armed and 5s overdue → `0`; `idle` → `null`;
`off` → `null`; armed with `nextTickAt: null` → `null`; armed with
`tickMs: 0` → `null`. `graceRemainingMs` — spawned 2m ago, grace 10m →
`480_000`; spawned 12m ago → `0`; `lastSpawnAt: null` → `null`. The two
records: a `Record<WatchdogEventKind, true>` literal beside them pins that
every kind is classified, and `failed` is `bad`, both `exhausted` and
`disabled` are `warn`.

**`watchdog-monitor.test.tsx`** (rewritten around the new markup, same
seventeen scenarios plus these):
- Off: the sweeper tile reads `off — BM_AGENTS off`; the watching tile
  reads `—` and `nothing is watched while off`; the policy tile still
  prints `check every 1m`, `leave alone for 10m`, `give up after 2`; no
  `watchdog-rows`; no sweep meter.
- Idle: no sweep meter; `no running run`.
- Armed, one fresh run 4s old: the sweep meter's `aria-valuenow` is `42`
  for a `nextTickAt` 42s ahead and `aria-valuemax` is `60`; the card's
  meter has `aria-valuenow` `4` and `aria-valuemax` `900`; the card reads
  `heartbeat 4s ago` and `stale at 15m`; the verdict reads `ok`; the
  watching tile reads `1` with `0 crashed` and `1 fresh` and no
  `not yet watched` item.
- Armed, one crashed run 17m old with an annotation of one spawn 2m ago:
  the meter's `aria-valuenow` is `1020` and its fill is full; the verdict
  reads `crashed`; `watchdog-clause` reads exactly
  `watchdogClause(annotation, NOW)`; `watchdog-attempts` has the label
  `attempt 1 of 2`; `watchdog-grace` reads `leave alone 8m more`; the
  session id prints.
- The same crashed run with `lastSpawnAt` 12m ago renders no
  `watchdog-grace`.
- A crashed run without an annotation renders the verdict `crashed` and no
  `watchdog-clause`, `watchdog-attempts` or `watchdog-grace`.
- Events: the table has a header row plus one row per event; the first
  body row's cells read the clock, the kind word, the project tail, the
  runId and the detail; a sweeper-level event prints `—` in both the
  project and run cells; each kind badge carries its glyph and its tone
  class; empty → `nothing since the server started` and no table.
- The two existing clock tests (heartbeat ages on its own; countdown while
  armed with nothing running) keep passing, and a third pins that the card
  meter's `aria-valuenow` advances with the fake clock.

**`runs-view.test.tsx`** (extended):
- With runs, `runs-mode` is the last element child of `.board-tools`, the
  range group and the project select precede it, and the divider is present.
- After clicking `Watchdog`, `runs-mode` is still the last child and the
  divider is gone.
- For an empty payload, where the filters do not render, there is no
  divider.

## 7. Sequencing

`task-21` (open) edits `RunsView.tsx` around the list — the `starting`
array and the pinned region — while this work edits the bar and the body
switch. Different hunks; they merge in either order. The delivery is a
backlog task whose Plan points at this document's implementation plan, run
from the board.

## 8. Decisions taken, and what they cost

- **Cards, not a table, for watched runs.** A meter wants a row of its own
  under the facts it qualifies; a five-column table with a meter in a sixth
  is wider than the pane on an ordinary laptop. Cost: a card wraps its head
  on narrow widths; bought: the meter reads at any width.
- **A table for activity.** A log is columns — time, actor, what. The
  2026-09-02 design rejected a dense ledger table for the *runs list*, where
  a detail pane was the point; nothing there argues against one for a feed
  whose every line has the same five fields.
- **Clause verbatim, prefix kept.** The mockup dropped `watchdog:` because
  the column header carried the word. Keeping it costs ten redundant
  characters on a card and buys the guarantee `run-watchdog.ts` exists for:
  two surfaces printing one sentence about one run cannot disagree.
- **`role="meter"` on both bars.** Costs nothing at render; buys a reading
  for assistive tech and tests that assert `aria-valuenow` instead of
  parsing a `style` attribute.
- **Fractions derived every render.** Three small functions rather than
  state, for the reason the Invariants give for `exhausted`: an input that
  is re-read every tick must not feed a value that is stored once.
- **No 9.5m tick.** Stated in the non-goals; the honest meter has one line,
  the stale one, because that is the one line anything enforces.
- **Divider, yes; a separate right-hand slot, no.** Reordering inside the
  existing cluster keeps one flex container and one wrap behaviour; the
  divider is one inert span and one rule.
