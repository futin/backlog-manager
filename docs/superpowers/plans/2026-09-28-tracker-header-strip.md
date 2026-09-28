# Tracker Header Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 50 px white strip above every section holding one tracker chip — login, a `POLL` line-timer meter, an `API` usage meter and a 420 px popover with a
line timer per connected repo — replacing the Board band's five `polled … ago` spans and making `.main`'s 24 px top-left curve visible.

**Architecture:** Three pure derivations in `lib/tracker.ts` feed a `ui/Meter` primitive; one `useTrackers` instance at the shell (a context) polls on the
server's own clock and serves both the chip and Settings' Trackers card; `App.tsx` gains a `.maincol` column with the strip, the chip moving into the rail
bar below 700 px. Escape goes through the existing `useDialogEscape` stack; click-outside is the popover's own listener.

**Tech Stack:** React 18 + TypeScript, jest (`--runInBand`) with jsdom suites under `test/` (flat), `@testing-library/react` + `user-event`, plain CSS with
tokens in `client/src/styles.css` / `shared/theme.css`, design guards in `test/design-guards.test.ts`, rule tiers in `test/claude-rules.test.ts`.

**Spec:** `docs/superpowers/specs/2026-09-28-tracker-header-strip-design.md` — read it first; every task below cites the section it implements.

> **Override of this template's "No Placeholders / code blocks required" rule, by the repo's standing convention (`~/.claude/CLAUDE.md` → Learnings):**
> this plan specifies **behaviour and exact test cases — names, inputs, expected values — never literal implementation code.** Where a code-shaped block
> appears it is a signature or a fixture shape, illustrative, and the implementer is expected to disagree with it when the codebase says otherwise. Test
> cases ARE authoritative: the `it(...)` titles and their expected values are the contract. Size figures are soft targets.

## Global Constraints

- `pnpm` only; run suites with `pnpm run test:jest -- <file>` (jest, `--runInBand`); `pnpm run typecheck` before every commit; `pnpm test` before the last one.
- Every jsdom suite starts with the `/** @jest-environment jsdom */` docblock and imports `@testing-library/jest-dom`; suites are FLAT in `test/`.
- Every new component cites its DESIGN.md subsection in a header comment (§8.0 for the strip and chip; the `Meter` cites §8.0 and §7's meter row).
- Design guard 3: **every px font-size in `styles.css` is ≥ 11 px** — the dashboard's 9.5 px meter label and 9 px caret become 11 px here (spec §2.3).
- Design guard 7: a `ui/` component's class family (`.ui-meter…`) is declared ONCE, as a bare base selector, inside the `/* ── ui primitives` … `/* ── end ui
  primitives` block of `styles.css`; page CSS may lay it out (width, gap) and never restate its look.
- No new palette values; tones are `--green` / `--amber` / `--red`, surfaces `--strip` / `--strip-hi`, inks `--ink` / `--ink2` / `--ink3` (spec §1.3).
- `lib/tracker.ts` reads no clock: `now` is always a parameter (its header comment states this; keep it true).
- Comments explain *why*, at the file's existing density; wrap new prose at 160 columns; commit bodies at 72.
- `useDialogEscape` is the ONLY Escape listener in the client. The popover component calls it; nothing binds `keydown` itself.
- The rail's sub-nav tree is the only thing that switches sections or Settings' pages: the popover carries **no links and no buttons** (spec §2.4).
- Commit on `main` directly (this repo's convention for its own work; check `~/.backlog-manager/orchestrator/*/run.json` for a `running` status first).

## Review Focus

Inputs the spec implies but does not name, each pinned by a test in the task that owns the code:

1. **`limit: 0` or `remaining > limit`** (a platform answering before its first rate-limit header, or a reset mid-read) — `apiUsage` must answer `null` for a
   zero limit and clamp a negative `used` to `0` / `<1%`, never `NaN%` or a negative bar. → Task 1.
2. **A `polledAt` older than one cycle when the schedule is computed** (tab in the background, server restarting) — the next fetch fires after a 1 s floor, never
   "in the past" and never in a tight loop. → Task 3.
3. **The payload changes while the popover is open** (a repo disconnected, the token removed) — rows follow the live payload; the popover neither crashes on a
   vanished project nor keeps a stale row. → Task 4.
4. **Narrow flips while the popover is open** — the chip changes home; the popover must not survive the move half-anchored. → Task 5.
5. **A tracker project exists but every project is `no-token`** while `platforms[0].hasToken` is `true` on a stale payload — the chip must read from
   `hasToken`, not from `access`, for the no-token state, and from `access` for the red pip. → Task 4.

---

### Task 1: Derivations — `pollProgress`, `sweepProgress`, `apiUsage`, `resetClock` (spec §5)

**Files:**
- Modify: `client/src/lib/tracker.ts` (add exports beside `pollAge`/`accessReason`; widen `hasTracker`)
- Modify: `client/src/components/settings/TrackersGroup.tsx:82-87` (`resetClock` moves out; the card imports it)
- Modify: `docs/superpowers/specs/2026-09-28-tracker-header-strip-design.md` §2.1 and §4 (one correction, below)
- Test: `test/tracker-lib.test.ts`

**Interfaces:**
- Consumes: `TrackersPayload`, `TrackerPlatform`, `TrackerProjectRow`, `ProjectSummary` from `shared/types.ts`; `pollAge`'s parse-and-clamp pattern
  (`tracker.ts:36-43`).
- Produces (later tasks rely on these exact names):
  - `export const TRACKER_CYCLE_MS = 17_000` — the one client-side home of the poll cycle (server `TRACKER_POLL_MS` 15 s + the measured tick; equals
    `orchestrate.mjs`'s `TRACKER_POLL_WINDOW_MS`). Comment says so.
  - `export function pollProgress(polledAt: string | null, now: number): { fraction: number; leftS: number; overdue: boolean } | null`
  - `export function sweepProgress(projects: readonly Pick<TrackerProjectRow, 'source' | 'polledAt'>[], now: number): ReturnType<typeof pollProgress>`
  - `export function apiUsage(platform: Pick<TrackerPlatform, 'limit' | 'remaining' | 'reset'>): { fraction: number; label: string; left: number; resetsAt: string | null } | null`
  - `export function resetClock(reset: number): string` — moved verbatim from `TrackersGroup.tsx` (Unix seconds → local `HH:MM`, `toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`).
  - `hasTracker`'s parameter widens to `readonly Pick<ProjectSummary, 'source'>[] | null` so a `TrackerProjectRow[]` passes (both `source` unions are
    `SourceKind | 'unsupported' | null`).

- [ ] **Step 1: Correct the spec.** §2.1 says the chip is drawn iff `hasTracker(projects)`; §4 says `App` "already has `projects` from `useBoard`". `App` does
  not call `useBoard` (only `BoardView` does). Rewrite both sentences: the chip and the hook's schedule read `hasTracker(data.projects)` from the
  `/api/trackers` payload itself — `TrackerProjectRow` carries `source`. Nothing else in the spec changes. Commit: `docs(spec): the tracker chip reads its
  own payload for hasTracker`.

- [ ] **Step 2: Write the failing tests** in `test/tracker-lib.test.ts`, new `describe` blocks after `pollAge`'s. Use the file's `NOW` and `project()` helper;
  for rows use a local `row(over: Partial<TrackerProjectRow>)` returning `{ name: 'x', path: '/abs/x', source: 'github', repo: 'futin/x', polledAt: null,
  access: 'ok', detail: null, connect: null, ...over }`. Cases (titles are the contract):

  `describe('pollProgress')`
  - `'reads the fraction of the cycle elapsed and the whole seconds left'` — `polledAt = NOW − 5_000` → `{ fraction: 5000/17000, leftS: 12, overdue: false }`
    (compare `fraction` with `toBeCloseTo(0.294, 3)`).
  - `'is null for no stamp, an empty string and an unparseable one'` — `null`, `''`, `'yesterday'` → `null`.
  - `'clamps a stamp from the future to the start of the cycle'` — `polledAt = NOW + 60_000` → `fraction 0`, `leftS 17`, `overdue false`.
  - `'fills the bar and reads 0 s once the cycle has passed, without yet being overdue'` — `NOW − 17_000` → `fraction 1`, `leftS 0`, `overdue false`;
    `NOW − 33_999` → same, `overdue false`.
  - `'is overdue at exactly two cycles'` — `NOW − 34_000` → `overdue true`, `fraction 1`, `leftS 0`.

  `describe('sweepProgress')`
  - `'follows the newest stamp among github rows'` — rows at `NOW − 15_000`, `NOW − 3_000`, `NOW − 9_000` → equals `pollProgress(NOW − 3_000 stamp, NOW)`.
  - `'ignores rows that are not github, whatever their stamp'` — one `files` row at `NOW − 1_000` (`source: 'files'`) and one github row at `NOW − 10_000` →
    `leftS 7`.
  - `'is null when no github row has polled'` — github rows with `polledAt: null`, plus a `files` row with a stamp → `null`; empty array → `null`.

  `describe('apiUsage')`
  - `'is null while the platform has no limit'` — `{ limit: null, remaining: null, reset: null }` → `null`.
  - `'floors a use under one percent to <1%'` — `limit 5000, remaining 4986` → `label '<1%'`, `fraction` `toBeCloseTo(0.0028, 4)`, `left 4986`.
  - `'reads one decimal from one percent up'` — `remaining 4950` → `'1.0%'`; `remaining 4930` → `'1.4%'`; `remaining 500` → `'90.0%'`.
  - `'formats the reset as a local wall clock'` — `reset` = `Math.floor(Date.parse('2026-09-18T12:00:00Z') / 1000)` → `resetsAt` equals
    `new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`; `reset: null` → `resetsAt null`.
  - **(Review Focus 1)** `'is null for a zero limit and clamps a remaining above the limit to nothing used'` — `limit 0` → `null`; `limit 5000, remaining 5100`
    → `fraction 0`, `label '<1%'`, `left 5100`.

  `describe('hasTracker')` — add `'accepts the trackers payload rows as well as project summaries'` — `hasTracker([row()])` true, `hasTracker([row({ source:
  'files' })])` false. `describe('resetClock')` — `'is the same clock TrackersGroup used to draw'`: `resetClock(0)` equals the `toLocaleTimeString` expression above
  for `new Date(0)`.

- [ ] **Step 3: Run to verify they fail.** `pnpm run test:jest -- test/tracker-lib.test.ts` — expected: the new blocks fail with "is not a function" /
  TypeScript import errors; the existing blocks stay green.

- [ ] **Step 4: Implement** in `lib/tracker.ts`: `TRACKER_CYCLE_MS`; `pollProgress` parses like `pollAge` (same three `null` exits, same `Math.max(0, …)` clamp),
  `fraction = Math.min(elapsed / TRACKER_CYCLE_MS, 1)`, `leftS = Math.max(Math.ceil((TRACKER_CYCLE_MS − elapsed) / 1000), 0)`, `overdue = elapsed >= 2 *
  TRACKER_CYCLE_MS`; `sweepProgress` picks the max `Date.parse` among github rows with a parseable stamp and hands it to `pollProgress`; `apiUsage` returns
  `null` for a `null` or `≤ 0` limit or `null` remaining, `used = Math.max(0, limit − remaining)`, `fraction = used / limit`, `label = pct < 1 ? '<1%' :
  pct.toFixed(1) + '%'`, `left = remaining`, `resetsAt = reset === null ? null : resetClock(reset)`; move `resetClock` here and import it in `TrackersGroup.tsx`
  (delete the private copy; keep its comment with the function). Widen `hasTracker`. Header-comment each export with *why* (the cycle constant's comment names
  the server figure it mirrors and the orchestrate window it equals).

- [ ] **Step 5: Run to verify they pass.** `pnpm run test:jest -- test/tracker-lib.test.ts test/settings-view.test.tsx` — expected: all green.
  `pnpm run typecheck` — clean.

- [ ] **Step 6: Commit.** `feat(tracker): poll-cycle and API-usage derivations in lib/tracker.ts` — body names the four exports and the `hasTracker` widening.

---

### Task 2: The `Meter` primitive (spec §3)

**Files:**
- Create: `client/src/components/ui/Meter.tsx`
- Modify: `client/src/styles.css` — inside the ui primitives block (between `/* ── ui primitives` at ~2297 and `/* ── end ui primitives` at ~2736), after
  `.ui-progress-*`
- Test: `test/ui-meter.test.tsx`

**Interfaces:**
- Produces: `export function Meter(props: { label: string; value: string; fraction: number | null; tone?: 'green' | 'amber' | 'red'; width?: number })`.
  Root `<span class="ui-meter" data-tone="green|amber|red" style="width: <width>px">` (default 56); inside, `.ui-meter-head` holding `.ui-meter-label` (11 px,
  `--ink3`) over `.ui-meter-value` (11 px / 700, `--ink`), then `.ui-meter-track` (3.5 px, `--steel`, `overflow: hidden`, `aria-hidden`) with
  `.ui-meter-fill` whose inline `width` is `${fraction * 100}%` (clamped to 0–1), `0%` for `null`. Fill colour by `[data-tone]` on the root; **no `transition`**
  on the fill (spec §3: it advances once a second).

- [ ] **Step 1: Write the failing tests** in `test/ui-meter.test.tsx` (jsdom):
  - `'draws the label over the value as text'` — `render(<Meter label="POLL" value="12s" fraction={0.3} />)`; `screen.getByText('POLL')` and `'12s'` present.
  - `'fills the track to the fraction, clamped at both ends'` — `fraction 0.25` → fill `style.width === '25%'`; `1.7` → `'100%'`; `-0.2` → `'0%'`.
  - `'draws an empty track for null'` — `fraction null` → `'0%'`, and the root still renders label and value.
  - `'defaults to the green tone and 56 px, and takes both from props'` — no props → `data-tone="green"`, `style.width '56px'`; `tone="red" width={120}` → `"red"`,
    `'120px'`.
  - `'hides the bar from the accessibility tree and exposes only the text'` — `.ui-meter-track` has `aria-hidden="true"`; `getByText` finds label and value.

- [ ] **Step 2: Run to verify they fail.** `pnpm run test:jest -- test/ui-meter.test.tsx` — expected: "Cannot find module '../client/src/components/ui/Meter'".

- [ ] **Step 3: Implement** `Meter.tsx` (header comment: §8.0 strip chip, §7 meter row; why there is no transition) and the CSS family in the primitives
  block: `.ui-meter { display: inline-flex; flex-direction: column; gap: 3px; flex: none }`, `.ui-meter-head { display: flex; justify-content:
  space-between; align-items: baseline; gap: 6px }`, `.ui-meter-label { font-size: 11px; font-weight: 500; color: var(--ink3) }`, `.ui-meter-value { font-size:
  11px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums }`, `.ui-meter-track { height: 3.5px; border-radius: 4px; background:
  var(--steel); overflow: hidden }`, `.ui-meter-fill { display: block; height: 100%; border-radius: 4px; background: var(--green) }`, `.ui-meter[data-tone="amber"]
  .ui-meter-fill { background: var(--amber) }`, same for red.

- [ ] **Step 4: Run to verify they pass.** `pnpm run test:jest -- test/ui-meter.test.tsx test/design-guards.test.ts` — expected: green, including guard 7
  (`.ui-meter` declared once, inside the block, nothing outside starts with `.ui-meter`) and guard 3 (no font-size under 11 px).

- [ ] **Step 5: Commit.** `feat(ui): Meter — the strip chip's label-over-value line meter`.

---

### Task 3: One `useTrackers` at the shell, on the poll clock (spec §4)

**Files:**
- Modify: `client/src/hooks/useTrackers.ts`
- Create: `client/src/hooks/TrackersContext.tsx` (`TrackersProvider`, `useTrackersContext`)
- Modify: `client/src/components/settings/TrackersGroup.tsx:28` (`useTrackers()` → `useTrackersContext()`)
- Modify: `test/settings-view.test.tsx` (wrap the one `render(<SettingsView …/>)` in `<TrackersProvider>`; its fetch stubs already answer every URL)
- Test: `test/use-trackers.test.tsx`

**Interfaces:**
- Consumes: `TRACKER_CYCLE_MS`, `hasTracker` (Task 1); `isTrackersPayload`.
- Produces:
  - `useTrackers(): TrackersState` — unchanged shape (`data`, `loading`, `error`, `reload`), new behaviour below.
  - `export const TRACKER_FETCH_SLACK_MS = 500` (exported for the test).
  - `TrackersProvider({ children })` — calls `useTrackers()` once and provides it; `useTrackersContext(): TrackersState` — context default is
    `{ data: null, loading: true, error: false, reload: () => {} }` so a component rendered without a provider draws its loading branch, never throws.

Behaviour of the schedule (spec §4): after every response — success or error — exactly one pending timer. On success with a github row that has a
`polledAt`: fire at `max(newestPolledAt + TRACKER_CYCLE_MS + TRACKER_FETCH_SLACK_MS − now, 1_000)` ms. On success with github rows but no `polledAt`:
`TRACKER_CYCLE_MS`. On success with **no** github row: no timer (one fetch only). On error: `TRACKER_CYCLE_MS`. Focus refetches immediately and re-arms from
that response. Unmount clears the pending timer. A `reload()` while a timer is pending clears it first (one timer at a time).

- [ ] **Step 1: Write the failing tests** in `test/use-trackers.test.tsx` (jsdom, `jest.useFakeTimers()` + `jest.setSystemTime(NOW)`; a `Probe` component that
  renders `data?.platforms[0]?.login ?? 'none'`; `global.fetch = jest.fn()` answering a healthy payload — one github row with `polledAt` = `NOW − 5_000`,
  platform `login 'futin'`; count calls):
  - `'fetches once on mount'` — after `await act(...)`, `fetch` called once with `'/api/trackers'`.
  - `'schedules the next fetch just after the server's next tick'` — the deadline is `polledAt + 17_000 + 500 − now` = `12_500` ms for a stamp 5 s old:
    advance `12_499` ms → still 1 call; advance 1 ms more → 2 calls.
  - **(Review Focus 2)** `'floors the schedule at one second when the stamp is already older than a cycle'` — `polledAt = NOW − 60_000` → after `999` ms 1 call,
    after `1_000` ms 2 calls.
  - `'falls back to one cycle when no row has polled yet'` — `polledAt: null` → 2nd call at exactly `17_000`.
  - `'sets no timer when no project is a tracker'` — rows all `source: 'files'` → advance `60_000` → still 1 call.
  - `'re-arms after an error at one cycle'` — `fetch` rejects → `error true`, 2nd call at `17_000`.
  - `'refetches on focus and re-arms from that answer'` — `window.dispatchEvent(new Event('focus'))` → 2 calls; the old timer is gone: advancing to the old
    deadline adds nothing; the new deadline (from the second response's stamp) fires the 3rd.
  - `'clears the pending timer on unmount'` — unmount, advance `60_000` → still 1 call.
  - `'the provider hands one state to every reader'` — two probes under one `TrackersProvider` both read `futin` after 1 fetch call (not 2).
  - `'a reader without a provider sees the loading state and does not throw'` — `render(<Probe/>)` bare → text `none`, no fetch call.

- [ ] **Step 2: Run to verify they fail.** `pnpm run test:jest -- test/use-trackers.test.tsx` — expected: the schedule cases fail (no second call), the
  context cases fail on the missing module.

- [ ] **Step 3: Implement.** In `useTrackers.ts` keep the `isTrackersPayload` guard and error path; add a `timer` ref, an `arm(ms)` that clears then sets, and
  compute the delay from the payload as specified. Header comment: why the client asks right after the server's tick (the bar reaches the end and snaps back
  instead of drifting), why the 1 s floor, why no timer without a tracker. Create `TrackersContext.tsx`; switch `TrackersGroup` to the context (its header
  comment gains one sentence: it no longer owns the fetch, the shell does). Wrap `SettingsView`'s render in `settings-view.test.tsx` with the provider.

- [ ] **Step 4: Run to verify they pass.** `pnpm run test:jest -- test/use-trackers.test.tsx test/settings-view.test.tsx` — green. `pnpm run typecheck` — clean.

- [ ] **Step 5: Commit.** `feat(tracker): one useTrackers at the shell, scheduled on the server's poll clock`.

---

### Task 4: `TrackerChip` and its popover (spec §2)

**Files:**
- Create: `client/src/components/TrackerChip.tsx` (chip + `TrackerPopover`, the popover a separate component mounted only while open)
- Modify: `client/src/styles.css` — a new `/* ---------------------------------------------- Tracker chip` section (page CSS, outside the primitives block)
- Test: `test/tracker-chip.test.tsx`

**Interfaces:**
- Consumes: `useTrackersContext` (Task 3), `Meter` (Task 2), `pollProgress`, `sweepProgress`, `apiUsage`, `accessReason`, `hasTracker` (Task 1), `useNow`,
  `useDialogEscape`, `Section` from `lib/sections`.
- Produces: `export function TrackerChip({ section }: { section: Section }): JSX.Element | null`. Root `<div class="tracker-chip-root">` (position: relative)
  holding `<button class="tracker-chip" aria-haspopup="dialog" aria-expanded aria-label="Tracker: <login>">` and, while open, `<div class="tracker-pop"
  role="dialog" aria-label="Tracker">`. Test ids: `tracker-chip`, `tracker-pop`, `tracker-row` (one per github row), `tracker-pip`.

Readings (spec §2.2, §2.4), from `data` and `now = useNow(true, 1_000)`:
- `null` when `data === null` or `!hasTracker(data.projects)`.
- `platform = data.platforms.find(p => p.kind === 'github')`; `noToken = platform === undefined || !platform.hasToken`.
- Avatar text: `noToken ? '—' : login[0].toUpperCase()`. Name: `noToken ? 'no token' : login`.
- Pip: `noToken` → `data-tone="amber"`; else if some github row's `access !== 'ok'` → `"red"`; else no pip element.
- `POLL` meter (hidden when `noToken`): `sweep = sweepProgress(githubRows, now)`; `allFailing = githubRows.every(r => r.access !== 'ok')`; value/tone/fraction:
  `allFailing` → `fraction 1, tone red, value 'failing'`; `sweep === null` → `fraction null, value '…'`; `sweep.overdue` → `fraction 1, amber, 'overdue'`; else
  `fraction sweep.fraction, green, `${sweep.leftS}s``.
- `API` meter (hidden when `noToken` or `apiUsage(platform) === null`): `usage.label`, `usage.fraction`, tone `fraction ≥ 0.9 ? red : ≥ 0.6 ? amber : green`.
- Caret: `<span class="tracker-caret" aria-hidden>▾</span>`, rotated by `[aria-expanded="true"]`.
- Popover: identity line `GitHub · N repos connected` (`N` = github rows count; `1 repo connected` singular); one `tracker-row` per github row — name, muted
  repo, then a 120 px `Meter` — `<Meter label="next" value=… fraction=… tone=… width={120} />` — with: `access !== 'ok'` → `fraction 1, red, value
  accessReason(row)`; `pollProgress(row.polledAt, now) === null` → `null, 'connecting…'`; `overdue` → `1, amber, 'overdue'`; else `fraction, green,
  `${leftS}s``. Then the API block: a full-width `Meter` (`width` = 388, the popover's inner width at 420 − 2 × 16; label `API`, value `usage.label`) and
  the line `${left.toLocaleString()} of
  ${limit.toLocaleString()} left · resets ${resetsAt}` (omit the `· resets …` clause when `resetsAt` is null). In the no-token state the rows and API block
  are replaced by the one paragraph: `No token on this machine. Put BM_GITHUB_TOKEN in .env and restart the stack.` No footer.
- Dismissal: `TrackerPopover` calls `useDialogEscape(onClose)`; the chip's root registers `document.addEventListener('pointerdown', …)` while open and closes
  when `!root.contains(e.target)`; `useEffect(() => setOpen(false), [section])` closes on section change.

- [ ] **Step 1: Write the failing tests** in `test/tracker-chip.test.tsx` (jsdom; a `renderChip(payload, section = 'board')` helper wrapping in a
  `TrackersContext.Provider` with `{ data: payload, loading: false, error: false, reload }` — provide the context directly rather than stubbing fetch;
  fixtures: `platform()` = `{ kind: 'github', hasToken: true, login: 'futin', limit: 5000, remaining: 4930, reset: 1_790_000_000 }`, `row()` as in Task 1 with
  `polledAt` = `new Date(Date.now() − 5_000).toISOString()`; `jest.useFakeTimers()` with `setSystemTime` so `useNow` is deterministic):
  - `'renders nothing when no project is a tracker'` — rows all `files` → `queryByTestId('tracker-chip')` null; `data: null` → null.
  - `'draws the login, a POLL countdown and the API share for a healthy payload'` — `F` avatar text, `futin`, `POLL` with `12s`, `API` with `1.4%`; no pip.
  - `'advances the countdown once a second'` — advance `1_000` → `11s`.
  - `'reads overdue on a full amber bar at two cycles'` — `polledAt = now − 34_000` → value `overdue`, the POLL meter root `data-tone="amber"`, fill `100%`.
  - `'reads failing on a full red bar when every repo is failing, and only a red pip when some are'` — two rows both `access: 'forbidden'` → `failing`, red; one
    `ok` one `forbidden` → `12s` green and `tracker-pip` with `data-tone="red"`.
  - `'reads … before the first poll'` — rows `polledAt: null` → value `…`, fill `0%`.
  - **(Review Focus 5)** `'takes no-token from the platform, not from the rows'` — `platform({ hasToken: false, login: null })` with rows `access: 'ok'` → name
    `no token`, avatar `—`, amber pip, no `POLL`/`API` text; conversely `hasToken: true` with every row `access: 'no-token'` → `futin`, red pip, `failing`.
  - `'hides the API meter until the platform has a limit'` — `limit: null` → no `API` text, `POLL` still drawn.
  - `'opens a read-only popover with one row per connected repo'` — click → `getByRole('dialog', { name: 'Tracker' })`; `getAllByTestId('tracker-row')` length 2
    for two github rows (a third `files` row adds none); the identity line `GitHub · 2 repos connected`; `within(dialog).queryAllByRole('button')` and
    `queryAllByRole('link')` both empty.
  - `'draws a failing repo as a full red bar carrying the access reason'` — row `access: 'forbidden', detail: 'x'` → within its row: the same string
    `accessReason(row)` returns, `data-tone="red"`, fill `100%`.
  - `'draws the API line with the remaining count and the reset clock'` — text matches `/4,930 of 5,000 left · resets \d{2}:\d{2}/` (locale-dependent digits:
    assert with `resetClock(1_790_000_000)` from Task 1 instead of a regex).
  - `'replaces the rows with the token sentence when there is no token'` — text contains `BM_GITHUB_TOKEN`; no `tracker-row`.
  - `'closes on a pointerdown outside and stays open on one inside'` — `fireEvent.pointerDown(document.body)` → dialog gone; reopen; `pointerDown` on a row →
    still open.
  - `'closes when the section changes'` — rerender with `section="runs"` → gone.
  - `'gives Escape to the popover and not to a dialog beneath it, then hands it back'` — the shape of `test/dialog-escape.test.tsx:359`, kept independent
    of the Board: render a tiny local component that calls `useDialogEscape(closeBelow)` first, then open the chip; `userEvent.keyboard('{Escape}')` →
    popover closed, `closeBelow` not called; a second Escape → `closeBelow` called once.
  - **(Review Focus 3)** `'follows the payload while open'` — open with two rows, rerender the provider with one row → one `tracker-row`, dialog still open, no
    error; rerender with `hasToken: false` → the token sentence, no rows.

- [ ] **Step 2: Run to verify they fail.** `pnpm run test:jest -- test/tracker-chip.test.tsx` — expected: module not found.

- [ ] **Step 3: Implement** `TrackerChip.tsx` and the CSS: `.tracker-chip-root { position: relative; flex: none }`; `.tracker-chip { display: inline-flex;
  align-items: center; gap: 10px; height: 36px; padding: 0 10px 0 5px; border: 0; border-radius: 999px; background: none; color: var(--ink); cursor:
  pointer }`, hover/`[aria-expanded="true"]` → `background: var(--strip-hi)`; `.tracker-av { position: relative; width: 26px; height: 26px; border-radius:
  999px; background: var(--strip-hi); display: grid; place-items: center; font-size: 12px; font-weight: 600 }`; `.tracker-pip { position: absolute; right: -1px;
  bottom: -1px; width: 7px; height: 7px; border-radius: 999px; border: 1.5px solid var(--strip) }` coloured by `[data-tone]`; `.tracker-name { font-size:
  12.5px; font-weight: 600 }`; `.tracker-meters { display: flex; gap: 10px }`; `.tracker-caret { font-size: 11px; color: var(--ink3); transition: transform .15s }`
  and `[aria-expanded="true"] .tracker-caret { transform: rotate(180deg) }`; `.tracker-pop { position: absolute; right: 0; top: calc(100% + 6px); width: 420px;
  padding: 14px 16px; border-radius: 16px; background: var(--strip); box-shadow: <the same shadow `.ui-modal`/`.ui-sheet` use — read it, do not invent one>;
  z-index: 20 }`; `.tracker-pop-id { display: flex; align-items: center; gap: 10px; margin-bottom: 12px }`; `.tracker-row { display: grid; grid-template-columns:
  minmax(0, 1fr) 120px; align-items: center; gap: 12px; padding: 6px 0; border-top: 1px solid var(--hairline) }`; `.tracker-row-name { font-size: 13px }`,
  `.tracker-row-repo { font-size: 12px; color: var(--ink3) }`; `.tracker-pop-api { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--hairline);
  font-size: 12px; color: var(--ink2) }`; `.tracker-pop-note { font-size: 13px; color: var(--ink2); line-height: 1.45 }`. Header comment on the component:
  §8.0, the shell rule ("true of the machine wherever you stand → out of the section"), why click-outside is its own listener while Escape is the stack's,
  why there are no links (the rail rule).

- [ ] **Step 4: Run to verify they pass.** `pnpm run test:jest -- test/tracker-chip.test.tsx test/dialog-escape.test.tsx test/design-guards.test.ts` — green.
  `pnpm run typecheck` — clean.

- [ ] **Step 5: Commit.** `feat(shell): TrackerChip — login, POLL and API meters, a per-repo popover`.

---

### Task 5: The strip — `.maincol`, `--main-gap`, the narrow home, design guard 9 (spec §1, §7)

**Files:**
- Modify: `client/src/App.tsx:91-103` (shell) and the `Shell`/`App` wrapper (`TrackersProvider`)
- Modify: `client/src/components/SideRail.tsx:37-40, 98-107` (`chipSlot` prop, drawn in `.rail-bar` between the brand and ☰)
- Modify: `client/src/styles.css` — `:root` (~35), `.shell`/`.rail` (~131), `.rail-bar` (~211), `.main` (~217-222), the 700 px block (~231-249), `.runs-board`
  (~1385)
- Modify: `test/design-guards.test.ts` (guard 9)
- Test: `test/shell-strip.test.tsx`

**Interfaces:**
- Consumes: `TrackerChip` (Task 4), `TrackersProvider` (Task 3), `useNarrow`.
- Produces: `SideRail` gains `chipSlot?: ReactNode`; `App`'s tree is `.shell > .rail + .maincol > (.topstrip + .main)`; token `--main-gap: 50px` on `:root`,
  `0px` inside `@media (max-width: 700px)`.

CSS changes, exactly: `:root { --main-gap: 50px }` beside `--body-pad`; new `.maincol { flex: 1; min-width: 0; display: flex; flex-direction: column;
background: var(--strip) }` and `.topstrip { height: var(--main-gap); display: flex; align-items: center; justify-content: flex-end; padding: 0
var(--body-pad); flex: none }`; `.main` keeps `flex: 1; min-width: 0` (it now fills the column vertically instead of the shell horizontally) and drops
`margin-top: 24px` entirely; its comment is rewritten (the strip is what makes the radius visible; `body` stays `--board`). In the
700 px block: `:root { --main-gap: 0px }`, `.topstrip { display: none }`, `.maincol { display: contents }` (so `.main` is the column's direct flex item as
before), and `.main { border-top-left-radius: 0 }` (the `margin-top: 0` there is dead once the base has none — remove it). `.runs-board` → `calc(100vh /
var(--font-scale, 1) - var(--body-pad) * 2 - var(--main-gap))`. `.rail-bar` at narrow gains `gap: 8px`; the chip sits between brand and ☰ (the ☰ keeps
`margin-left: auto`, so give the chip no margin and let the brand/chip/☰ order do the work — chip pill 36 px fits the bar's row).

App: `TrackersProvider` wraps the shell; `const narrow = useNarrow()`; `const chip = <TrackerChip section={section} />`; `<SideRail … chipSlot={narrow ?
chip : undefined} />`; `.topstrip` renders `{narrow ? null : chip}` — **one element, one home, chosen in JS** (spec §1.2), the strip itself always in the
tree (CSS hides it at narrow, keeping `.runs-board`'s calc honest).

- [ ] **Step 1: Write the failing tests** in `test/shell-strip.test.tsx` (jsdom; copy `nav.test.tsx`'s two `jest.mock` stubs for `BoardView` and
  `SettingsView`; copy `installMatchMedia` from `test/ui-use-narrow.test.tsx`; `global.fetch` answers `/api/trackers` with a healthy payload (one github row,
  `login 'futin'`) and `{ items: [], errors: [] }`-shaped `{ ok: true }` JSON for anything else — Archive's fetch tolerates a wrong shape as `nav.test` shows):
  - `'draws the chip in the top strip at desktop width, and nowhere else'` — `render(<App/>)`; `await screen.findByTestId('tracker-chip')`; its
    `closest('.topstrip')` non-null; `document.querySelectorAll('[data-testid="tracker-chip"]').length === 1`; `.rail-bar` absent.
  - `'moves the chip into the rail bar below 700 px'` — `installMatchMedia(true)` → chip's `closest('.rail-bar')` non-null, `closest('.topstrip')` null,
    count 1.
  - **(Review Focus 4)** `'closes the popover when the chip changes home'` — start wide, open the popover, `act(() => mm.emit(true))` → `queryByRole('dialog',
    { name: 'Tracker' })` null; the chip is in the rail bar.
  - `'keeps the strip in the tree when there is no tracker'` — payload with only `files` rows → `.topstrip` present and empty (`children.length === 0`).
  - `'the strip precedes the main column and the rail precedes both'` — `document.querySelector('.shell')!.children` are `[nav.rail, div.maincol]`, and
    `.maincol.children` are `[.topstrip, main.main]`.
  - In `test/design-guards.test.ts`, `describe('guard 9 — the strip's height and the well's gap are one token')`:
    - `'--main-gap is declared on :root exactly twice: the default and the narrow override'` — `styleRules.filter(r => /--main-gap:/.test(r.body))` has length 2,
      both `selector === ':root'`, bodies read `50px` and `0px` respectively (in file order).
    - `'no .main rule declares margin-top'` — every rule whose selector is exactly `.main` has no `margin-top` in its body.
    - `'.topstrip and .runs-board read the token, and nothing else does'` — `.topstrip`'s body contains `height: var(--main-gap)`; `.runs-board`'s body
      contains `- var(--main-gap)`; the count of `var(--main-gap)` across all rule bodies is exactly 2.

- [ ] **Step 2: Run to verify they fail.** `pnpm run test:jest -- test/shell-strip.test.tsx test/design-guards.test.ts` — expected: shell cases fail (no
  chip / no `.topstrip`), guard 9 fails (0 declarations).

- [ ] **Step 3: Implement** the CSS, `SideRail` prop and `App` tree as specified. Rewrite the `.main` CSS comment and the App JSX comment above `<main>` to say
  why the strip exists and why `body` stays `--board`. `SideRail`'s doc comment gains the slot: the phone bar is the chip's narrow home because the strip is
  not drawn there (§8.0).

- [ ] **Step 4: Run to verify they pass.** `pnpm run test:jest -- test/shell-strip.test.tsx test/design-guards.test.ts test/nav.test.tsx
  test/ui-use-narrow.test.tsx test/runs-view.test.tsx` — green. `pnpm run typecheck` — clean. Then look: `pnpm run dev:web` against the running API on 4322
  (or the compose stack), open `http://127.0.0.1:5177`, confirm on the daylight theme that the strip is white, the well's top-left corner curves, the chip
  counts down and snaps back at the server's tick, Runs fills the viewport without a scrollbar at 100 % and 120 % font scale, and the phone width puts the chip
  beside ☰. Kill only the process you started, by its pid.

- [ ] **Step 5: Commit.** `feat(shell): the tracker strip — one --main-gap above every section, chip in the rail bar below 700 px`.

---

### Task 6: The Board band loses its tracker lines (spec §6)

**Files:**
- Modify: `client/src/components/board/BoardView.tsx:414-415, 473, 641-650` (`trackerLines`, the spans; `useNow`'s `tracked` arm if nothing else reads it)
- Modify: `client/src/styles.css:2512-2517` (`.board-band-tracker` rule and its comment; keep `.item-body-tracker`)
- Modify: `test/tracker-board.test.tsx:313-330`

**Interfaces:** none new. `trackerLine` stays exported from `lib/tracker.ts` (the item modal's reader).

- [ ] **Step 1: Flip the tests.** In `test/tracker-board.test.tsx` replace the three band cases with one: `'draws no tracker line in the band — the strip chip
  is that reading's home now'` — `renderBoard([issueItem()])` → `queryByTestId('tracker-line')` null; and keep the item modal's own line case if the suite
  has one (search the file for `item-body-tracker`; if the modal's line is asserted elsewhere, leave that alone). Run: `pnpm run test:jest --
  test/tracker-board.test.tsx` — expected: the new case fails (a line is drawn).

- [ ] **Step 2: Implement.** Remove `trackerLines` and the `.map` at ~646; remove the `.board-band-tracker` rule and rewrite its comment for the one reading
  left (`.item-body-tracker`). Then grep `BoardView.tsx` for every reader of `now`: if the only tracker-driven reader was `trackerLines`, change `useNow(hasLive
  || tracked, tracked ? 5_000 : 60_000)` to what the remaining readers need (`useNow(hasLive, 60_000)` if only the run readings use it) and drop the
  `hasTracker` import if unused; if the item modal's age or `claimControl` still takes `now` from here, leave the call as it is. Record the decision in the
  comment at ~392.

- [ ] **Step 3: Verify.** `pnpm run test:jest -- test/tracker-board.test.tsx test/board.test.tsx test/board-run-chip.test.tsx test/item-modal.test.tsx` —
  green; `pnpm run typecheck` — clean; `grep -rn "board-band-tracker" client/ test/` — empty.

- [ ] **Step 4: Commit.** `refactor(board): the band no longer prints tracker lines`.

---

### Task 7: Docs, the new invariant, rules and CLAUDE.md (spec §7)

**Files:**
- Modify: `.claude/DESIGN.md` §8.0 (~164-183: a "Shell strip" paragraph after the phone-bar paragraph) and §8.3 band paragraph (~243)
- Modify: `docs/subsystems/board.md` "A connected tracker" (~234-241) and the `hooks/useTrackers.ts` line (~283)
- Modify: `docs/subsystems/invariants.md` — new `## The strip's height and the well's gap are one token` section, placed after the Escape section
  (~1573-1600); extend the Escape section with the popover entry (fourth non-dialog-counted entry beside `Confirm`)
- Modify: `.claude/rules/board.md` — new bullet, and the Escape bullet's count
- Modify: `CLAUDE.md` — new Invariants headline (byte-equal with the rule bullet's bold span) + `Why:` link; the `client/src/` line's tracker sentence
- Modify: `docs/overview.md:18` only if the board.md one-liner no longer fits (it does — leave it unless you change what board.md is about)

**Interfaces:** `test/claude-rules.test.ts` is the guard: every rule bullet anchored exactly once into `invariants.md`, headline byte-equal with CLAUDE.md's,
one home per anchor.

- [ ] **Step 1: Run the rule guard first**, so the change is test-driven: `pnpm run test:jest -- test/claude-rules.test.ts` — green before; after adding ONLY
  the CLAUDE.md headline it must go red ("missing on the rules side"), which proves the guard sees it.

- [ ] **Step 2: Write the invariant.** Headline (CLAUDE.md and the rule bullet's bold span, identical): **The strip's height and the well's gap are one token,
  `--main-gap`, read by the strip and the Runs page — never a px literal.** Mechanism (`.claude/rules/board.md`, one bullet, ≤ the file's usual length):
  `--main-gap` is declared on `:root` (50 px) and overridden to `0px` in the 700 px block; `.topstrip` is its height, `.runs-board` subtracts it, `.main` has no
  `margin-top`; `App.tsx` renders the chip in ONE of two homes chosen by `useNarrow`; design guard 9 pins the three readers and the two declarations. `Why:`
  link to the new anchor. Reasoning (`invariants.md`): the 24 px margin that never showed because `body` is `--board`; why the strip is `--strip` and not a
  new token; why the Runs page must subtract it (100vh fill); why the chip has one home, not CSS-hidden twins (two `useNow` clocks, two popovers on the
  Escape stack); why the phone keeps `0px` rather than a smaller strip.

- [ ] **Step 3: Extend the Escape rule** (rule bullet + invariants section + `useDialogEscape.ts`'s "all four call sites" comment): `TrackerPopover` is the
  second entry that is not a dialog — mounted only while open, joins by mount order, closes only itself; still three dialogs counted.

- [ ] **Step 4: Rewrite the docs.** DESIGN §8.0: the strip (50 px, `--strip`, right-aligned chip, the L with the rail, the curve), the chip's anatomy and the
  11 px adjustments (spec §2.2–2.3), the phone home. §8.3: the band paragraph loses "the poll-age line"; if it lists what the band carries, the list is
  title/count/search/run chip/controls. `board.md` "A connected tracker": *one chip in the shell and three readings on the card and modal*; describe
  `TrackerChip`, `Meter`, `useTrackers`' schedule and `TrackersContext`, where the chip lives at each width; the `hooks/useTrackers.ts` line becomes "the
  shell's one instance, on the poll clock; Settings reads it through `TrackersContext`". CLAUDE.md `client/src/`: "A connected tracker adds one shell-level
  chip (the strip, or the rail bar below 700 px) and three item readings: …" — keep the rest of that sentence. Do **not** touch the `verified:` stamps at the
  foot of the docs; the docs-sync pass restamps them.

- [ ] **Step 5: Verify.** `pnpm run test:jest -- test/claude-rules.test.ts test/design-guards.test.ts` — green; then the whole union: `pnpm test` — green
  (note WSL is not this machine; every case must pass here). `pnpm run typecheck` and `pnpm run build` — clean.

- [ ] **Step 6: Commit.** `docs: the tracker strip — DESIGN §8.0, board.md, and the one-token invariant`.

---

## Self-review (done while writing; kept so the executor sees the seams)

- **Spec coverage:** §1 → Task 5; §2 → Task 4; §3 → Task 2; §4 → Task 3; §5 → Task 1; §6 → Task 6; §7 → Tasks 5 (guard 9) and 7; §8 → each task's tests.
  §2.4's identity line and API line: Task 4. §1.3's theme rule: Tasks 2/4 CSS. The spec's §2.1/§4 `hasTracker` slip is corrected in Task 1 step 1.
- **Names used across tasks:** `TRACKER_CYCLE_MS`, `pollProgress`, `sweepProgress`, `apiUsage`, `resetClock`, `hasTracker` (Task 1) ← Tasks 3, 4;
  `Meter` props `label/value/fraction/tone/width` (Task 2) ← Task 4; `useTrackersContext`, `TrackersProvider`, `TRACKER_FETCH_SLACK_MS` (Task 3) ← Tasks 4, 5;
  `TrackerChip({ section })`, test ids `tracker-chip`/`tracker-pop`/`tracker-row`/`tracker-pip` (Task 4) ← Task 5; `chipSlot` (Task 5).
- **Review Focus:** 1 → Task 1; 2 → Task 3; 3 → Task 4; 4 → Task 5; 5 → Task 4 — each has a named case.
- **Order matters:** Task 3 before 4 (context), 4 before 5 (chip), 6 after 5 (the reading must have its new home before the old one goes).
