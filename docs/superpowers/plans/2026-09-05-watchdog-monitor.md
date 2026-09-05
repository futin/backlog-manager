# Watchdog Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Under `backlog-orchestrate`, `backlog-execute` runs the tasks in order and NEVER commits — the run commits once per item; skip every "Commit" step in that setting.

> **Plan style override (repo rule, `~/.claude/CLAUDE.md` → Learnings):** this plan specifies **behaviour and exact test cases, never literal implementation code**. Code blocks below are signatures, copy strings and test-id names — the contract neighbouring tasks rely on — not text to transcribe. Write the tests from the cases as stated; disagree with the plan in a comment if a case is wrong. Every size figure in this plan is a soft target.

**Goal:** Move the watchdog's live surface (phase, watched runs, activity feed) from Settings into the Runs section behind a `Runs | Watchdog` mode switch, leaving Settings with the four knobs alone.

**Architecture:** A new `WatchdogMonitor` component under `client/src/components/runs/` joins two payloads the client already fetches — `GET /api/agents/watchdog` via `useWatchdog` and the live runs array `RunsView` already holds from `useOrchestratorRuns` — into a state card, a watched-run row list and the relocated activity feed. `RunsView` gains a persisted `RunsMode` and renders either its existing body or the monitor. `WatchdogGroup` (Settings) drops its State row and Activity list and stops polling. Two pure helpers move to `lib/` so the strip, the monitor and Settings read one implementation each: `stateLine` (Settings → `lib/run-watchdog.ts`) and `lastReportedEntry` (`RunStrip` → `lib/run-time.ts`). No server change.

**Tech Stack:** React 18 + TypeScript (client), jest `--runInBand` with `@jest-environment jsdom` docblocks for component suites, `@testing-library/react` + `user-event`, existing `usePersistedState`/`useNow` hooks.

**Spec:** `docs/superpowers/specs/2026-09-05-watchdog-monitor-design.md` — read it first; section numbers below (§2, §3.2 …) refer to it.

## Global Constraints

- **No server change.** Nothing under `server/` or `shared/` changes except reading existing exports. `WatchdogStatus`, `OrchestratorRunsPayload`, `RUN_CLAIMED_STAGES`, `WATCHDOG_EVENT_CAP` are consumed as they are.
- **One implementation per sentence.** `stateLine`, `watchdogClause`, `isCrashed` live in `client/src/lib/run-watchdog.ts`; `lastReportedEntry` lives in `client/src/lib/run-time.ts`; `projectLabel` (`lib/project-label.ts`) is the only project-tail printer. No component keeps a private copy.
- **Nothing in Settings is live.** After Task 5, `WatchdogGroup` installs no interval and renders no text that changes on a clock.
- **Copy is exact.** Strings quoted in this plan (`no running run`, `nothing since the server started`, `· not yet watched`, `Configure in Settings › Orchestrator watchdog.`, …) are asserted verbatim by tests; do not paraphrase.
- **Test ids** follow the existing `runs-*` naming: `runs-mode`, `runs-mode-runs`, `runs-mode-watchdog`, `watchdog-state`, `watchdog-state-line`, `watchdog-config-line`, `watchdog-rows`, `watchdog-row`, `watchdog-row-missing`, `watchdog-rows-empty`, `watchdog-events`.
- **Comments explain why, at the repo's existing density.** Every moved function keeps its doc comment; every new module gets one that names the failure or reasoning behind it (the spec's §9 is the source).
- **Run tests per file** with `pnpm test -- test/<file>`; run `pnpm run typecheck` at the end of every task; run the whole `pnpm test` in Task 6.
- **Sequencing.** Land after task-15 (runs-view sweep) has merged; rebase onto its `RunsView.tsx` before Task 4.

---

## File map

| Path | Change | Responsibility after this plan |
|---|---|---|
| `client/src/lib/run-watchdog.ts` | modify | `isCrashed`, `watchdogClause`, **`stateLine`** — every watchdog sentence the client prints |
| `client/src/lib/run-time.ts` | modify | gains **`lastReportedEntry`** (from `RunStrip.tsx`) |
| `client/src/lib/runs-mode.ts` | create | `RunsMode`, `RUNS_MODES`, `isRunsMode`, `RUNS_MODE_KEY` — pure, no React |
| `client/src/hooks/useWatchdog.ts` | modify | `useWatchdog({ live })` — poll only when `live` |
| `client/src/components/runs/WatchdogMonitor.tsx` | create | the `'watchdog'` mode body: state card, watched-run rows, activity feed |
| `client/src/components/runs/RunsView.tsx` | modify | mode switch in the bar, persisted mode, body switch, `onSelectRun` |
| `client/src/components/board/RunStrip.tsx` | modify | imports `lastReportedEntry` instead of defining it |
| `client/src/components/settings/WatchdogGroup.tsx` | modify | knobs only + `Live view` orientation row; no State, no Activity, no poll |
| `client/src/styles.css` | modify | `.watchdog-*` rules move from the Settings block into the Runs block and grow the card/row classes |
| `test/run-watchdog.test.ts` | modify | + `stateLine` cases (moved from Settings suite) |
| `test/run-time.test.ts` | modify | + `lastReportedEntry` cases |
| `test/runs-mode.test.ts` | create | `isRunsMode` guard |
| `test/watchdog-hook.test.tsx` | modify | + `live: false` cases |
| `test/watchdog-monitor.test.tsx` | create | the monitor, standalone |
| `test/runs-view.test.tsx` | modify | + mode switch cases |
| `test/settings-watchdog.test.tsx` | modify | − State/Activity cases, + trimmed-group cases |
| `CLAUDE.md`, `docs/superpowers/specs/2026-09-04-orchestrator-watchdog-design.md` | modify | Layout paragraph; §6.4 supersession note |

---

### Task 1: Move `stateLine` into `lib/run-watchdog.ts`

Pure relocation, behaviour-preserving. Settings keeps rendering the State row for now (Task 5 removes it); it just imports the function from its new home.

**Files:**
- Modify: `client/src/lib/run-watchdog.ts` (append after `watchdogClause`)
- Modify: `client/src/components/settings/WatchdogGroup.tsx` (delete `stateLine` at ~line 99–124; import it from `../../lib/run-watchdog`)
- Modify: `test/run-watchdog.test.ts` (new `describe('stateLine')`)
- Modify: `test/settings-watchdog.test.tsx` (the pure `stateLine` test at ~line 178 moves out; its import changes)

**Interfaces:**
- Produces: `export function stateLine(status: WatchdogStatus, now?: number): string` in `client/src/lib/run-watchdog.ts` — identical signature and output to today's.

- [ ] **Step 1: Write the failing tests** in `test/run-watchdog.test.ts`, a new `describe('stateLine', …)` with a local `watchdogStatus(over)` factory (defaults: `phase: 'idle'`, `nextTickAt: null`, `config: DEFAULT_WATCHDOG_CONFIG`, `watching: []`, `events: []`). Pin `now = Date.parse('2026-09-05T12:00:00.000Z')`. Cases, each an exact `toBe`:
  1. `off` with `reason: 'BM_WATCHDOG off'` → `off — BM_WATCHDOG off`.
  2. `off` with no `reason` → `off — unknown`.
  3. `idle`, enabled → `idle — no running run`.
  4. `idle`, `config.enabled: false` → `idle — no running run · resume disabled`.
  5. `armed`, `watching: ['run-a', 'run-b']`, `nextTickAt = now + 42_000` ISO, enabled → `armed — watching run-a, run-b, next check in 42s`.
  6. `armed`, same but `enabled: false` → `… next check in 42s · resume disabled`.
  7. `armed`, `nextTickAt: null` → countdown reads `0s`.
  8. `armed`, `nextTickAt` in the past (`now − 5_000`) → `0s`, never negative.
- [ ] **Step 2: Run** `pnpm test -- test/run-watchdog.test.ts` → FAIL: `stateLine` is not exported from `run-watchdog`.
- [ ] **Step 3: Move the function** with its doc comment from `WatchdogGroup.tsx` into `run-watchdog.ts`; extend the module header comment's "any later surface (a Settings watchdog group, say)" aside to name the monitor and Settings as the two consumers. Change `WatchdogGroup.tsx` to import `stateLine` from `../../lib/run-watchdog` and keep re-exporting nothing (the Settings test will import from the lib in Step 5).
- [ ] **Step 4: Run** `pnpm test -- test/run-watchdog.test.ts` → PASS (8 new cases + existing).
- [ ] **Step 5: Update `test/settings-watchdog.test.tsx`:** delete the `stateLine: idle/armed suffix …` pure case (its content is now cases 3–6 above); change the import so `stateLine` no longer comes from `WatchdogGroup`. Run `pnpm test -- test/settings-watchdog.test.tsx` → PASS, one fewer test.
- [ ] **Step 6:** `pnpm run typecheck` → clean. Commit: `refactor(client): move stateLine into lib/run-watchdog beside its two siblings`.

---

### Task 2: `useWatchdog({ live })`

**Files:**
- Modify: `client/src/hooks/useWatchdog.ts`
- Modify: `test/watchdog-hook.test.tsx`

**Interfaces:**
- Produces: `export function useWatchdog(opts?: { live?: boolean }): { status; error; reload; save }` — same return shape as today. `live` defaults to `true`. `live: false` ⇒ no `setInterval` is ever installed, whatever `phase` reads. Mount fetch, focus refetch, `save()` and the error posture are unchanged in both settings.

- [ ] **Step 1: Write the failing tests** in `test/watchdog-hook.test.tsx` (reuse its `status()`, `stubFetch`, `flush`):
  1. `renderHook(() => useWatchdog({ live: false }))` with `status('armed')`: after `flush()` fetch called once; after `advanceTimersByTimeAsync(WATCHDOG_POLL_MS)` still once; after a second `WATCHDOG_POLL_MS` still once.
  2. `useWatchdog({ live: false })`, `armed`: a `window.dispatchEvent(new Event('focus'))` inside `act` → exactly two calls total (focus still refetches).
  3. `useWatchdog({ live: false })`: `save({ enabled: false })` posts to `/api/agents/watchdog/config` with body `{"enabled":false}` and no extra GET follows (total calls: 1 GET + 1 POST).
  4. `useWatchdog({ live: true })` explicit, `armed`: after `WATCHDOG_POLL_MS` two calls (the default still polls; this is the existing case 10 with the option spelled out).
  5. `useWatchdog()` with no argument still polls (existing case 10 stays untouched and green).
- [ ] **Step 2: Run** `pnpm test -- test/watchdog-hook.test.tsx` → FAIL: case 1 sees 2 calls after the interval.
- [ ] **Step 3: Implement.** Add the options parameter; guard the armed-poll effect on `live && status?.phase === 'armed'` and add `live` to its dependency array. Rewrite the hook's doc comment and `WATCHDOG_POLL_MS`'s comment: the poll exists for the **monitor's** state line and heartbeat ages (spec §3, §4), not a Settings row; Settings passes `live: false` because nothing there changes on a clock any more.
- [ ] **Step 4: Run** `pnpm test -- test/watchdog-hook.test.tsx` → PASS.
- [ ] **Step 5:** `pnpm run typecheck` → clean. Commit: `feat(client): useWatchdog gains a live flag so Settings can stop polling`.

---

### Task 3: `WatchdogMonitor` (standalone) + lift `lastReportedEntry`

The monitor is built and tested on its own props before anything mounts it. `lastReportedEntry` is lifted first so the monitor and `RunStrip` share it.

**Files:**
- Modify: `client/src/lib/run-time.ts` (append `lastReportedEntry` with its doc comment from `RunStrip.tsx` ~lines 56–80)
- Modify: `client/src/components/board/RunStrip.tsx` (delete the local function; import it from `../../lib/run-time`)
- Modify: `test/run-time.test.ts` (new `describe('lastReportedEntry')`)
- Create: `client/src/components/runs/WatchdogMonitor.tsx`
- Create: `test/watchdog-monitor.test.tsx`
- Modify: `client/src/styles.css` (move the `.watchdog-events*` rules from the Settings block ~lines 577–592 into the Runs block after `.runs-seg`'s rules ~line 1435; add `.watchdog-state`, `.watchdog-config`, `.watchdog-hint`, `.watchdog-rows`, `.watchdog-row`, `.watchdog-row-ok`, `.watchdog-row-crashed`, `.watchdog-row-missing`, `.watchdog-rows-empty`; single column under the existing `@media (max-width: 700px)`)

**Interfaces:**
- Produces: `export function lastReportedEntry(queue: readonly RunQueueItem[]): RunQueueItem | null` in `lib/run-time.ts`.
- Produces: `export function WatchdogMonitor(props: { runs: OrchestratorRunsPayload['runs']; onSelectRun: (project: string, runId: string) => void }): JSX.Element` (named export, like `RunDetail`).
- Consumes: `stateLine` (Task 1), `useWatchdog()` default-live (Task 2), `isCrashed`, `watchdogClause`, `projectLabel`, `formatClock`, `formatSpanCompact`, `useNow`, `WATCHDOG_EVENT_CAP`.

**Rendering contract (spec §3):**

```
[data-testid=watchdog-state]
  [watchdog-state-line]   stateLine(status, now)
  [watchdog-config-line]  `check every ${formatSpanCompact(tickMs)} · leave alone for ${formatSpanCompact(graceMs)} · give up after ${maxAttempts}`
  .watchdog-hint          `Configure in Settings › Orchestrator watchdog.`

[data-testid=watchdog-rows]   (omitted entirely when phase === 'off')
  <button data-testid=watchdog-row class="watchdog-row watchdog-row-ok|watchdog-row-crashed">
     projectLabel(project) · runId · (`${id} · ${stage}` | `between items`) · `heartbeat ${formatSpanCompact(now − updatedAt)} ago` · (`ok` | `crashed · ${clause}` | `crashed`) · [`· not yet watched`]
  <div data-testid=watchdog-row-missing>  `${id} — not in the runs payload`
  <div data-testid=watchdog-rows-empty>   `no running run` (idle) | `nothing running in the runs payload yet` (armed)

<ul data-testid=watchdog-events class="watchdog-events">  one <li> per event, newest first: <time dateTime=at>formatClock(at) ?? '—:—'</time> [projectLabel(project)] detail
  or <div class="watchdog-events watchdog-events-empty">  `nothing since the server started`
  hint names WATCHDOG_EVENT_CAP and says an API restart empties it
```

`status === null` → only: `Could not reach the watchdog — ${error}. This view will fill in once the API answers GET /api/agents/watchdog again.` (drop ` — ${error}` when `error` is null). `useNow(rowsNonEmpty, 5_000)` supplies `now`; rows use `Math.max(0, now − Date.parse(updatedAt))`. Rows are the payload's `status === 'running'` entries in payload order; `watching` annotates (§3.2). The "active item" is `lastReportedEntry(run.queue)`.

- [ ] **Step 1: Failing tests for `lastReportedEntry`** in `test/run-time.test.ts` (build queue items with a small local factory `{ id, stage, stageAt: {} , …inert fields }`):
  1. `[merged, dispatched, pending]` → the `dispatched` entry.
  2. `[merged, fixing, verifying, pending]` → the `verifying` entry (LAST in-flight, not first).
  3. `[merged, branched, pending, pending]` → `null` (only terminal + pending).
  4. `[]` → `null`.
  5. `[parked, pending]` → `null` (parked is terminal per `isTerminalStage`).
- [ ] **Step 2: Run** `pnpm test -- test/run-time.test.ts` → FAIL: not exported.
- [ ] **Step 3: Move the function** + doc comment into `run-time.ts`; make `RunStrip.tsx` import it. Run `pnpm test -- test/run-time.test.ts test/orchestrator-strip.test.tsx` → PASS (strip behaviour unchanged).
- [ ] **Step 4: Write the failing monitor tests** in `test/watchdog-monitor.test.tsx` (`@jest-environment jsdom`). Stub `global.fetch` per URL like `settings-watchdog.test.tsx` does (only `/api/agents/watchdog` is ever hit — assert no other URL is fetched). Factories: `watchdogStatus(over)` as in Task 1; `liveRun(over)` returning an `OrchestratorRunsPayload['runs'][number]` with defaults `status: 'running'`, `fresh: true`, `pastRuns: 0`, `mergeMode/Effective: 'merge'`, `mergeModeNote: null`, `maxItems: null`, `attention: []`, `queue: []`; `queueItem(id, stage)` inert. Pin the clock with `jest.useFakeTimers(); jest.setSystemTime(NOW)` where `NOW = Date.parse('2026-09-05T12:00:00.000Z')`; flush with the `advanceTimersByTimeAsync(0)` idiom. Cases:
  1. **Unavailable.** fetch rejects `new Error('watchdog unreachable')` → text matches `/Could not reach the watchdog — watchdog unreachable/`; `queryByTestId('watchdog-rows')`, `('watchdog-events')`, `('watchdog-state-line')` all null.
  2. **Off.** `phase: 'off', reason: 'BM_AGENTS off'`, `runs: []` → state line `off — BM_AGENTS off`; config line equals the template with `formatSpanCompact(60_000)`, `formatSpanCompact(600_000)`, `2` computed in the test, not typed; hint text present; `queryByTestId('watchdog-rows')` null; events section still renders.
  3. **Idle, empty.** `phase: 'idle'`, `runs: []` → `watchdog-rows-empty` reads `no running run`.
  4. **Armed, skew.** `phase: 'armed'`, `watching: []`, `runs: []` → `watchdog-rows-empty` reads `nothing running in the runs payload yet`.
  5. **Armed, one fresh row.** `watching: ['run-1']`; one run `{ project: '/abs/alpha', runId: 'run-1', updatedAt: NOW − 4_000, queue: [queueItem('bug-16','dispatched'), queueItem('task-13','pending')] }` → exactly one `watchdog-row`; it has text `alpha`, `run-1`, `bug-16 · dispatched`, `heartbeat 4s ago`, `ok`; does NOT contain `not yet watched`; has class `watchdog-row-ok`.
  6. **Between items.** Same as 5 but `queue: [queueItem('bug-16','merged'), queueItem('task-13','pending')]` → row text `between items`.
  7. **Crashed with annotation.** `fresh: false`, `updatedAt: NOW − 130_000`, `watchdog: { enabled: true, attempts: 1, maxAttempts: 2, lastSpawnAt: '2026-09-05T11:58:00.000Z', lastSessionId: 's1', lastError: null, exhausted: false }` → row has class `watchdog-row-crashed`, text `heartbeat 2m ago`, and text `crashed · ` + `watchdogClause(thatAnnotation)` (call the function in the assertion).
  8. **Crashed, not yet annotated.** `fresh: false`, no `watchdog` field → verdict text is exactly `crashed` (no trailing separator).
  9. **Not yet watched.** running run present, `watching: []`, `phase: 'armed'` → row contains `· not yet watched`.
  10. **Missing.** `watching: ['run-9']`, `runs: []` → one `watchdog-row-missing` with text `run-9 — not in the runs payload`; it is not a `button`; no `watchdog-rows-empty`.
  11. **Shared runId.** two running runs `{ project: '/abs/alpha', runId: 'run-1' }` and `{ project: '/abs/beta', runId: 'run-1' }`, `watching: ['run-1']` → two `watchdog-row`s, texts `alpha` and `beta`, neither `not yet watched`.
  12. **Done runs are not rows.** a `status: 'done'` run in `runs` → zero `watchdog-row`.
  13. **Click.** `onSelectRun` mock; `userEvent.click` the row from case 5 → called once with `('/abs/alpha', 'run-1')`.
  14. **Events.** three events (the three from `settings-watchdog.test.tsx` case 9, verbatim) → `watchdog-events` has three `listitem`s in that order, each containing `formatClock(at)`, `projectLabel(project)` (`alpha`/`beta`/`gamma`) and `detail`; an event with `project: null` renders no project span.
  15. **Empty events.** `events: []` → `nothing since the server started`; the hint contains the string `${WATCHDOG_EVENT_CAP}`.
  16. **Heartbeat moves.** case 5 setup, then `advanceTimersByTimeAsync(5_000)` inside `act` → row text `heartbeat 9s ago` (the fetch stub keeps answering the same payload; `useNow` alone moved it).
- [ ] **Step 5: Run** `pnpm test -- test/watchdog-monitor.test.tsx` → FAIL: module not found.
- [ ] **Step 6: Implement `WatchdogMonitor.tsx`** to the contract above. Header comment: why rows come from the runs payload and `watching` only annotates (shared `runId`s — cite `runs-view.test.tsx`'s dedupe case; the sweeper is armed over exactly the `running` set), why `projectLabel` and not a private basename, why the click-through exists, and why `WATCHDOG_EVENT_CAP` is read rather than typed. Then move and extend the CSS.
- [ ] **Step 7: Run** `pnpm test -- test/watchdog-monitor.test.tsx` → PASS (16 cases).
- [ ] **Step 8:** `pnpm run typecheck` → clean. Commit: `feat(runs): WatchdogMonitor — state, watched runs, activity, standalone`.

---

### Task 4: Mode switch in `RunsView`

**Files:**
- Create: `client/src/lib/runs-mode.ts`
- Create: `test/runs-mode.test.ts`
- Modify: `client/src/components/runs/RunsView.tsx` (bar ~line 597–634; body ~line 636; add `onSelectRun`)
- Modify: `test/runs-view.test.tsx`

**Interfaces:**
- Produces (`lib/runs-mode.ts`): `export type RunsMode = 'runs' | 'watchdog'`; `export const RUNS_MODES: readonly RunsMode[]`; `export function isRunsMode(v: unknown): v is RunsMode`; `export const RUNS_MODE_KEY = 'backlog-manager.runs-mode'`; `export const MODE_BUTTON: Record<RunsMode, string> = { runs: 'Runs', watchdog: 'Watchdog' }`.
- Consumes: `WatchdogMonitor` (Task 3).

**Behaviour (spec §2):** `usePersistedState<string>(RUNS_MODE_KEY, 'runs')`; `mode = isRunsMode(stored) ? stored : 'runs'`. The segmented control (`role="group"`, `aria-label="View"`, `data-testid="runs-mode"`, buttons `runs-mode-runs`/`runs-mode-watchdog` with `aria-pressed`) renders **always**, before the range control, outside the `merged.length > 0` condition. Range control and project select render only when `mode === 'runs' && merged.length > 0`. Body: `'watchdog'` → `<WatchdogMonitor runs={liveRuns} onSelectRun={…} />`; `'runs'` → today's body verbatim, `no runs yet` included. `onSelectRun(project, runId)` → `setStoredMode('runs')` then `setSelected({ project, runId })`.

- [ ] **Step 1: Failing guard tests** in `test/runs-mode.test.ts`: `isRunsMode('runs')` true; `('watchdog')` true; `('banana')` false; `(undefined)` false; `(null)` false; `(42)` false; `({})` false; `RUNS_MODES` equals `['runs', 'watchdog']`; `RUNS_MODE_KEY` equals `'backlog-manager.runs-mode'`.
- [ ] **Step 2: Run** `pnpm test -- test/runs-mode.test.ts` → FAIL. Implement `lib/runs-mode.ts` (comment: why persisted unlike range — spec §9). Run → PASS.
- [ ] **Step 3: Failing view tests** in `test/runs-view.test.tsx`, using its `renderRunsView`, `RUN_LIVE`/`RUN_A`/`RUN_B` fixtures and `LIVE_RUNS`. Add `localStorage.clear()` to the file's `beforeEach`. Cases:
  1. **Default.** render with runs → `runs-mode` present; `runs-mode-runs` has `aria-pressed="true"`, `runs-mode-watchdog` `"false"`; `runs-range` and the `Project` select present; `runs-list` present.
  2. **Renders on empty.** `renderRunsView([], [])` → `no runs yet` AND `runs-mode` present; `runs-range` absent.
  3. **Switch to Watchdog.** click `runs-mode-watchdog` → `runs-mode-watchdog` pressed; `queryByTestId('runs-range')` null; `queryByLabelText('Project')` null; `queryByTestId('runs-tiles')`, `('runs-list')`, `('run-detail-slot')` all null; `findByTestId('watchdog-state')` present. (Stub `fetch` for `/api/agents/watchdog` in this suite's `beforeEach` — the real `useWatchdog` calls `fetchWatchdog` from `lib/agents`, which this file mocks at module level: add `fetchWatchdog: jest.fn()` to the `jest.mock('../client/src/lib/agents', …)` factory and give it a resolved `watchdogStatus()` default alongside `fetchArchivedRun`'s.)
  4. **Switch back keeps selection.** select `RUN_A`'s row, switch to Watchdog, switch to Runs → `RUN_A`'s row has `aria-current` (or whatever attribute the existing "moves the selection" case asserts — reuse its assertion verbatim).
  5. **Restores stored mode.** `localStorage.setItem(RUNS_MODE_KEY, JSON.stringify('watchdog'))` before render → opens with `runs-mode-watchdog` pressed and `watchdog-state` present; `runs-list` absent.
  6. **Clamps garbage.** `localStorage.setItem(RUNS_MODE_KEY, JSON.stringify('banana'))` → opens in runs mode; after first render `localStorage.getItem(RUNS_MODE_KEY)` is `JSON.stringify('runs')` OR still `'"banana"'` — assert only the rendered mode, not the write (the guard is on read).
  7. **Persists the choice.** click `runs-mode-watchdog` → `localStorage.getItem(RUNS_MODE_KEY)` equals `JSON.stringify('watchdog')`.
  8. **Row click-through.** `fetchWatchdog` resolves `watchdogStatus({ phase: 'armed', watching: [RUN_LIVE.runId] })`; render with `LIVE_RUNS`; switch to Watchdog; click the `watchdog-row` → mode returns to Runs, and the row for `RUN_LIVE` is the selected one (same assertion as case 4).
- [ ] **Step 4: Run** `pnpm test -- test/runs-view.test.tsx` → FAIL on the new cases only.
- [ ] **Step 5: Implement in `RunsView.tsx`.** Add imports; the persisted mode + guard; the segmented control (mirror the range control's markup and comment, saying why this one sits outside the `merged.length` condition); gate range/project on `mode === 'runs'`; wrap the body in the mode switch; define `onSelectRun`. Update the file header comment's "what this section answers" paragraph to name the two modes.
- [ ] **Step 6: Run** `pnpm test -- test/runs-view.test.tsx` → PASS (all existing + 8).
- [ ] **Step 7:** `pnpm run typecheck` → clean. Commit: `feat(runs): Runs | Watchdog mode switch, persisted; monitor mounts in watchdog mode`.

---

### Task 5: Trim `WatchdogGroup` to knobs

**Files:**
- Modify: `client/src/components/settings/WatchdogGroup.tsx`
- Modify: `test/settings-watchdog.test.tsx`

**Interfaces:**
- Consumes: `useWatchdog({ live: false })` (Task 2).
- Removes: `projectBasename` (private), the State `SettingsRow`, the Activity `set-row`, the `formatClock` import. `TICK_LADDER`/`GRACE_LADDER`/`ATTEMPT_LADDER`/`ladderWithSelected` unchanged.

**Behaviour (spec §5):** group title unchanged. First row is a control-less `SettingsRow` named `Live view` whose hint is, in this order: the existing two sentences about `~/.backlog-manager/settings/watchdog.json` living on the API host and being shared by every device, then `The sweeper's state, the runs it is watching and its activity are on Runs › Watchdog.` Then Enabled / Check every / Leave a resumed run alone for / Give up after exactly as today. The `status === null` unavailable notice is unchanged.

- [ ] **Step 1: Adjust tests** in `test/settings-watchdog.test.tsx`:
  - Delete: case 3 (`reads watching run ids, the next-tick countdown…`), case 9 (`renders three Activity rows…`), case 10 (`shows the empty-history line…`). Their behaviour is now Task 3's cases 5, 14, 15.
  - Rewrite case 1 (`renders the group titled, idle, and names the shared config file in its hint`): still asserts the title and the `watchdog.json` hint; additionally asserts text `Runs › Watchdog` is present, and `queryByText(/^idle — /)` and `queryByText('Activity')` are both null.
  - Add: **No poll from Settings.** `jest.useFakeTimers()`, `phase: 'armed'` payload, render, flush, `advanceTimersByTimeAsync(WATCHDOG_POLL_MS × 2)` → the fetch mock was called for `/api/agents/watchdog` exactly once (plus the `/api/agents/status` call `AgentsGroup` makes — filter the mock's calls by URL).
  - Add: **Row order.** the group's `set-name` texts, in DOM order, are `['Live view', 'Enabled', 'Check every', 'Leave a resumed run alone for', 'Give up after']`.
  - Keep untouched: ladder/limits, `1h 00m` label, defaults-through-`formatSpanCompact`, POST `{maxAttempts}` redraw, POST `{enabled:false}`, unavailable notice.
- [ ] **Step 2: Run** `pnpm test -- test/settings-watchdog.test.tsx` → FAIL on the rewritten case 1 and the two new ones.
- [ ] **Step 3: Implement the trim.** Pass `{ live: false }` to `useWatchdog`; add the `Live view` row; delete the State row, the Activity block, `projectBasename` and the now-unused imports. Rewrite the component header comment: the group is knobs only, the live half moved and why (spec "Why this exists" — nothing in Settings is live), and note the `live: false` reason inline at the hook call.
- [ ] **Step 4: Run** `pnpm test -- test/settings-watchdog.test.tsx test/settings-view.test.tsx` → PASS.
- [ ] **Step 5:** `pnpm run typecheck` → clean (catches the dead imports). Commit: `feat(settings): watchdog group keeps the knobs; live state moved to Runs › Watchdog`.

---

### Task 6: Documents and whole-suite verification

**Files:**
- Modify: `CLAUDE.md` (Layout bullet for `client/src/`, ~lines 61–78)
- Modify: `docs/superpowers/specs/2026-09-04-orchestrator-watchdog-design.md` (§6.4, ~line 388)

- [ ] **Step 1: `CLAUDE.md`.** In the Runs parenthetical, after "…no polling interval, since history moves at run boundaries, not on a live heartbeat" add: a `Runs | Watchdog` mode switch (`lib/runs-mode.ts`, persisted under `backlog-manager.runs-mode`, unknown value → Runs) whose Watchdog mode renders `WatchdogMonitor` — the sweeper's state line, one row per `running` run in the live payload (rows from the runs payload, `watching` only annotates, because two projects can share a `runId`), and the activity feed; it owns the one live `useWatchdog()` and reuses `RunsView`'s live runs, so switching modes adds no request. Replace "Settings, and an Orchestrator watchdog group (`WatchdogGroup.tsx`, server-side knobs and activity, via `hooks/useWatchdog.ts`)" with: Settings, whose Orchestrator watchdog group (`WatchdogGroup.tsx`) is knobs only — it calls `useWatchdog({ live: false })` and shows nothing that moves on a clock; the live half is Runs › Watchdog. Add one line to the `shared/`/`lib` notes: `stateLine` lives in `lib/run-watchdog.ts` beside `isCrashed`/`watchdogClause`; `lastReportedEntry` in `lib/run-time.ts`, read by both `RunStrip` and `WatchdogMonitor`.
- [ ] **Step 2: Watchdog spec §6.4.** Insert as the first paragraph under the heading: `*Superseded on 2026-09-05 by* `2026-09-05-watchdog-monitor-design.md` *for the State row and the Activity feed, which now live on Runs › Watchdog. The knobs below are unchanged.*`
- [ ] **Step 3: Whole suite.** `pnpm test` → all green; `pnpm run typecheck` → clean; `pnpm run build` → succeeds (the Runs chunk still lazy-loads; `WatchdogMonitor` lands in it, not in the Settings chunk — check `client/dist/assets` names if in doubt).
- [ ] **Step 4:** Commit: `docs: CLAUDE.md and watchdog spec follow the monitor move`.

---

## Self-review against the spec

- §2 mode switch, unconditional render, gated range/project, persisted + clamped, body switch, `onSelectRun` → Task 4.
- §3.1 state card, config line, hint, null/off handling → Task 3 cases 1–2.
- §3.2 rows from payload, `watching` annotation, placeholder, shared runId, active item via one shared rule, heartbeat, verdict via `watchdogClause`, click → Task 3 cases 3–13, 16 (+ `lastReportedEntry` lift).
- §3.3 activity moved, `projectLabel`, cap in hint → Task 3 cases 14–15.
- §3.4 styles → Task 3 Step 6.
- §4 `live` option → Task 2; consumed in Task 5.
- §5 Settings trim, `Live view` row, deletions → Task 5.
- §6 documents → Task 6; hook comment in Task 2.
- §7 every listed suite has a task; the `stateLine` relocation is Task 1.
- §8 sequencing → Global Constraints.
- Names used across tasks: `stateLine` (T1→T3), `useWatchdog({ live })` (T2→T3,T5), `lastReportedEntry` (T3), `WatchdogMonitor` + props (T3→T4), `RUNS_MODE_KEY`/`isRunsMode` (T4). Consistent.
