# Runs View Redesign (range picker, stage track, machine time) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **OVERRIDE — tests are cases, not code.** This plan deliberately does NOT
> hand you literal test or implementation code, overriding the
> writing-plans template's "code blocks required" rule. Handed code gets
> transcribed verbatim, bugs included, with nobody positioned to catch
> them (7 defects traced to plan-text code in each of two prior projects
> in this workspace). The plan gives exact type definitions and signatures
> (those ARE the contract), exact class names, test ids and copy, and exact
> test CASES — name, setup, input, expected observable result. You write
> the test bodies and the implementation; if a case seems wrong, stop and
> say so rather than transcribing it.

> **Size budgets are soft.** Any line-count or brevity target in this plan
> is a target, not a gate — never compress away a rationale comment or a
> test case to hit one. This repo's comments explain *why*, at length; match
> the density of the file you are editing.

**Goal:** Make the Runs section's detail pane legible — per-item stage
times on a full-width seven-node track, a run-level and range-level
"machine time by stage" breakdown — and add a Today / This week / This
month / All range control that scopes the whole section.

**Architecture:** Client only. Two new pure lib pieces (`run-range.ts`, and
`runStageTotals(run, now)` + `sumStageTotals` in `run-stats.ts`) feed two
new presentational components (`StageBars`, `StageTrack`) that `RunDetail`
and `RunsView` compose. One existing helper (`RowTime`) moves out of
`RunDrawer` into a shared file so the drawer, the pane and the tiles read
an item's duration through the single implementation that already
excludes queue wait (`itemDurationMs`). No server, API, shared-type or
`orchestrate.mjs` change.

**Tech Stack:** React 18 + Vite (client), Jest (`pnpm test`, `--runInBand`;
component suites opt into jsdom with a `@jest-environment jsdom`
docblock), `@testing-library/react` + `user-event`, TypeScript
(`pnpm run typecheck`), shared types in `shared/types.ts` (read-only here).

**Spec:** `docs/superpowers/specs/2026-09-02-runs-view-redesign-design.md`
— read it first. Every definition below (queue wait, item work time, open
span, machine time, range windows) is stated there once with its reason;
this plan only tells you where each one lands.

## Global Constraints

- **pnpm only.** `pnpm test` (jest, `--runInBand`), `pnpm run typecheck`,
  `pnpm run build`. Never npm/yarn.
- **Tests are flat in `test/`**, `*.test.ts` / `*.test.tsx`; component
  suites carry the `@jest-environment jsdom` docblock as their first lines.
- **No change to `server/`, `shared/types.ts`, or
  `skills/backlog-orchestrate/tools/orchestrate.mjs`.** If a task seems to
  need one, stop — the spec's Non-goals rule it out.
- **Lib functions take `now` as a parameter, never call `Date.now()`
  internally**, and return `null` / skip the entry on an unparseable stamp
  instead of throwing (run-time.ts and run-stats.ts both state this rule in
  their file headers; keep to it).
- **Colour vocabulary is closed.** Only existing theme tokens (`--cyan`,
  `--good`/`--green`, `--amber`, `--red`, `--mustard`, `--ink*`,
  `--hairline*`, `--steel`, `--strip`, `--strip-hi`). No new hue; text never
  wears a data colour (values print in `--ink`/`--ink2`/`--ink3`).
- **`RunDrawer`'s rendered output must not change.** These suites must pass
  with zero edits after every task: `test/orchestrator-drawer.test.tsx`,
  `test/run-time-ui.test.tsx`, `test/orchestrator-strip.test.tsx`,
  `test/run-stepper-style.test.ts`.
- **Comments explain why.** Every new file gets a header comment in the
  house register (what it is, why it exists, what it deliberately is not);
  every deleted piece of code takes its rationale comment with it and
  leaves a pointer where the replacement's reasoning now lives.
- **Git:** branch `feature/runs-view-redesign` off `main` before Task 1.
  One commit per task, message in the repo's `type(scope): summary` style.
  Never push. The working tree already holds two unrelated modified files
  (`server/src/agents/prompt.util.ts`, `test/agents-prompt.test.ts`) — never
  stage them; `git add` explicit paths only.

## File Structure

| File | Responsibility |
|---|---|
| `client/src/lib/run-range.ts` (new) | The four range keys, their two label sets, and the calendar-window arithmetic (`rangeStart`, `inRange`). Pure, local-time, `now` in. |
| `client/src/lib/run-time.ts` | Gains `itemQueueWaitMs`. Already owns `itemDurationMs`, `inStageMs`, `isTerminalStage`, `stepperDots`, `STEPPER_STAGES`, the formatters. |
| `client/src/lib/run-stats.ts` | Loses `itemWallMs`; `aggregateRuns` reports `avgItemWorkMs` via `itemDurationMs`; `runStageTotals(run, now)` becomes machine time; gains `MACHINE_STAGES`, `StageTotals`, `sumStageTotals`. |
| `client/src/components/board/RunRowTime.tsx` (new) | `RowTime` + `TIMELESS_STAGES`, moved verbatim out of `RunDrawer.tsx`; both surfaces import it. |
| `client/src/components/runs/StageBars.tsx` (new) | Seven-row horizontal bar widget over a `StageTotals`. Used twice (pane, wide tile). |
| `client/src/components/runs/StageTrack.tsx` (new) | The full-width seven-node track for one queue item. |
| `client/src/components/runs/RunDetail.tsx` | Composes rollup + item cards (RowTime, lead line, StageTrack); ticks via `useNow`. |
| `client/src/components/runs/RunsView.tsx` | Range state + control, range filter, wide tile, `avg item work` relabel, range-empty note. |
| `client/src/styles.css` | New `.runs-seg*`, `.runs-tile-wide`/`.runs-tile-head`, `.run-bars*`, `.run-track*`, `.run-detail-lead`/`-sub`/`-rollup`; deletes `.run-detail-stagebar`, `.run-detail-seg`, `.run-detail-caption`, `.run-seg-*`. |
| `CLAUDE.md`, `docs/invariants.md` | Layout bullet update; new invariant "queue wait is not work". |

---

### Task 1: `lib/run-range.ts` — calendar windows

**Files:**
- Create: `client/src/lib/run-range.ts`
- Test: `test/run-range.test.ts`

**Interfaces:**
- Consumes: nothing from this plan.
- Produces (exact):
  ```ts
  export const RUN_RANGES = ['today', 'week', 'month', 'all'] as const;
  export type RunRange = (typeof RUN_RANGES)[number];
  /** Button copy, in the toolbar: Today / This week / This month / All */
  export const RANGE_BUTTON: Record<RunRange, string>;
  /** Scope copy, in the wide tile's substat: today / this week / this month / all runs */
  export const RANGE_SCOPE: Record<RunRange, string>;
  /** Local-calendar window start as epoch ms; `null` for 'all' (no window). */
  export function rangeStart(range: RunRange, now: number): number | null;
  /** Is a run whose `startedAt` is this ISO string inside the window? */
  export function inRange(startedAt: string, range: RunRange, now: number): boolean;
  ```

Behaviour (from the spec's "Range" definition): all arithmetic in the
viewer's local time via `new Date(now)` + `setHours(0, 0, 0, 0)`;
`today` = that midnight; `week` = that midnight minus `(getDay() + 6) % 7`
days (Monday-based; a Sunday belongs to the week that started six days
earlier); `month` = that midnight with `setDate(1)`; `all` → `null`.
`inRange`: `all` → `true` for every input, parseable or not; otherwise
`Date.parse(startedAt)`, `NaN` → `false`, else `at >= start` (inclusive).
File header: why local not UTC (the same reason `dayKey` gives), why keyed
on `startedAt` (the day groups already are), why calendar-aligned rather
than rolling (so "today" and "this week" mean what a person means by them).

- [ ] **Step 1: Write the failing tests** in `test/run-range.test.ts`.
  Build every `now` with the local `Date` constructor
  (`new Date(2026, 8, 2, 14, 7).getTime()`), never an ISO string, so the
  suite passes in any timezone. Cases:
  1. `rangeStart('today', Wed 2026-09-02 14:07)` equals
     `new Date(2026, 8, 2).getTime()`.
  2. `rangeStart('week', Wed 2026-09-02 14:07)` equals
     `new Date(2026, 7, 31).getTime()` (Monday Aug 31).
  3. `rangeStart('week', Sun 2026-09-06 23:59)` equals the same Monday
     Aug 31 — not Monday Sep 7.
  4. `rangeStart('week', Mon 2026-08-31 00:00:00.000)` equals that exact
     instant (a Monday midnight is its own week start).
  5. `rangeStart('month', 2026-09-02 14:07)` equals
     `new Date(2026, 8, 1).getTime()`; `rangeStart('month', 2026-09-01 00:00)`
     equals that exact instant.
  6. `rangeStart('all', anything)` is `null`.
  7. `inRange` is inclusive at the boundary: a `startedAt` equal to the
     window start (as ISO) is in; one millisecond earlier is out.
  8. `inRange('garbage', r, now)` is `false` for `today`/`week`/`month`
     and `true` for `all`.
  9. `RUN_RANGES` is exactly `['today','week','month','all']` in that
     order; `RANGE_BUTTON` is `{today:'Today', week:'This week',
     month:'This month', all:'All'}`; `RANGE_SCOPE` is `{today:'today',
     week:'this week', month:'this month', all:'all runs'}`.
- [ ] **Step 2: Run** `pnpm test -- test/run-range.test.ts` — expect
  failure: module not found.
- [ ] **Step 3: Implement** `client/src/lib/run-range.ts` per the
  behaviour above, with the header comment.
- [ ] **Step 4: Run** the suite — all nine pass. `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(runs): add run-range lib (calendar windows)`.

---

### Task 2: lib — queue wait, machine time, work-time average

**Files:**
- Modify: `client/src/lib/run-time.ts` (add one export beside `itemDurationMs`)
- Modify: `client/src/lib/run-stats.ts`
- Test: `test/run-time.test.ts`, `test/run-stats.test.ts`

**Interfaces:**
- Consumes: `itemDurationMs`, `inStageMs`, `isTerminalStage`, `itemStageSpans` (all existing).
- Produces (exact):
  ```ts
  // run-time.ts
  /** pending stamp → first non-pending arrival; null when either is missing/unparseable. */
  export function itemQueueWaitMs(item: Pick<RunQueueItem, 'stageAt'>): number | null;

  // run-stats.ts
  /** Pipeline order. The seven stages that are the orchestrator working — never `pending`, never an exit. */
  export const MACHINE_STAGES: readonly RunStage[] =
    ['preflight', 'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging'];
  export type StageTotals = Partial<Record<RunStage, number>>;
  export function runStageTotals(
    run: { queue: readonly Pick<RunQueueItem, 'stage' | 'stageAt'>[] },
    now: number
  ): StageTotals;
  export function sumStageTotals(totals: readonly StageTotals[]): StageTotals;
  export interface RunAggregates { /* unchanged fields, except: */ avgItemWorkMs: number | null; /* replaces avgItemWallMs */ }
  // REMOVED: itemWallMs
  ```

Behaviour:
- `itemQueueWaitMs`: parse `stageAt.pending`; take the private
  `startedAtMs(item)`; `null` if either is `null`; else
  `Math.max(0, start - pending)`. Doc comment: this is the one interval
  that is not work on the item, and why the pane prints it as context only.
- `runStageTotals(run, now)`: for every item, add each `itemStageSpans`
  span whose `stage` is in `MACHINE_STAGES`; then, if
  `!isTerminalStage(item.stage) && MACHINE_STAGES.includes(item.stage)`,
  add `inStageMs(item, now)` (skip when `null`) to `item.stage`. Nothing
  else — `pending` spans and spans labelled by a terminal stage are
  dropped. Rewrite its doc comment: what "machine time" is, why `pending`
  is out (summing five items' queue waits would report four run-lengths of
  nothing), why the open span is in (a live run's rollup must move).
- `sumStageTotals`: field-wise sum; `{}` for an empty list.
- `aggregateRuns`: `avgItemWorkMs` = mean of `itemDurationMs(item, now)`
  over items with `stage === 'merged'` where the result is not `null`;
  `null` when none qualify. The `now` parameter is now genuinely read —
  replace the "deliberately goes unread" comment before the `return` with
  the new truth (it reaches `itemDurationMs`, which ignores it for a
  terminal item; it is still not folded into any run-wall average, and that
  half of the old comment stays).
- Delete `itemWallMs` and its doc comment. Rewrite the file header's
  paragraph that argues against importing `run-time.ts`: the reason it now
  imports `itemDurationMs`/`inStageMs`/`isTerminalStage` is that "how long
  did this item take" must have exactly one implementation — the drawer,
  the pane and the tiles disagreed by the whole queue wait (real run
  `run-20260901-112815`: bug-7 read 161m in the pane, 25m in the drawer).
  `parseStamp` may stay a private duplicate; say why in one line.

- [ ] **Step 1: Write the failing tests.**
  `test/run-time.test.ts` (existing helpers `T0`, `at(offsetMs)`,
  `queueItem(stage, stageAt)`), new `describe('itemQueueWaitMs')`:
  1. `{pending: at(0), preflight: at(15_000), dispatched: at(40_000)}` → `15_000`.
  2. `{pending: at(0), dispatched: at(20_000)}` (no preflight) → `20_000`.
  3. `{pending: at(0)}` alone → `null`.
  4. `{dispatched: at(20_000)}` (no pending) → `null`.
  5. `{pending: 'garbage', dispatched: at(20_000)}` → `null`.

  `test/run-stats.test.ts` (existing helpers `T0`, `at`, `withStageAt`,
  `archiveItem`, `archiveRun`):
  6. Delete the `describe('itemWallMs')` block and the import.
  7. `MACHINE_STAGES` equals the seven stages in the stated order.
  8. Rewrite case 7 (`runStageTotals` "sums each stage span across every
     item"): same two merged items as today; expected is now
     `{ dispatched: 60_000 }` — `pending` no longer appears. Add a second
     `now` argument (`T0`); it must not matter for terminal items.
  9. New: a live item (`stage: 'fixing'`, `stageAt: {pending: at(0),
     dispatched: at(10_000), fixing: at(30_000)}`), `now = T0 + 90_000` →
     `{ dispatched: 20_000, fixing: 60_000 }`.
  10. New: a terminal-labelled span is excluded and a terminal item adds no
      open span: `stage: 'parked'`, `stageAt: {pending: at(0), dispatched:
      at(10_000), parked: at(30_000)}`, `now = T0 + 999_000` →
      `{ dispatched: 20_000 }`.
  11. New: a live item whose current stage is not machine time
      (`stage: 'pending'`, `stageAt: {pending: at(0)}`) → `{}`.
  12. New `describe('sumStageTotals')`: `[]` → `{}`;
      `[{dispatched: 1_000, fixing: 500}, {dispatched: 2_000}]` →
      `{dispatched: 3_000, fixing: 500}`.
  13. Case 8 (`aggregateRuns` main fixture): rename the assertion to
      `avgItemWorkMs` and give each of the three merged items a
      `dispatched: at(50_000)` stamp so work time is 50 s shorter than the
      old first→last reading; expected `avgItemWorkMs` is `150_000` (the
      old rule would say `200_000` — say so in the comment, that difference
      is what this case now pins).
  14. New: "avg item work excludes queue wait": one merged item
      `{pending: at(0), preflight: at(3_600_000), merged: at(3_660_000)}`
      → `avgItemWorkMs` is `60_000`, not `3_660_000`.
  15. Case 9 (empty list): `avgItemWorkMs: null`.
- [ ] **Step 2: Run** `pnpm test -- test/run-time.test.ts test/run-stats.test.ts`
  — expect failures (missing exports, wrong numbers).
- [ ] **Step 3: Implement** per the behaviour above; `pnpm run typecheck`
  will now fail in `RunsView.tsx` (`avgItemWallMs`) and `RunDetail.tsx`
  (`itemWallMs`, `runStageTotals` arity) — fix ONLY the minimum to compile:
  `RunsView` reads `avgItemWorkMs`; `RunDetail` replaces its `itemWallMs`
  call with `itemDurationMs(row, now)` (Task 6 rewrites that row anyway).
  Expect `test/run-detail.test.tsx` case 1's `"10m"` assertion and
  `test/runs-view.test.tsx`'s "aggregate tile numbers" case to go red on
  the avg number — that is correct and is fixed in Tasks 6/7; do not paper
  over it here.
- [ ] **Step 4: Run** the two lib suites — green. `pnpm run typecheck` — green.
- [ ] **Step 5: Commit** — `fix(runs): item work time excludes queue wait; machine-time totals`.

---

### Task 3: Move `RowTime` to a shared file

**Files:**
- Create: `client/src/components/board/RunRowTime.tsx`
- Modify: `client/src/components/board/RunDrawer.tsx` (delete `TIMELESS_STAGES` and `RowTime`, import both)
- Test: none new. `test/run-time-ui.test.tsx` and `test/orchestrator-drawer.test.tsx` are the contract and stay untouched.

**Interfaces:**
- Produces (exact):
  ```ts
  export const TIMELESS_STAGES: readonly RunStage[];   // ['ungroomed', 'skipped'], moved verbatim
  export function RowTime({ item, now, testIdPrefix = 'run-drawer-time' }: {
    item: Pick<RunQueueItem, 'id' | 'stage' | 'stageAt'>;
    now: number;
    testIdPrefix?: string;
  }): JSX.Element | null;
  ```
  Class stays `run-drawer-item-time`; test id is `${testIdPrefix}-${item.id}`.
  The drawer passes nothing new, so its DOM is byte-identical.

- [ ] **Step 1: Baseline** — `pnpm test -- test/run-time-ui.test.tsx test/orchestrator-drawer.test.tsx` green.
- [ ] **Step 2: Move.** Cut `TIMELESS_STAGES` and `RowTime` (with their doc
  comments) into the new file; widen the prop to the `Pick` above; add the
  `testIdPrefix` prop with its default. Header comment: why it lives in
  `board/` (the drawer was its first reader, and `RunDetail` already
  imports `ACTIVE_RUN_STAGES` from `../board/ItemCard`, so `runs/`
  reading from `board/` has precedent) and why it is shared at all (one
  implementation of an item's time reading for both surfaces — the pane's
  own version counted queue wait, see Task 2). `RunDrawer.tsx` imports both.
- [ ] **Step 3: Run** the two suites again — green with zero edits.
  `pnpm run typecheck`.
- [ ] **Step 4: Commit** — `refactor(runs): share RowTime between drawer and detail pane`.

---

### Task 4: `StageBars` component

**Files:**
- Create: `client/src/components/runs/StageBars.tsx`
- Modify: `client/src/styles.css` (new `.run-bars*` block, appended after the run-detail block)
- Test: `test/stage-bars.test.tsx` (jsdom)

**Interfaces:**
- Consumes: `MACHINE_STAGES`, `StageTotals` (Task 2); `formatSpanCompact` (run-time).
- Produces (exact):
  ```ts
  export function StageBars({ totals, testId }: { totals: StageTotals; testId: string }): JSX.Element;
  ```

Markup (exact classes/test ids): root `div.run-bars` with
`data-testid={testId}`; one `div.run-bars-row` per `MACHINE_STAGES` entry,
in that order, `data-testid={`${testId}-${stage}`}`, containing
`span.run-bars-label` (the stage name), `span.run-bars-track` (contains
`span.run-bars-fill` with inline `width: <pct>%` and `aria-hidden="true"`
only when the value is > 0), and `span.run-bars-value` (plus
`run-bars-value-none` when absent/zero) whose text is
`formatSpanCompact(ms)` or `—`. `pct = ms / max * 100` where `max` is the
largest of the seven values (floor 1 to avoid `/0`), formatted with one
decimal.

CSS (spec "StageBars"): `.run-bars{display:flex;flex-direction:column;gap:5px}`;
`.run-bars-row{display:grid;grid-template-columns:80px 1fr 60px;align-items:center;gap:8px}`;
`.run-bars-label{font-family:var(--mono);font-size:10px;color:var(--ink2)}`;
`.run-bars-track{position:relative;height:6px;border-left:1px solid var(--hairline2)}`;
`.run-bars-fill{position:absolute;left:0;top:0;height:6px;background:var(--cyan);border-radius:0 3px 3px 0;min-width:2px}`;
`.run-bars-value{font-family:var(--mono);font-size:10.5px;color:var(--ink);text-align:right;font-variant-numeric:tabular-nums}`;
`.run-bars-value-none{color:var(--ink3)}`. Comment block: one series → one
hue; why cyan (the tone every machine stage already wears on its chip);
why the row set is fixed and ordered; why the value sits in ink not cyan;
why no in-bar labels and no track background (the `—` says "nothing").

- [ ] **Step 1: Write the failing tests** (`test/stage-bars.test.tsx`):
  1. Renders exactly seven `[data-testid^="<testId>-"]` rows, in
     `MACHINE_STAGES` order, each labelled with its stage name.
  2. Values use `formatSpanCompact`: `{dispatched: 26_760_000}` → row text
     contains `7h 26m`; `{merging: 23_000}` → `23s`.
  3. An absent stage prints `—`, carries `run-bars-value-none`, and its
     track contains no `.run-bars-fill`.
  4. Widths scale to the largest value: `{dispatched: 1_000, fixing: 500}`
     → fills have `width: 100.0%` and `width: 50.0%`.
  5. Empty totals `{}` → seven `—` rows and zero fills (the widget never
     hides).
- [ ] **Step 2: Run** the suite — fails (module missing).
- [ ] **Step 3: Implement** component + CSS + comments.
- [ ] **Step 4: Run** — green. `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(runs): StageBars widget`.

---

### Task 5: `StageTrack` component

**Files:**
- Create: `client/src/components/runs/StageTrack.tsx`
- Modify: `client/src/styles.css` (new `.run-track*` block after `.run-bars*`)
- Test: `test/stage-track.test.tsx` (jsdom)

**Interfaces:**
- Consumes: `stepperDots`, `STEPPER_STAGES`, `itemStageSpans`, `inStageMs`, `formatSpan`, `formatClock` (existing libs).
- Produces (exact):
  ```ts
  export function StageTrack({ item, now }: {
    item: Pick<RunQueueItem, 'id' | 'stage' | 'stageAt' | 'fixLoops'>;
    now: number;
  }): JSX.Element | null;   // null when item.stage === 'ungroomed'
  ```

Markup (exact): root `div.run-track` `data-testid={`run-track-${id}`}`.
For each `dot` of `stepperDots(item)` at index `i` (seven, in
`STEPPER_STAGES` order): `div.run-track-node`
`data-testid={`run-track-${id}-${dot.stage}`}` with `data-in` and
`data-out` attributes, containing:
- `span.run-track-dot.run-track-dot-<dot.state>` (`filled` | `current` | `hollow`), `aria-hidden="true"`;
- when `dot.stage === 'fixing' && item.fixLoops > 0`:
  `span.run-track-loops` `data-testid={`run-track-${id}-loops`}`, text
  `×${fixLoops}`, `title` and `aria-label` both `${n} fix loop` /
  `${n} fix loops`;
- `span.run-track-name.run-track-name-<dot.state>` — the stage name;
- the value span `data-testid={`run-track-${id}-${dot.stage}-val`}`:
  - `dot.state === 'current'` → `span.run-track-val`, text
    `formatSpan(inStageMs(item, now))`, or `—` (with `run-track-val-none`)
    when that is `null`;
  - `dot.stage === 'merged'` and visited → `span.run-track-val.run-track-val-when`,
    text `formatClock(stageAt.merged) ?? '—'`;
  - visited with a span in `itemStageSpans(item)` labelled by this stage →
    `span.run-track-val`, text `formatSpan(span.ms)`;
  - otherwise `span.run-track-val.run-track-val-none`, text `—`.

Segment states: `last` = highest `i` whose `dot.state !== 'hollow'` (−1 if
none). `data-in` = `'none'` for `i === 0`; else `'live'` when
`i <= last && dot.state === 'current'`; else `'done'` when `i <= last`;
else `'idle'`. `data-out` = `'none'` for `i === 6`; else `'done'` when
`i < last`; else `'idle'`. (A hollow node between two visited ones thus
sits on a green line — the spec's "passed through without stopping".)

CSS (spec "StageTrack"; the file's reduced-motion block already zeroes
every animation, so no new media rule is needed):
`.run-track{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));margin-top:8px}`;
`.run-track-node{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;padding-top:2px;min-width:0}`;
`.run-track-node::before,.run-track-node::after{content:'';position:absolute;top:6px;height:2px;background:var(--hairline)}`;
`.run-track-node::before{left:0;right:calc(50% + 6px)}`; `.run-track-node::after{left:calc(50% + 6px);right:0}`;
`[data-in="none"]::before`, `[data-out="none"]::after` → `display:none`;
`[data-in="done"]::before`, `[data-out="done"]::after` → `background:var(--good)`;
`[data-in="live"]::before` → a 90° gradient `35% cyan → cyan → 35% cyan`
(via `color-mix`), `background-size:200% 100%`, `animation:run-track-sweep 1.6s linear infinite`
with `@keyframes run-track-sweep{from{background-position:100% 0}to{background-position:-100% 0}}`;
`.run-track-dot{width:10px;height:10px;border-radius:50%;border:2px solid var(--hairline2);background:var(--strip);box-sizing:border-box;z-index:1}`;
`.run-track-dot-filled{background:var(--good);border-color:var(--good)}`;
`.run-track-dot-current{background:var(--cyan);border-color:var(--cyan);animation:run-track-ring 2s ease-in-out infinite}` with a
`box-shadow` ring keyframe (3px at 30% cyan → 6px at 10% cyan);
`.run-track-name{font-family:var(--mono);font-size:10px;color:var(--ink2);letter-spacing:.02em;margin-top:3px;max-width:100%;overflow:hidden;text-overflow:ellipsis}`,
`-hollow{color:var(--ink3)}`, `-current{color:var(--ink)}`;
`.run-track-val{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}`,
`-none{color:var(--ink3);font-weight:400}`, `-when{color:var(--ink2);font-weight:400}`;
`.run-track-loops{position:absolute;left:calc(50% + 9px);top:-3px;font-family:var(--mono);font-size:9px;font-weight:600;color:var(--ink);background:var(--strip-hi);border:1px solid var(--hairline2);border-radius:2px;padding:0 3px;line-height:14px;z-index:2}`;
under `@media (max-width:700px)`: `.run-track-name{font-size:8px}` `.run-track-val{font-size:10.5px}`.
Comment block: why seven nodes and not eight (the drawer's own reason,
`STEPPER_STAGES`), why equal columns not time-proportional (the stepper
CSS comment's "position indicator, not a time axis" — the numbers under
the nodes now carry the time), why the hollow-on-green reading, why the
sweep is the only motion.

- [ ] **Step 1: Write the failing tests** (`test/stage-track.test.tsx`; a
  local builder `trackItem(id, stage, stageAt, fixLoops = 0)` returning the
  `Pick`; a fixed `T0` and `at(offset)` like run-time.test.ts):
  1. Seven nodes, test ids `run-track-x-<stage>` in `STEPPER_STAGES` order,
     each containing its stage name.
  2. Finished merged item with `{pending: at(0), preflight: at(15_000),
     dispatched: at(60_000), inspecting: at(360_000), reviewing:
     at(380_000), verifying: at(700_000), merging: at(760_000), merged:
     at(772_000)}`: `dispatched-val` reads `5m 00s`; `inspecting-val`
     `20s`; `reviewing-val` `5m 20s`; `verifying-val` `1m 00s`;
     `merging-val` `12s`; `fixing` node has `run-track-dot-hollow`,
     `fixing-val` is `—` with `run-track-val-none`, and the node has
     `data-in="done"` and `data-out="done"`; `merged-val` has
     `run-track-val-when` and reads `formatClock(at(772_000))`; first node
     `data-in="none"`, last node `data-out="none"`.
  3. Live item at `fixing`, `fixLoops: 1`, `{pending: at(0), dispatched:
     at(10_000), inspecting: at(20_000), reviewing: at(30_000), fixing:
     at(40_000)}`, `now = T0 + 684_000`: fixing dot `run-track-dot-current`,
     node `data-in="live"`, `fixing-val` reads `10m 44s`; `verifying`,
     `merging`, `merged` nodes are hollow with `data-in="idle"` and `—`;
     badge `run-track-x-loops` reads `×1` with `aria-label="1 fix loop"`.
  4. `fixLoops: 2` → `×2`, `aria-label="2 fix loops"`; `fixLoops: 0` → no
     `run-track-x-loops` in the document.
  5. `pending` item with `{pending: at(0)}`: a track renders; all seven
     dots hollow; every `data-in`/`data-out` is `none` or `idle`; no
     `live` anywhere.
  6. `ungroomed` item → component returns `null` (no `run-track-x`).
  7. `parked` item with `{pending, dispatched, inspecting}` stamps: dots
     filled through `inspecting`, no `run-track-dot-current` anywhere,
     `merged-val` is `—` (not a clock).
  8. Current stamp unparseable (`fixing: 'garbage'`, stage `fixing`) →
     `fixing-val` is `—` with `run-track-val-none`.
  9. `now` drives the current value: render with `now`, `rerender` with
     `now + 60_000` → `fixing-val` advances by exactly one minute (pins
     that the component never reads `Date.now()` itself).
- [ ] **Step 2: Run** — fails (module missing).
- [ ] **Step 3: Implement** component + CSS + comments.
- [ ] **Step 4: Run** — green. `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(runs): StageTrack — full-width stage stepper with durations`.

---

### Task 6: `RunDetail` — rollup, item cards, live tick

**Files:**
- Modify: `client/src/components/runs/RunDetail.tsx`
- Modify: `client/src/styles.css` — delete `.run-detail-stagebar`, `.run-detail-seg`, `.run-detail-caption`, the six `.run-seg-*` rules and their comment blocks; add `.run-detail-sub`, `.run-detail-rollup`, `.run-detail-lead`
- Test: `test/run-detail.test.tsx`

**Interfaces:**
- Consumes: `useNow(enabled, periodMs)` (`hooks/useNow.ts`); `StageBars`
  (Task 4); `StageTrack` (Task 5); `RowTime` (Task 3); `runStageTotals`,
  `itemQueueWaitMs`, `itemStageSpans`, `formatSpan`, `formatSpanCompact`.
- Produces: the pane's test ids the RunsView suite may lean on:
  `run-detail-machine` (+ `-<stage>` rows), `run-detail-lead-<id>`,
  `run-detail-item-time-<id>`, `run-track-<id>` (+ `-<stage>`, `-<stage>-val`, `-loops`).

Changes:
1. `const now = useNow(live !== null, 1_000);` replaces `Date.now()`.
   Comment: the current node's duration, the active row's `elapsed` and
   the live rollup row must move every second — the 5s poll alone makes
   them jump; `useNow(false)` installs no interval, so an archived
   selection stays a pure function of its props.
2. Derive one source object: `const source = live ?? fetchedRun ?? summary;`
   — rows come from it exactly as today (the two mapping functions stay),
   and the rollup reads `runStageTotals(source, now)` from the same object
   so rows and bars can never disagree.
3. After the chips (and the fetch-error note, when shown): a
   `.run-detail-heading` reading `Machine time by stage` with a
   right-aligned `span.run-detail-sub` reading `queue wait excluded`, then
   `div.run-detail-rollup` containing
   `<StageBars totals={runStageTotals(source, now)} testId="run-detail-machine" />`.
4. Item card: head keeps id / title / stage chip and replaces the
   `run-drawer-item-time` span with
   `<RowTime item={row} now={now} testIdPrefix="run-detail-item-time" />`.
   Below the head, a `div.run-detail-lead`
   `data-testid={`run-detail-lead-${id}`}` whose text joins with ` · ` the
   parts that exist: `queue ${formatSpanCompact(itemQueueWaitMs(row))}`
   and `preflight ${formatSpan(ms)}` where `ms` is the `preflight`-labelled
   span from `itemStageSpans(row)`; the element is omitted when both are
   unknown. Then `<StageTrack item={row} now={now} />`. The stage bar, its
   caption and the `N fix loop(s)` line are deleted (the badge carries the
   count). Verification `<details>` unchanged.
5. Styles: `.run-detail-heading` gets `display:flex;align-items:baseline;gap:8px`
   so the sub-label can sit at its right (`.run-detail-sub{margin-left:auto;font-family:var(--mono);text-transform:none;letter-spacing:.02em;font-weight:400}`);
   `.run-detail-rollup{background:var(--steel);border:1px solid var(--hairline);border-radius:2px;padding:10px 12px}`
   with `.run-detail-rollup .run-bars-row{grid-template-columns:80px 1fr 60px}`;
   `.run-detail-lead{font-family:var(--mono);font-size:10px;color:var(--ink3)}`.
6. File header comment: replace the "segmented per-item stage bar"
   paragraph with the track + rollup story, and record the queue-wait
   defect that motivated sharing `RowTime` (bug-7, 161m vs 25m).

- [ ] **Step 1: Update and write tests** in `test/run-detail.test.tsx`
  (helpers `archiveItem`, `liveItem`, `primarySummary`, `primaryFull`,
  `mockFetchArchivedRun`; import `formatClock` from run-time for
  timezone-safe clock expectations):
  1. Delete the two cases `stage bar renders one segment per span with the
     tone class` and `renders no stage bar or caption for an item with no
     recorded spans`.
  2. Give `a-1` a `dispatched: '2026-09-01T09:02:00.000Z'` stamp in BOTH
     `primarySummary()` and `primaryFull()`; the header/chips case now
     expects `run-detail-item-time-a-1` to read
     `8m 00s · ${formatClock('2026-09-01T09:10:00.000Z')}` (was `10m`).
  3. New "item time excludes queue wait" — fixture modelled on the real
     measurement: one merged item `{pending: 09:00:00Z, preflight:
     11:16:00Z, dispatched: 11:17:00Z, merged: 11:41:00Z}` →
     `run-detail-item-time-<id>` reads `25m 00s · ${formatClock(11:41)}`
     and does not contain `2h 41m`; `run-detail-lead-<id>` reads
     `queue 2h 16m · preflight 1m 00s`.
  4. New "lead line is omitted when nothing is known": an item with
     `stageAt: {}` and one with `{pending}` only → no
     `run-detail-lead-<id>` for either; an item with `{pending,
     dispatched}` → lead reads `queue <wait>` with no ` · preflight` part.
  5. New "rollup sums machine time across items and excludes queue wait":
     two items whose `dispatched` spans are 5m and 10m, `pending` spans
     present → `run-detail-machine-dispatched` reads `15m`;
     `run-detail-machine-preflight` reads `—`; exactly one element has
     test id `run-detail-machine`.
  6. New "live selection ticks every second and an archived one installs no
     timer": `jest.useFakeTimers()`; a `live` run whose item is `fixing`
     with `fixing` stamped `new Date(Date.now() - 600_000).toISOString()`
     → `run-track-<id>-fixing-val` reads `10m 00s`;
     `act(() => jest.advanceTimersByTime(1_000))` → `10m 01s`; the
     `run-detail-machine-fixing` row is not `—`. Then render the archived
     `primarySummary()` with `live={null}` (fetch mock resolving
     `primaryFull()`) and assert `jest.getTimerCount()` is `0` after the
     fetch settles. Restore real timers in `afterEach`.
  7. New "fix loops show as a badge, not a line": `a-1` (fixLoops 1) →
     `run-track-a-1-loops` reads `×1`; within `run-detail-item-a-1` no
     element's text matches `/^\d+ fix loops?$/`; and
     `run-detail-stagebar-a-1` / `run-detail-caption-a-1` are absent.
  8. Every other existing case (tails fetch, details open/closed, stale
     fetch guard, error note, attention list) stays as is and must pass.
- [ ] **Step 2: Run** `pnpm test -- test/run-detail.test.tsx` — the new
  and edited cases fail.
- [ ] **Step 3: Implement** the changes above, delete the dead CSS (grep
  `run-seg-`, `run-detail-stagebar`, `run-detail-seg`, `run-detail-caption`
  across `client/` and `test/` afterwards — zero hits).
- [ ] **Step 4: Run** the suite — green. `pnpm run typecheck`. Run the four
  drawer/strip suites named in Global Constraints — still green.
- [ ] **Step 5: Commit** — `feat(runs): detail pane — stage track, machine-time rollup, live tick`.

---

### Task 7: `RunsView` — range control, wide tile, empty note

**Files:**
- Modify: `client/src/components/runs/RunsView.tsx`
- Modify: `client/src/styles.css` (`.runs-tiles` grid, `.runs-tile-wide`, `.runs-tile-head`, `.runs-seg*`, media queries)
- Test: `test/runs-view.test.tsx`

**Interfaces:**
- Consumes: `RUN_RANGES`, `RunRange`, `RANGE_BUTTON`, `RANGE_SCOPE`, `inRange` (Task 1); `runStageTotals`, `sumStageTotals`, `avgItemWorkMs` (Task 2); `StageBars` (Task 4); existing `pickAuthority`, `aggregateRuns`, `formatSpanCompact`.
- Produces: test ids `runs-range` (group), `runs-range-<key>` (buttons), `runs-tile-machine` (wide tile), `runs-tile-machine-bars` (+ `-<stage>` rows), `runs-empty-range`.

Changes:
1. `const [range, setRange] = useState<RunRange>('all');` — component
   state, not persisted (same as `projectFilter`; say so).
2. `const inScope = merged.filter((m) => inRange(m.run.startedAt, range, now));`
   then the existing project filter runs over `inScope` to produce
   `filtered`. `projects` (the select's options) keeps deriving from
   `merged`, not `filtered` — a range that empties a project must not
   remove it from the select.
3. Toolbar (`.board-tools`, rendered under the same `merged.length > 0`
   guard as the select), before the select:
   `div.runs-seg` `role="group"` `aria-label="Range"` `data-testid="runs-range"`
   with one `button[type=button]` per `RUN_RANGES` entry:
   `data-testid={`runs-range-${r}`}`, `aria-pressed={r === range}`,
   text `RANGE_BUTTON[r]`, `onClick` → `setRange(r)`.
4. Tiles: the avg tile's label becomes `avg item work`, value from
   `aggregates.avgItemWorkMs`, plus a `.runs-tile-substat` line `queue wait
   excluded`. A sixth tile `div.runs-tile.runs-tile-wide`
   `data-testid="runs-tile-machine"`: `div.runs-tile-head` holding
   `.runs-tile-label` `machine time by stage` and a `.runs-tile-substat`
   `span` reading `${RANGE_SCOPE[range]} · queue wait excluded`; then
   `<StageBars totals={machine} testId="runs-tile-machine-bars" />` where
   `machine = sumStageTotals(filtered.map((m) => runStageTotals(pickAuthority([m.live], m.run), now)))`.
5. Inside `.runs-list`, when `filtered.length === 0`:
   `div.drawer-empty` `data-testid="runs-empty-range"` reading
   `no runs in this range`, and no day groups. The detail slot renders
   nothing (its existing `selectedRow !== undefined` guard). The view-level
   `no runs yet` state stays for `merged.length === 0` only.
6. CSS: `.runs-tiles{grid-template-columns:repeat(5,minmax(0,1fr)) minmax(300px,2.3fr)}`;
   `.runs-tile-wide{gap:8px}`; `.runs-tile-head{display:flex;align-items:baseline;gap:8px}`;
   `.runs-tile-head .runs-tile-substat{margin-left:auto}`;
   new `@media (max-width:900px){.runs-tiles{grid-template-columns:repeat(3,minmax(0,1fr))}.runs-tile-wide{grid-column:1/-1}}`;
   in the existing 700px block add `.runs-tile-wide{grid-column:1/-1}`.
   `.runs-seg{display:inline-flex;background:var(--steel);border:1px solid var(--hairline);border-radius:2px;overflow:hidden}`;
   `.runs-seg > button{border:0;background:transparent;font-family:var(--mono);font-size:10px;letter-spacing:.04em;color:var(--ink2);padding:4px 10px;cursor:pointer;transition:color .15s,background .15s}`;
   `.runs-seg > button + button{border-left:1px solid var(--hairline)}`;
   `.runs-seg > button:hover{color:var(--ink)}`;
   `.runs-seg > button[aria-pressed="true"]{color:var(--ink);background:var(--strip-hi);box-shadow:inset 0 -2px 0 var(--cyan)}`;
   `.runs-seg > button:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--cyan)}` (the `.board-select:focus` cyan-rule idiom).
   Comments: why a segmented group and not a select (four fixed options a
   person flips between constantly), why the pressed rule is cyan (the
   rail's `.on` idiom), why the wide tile shares the grid row.
7. File header: add the range control and the wide tile to the section's
   description.

- [ ] **Step 1: Update and write tests** in `test/runs-view.test.tsx`
  (helpers `item`, `liveQueueItem`, `run`, `mockArchive`, `mockRuns`,
  `mockFetchArchivedRun`, `userEvent`). Build time-relative fixtures with
  `new Date(Date.now() - ms).toISOString()`: `A` started 60 s ago (in every
  range), `B` started 40 days ago (in `all` only; never inside a Monday-
  based week or a calendar month — 40 days always crosses the 1st).
  1. Four buttons `runs-range-today|week|month|all` render; only
     `runs-range-all` has `aria-pressed="true"`; the group has
     `aria-label="Range"`.
  2. Clicking `runs-range-today` with `A` and `B` in the archive: only A's
     row remains; `runs-tile-runs` value reads `1`; `runs-range-today` is
     now the pressed one and `runs-range-all` is not.
  3. `today` composed with the project filter set to B's project (A and B
     in different projects): `runs-empty-range` renders with
     `no runs in this range`; `runs-tile-runs` reads `0`; the avg /
     rework / verify tiles read `—`; every `runs-tile-machine-bars-<stage>`
     reads `—`; the project `<select>` still offers both projects.
  4. Clicking back to `runs-range-all` restores both rows (and the
     existing fixture's ordering/pinning cases keep passing untouched).
  5. The avg tile is labelled `avg item work`; in the existing "renders the
     aggregate tile numbers" case, recompute the expected value from
     `itemDurationMs` semantics (first non-`pending` arrival → `merged`
     stamp, per merged item) and document the arithmetic beside the
     assertion as the existing comments do.
  6. Wide tile: `runs-tile-machine` renders seven
     `runs-tile-machine-bars-<stage>` rows in `MACHINE_STAGES` order; with
     `A` carrying a 5-minute `dispatched` span and `B` a 10-minute one,
     `runs-tile-machine-bars-dispatched` reads `15m` under `all` and `5m`
     under `today`; its substat reads `all runs · queue wait excluded` and
     then `today · queue wait excluded`.
  7. Live open span reaches the wide tile: extend the existing live-backed
     aggregate case (`LIVE_RUNS`) so the live run's active item is in
     `fixing` → `runs-tile-machine-bars-fixing` does not read `—`.
- [ ] **Step 2: Run** `pnpm test -- test/runs-view.test.tsx` — new cases fail.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** the suite — green. `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(runs): range control, machine-time tile, range-empty note`.

---

### Task 8: Docs, dead-code sweep, full verification

**Files:**
- Modify: `CLAUDE.md` (Layout bullet for Runs; new Invariants bullet)
- Modify: `docs/invariants.md` (new section)
- Verify: `client/src/styles.css` has no orphaned rules from the old bar

Docs content:
- CLAUDE.md Layout, the `Runs (RunsView …)` clause: mention the range
  control (Today / This week / This month / All, calendar-aligned local
  windows on `startedAt`, scoping tiles, list and rollup together), the
  wide "machine time by stage" tile, and that the detail pane shows the
  same rollup per run plus a full-width seven-node `StageTrack` per item
  with durations under the nodes; `lib/run-range.ts` joins
  `lib/run-stats.ts` in the "pure statistics lib" sentence.
- CLAUDE.md Invariants, new bullet **"Queue wait is not work."** —
  `itemDurationMs` (`client/src/lib/run-time.ts`) is the one
  implementation of "how long did this item take", read by the drawer's
  and the pane's `RowTime`, by `aggregateRuns`' `avgItemWorkMs`, and by
  nothing else; machine time (`runStageTotals`) excludes `pending`.
  `run-stats.ts` used to carry a second rule that spanned first stamp to
  last: real run `run-20260901-112815` read bug-7 as 161m in the pane and
  25m in the drawer — the difference was the four items ahead of it in
  the queue. `MACHINE_STAGES` is the closed list of what counts.
- `docs/invariants.md`: a section with the same title, the measurement,
  the two functions by path, and the rule that a new duration-reading
  surface imports `itemDurationMs` rather than subtracting stamps itself.

- [ ] **Step 1: Write** both doc changes.
- [ ] **Step 2: Sweep** — `grep -rn "run-seg-\|run-detail-stagebar\|run-detail-seg\|run-detail-caption\|itemWallMs\|avgItemWallMs" client/ test/ docs/ CLAUDE.md` → only historical mentions in `docs/superpowers/` may remain.
- [ ] **Step 3: Verify** — `pnpm test` (whole suite), `pnpm run typecheck`,
  `pnpm run build`; all green. Then look at it: with `pnpm run dev` and
  `pnpm run dev:web` (or the running compose stack) open the Runs tab and
  check, against the spec's Layout section, in the midnight and daylight
  themes and at a ~700px width: range buttons flip and re-scope
  everything; wide tile and per-run rollup print seven rows; a live run's
  current node pulses, its value ticks, the entering segment sweeps; a
  finished item's hollow skipped node sits on a green line; `×N` badges;
  no horizontal scroll; `prefers-reduced-motion` stops the sweep and pulse.
- [ ] **Step 4: Commit** — `docs(runs): record the range control, machine time and the queue-wait invariant`.

---

## Plan self-review

- **Spec coverage.** Range definition → Task 1; queue wait / item work
  time / open span / machine time → Task 2; RowTime sharing → Task 3;
  StageBars → Task 4; StageTrack (states, segments, values, badge, a11y,
  motion) → Task 5; detail pane composition, lead line, live tick, dead
  CSS → Task 6; toolbar, tiles, wide tile, range filter, empty note → Task
  7; docs and the new invariant → Task 8. Error-handling rules (`null` →
  `—` / omitted / skipped) are pinned by Task 5 cases 5–8, Task 6 case 4
  and Task 7 case 3.
- **Placeholders.** None — every step names its file, its exact class /
  test id / copy, and its expected values.
- **Type consistency.** `StageTotals`, `MACHINE_STAGES`,
  `runStageTotals(run, now)`, `sumStageTotals`, `avgItemWorkMs`,
  `itemQueueWaitMs`, `RowTime({ item, now, testIdPrefix })`,
  `StageBars({ totals, testId })`, `StageTrack({ item, now })`,
  `RUN_RANGES` / `RunRange` / `RANGE_BUTTON` / `RANGE_SCOPE` /
  `rangeStart` / `inRange` are spelled identically in every task that
  produces or consumes them.
