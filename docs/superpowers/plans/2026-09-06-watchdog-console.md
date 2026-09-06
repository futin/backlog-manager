# Watchdog Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the Runs section's `Runs | Watchdog` switch to the far right of
the bar so it stops moving when the mode changes, and turn Runs › Watchdog
from three blocks of prose into three tiles, one freshness-metered card per
running run, and a kind-badged activity table.

**Architecture:** Presentation only. `RunsView.tsx` reorders three bar
children and adds one inert divider span. `WatchdogMonitor.tsx` keeps its
props, its `useWatchdog()` ownership, its `useNow` gate, its
`running`/`orphans` join and its click-through, and rerenders them as tiles,
cards and a table. Three pure derivations join the two `lib/` modules that
already hold every sentence the client prints about runs and the watchdog:
`freshnessFraction` beside `runIsLive` in `lib/run-time.ts`, `sweepFraction`
and `graceRemainingMs` beside `stateLine` in `lib/run-watchdog.ts`, plus two
`Record<WatchdogEventKind, …>` maps for the badge glyph and tone. No server,
wire, hook or wording change.

**Tech Stack:** React 18 function components, plain CSS in
`client/src/styles.css` on the existing tokens, jest + @testing-library
(jsdom docblock) for components, jest for the pure libs.

**Spec:** `docs/superpowers/specs/2026-09-06-watchdog-console-design.md` —
read it first; §-numbers below refer to it. The adopted treatment is drawn in
`docs/superpowers/specs/2026-09-06-watchdog-console-mockup.html` (design B).

## How to read this plan — tests are authoritative, code is illustrative

This plan **deliberately overrides** writing-plans' "code blocks required"
rule. It specifies behaviour, signatures, exact expected values and edge
cases; it does not hand over implementation code or test scaffolding to
transcribe. Handed code gets copied verbatim, so a defect in a plan becomes a
defect on the branch with nobody positioned to catch it — seven such defects
were traced to plan text in each of two earlier projects, test scaffolding
being the worst offender because it reads as boilerplate. Where a fragment
appears below it is a shape to match, never a line to paste. You may
disagree with any line here that turns out wrong in the file; say so in the
item's `stage` note.

Every task ends green: its own suites, then `pnpm run typecheck`. There are
**no commit steps**: `backlog-execute` never commits, and the orchestrator
commits the worktree once when the item finishes.

Line numbers are as of `e61a4d2` and drift as tasks land; the named symbol is
the anchor, the number is a hint.

## Global Constraints

- **No server, wire, hook or wording change.** `GET /api/agents/watchdog`
  and `GET /api/orchestrator/runs` are read as they are; `useWatchdog`,
  `useOrchestratorRuns`, `stateLine` and `watchdogClause` are not edited.
- **Test ids are kept wherever the element's meaning survives** (spec §6):
  `runs-mode`, `runs-mode-runs`, `runs-mode-watchdog`, `runs-range`,
  `watchdog-monitor`, `watchdog-state`, `watchdog-state-line`,
  `watchdog-config-line`, `watchdog-rows`, `watchdog-row`,
  `watchdog-verdict`, `watchdog-row-missing`, `watchdog-rows-empty`,
  `watchdog-events`, `watchdog-events-hint`, `watchdog-events-empty`. New:
  `runs-tools-divider`, `watchdog-phase`, `watchdog-sweep`,
  `watchdog-watching`, `watchdog-meter`, `watchdog-clause`,
  `watchdog-attempts`, `watchdog-grace`.
- **Copy kept word for word** (existing tests pin it): `Configure in
  Settings › Orchestrator watchdog.`, `no running run`, `nothing running in
  the runs payload yet`, `between items`, `· not yet watched`, `<id> — not
  in the runs payload`, `nothing since the server started`, the events hint
  naming `WATCHDOG_EVENT_CAP` and the restart, `heartbeat <span> ago`,
  `heartbeat unknown`, and the `Could not reach the watchdog …` notice.
- **Numbers print from constants**, never literals: `RUN_STALE_MS` for the
  `15m` on a card, `config.tickMs`/`graceMs`/`maxAttempts` for the policy
  tile, `WATCHDOG_EVENT_CAP` in the hint.
- **Old CSS is replaced, not kept beside** (spec §3.4): every
  `.watchdog-state*`, `.watchdog-config`, `.watchdog-row-*`,
  `.watchdog-activity*` and `.watchdog-events*` rule that no longer has an
  element goes, including the 700px `.watchdog-row` block.
- **Comments explain why, at the existing density** (CLAUDE.md
  Conventions). Every new function and every non-obvious rule carries the
  reasoning the spec gives for it.
- Run per-file suites with `pnpm exec jest <files>`; `pnpm run typecheck`
  at the end of every task; the whole `pnpm test` plus `pnpm run build` in
  Task 5.

## File map

- `client/src/components/runs/RunsView.tsx` — Task 1: bar children reordered
  (`.board-tools`, ≈l.727–786), divider span added inside the filters'
  fragment.
- `client/src/styles.css` — Task 1: `.board-tools-divider` beside the
  `.runs-seg` rules (≈l.1577). Tasks 3–4: the Runs › Watchdog block
  (≈l.1579–1650) rewritten; the 700px `.watchdog-row` block (≈l.1723–1729)
  removed; new 900px/700px rules for `.watchdog-tiles`.
- `client/src/lib/run-time.ts` — Task 2: `freshnessFraction` after
  `runIsLive` (≈l.231).
- `client/src/lib/run-watchdog.ts` — Task 2: `sweepFraction`,
  `graceRemainingMs`, `WATCHDOG_KIND_GLYPH`, `WATCHDOG_KIND_TONE`,
  `WatchdogKindTone` after `stateLine` (≈l.145–170).
- `client/src/components/runs/WatchdogMonitor.tsx` — Task 3: head tiles and
  cards; Task 4: activity table. Header comment extended with the spec's
  "why" for form-encoded state.
- `test/runs-view.test.tsx` — Task 1: three cases after the task-18 block
  (≈l.1503–1603); helper `renderRunsView(archiveRuns, liveRuns)` (l.389),
  fixtures `ARCHIVE_RUNS`, `LIVE_RUNS`.
- `test/run-time.test.ts` — Task 2: `describe('freshnessFraction')` after
  `describe('runIsLive')` (l.154).
- `test/run-watchdog.test.ts` — Task 2: three new describes after
  `describe('stateLine')` (l.136).
- `test/watchdog-monitor.test.tsx` — Tasks 3–4: seventeen cases adjusted,
  eight added; fixtures `NOW`, `watchdogStatus()`, `queueItem()`,
  `liveRun()`, `renderMonitor()` unchanged.
- `CLAUDE.md` — Task 1 (switch sentence) and Task 4 (monitor sentence) in
  the Layout entry for Runs.
- `docs/superpowers/specs/2026-09-05-watchdog-monitor-design.md` — Task 4:
  superseded notes on §2 and §3.

---

### Task 1: The bar — switch last, divider beside the filters

**Files:**
- Modify: `client/src/components/runs/RunsView.tsx` ≈l.727–786 (the
  `.board-bar` → `.board-tools` block)
- Modify: `client/src/styles.css` ≈l.1577 (after `.runs-seg > button:focus-visible`)
- Modify: `CLAUDE.md` Layout › Runs entry, the mode-switch sentence
- Test: `test/runs-view.test.tsx`

**Interfaces:**
- Produces: DOM order inside `.board-tools` — `[runs-range] [Project select]
  [runs-tools-divider] [runs-mode]` in runs mode with runs; `[runs-mode]`
  alone otherwise. CSS class `board-tools-divider`.

- [ ] **Step 1: Write the three failing cases** at the end of the task-18
  block in `test/runs-view.test.tsx`, reading `.board-tools` as
  `screen.getByTestId('runs-mode').parentElement`:
  1. *keeps the mode switch as the last tool in the bar in both modes* —
     after `renderRunsView(ARCHIVE_RUNS, LIVE_RUNS)`: the container's
     `lastElementChild` is the `runs-mode` group, and in `children` order
     the `runs-range` group comes before the `Project` select, which comes
     before `runs-tools-divider`, which comes before `runs-mode`. Click
     `runs-mode-watchdog`: `lastElementChild` is still `runs-mode` and
     `children.length` is `1`. Click `runs-mode-runs`: the original order
     is back.
  2. *draws the divider only beside the filters* — present after the first
     render; absent after clicking `runs-mode-watchdog`.
  3. *renders no divider for an empty payload* — `renderRunsView([], [])`:
     `runs-mode` present, `runs-range` absent, `runs-tools-divider` absent.
- [ ] **Step 2: Run** `pnpm exec jest test/runs-view.test.tsx` → FAIL on the
  three new cases only (today the switch is the first child and no divider
  exists).
- [ ] **Step 3: Reorder the JSX.** Move the `runs-mode` `<div className="runs-seg" …>`
  below the `{mode === 'runs' && merged.length > 0 && (<>…</>)}` fragment so
  it is the last child of `.board-tools`. Inside the fragment, after the
  `<select className="board-select" aria-label="Project">`, add
  `<span className="board-tools-divider" aria-hidden="true" data-testid="runs-tools-divider" />`.
  Rewrite the switch's comment: it no longer "sits OUTSIDE the condition
  ahead of" the filters; it sits after them, last, because `.board-tools`
  is right-anchored and a first child slides by the width of whatever
  unmounts beside it (spec "Why this exists"). Keep the sentence about
  escaping the `merged.length > 0` gate — that reasoning still holds.
- [ ] **Step 4: Add the rule** after the `.runs-seg` focus rule:
  `.board-tools-divider` — `width: 1px; background: var(--hairline2);
  align-self: stretch; margin: 3px 4px`. Comment: three controls in one row,
  two scope history and one picks the surface; the rule stops them reading
  as one instrument, and it lives inside the filters' fragment so watchdog
  mode never shows a rule beside a lone switch.
- [ ] **Step 5: Run** `pnpm exec jest test/runs-view.test.tsx` → PASS, all
  existing cases plus three.
- [ ] **Step 6: CLAUDE.md.** In the Layout entry for Runs, replace
  `it renders unconditionally, ahead of the range control, because the
  sweeper has a phase to report` with `it renders unconditionally, last in
  the bar — after the range control, the project select and a hairline
  divider, so its right edge stays put when those two unmount in watchdog
  mode — because the sweeper has a phase to report`.
- [ ] **Step 7:** `pnpm run typecheck` → clean.

---

### Task 2: Library — three derivations and two kind records

**Files:**
- Modify: `client/src/lib/run-time.ts` (after `runIsLive`, ≈l.238)
- Modify: `client/src/lib/run-watchdog.ts` (after `stateLine`, ≈l.170; its
  import line gains `RunWatchdog`, `WatchdogConfig`, `WatchdogEventKind`
  types)
- Test: `test/run-time.test.ts`, `test/run-watchdog.test.ts`

**Interfaces:**
- Produces (`lib/run-time.ts`):
  `export function freshnessFraction(updatedAt: string, now: number): number | null`
- Produces (`lib/run-watchdog.ts`):
  `export function sweepFraction(status: WatchdogStatus, now: number): number | null`;
  `export function graceRemainingMs(w: RunWatchdog, config: Pick<WatchdogConfig, 'graceMs'>, now: number): number | null`;
  `export type WatchdogKindTone = 'live' | 'done' | 'bad' | 'warn' | 'muted'`;
  `export const WATCHDOG_KIND_GLYPH: Record<WatchdogEventKind, string>`;
  `export const WATCHDOG_KIND_TONE: Record<WatchdogEventKind, WatchdogKindTone>`.

- [ ] **Step 1: `describe('freshnessFraction')`** in `test/run-time.test.ts`,
  after `runIsLive`, with a pinned `NOW` and stamps built from it:
  - a stamp equal to `NOW` → `0`;
  - `NOW − 38_000` → exactly `38_000 / RUN_STALE_MS` (import the constant;
    never type `900000`);
  - `NOW − RUN_STALE_MS` → `1`;
  - `NOW − 22 * 60_000` → `1` (clamped, not `1.47`);
  - `NOW + 30_000` (a stamp from the future) → `0`, not negative;
  - `'garbage'` → `null`.
- [ ] **Step 2: Run** `pnpm exec jest test/run-time.test.ts` → FAIL: not
  exported.
- [ ] **Step 3: Implement** `freshnessFraction` beside `runIsLive`, reusing
  `parseStamp` and the already-imported `RUN_STALE_MS`. Doc comment: why
  it is derived every render and never stored (spec §8, the `exhausted`
  precedent), why `null` rather than `0` for an unreadable stamp (`0`
  would claim a heartbeat this instant), why the clamp on both sides.
- [ ] **Step 4: Run** `pnpm exec jest test/run-time.test.ts` → PASS.
- [ ] **Step 5: Three describes** in `test/run-watchdog.test.ts` after
  `stateLine`, building statuses from a local `armed(nextTickAt, tickMs)`
  helper over `DEFAULT_WATCHDOG_CONFIG`:
  - `sweepFraction`: armed, `nextTickAt = NOW + 42_000`, `tickMs 60_000` →
    `toBeCloseTo(0.7, 10)`; armed, `nextTickAt = NOW − 5_000` → `0`;
    `phase: 'idle'` → `null`; `phase: 'off'` → `null`; armed with
    `nextTickAt: null` → `null`; armed with `tickMs: 0` → `null`; armed
    with `nextTickAt: 'garbage'` → `null`.
  - `graceRemainingMs` with `{ graceMs: 600_000 }`: `lastSpawnAt = NOW −
    120_000` → `480_000`; `lastSpawnAt = NOW − 720_000` → `0`;
    `lastSpawnAt: null` → `null`; `lastSpawnAt: 'garbage'` → `null`. Build
    the `RunWatchdog` from a full literal (all seven fields) so a later
    field addition fails here loudly.
  - the records: a `const every: Record<WatchdogEventKind, true> = { armed:
    true, idle: true, spawned: true, failed: true, exhausted: true,
    recovered: true, disabled: true }` literal (the same mechanism
    `test/agents-shared.test.ts:607` uses for `RunStage`), then for each
    key of `every`: `WATCHDOG_KIND_GLYPH[k]` is a non-empty string and the
    seven glyphs are pairwise distinct; `WATCHDOG_KIND_TONE.spawned ===
    'live'`, `.recovered === 'done'`, `.failed === 'bad'`, `.exhausted ===
    'warn'`, `.disabled === 'warn'`, `.armed === 'muted'`, `.idle ===
    'muted'`.
- [ ] **Step 6: Run** `pnpm exec jest test/run-watchdog.test.ts` → FAIL: not
  exported.
- [ ] **Step 7: Implement** in `run-watchdog.ts`:
  - `sweepFraction`: `null` unless `phase === 'armed'`, `nextTickAt` parses
    (`Date.parse` finite) and `config.tickMs` is a finite number `> 0`;
    else `(nextTickAt − now) / tickMs` clamped to `[0, 1]`.
  - `graceRemainingMs`: `null` when `lastSpawnAt` is `null` or does not
    parse; else `Math.max(0, lastSpawnAt + graceMs − now)`. Comment: the
    server starts grace on ANY spawn attempt, success or not (CLAUDE.md
    "Any spawn attempt starts the grace clock"), so `lastSpawnAt` is the
    right origin even after a failed spawn.
  - `WATCHDOG_KIND_GLYPH`: `spawned '●'`, `recovered '✓'`, `failed '✕'`,
    `exhausted '⚠'`, `disabled '‖'`, `armed '◉'`, `idle '○'` — the app's
    `RUN_STATUS_GLYPH` vocabulary extended so no badge is colour alone.
  - `WATCHDOG_KIND_TONE` as the test pins; comment why both "resume by
    hand" kinds are `warn` (amber means a human must act) and why `armed`
    and `idle` are `muted` (the sweeper's own breathing, not news).
  Extend the module's header comment: these are readings about the
  sweeper, so they live beside the three sentences for the same
  two-surfaces reason.
- [ ] **Step 8: Run** `pnpm exec jest test/run-watchdog.test.ts test/run-time.test.ts`
  → PASS.
- [ ] **Step 9:** `pnpm run typecheck` → clean.

---

### Task 3: Monitor head and cards

**Files:**
- Modify: `client/src/components/runs/WatchdogMonitor.tsx` (the `return`
  from the `.watchdog-state` card through the `.watchdog-rows` block,
  ≈l.117–186; imports)
- Modify: `client/src/styles.css` Runs › Watchdog block ≈l.1579–1631 and the
  700px `.watchdog-row` block ≈l.1723–1729
- Test: `test/watchdog-monitor.test.tsx`

**Interfaces:**
- Consumes: Task 2's `freshnessFraction`, `sweepFraction`,
  `graceRemainingMs`; existing `stateLine`, `watchdogClause`, `isCrashed`,
  `lastReportedEntry`, `formatSpanCompact`, `formatClock`, `projectLabel`,
  `RUN_STALE_MS`.
- Produces: markup and classes Task 4 leaves alone — `.watchdog-tiles` >
  three `.runs-tile`; `.watchdog-lamp` with `-armed|-idle|-off`;
  `.watchdog-sweep` > `.watchdog-sweep-fill`; `.watchdog-policy` (a
  two-column label/value grid); `.watchdog-rows` > `.watchdog-row` cards
  with `.watchdog-card-head`, `.watchdog-card-item`, `.watchdog-meter` >
  `.watchdog-meter-fill`, `.watchdog-meter-labels`, `.watchdog-card-wd`,
  `.watchdog-attempts`, `.watchdog-verdict-glyph`.

- [ ] **Step 1: Adjust the existing cases** in `test/watchdog-monitor.test.tsx`
  (names as in the file today):
  - *names the off reason and prints the config, with no rows section at
    all*: replace the single `toHaveTextContent('check every 1m · leave
    alone for 10m · give up after 2')` with three regex assertions on
    `watchdog-config-line` — `/check every\s*1m/`, `/leave alone for\s*10m/`,
    `/give up after\s*2/`; add: `watchdog-sweep` absent; `watchdog-watching`
    reads `—`; `nothing is watched while off` present; `watchdog-phase`
    reads `off`.
  - *reads "no running run" when idle …*: add `watchdog-sweep` absent and
    `watchdog-phase` reads `idle`.
  - *renders a fresh watched run …*: assert the verdict through
    `within(row).getByTestId('watchdog-verdict')` reading exactly `ok`
    (`/^ok$/`); add `watchdog-meter` on the row with `aria-valuenow="4"`,
    `aria-valuemax="900"` and `aria-valuetext="heartbeat 4s ago"`; the row
    reads `stale at 15m`; `watchdog-watching` reads `1`, its tile reads
    `0 crashed` and `1 fresh` and does not read `not yet watched`.
  - *prints the strip's own watchdog clause for a crashed run*: move the
    fixture's `updatedAt` to `NOW − 1_020_000` (17m) and its annotation's
    `lastSpawnAt` to `NOW − 120_000` with `lastSessionId: 'sess-1'`; assert
    `heartbeat 17m ago`, verdict `/^crashed$/`, `watchdog-clause` reading
    exactly `watchdogClause(annotation, NOW)` (call the function, never
    retype the sentence), `watchdog-attempts` with
    `aria-label="attempt 1 of 2"`, `watchdog-grace` reading `leave alone 8m
    more`, the text `session sess-1`, the row reads `past the 15m stale
    line`, and `watchdog-meter` `aria-valuenow="1020"`.
  - *reads a bare "crashed" for a run the server has not annotated yet*:
    keep `/^crashed$/` on `watchdog-verdict`; add: no `watchdog-clause`,
    `watchdog-attempts` or `watchdog-grace`.
  - *ages the heartbeat on its own …*: add `aria-valuenow` moving `4` → `9`.
  - *counts the next tick down while armed …*: add `watchdog-sweep`
    `aria-valuenow` `42` → `37` with `aria-valuemax="60"`.
  The other ten cases (between items, skew suffix, orphan placeholder,
  shared runId, finished run ignored, click-through, events ×2, unavailable
  notice, one-tick skew line) are unchanged by this task.
- [ ] **Step 2: Add two cases:**
  - *renders no grace line once the grace window has elapsed* — the crashed
    fixture with `lastSpawnAt = NOW − 720_000`: `watchdog-clause` present,
    `watchdog-grace` absent.
  - *counts crashed, fresh and unwatched runs in the watching tile* —
    `watching: ['run-1']` with three running runs: `run-1` fresh, `run-2`
    crashed (`fresh: false`, `project: '/abs/beta'`), `run-3` fresh and
    absent from `watching` (`project: '/abs/gamma'`): the tile reads `3`,
    `1 crashed`, `2 fresh`, `1 not yet watched`.
- [ ] **Step 3: Run** `pnpm exec jest test/watchdog-monitor.test.tsx` → FAIL
  on the adjusted and new cases; the ten untouched ones still pass.
- [ ] **Step 4: Rewrite the head** (spec §3.1). Replace the
  `.watchdog-state` card with `<div className="watchdog-tiles">` holding
  three `.runs-tile`s (keep `data-testid="watchdog-state"` on the wrapper
  so the unavailable-notice case's selector still resolves):
  - sweeper: label `sweeper`; value = `<span className="watchdog-lamp
    watchdog-lamp-<phase>" aria-hidden>` + `<span data-testid="watchdog-phase">{phase}</span>`;
    then `<span className="watchdog-state-line" data-testid="watchdog-state-line">{stateLine(status, now)}</span>`;
    then, only when `sweepFraction(status, now)` is non-null, the meter:
    `<div className="watchdog-sweep" role="meter" data-testid="watchdog-sweep"
    aria-label="time to next sweep" aria-valuemin={0}
    aria-valuemax={Math.round(config.tickMs / 1000)}
    aria-valuenow={Math.round((Date.parse(status.nextTickAt) − now) / 1000) clamped ≥ 0}>`
    with a `.watchdog-sweep-fill` child whose inline `width` is
    `${fraction * 100}%`. `Math.round`, not `floor`, to match `stateLine`'s
    own countdown so the bar and the sentence agree to the second.
  - watching: label `watching`; value `<span data-testid="watchdog-watching">`
    = `running.length` while `phase !== 'off'`, else `—`; a `<small>` with
    `running run`/`running runs`; substat items in order — `N crashed`
    (class `watchdog-warn` and a leading `⚠` only while N > 0), `N fresh`,
    and `N not yet watched` only when N > 0 — or the single item `nothing
    is watched while off`.
  - policy: label `policy`; `<div className="watchdog-policy" data-testid="watchdog-config-line">`
    with three label/value pairs — `check every` / `formatSpanCompact(config.tickMs)`,
    `leave alone for` / `formatSpanCompact(config.graceMs)`, `give up
    after` / `config.maxAttempts`; then the existing hint span, text
    unchanged.
- [ ] **Step 5: Rewrite the rows as cards** (spec §3.2), keeping the
  container (`watchdog-rows`, still omitted while `off`), the per-run
  `<button data-testid="watchdog-row">` with its `watchdog-row-ok|crashed`
  class and its `onClick`. Inside, top to bottom:
  - `.watchdog-card-head`: project label, `runId`, the skew chip (unchanged
    text), and at the right the verdict as TWO siblings —
    `<span className="watchdog-verdict-glyph" aria-hidden>{crashed ? '⚠' : '●'}</span>`
    then `<span className="watchdog-row-verdict" data-testid="watchdog-verdict">{crashed ? 'crashed' : 'ok'}</span>`.
  - `.watchdog-card-item`: `lastReportedEntry` line, unchanged text.
  - the meter, only when `Date.parse(run.updatedAt)` is finite:
    `<div className="watchdog-meter" role="meter" data-testid="watchdog-meter"
    aria-label="heartbeat age" aria-valuemin={0}
    aria-valuemax={RUN_STALE_MS / 1000}
    aria-valuenow={Math.floor(age / 1000)}
    aria-valuetext={heartbeatSentence}>` with `.watchdog-meter-fill` at
    `width: ${freshnessFraction(run.updatedAt, now) * 100}%`; beneath,
    `.watchdog-meter-labels` — left the heartbeat sentence (`heartbeat 4s
    ago`, from `formatSpanCompact(age)`), right `stale at
    ${formatSpanCompact(RUN_STALE_MS)}` on a fresh card and `past the
    ${formatSpanCompact(RUN_STALE_MS)} stale line` on a crashed one. When
    the stamp does not parse: no meter, the line `heartbeat unknown`.
  - `.watchdog-card-wd`, crashed cards with `run.watchdog` only: the pips
    `<span className="watchdog-attempts" data-testid="watchdog-attempts"
    aria-label={`attempt ${attempts} of ${maxAttempts}`}>` holding
    `maxAttempts` `<i>` dots, the first `attempts` of them class `on`; then
    `<span data-testid="watchdog-clause">{watchdogClause(run.watchdog, now)}</span>`
    (omit the span when the clause is `''`); then `→ session {lastSessionId}`
    when non-null; then `<span data-testid="watchdog-grace">leave alone
    {formatSpanCompact(g)} more</span>` only while `g = graceRemainingMs(run.watchdog, config, now)`
    is `> 0`.
  Orphan placeholders and the two empty states: unchanged markup.
- [ ] **Step 6: CSS.** Replace `.watchdog-state`, `.watchdog-state-line`,
  `.watchdog-config`, and every `.watchdog-row-*` rule (and the 700px
  `.watchdog-row` block) with: `.watchdog-tiles` (`display: grid;
  grid-template-columns: 1.2fr 1fr 1.5fr; gap: 8px`); `.watchdog-lamp`
  (8px disc, `--ink3`), `-armed` (`--cyan` plus the ring animation the
  mockup uses, respecting `prefers-reduced-motion`), `-off` (transparent
  with a 1.5px `--ink3` border); `.watchdog-sweep` (5px track on `--steel`,
  hairline border, radius 3px, `overflow: hidden`) and `-fill` (`--cyan`,
  `transition: width 5s linear` — the 5s re-render glides); `.watchdog-policy`
  (grid `1fr auto`, mono 10.5px, values `--ink` 600 tabular); the card
  (`.watchdog-row`: column flex, gap 7px, `--panel`, hairline, radius 2px,
  10–12px padding, `text-align: left`, hover `--hairline2`, focus ring as
  today), `-crashed` (`border-color: var(--amber)` — the same amber the
  crashed strip wears, with that rule's rationale), `.watchdog-card-head`
  (baseline flex, wrap, the verdict pair pushed right with `margin-left:
  auto` on the glyph), `.watchdog-row-verdict` toned `--ink3` / `--amber`;
  `.watchdog-meter` (6px track on `--steel`, hairline, radius 3px) and
  `-fill` (`--cyan`, `min-width: 2px`, the same 5s transition; `--amber`
  under `.watchdog-row-crashed`); `.watchdog-meter-labels` (space-between,
  9.5px, `--ink3`); `.watchdog-card-wd` (10px, `--amber`, wrap);
  `.watchdog-attempts i` (7px discs, 1.5px `--amber` border, `.on` filled);
  `.watchdog-rows` becomes `display: grid; grid-template-columns:
  repeat(auto-fit, minmax(300px, 1fr)); gap: 8px`. Media: 900px →
  `.watchdog-tiles { grid-template-columns: 1fr 1fr }` with the third tile
  `grid-column: 1 / -1`; 700px → one column. Rewrite the block's header
  comment: "deliberately plainer than `.runs-tile`" is no longer true, and
  the spec's "Why this exists" says why (state encoded in form, the
  approach-to-crashed reading).
- [ ] **Step 7: Run** `pnpm exec jest test/watchdog-monitor.test.tsx test/runs-view.test.tsx`
  → PASS (19 monitor cases).
- [ ] **Step 8:** `pnpm run typecheck` → clean.

---

### Task 4: Activity table, viewport bounding, documents

**Files:**
- Modify: `client/src/components/runs/WatchdogMonitor.tsx` (the
  `.watchdog-activity` block, ≈l.188–210)
- Modify: `client/src/styles.css` (the `.watchdog-activity*` /
  `.watchdog-events*` rules; `.watchdog-monitor`)
- Modify: `CLAUDE.md` Layout › Runs entry, the Watchdog-mode sentence
- Modify: `docs/superpowers/specs/2026-09-05-watchdog-monitor-design.md` §2, §3
- Test: `test/watchdog-monitor.test.tsx`

**Interfaces:**
- Consumes: Task 2's `WATCHDOG_KIND_GLYPH`, `WATCHDOG_KIND_TONE`.
- Produces: `<table data-testid="watchdog-events" className="watchdog-table">`
  inside `.watchdog-table-wrap`; badge class `watchdog-kind
  watchdog-kind-<tone>`.

- [ ] **Step 1: Adjust the two events cases and add three:**
  - *renders every event newest-first with its clock, project tail and
    detail*: replace `getAllByRole('listitem')` with the rows of
    `within(screen.getByTestId('watchdog-events')).getAllByRole('row')`;
    `rows[0]` is the header and its `columnheader`s read `time`, `kind`,
    `project`, `run`, `what the sweeper did`; `rows[1]`'s cells read, in
    order, `formatClock(events[0].at)`, `events[0].kind`, `projectLabel(events[0].project)`,
    `events[0].runId`, `events[0].detail`; the same for `rows[2]` against
    `events[1]`; the third event in the fixture is the sweeper-level one
    (`project: null`, `runId: null`) and `rows[3]` reads `—` in both the
    project and the run cell.
  - *says the feed is empty and names the cap it is bounded by*: add
    `screen.queryByRole('table')` is `null`.
  - new *badges each event by kind, with its glyph and tone* — a fixture
    with one event of every kind: each badge (`within(row).getByText(kind)`'s
    closest `.watchdog-kind`) carries class `watchdog-kind-${WATCHDOG_KIND_TONE[kind]}`
    and its `aria-hidden` glyph span reads `WATCHDOG_KIND_GLYPH[kind]`
    (assert through the records, never retyped strings).
  - new *keeps the hint above the table* — `watchdog-events-hint` precedes
    the table in document order (`compareDocumentPosition`).
  - new *renders an unparsable event stamp as —:—* — an event with
    `at: 'garbage'`: its time cell reads `—:—`.
- [ ] **Step 2: Run** `pnpm exec jest test/watchdog-monitor.test.tsx` → FAIL
  on the five.
- [ ] **Step 3: Replace the `<ul>`** (spec §3.3): heading `Activity` and the
  hint unchanged; empty → the existing `watchdog-events-empty` div; else
  `<div className="watchdog-table-wrap"><table className="watchdog-table"
  data-testid="watchdog-events">` with a `<thead>` of five `<th scope="col">`
  and one `<tr>` per event: `<td><time dateTime={at}>{formatClock(at) ?? '—:—'}</time></td>`,
  `<td><span className={`watchdog-kind watchdog-kind-${WATCHDOG_KIND_TONE[kind]}`}><span aria-hidden>{WATCHDOG_KIND_GLYPH[kind]}</span>{kind}</span></td>`,
  `<td>{project === null ? '—' : projectLabel(project)}</td>`,
  `<td>{runId ?? '—'}</td>`, `<td className="watchdog-table-detail">{detail}</td>`.
  Row `key` as today.
- [ ] **Step 4: CSS.** Remove `.watchdog-events`, `.watchdog-events-empty`
  (keep a rule for the empty div's text tone), `.watchdog-events li`,
  `.watchdog-events time`, `.watchdog-event-project`. Add:
  `.watchdog-monitor { flex: 1 1 auto; min-height: 0 }` (it is the flex
  child of `.runs-board` that absorbs the remainder, exactly as
  `.runs-split` — cite that rule's comment); `.watchdog-activity { flex: 1
  1 auto; min-height: 0; display: flex; flex-direction: column; gap: 6px }`;
  `.watchdog-table-wrap { flex: 1 1 auto; min-height: 120px; overflow:
  auto; overscroll-behavior: contain; background: var(--panel); border:
  1px solid var(--hairline); border-radius: 2px }`; `.watchdog-table`
  (`width: 100%; border-collapse: collapse; mono 10.5px; --ink2`), `th`
  (`position: sticky; top: 0; z-index: 1; --strip-hi; display-face 9.5px
  uppercase letter-spaced --ink3; hairline bottom border; left-aligned;
  nowrap`), `td` (`6px 10px`, hairline top border, baseline, nowrap;
  `.watchdog-table-detail` wraps and is `--ink`); `.watchdog-kind` (the
  stage-chip idiom: mono 9.5px 600 uppercase `.06em`, 1px border, radius
  9px, `1px 7px 1px 5px`, inline-flex gap 4px) and the five tones —
  `-live` `--cyan`, `-done` `--green`, `-bad` `--red`, `-warn` `--amber`
  (each with a 45% `color-mix` border as the stage chips do), `-muted`
  `--ink3` with a `--hairline2` border. Below 700px nothing needs undoing:
  `.runs-board` is already `height: auto` there, so `flex: 1` has no
  remainder and the wrap sizes to content — say so in a comment beside the
  existing `.runs-board { height: auto }` rule, the way `.runs-split`'s
  comment already does.
- [ ] **Step 5: Run** `pnpm exec jest test/watchdog-monitor.test.tsx` → PASS
  (22 cases: seventeen adjusted or untouched, two from Task 3, three here).
- [ ] **Step 6: CLAUDE.md.** In the Layout entry for Runs, replace the
  sentence that begins `Watchdog mode replaces the whole body with` and ends
  `and the activity feed.` with the text below, verbatim (it is one sentence
  in the file; the line breaks here are only wrapping). Keep the rest of the
  paragraph, from the `useWatchdog()` ownership sentence onward, as it is.

```text
Watchdog mode replaces the whole body with `WatchdogMonitor` — three tiles
(the sweeper's phase with `stateLine` and a depleting sweep meter, the
watched count, the read-only policy), one card per `running` run in the live
payload with a heartbeat freshness meter against `RUN_STALE_MS`
(`freshnessFraction`, `lib/run-time.ts`) and, on a crashed card, attempt pips,
the strip's own `watchdogClause` verbatim and the grace remaining
(`sweepFraction`/`graceRemainingMs`, `lib/run-watchdog.ts`, beside the
`WATCHDOG_KIND_GLYPH`/`WATCHDOG_KIND_TONE` records the activity badges read)
— cards from the runs payload, `watching` only annotates, because two
projects can share a `runId`; the skew shows in both directions, `· not yet
watched` and a placeholder row — and the activity feed as a kind-badged
table that takes the section's remaining viewport height.
```

- [ ] **Step 7: Superseded notes.** In
  `docs/superpowers/specs/2026-09-05-watchdog-monitor-design.md`, add one
  italic line directly under each of two headings, verbatim:

  Under `## 2. The mode switch — \`RunsView.tsx\`` (the heading's own
  backticks are the file's):

```text
*Superseded on 2026-09-06 by `2026-09-06-watchdog-console-design.md` §2 for
the switch's position (last in the bar, after a divider); the persistence
rule below stands.*
```

  Under `## 3.` (the `WatchdogMonitor` heading):

```text
*Superseded on 2026-09-06 by `2026-09-06-watchdog-console-design.md` §3 for
the presentation (§3.1–3.4: tiles, cards, table); §3.2's join rules — rows
from the runs payload, `watching` as annotation, the skew rendered both ways
— stand.*
```

- [ ] **Step 8:** `pnpm run typecheck` → clean.

---

### Task 5: Whole-suite verification

**Files:** none new.

- [ ] **Step 1:** `pnpm test` → every suite green (the count grows by three
  in `runs-view`, six in `run-time`, eleven plus the records case(s) in
  `run-watchdog`, five in `watchdog-monitor`; nothing else moves).
- [ ] **Step 2:** `pnpm run typecheck` → clean.
- [ ] **Step 3:** `pnpm run build` → succeeds; `WatchdogMonitor` still lands
  in the Runs lazy chunk (no import from `lib/` pulled a React component
  across chunk lines — the two new lib exports are pure).
- [ ] **Step 4:** Read `git diff --stat` in the worktree: the changed set is
  exactly `RunsView.tsx`, `WatchdogMonitor.tsx`, `styles.css`,
  `run-time.ts`, `run-watchdog.ts`, four test files, `CLAUDE.md`, the
  2026-09-05 spec. Anything under `server/`, `shared/` or `hooks/` in that
  list is a mistake to undo.

## Self-review against the spec

- §2 bar → Task 1 (order, divider, its condition, CLAUDE.md sentence).
- §3.1 tiles, §3.2 cards → Task 3, every element and every test id named
  there; the `0 crashed` no-glyph rule and the sibling-glyph verdict are in
  Task 3 Steps 4–5.
- §3.3 table → Task 4 Step 3; §3.4 layout and styling → Task 3 Step 6 and
  Task 4 Step 4, including "replace, don't keep beside" and the 700px note.
- §4 library → Task 2, signatures identical to the spec's, values pinned.
- §5 documents → Task 1 Step 6, Task 4 Steps 6–7.
- §6 testing → every case listed in the spec appears in Tasks 1–4 with the
  same expected values (`0.7`, `480_000`, `4`/`900`, `1020`, `42`→`37`,
  `8m`).
- Non-goals honoured: no file under `server/`, `shared/` or `hooks/` is
  touched; `stateLine` and `watchdogClause` are called, never edited; no
  9.5m tick.
- Type consistency: `freshnessFraction(updatedAt, now)`,
  `sweepFraction(status, now)`, `graceRemainingMs(w, config, now)`,
  `WATCHDOG_KIND_GLYPH`, `WATCHDOG_KIND_TONE`, `WatchdogKindTone` are
  spelled identically in Tasks 2, 3 and 4 and in the CLAUDE.md text.
