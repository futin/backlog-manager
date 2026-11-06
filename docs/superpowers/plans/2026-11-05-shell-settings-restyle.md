# Shell and Settings restyle (status pills, Sync now, always-on counts, Settings pages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the shell (rail, status pills, status popover) and every Settings page per the app restyle spec, add the two `Sync now` routes, and give
the rail always-on GitHub and Runs counts without adding a second poller anywhere.

**Architecture:** Two primitives (`ui/StatusPill`, the `NumberField` stepper); two shell contexts (`OrchestratorRunsContext` replaces the per-view runs
polls and `useReportWorking`, `PullRequestsContext` lifts the PRs page's 60 s read to the shell); two guarded server routes that ask an already-armed poller
for one sweep; then `SideRail`, `TrackerChip`, `JiraChip` and the `settings/` components compose them, with CSS in `client/src/styles.css`.

**Tech Stack:** React + TypeScript (Vite), NestJS, plain CSS with daylight tokens (`shared/theme.css`), jest + Testing Library (jsdom), supertest.

**Spec:** `docs/superpowers/specs/2026-11-05-app-restyle-design.md` §4.9, §4.9a, §4.10, §5, §8, §9 (plan 4 of 4, §10). Mocks:
`docs/superpowers/specs/2026-11-05-jira-restyle-mockups/` — `Shell.dc.html`, `Settings.dc.html`, `SettingsMore.dc.html`; `00-mock-audit.md` "Round 2" row
Shell for what is drawn but not built (the API port, a second Jira count colour). Runs after plans 1–3 on the same branch.

**How to read this plan (override of writing-plans' code-block rule).** This plan gives behaviour, names, signatures, exact values and exact test CASES —
never literal code. Write the code and the test bodies yourself; if a case here looks wrong against the code, say so in your report rather than transcribe
it. Line counts are soft. Where the plan and the spec differ, the spec wins; report the difference.

## Global Constraints

- Everything in plan 1's Global Constraints holds: one uppercase rule (`.rail-kicker`), the 11 px floor, the tint form
  `color-mix(in srgb, var(--<mark>) N%, var(--strip)|var(--steel))` (never bare `var(--amber)`), CSP `style-src 'self'` (no `style=`, no `<style>`), no new
  theme tokens, no dark-only rules, flat jest tests, touched suites only (`pnpm exec jest <files>`), `git add <paths>` (never `-A`), new prose at 160 columns,
  commit messages end with the executing session's own attribution line.
- **Primitives block and guard 7** (`test/design-guards.test.ts:323` `FAMILIES`, cases :380-396): every `ui-*` family is declared once, inside
  `/* ── ui primitives` … `/* ── end ui primitives`, and ANY selector outside that block that names a `ui-*` class anywhere — descendant side included — fails.
  Page CSS never writes `.rail-x .ui-pill` or `.set-x .ui-number`; it uses its own classes on its own elements, or a structural selector (precedent
  `styles.css:1288`, `> button`). New shared looks (StatusPill, the stepper) are primitives, inside the block, with `FAMILIES` updated.
- **`daylight-contrast` `PINNED`** (`test/daylight-contrast.test.ts:393`) gains every new tint site; each key equals the CSS selector exactly (quotes
  included, whitespace normalised). Dots and stripes are marks, not tints; pills and tiles are tints.
- **Popover composers stay at ten** (plans 1–3 moved them). The status popovers are the existing `TrackerChip` / `JiraChip` composers; this plan adds none
  and no dialog. `test/dialog-count-docs.test.ts` must stay green untouched.
- **Server:** every route under `/api`, behind `SameOriginPostGuard`; the server never writes git; a sweep never ARMS a poller (spec §3), it only asks one
  that is armed. Supertest via `listenLoopback` (`test/helpers/app.ts`); fixture dates via `daysAgoDate`.
- Before each commit, `grep -l <symbol> test/` for every shared hook or helper the task adds a caller of, and add the hits to the run (each task names its
  known hits; re-run the grep, the list may have grown).

## Review Focus

1. A Jira site in a stored 429 window when Sync now is pressed — 429 with the stored `retryAt`, no outbound call, and the popover says
   `Jira asked to wait until <HH:MM>` rather than an error (Tasks 4, 7).
2. Sync now pressed twice quickly, and pressed while the timed sweep is already running — one outbound sweep, both callers get the same answer (Tasks 4, 5).
3. Every GitHub repo `off`, or no token — the GitHub pill is red/grey not green, the rail's GitHub count is hidden, and Sync now answers 409. The PR
   reader stays gated on `hasTracker` (a registered GitHub project), so it still mounts: GET `/api/prs` answers `{ token: false, repos: [] }` with no
   outbound call (`pulls.service.ts:171-178`), and the PRs page keeps its no-token message (Tasks 3, 5, 7).
4. A tab whose runs request fails or has not answered — the cursor stays solid (`working` undefined), the Runs pill is hidden, no view crashes (Task 2).
5. A Watchdog value saved on the host that is not on today's ladder (an old `watchdog.json`) — the stepper shows it and steps to the neighbouring rungs
   (Tasks 1, 9).

---

### Task 1: `ui/StatusPill` and the `NumberField` stepper

**Files:**
- Create: `client/src/components/ui/StatusPill.tsx`, `test/ui-status-pill.test.tsx`
- Modify: `client/src/components/ui/NumberField.tsx`, `client/src/styles.css` (primitives block), `test/design-guards.test.ts:323`,
  `test/ui-number-field.test.tsx`, `test/daylight-contrast.test.ts:393` (only if the pill tints)

**Interfaces:**
- Consumes: `type StateTone` from `client/src/lib/tones.ts` (plan 2).
- Produces: `StatusPill({ tone: StateTone; word: string; age?: string | null })` — a 28 px pill (mock `Shell.dc.html` status chips): a 7 px dot carrying
  `data-tone` (`aria-hidden`), the word at 12.5/600, and `age` in `--ink3` when it is a non-empty string; nothing for `null`/absent. Family `ui-status`. It is
  a span; callers wrap it in their own button and give that button the accessible name.
- Produces: `NumberField` gains `step?: number` (default 1), `ladder?: readonly number[]`, `format?: (v: number) => string`. Look `− value unit +` (mock
  `SettingsMore.dc.html`, Watchdog/Tick rows): − and + are `button`s named `Decrease <label>` / `Increase <label>` (`Decrease` / `Increase` with no label).
  Free mode (no `ladder`): the input stays typeable and commits on blur/Enter as today; − / + commit `value ∓ step` clamped to `[min, max]` at once. Ladder
  mode: no textbox (the value is text, `format(value)` or the number); − / + commit the previous / next rung at once; a `value` not on the ladder is placed in
  order and steps to its neighbours. A button at its bound, and both while `disabled`, are disabled. Stepper classes join the existing `ui-number` family.

- [ ] **Step 1: Write the failing tests.** `ui-status-pill`: renders the word; the dot's `data-tone` is each of `green|amber|red|grey`; `age="9s ago"`
  renders it; `age={null}` renders no age node. `ui-number-field` (existing cases unchanged): value 5, min 1, max 10 — `Increase` commits 6 once;
  `Decrease` at value 1 is disabled and commits nothing; `Increase` at 10 is disabled; `step={5}` at 8 commits 10 (clamped); typing 7 + Enter still commits
  7. Ladder `[30000, 60000, 120000]`, value 60000, `format` → `1m`: shows `1m`, no `spinbutton` role; `Increase` commits 120000, `Decrease` 30000; value
  120000 disables `Increase`; value 90000 (off-ladder) steps down to 60000 and up to 120000.
- [ ] **Step 2: Run** `pnpm exec jest test/ui-status-pill.test.tsx test/ui-number-field.test.tsx` — FAIL (no StatusPill, no buttons).
- [ ] **Step 3: Implement** both, CSS inside the primitives block; add `ui-status` to `FAMILIES`. If the pill draws a tinted fill, pin it in `PINNED`.
- [ ] **Step 4: Run** the two suites plus `test/design-guards.test.ts test/daylight-contrast.test.ts` and `grep -l NumberField test/`
  (today: `ui-number-field`) — PASS.
- [ ] **Step 5: Commit** `feat(ui): status pill and number stepper`.

### Task 2: Runs context — one runs poll per tab (spec §4.9a, Runs)

**Files:**
- Create: `client/src/hooks/OrchestratorRunsContext.tsx`
- Modify: `client/src/hooks/useOrchestratorRuns.ts:109-117` (return gains `answered`), `client/src/lib/run-pulse.ts:24` (add beside `runsWorking`), `client/src/App.tsx:76-97` (provider), `:184-229` (pulse/report machinery removed),
  `:371-378`, `:416-426` (no `onWorking`); `ArchiveView.tsx:99,143-144`, `BoardView.tsx:123,161-165`, `PullRequestsView.tsx:81,84-85`,
  `RunsView.tsx:490,505-510`; `test/run-pulse.test.ts:64-94`
- Delete: `client/src/hooks/useReportWorking.ts`

**Interfaces:**
- Produces: `useOrchestratorRuns()` returns `answered: boolean` beside its fields — `false` until the first successful payload, `true` from then on, and
  it STAYS `true` when a later fetch fails (today's return has no such field, and `runs` is `[]` both before and after an empty first answer).
- Consumes: `useOrchestratorRuns()` (`hooks/useOrchestratorRuns.ts:109`), `runsWorking` (`lib/run-pulse.ts:24`), `isRemoteRun` (`lib/remote-run.ts:24`).
- Produces: `liveRunCount(runs, remote): number` in `lib/run-pulse.ts` — local runs whose status is `running` or `paused` plus remote runs in either status
  (what `splitLive` puts in Live). `OrchestratorRunsProvider({ children })` calls `useOrchestratorRuns()` once and provides its whole return plus
  `working: boolean | undefined` (`undefined` while `answered` is false, else `runsWorking(runs, starting)`) and `liveCount: number`.
  `useOrchestratorRunsContext()` returns that value and THROWS outside the provider (a bare render must fail loudly, not draw an empty runs list).
- Mounted in `App` inside `ProjectsProvider`, around `AppShell`; `AppShell` passes `working` to `SideRail` exactly as today.

- [ ] **Step 1: Write the failing tests.** `run-pulse`: `liveRunCount` — one running + one paused + one done local → 2; a running remote → +1; empty → 0.
  The source guard (:64-94) changes shape, with a comment citing spec §4.9a: the ONLY file matching `/=\s*useOrchestratorRuns\(\)/` is
  `hooks/OrchestratorRunsContext.tsx`; `App.tsx` does not match; each of the four `VIEWS` calls `useOrchestratorRunsContext()`; the case
  `has each of those views report its own runs and starting entries up` is deleted (no view reports any more), and no file under `client/src` mentions
  `useReportWorking`. A provider case: two consumers under one provider, fake timers, 10 s → `fetchOrchestratorRuns` called 3 times (mount + two 5 s ticks),
  not 6 (flush the resolved fetch between timer advances: `useRefreshing` re-arms after each answer settles, `board.md:151-153` — never loosen to
  `>= 2`). An orchestrator-hook case (`test/orchestrator-hook.test.tsx`): `answered` is `false`
  before the first fetch resolves, `true` after an empty `{ runs: [] }` answer, and still `true` after a later fetch rejects; the provider's `working` is
  `undefined` before that first answer.
- [ ] **Step 2: Run** `pnpm exec jest test/run-pulse.test.ts` plus that hook suite — FAIL.
- [ ] **Step 3: Implement**; move the `working` comment at `App.tsx:185-200` into the provider, rewritten (the views no longer report).
- [ ] **Step 4: Guard suites.** `grep -l 'useOrchestratorRuns\|useReportWorking' test/` — today dispatch-button, board-live-cards, orchestrator-start-ui,
  watchdog-hook, agents-client, run-pulse, board-run-chip, orchestrator-hook, runs-view, orchestrator-archive-hook, nav, poll-coalescing, prs-view. Every one
  that renders a view bare wraps it in `OrchestratorRunsProvider`; run them all — PASS.
- [ ] **Step 5: Commit** `refactor(client): one runs poll per tab`.

### Task 3: PR context — the shell's PR read (spec §4.9a, GitHub)

**Files:**
- Create: `client/src/hooks/PullRequestsContext.tsx`
- Modify: `client/src/hooks/usePullRequests.ts`, `client/src/lib/pr-layouts.ts`, `PullRequestsView.tsx:82,198`, `GithubAccessGroup.tsx:32`, `App.tsx`;
  `server/src/tracker/pulls.service.ts` header (~:23-30, "Nothing reads pull requests except the PRs page…"); `.claude/rules/tracker.md:109`;
  `.claude/rules/board.md:151`; `test/use-pull-requests.test.tsx`, `test/pr-layouts-lib.test.ts`

**Interfaces:**
- Produces: `PullRequestsProvider({ children })` reads `useTrackersContext()`; enabled iff `hasTracker(data.projects)` (a GitHub project is registered —
  the PRs page's own no-token message keeps working). While enabled it mounts an inner reader calling `usePullRequests()` (unchanged: 60 s, `armed: true`);
  while disabled nothing mounts and nothing is read. Tests add a no-token case: a registered GitHub project and GET `/api/prs` answering
  `{ token: false, repos: [] }` → `enabled` true, `needsYouCount(data)` 0 (the hidden rail pill is pinned in Task 6, where `SideRail` gains `counts`). `usePullRequestsContext(): { data; error; refresh; enabled: boolean }` (disabled: `data` and `error`
  null, `refresh` resolves `null`). Throws outside the provider.
- Produces: `needsYouCount(data: PullRequestsPayload | null): number` in `lib/pr-layouts.ts` — the Inbox's `Needs you` number: the same pipeline
  `PullRequestsView.tsx:198` feeds the Inbox (`groupRepos`, `lib/prs.ts:242` → `splitReach(...).shown` → `rankPrs` → `levelCounts`);
  `null` → 0.

- [ ] **Step 1: Write the failing tests.** `pr-layouts-lib`: `needsYouCount` equals the Inbox's `Needs you` figure for an existing fixture; a forbidden repo's
  PRs are not counted; `null` → 0. `use-pull-requests`: under the provider with no GitHub project, no `/api/prs` request on mount or after 60 s; with one, the
  PRs view and the Access card mounted together make ONE request per 60 s.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**; move the three doc statements in this commit, each now naming the shell as the always-on reader with
  spec §4.9a as the reason (the server cache stays on demand, no timer).
- [ ] **Step 4: Guard suites** `grep -l 'usePullRequests\|useTrackersContext\|rankPrs' test/` — today use-pull-requests, github-settings, use-trackers,
  pr-layouts-lib, plus prs-view — PASS.
- [ ] **Step 5: Commit** `feat(client): shell-level PR read for the rail count`.

### Task 4: `POST /api/jira/sweep` (spec §5)

**Files:**
- Modify: `server/src/jira/poller.service.ts` (beside `boardSaved` :272), `server/src/jira/jira-write.controller.ts` (beside #472's `boards/sweep`
  :101-123), `test/jira-write-routes.test.ts` (the new route joins the guard describe's `it.each` lists :86-113 only — NOT the `unconfigured` describe :115-147, whose 400/503 cases contradict this route's no-body read and 409), `docs/subsystems/jira.md` (route table :139, and
  :350 beside the `boards/sweep` paragraph)
- Create: `test/jira-sweep-route.test.ts`

**This route is SITE-WIDE only.** #472 already ships the per-board sweep: `POST /api/jira/boards/sweep { id }` (`jira-write.controller.ts:101-123`), which
reuses `boardSaved`, sweeps an `off` board too (a manual-only board is the one a `now` exists for) and is not refused inside a 429 window. That route and
its semantics are unchanged; Task 7's per-row icon posts it. `POST /api/jira/sweep` takes no target and is the popover head's `Sync now` only. This is a deviation from spec §5 and §8 (no optional `{ boardId }`, so
no 404 `unknown board` and no malformed-body 400), per #472's `boards/sweep`: report it with the plan's deviations, and Task 11 lists it.

**Interfaces:**
- Produces: `JiraPollerService.sweepNow(): Promise<SweepNowResult>` with
  `SweepNowResult = { kind: 'done' } | { kind: 'not-armed' } | { kind: 'wait'; retryAt: number }`; `SWEEP_FLOOR_MS = 5_000` exported.
  Order: not armed and nothing in flight → `not-armed`; `expireWindow(now)` then `inWindow(now)` → `wait` with `boot.retryAt`, no call; a sweep in flight →
  join it; last sweep finished < `SWEEP_FLOOR_MS` ago → `done` without calling out; else mark every non-`off` board in `forced` and `await tick()`.
- Route: `@Post('sweep')`, guarded, no body read. 200 → the `status()` payload with `live` filled as GET `/api/jira` does (`jira.controller.ts:45,63-66`);
  409 `{ message: 'Jira is not being polled' }`; 429 `{ message: 'rate limited', retryAt: <ISO> }` — this site-wide button is the only Jira sweep that
  answers 429 in a window. A 401/5xx/transport failure inside the sweep is a 200 (the poller records it as a timed sweep).

- [ ] **Step 1: Write the failing tests** (pattern of `test/jira-poller.test.ts`, `test/jira-write-routes.test.ts`): 409 when unconfigured; 409 when only
  `off` boards remain swept (disarmed); 200 and one search call per non-`off` board, none for the `off` one; two concurrent POSTs → one
  sweep's calls; a second POST 1 s after the first → zero new calls; `jira-write-routes` `boards/sweep` cases (:200-216) unchanged and green; inside a
  stored 429 window → 429 with that `retryAt`, zero calls; a 401 from Jira → 200, `access: 'unauthorized'`; a cross-origin POST → refused by the guard.
- [ ] **Step 2–4:** run `pnpm exec jest test/jira-sweep-route.test.ts test/jira-poller.test.ts test/jira-write-routes.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(jira): POST /api/jira/sweep`.

### Task 5: `POST /api/github/sweep` (spec §5)

**Files:**
- Modify: `server/src/tracker/poller.service.ts` (beside `tick()` :451, reusing `sweep()` :749-786 and `asleep` :1115), `server/src/tracker/pulls.service.ts`
  (beside `refresh` :428), `server/src/tracker/tracker.controller.ts:32-40`
- Create: `test/github-sweep-route.test.ts`

**Interfaces:**
- Produces: `TrackerPollerService.sweepNow(repo?: string): Promise<SweepNowResult>` (same union and `SWEEP_FLOOR_MS` value, own export): not armed and
  nothing in flight → `not-armed`; `repo` not a registered GitHub project → `unknown`; `repo` asleep → `wait` with the later of `sleepUntil` /
  `secondaryUntil`; in flight → join; inside the floor → `done`; else sync every non-`off`, non-asleep repo (or the named one) regardless of `due`, stamping
  `lastSyncAt` as `sweep()` does. Then `PullRequestsService.refreshNow(repos: string[]): Promise<void>` re-reads those repos once past `PR_TTL_MS` through the
  same `reading` map join (one read per repo in flight).
- Route: `@Post('github/sweep')` on `TrackerController` (`@Controller('api')`), guarded, body optional `{ repo: string }`. 200 → `TrackersPayload` (as
  `trackers()` :40); 409 `{ message: 'GitHub is not being polled' }`; 404 `<repo> is not the repo of a registered GitHub project` (`pulls.service.ts:325`);
  400 malformed; 429 `{ message: 'rate limited', retryAt: <ISO> }`. 401/5xx/transport → 200, cache and `access`/`detail` as a timed sweep leaves them.

- [ ] **Step 1: Write the failing tests** (pattern of `test/tracker-poll.test.ts`, `test/prs-cache.test.ts`, `test/tracker-sync-route.test.ts`): 409 with no
  token / not armed; an `off` repo is skipped (no call), others swept; two concurrent POSTs → one call per repo; a POST 1 s later → zero calls; unknown
  `repo` → 404 with the exact text; body `{ repo: 3 }` → 400; asleep named repo → 429 with the later end (both pools set, secondary later), zero calls;
  no `repo` with one asleep → 200, that repo untouched; a 401 → 200 with the cache unchanged; the PR cache is re-read once per swept repo inside its TTL;
  cross-origin → refused.
- [ ] **Step 2–4:** FAIL → implement → PASS (`test/github-sweep-route.test.ts test/tracker-poll.test.ts test/prs-cache.test.ts`).
- [ ] **Step 5: Commit** `feat(tracker): POST /api/github/sweep`.

### Task 6: The rail (mock `Shell.dc.html`, rail column)

**Files:**
- Modify: `client/src/components/SideRail.tsx` (:99 props, :162-171 brand, :209-224 Jira badge, :297-305 footer, :335 `RailTree`, :422 rows),
  `client/src/App.tsx` (counts and API state into `SideRail`), `client/src/styles.css` (`.rail*` rules from :147), `test/rail.test.tsx`, `test/nav.test.tsx`

**Interfaces:**
- Consumes: `GlyphTile` (plan 2), `Glyph`/`GlyphName` (plan 1), `Pill` (`ui/Pill.tsx`, `neutral` = grey, `warn` = amber), `useOrchestratorRunsContext()`
  `.liveCount`, `usePullRequestsContext()` + `needsYouCount`.
- Produces: `SideRail` props gain `counts?: { github?: number; runs?: number }` and `api?: 'ok' | 'down' | null`. App passes `needsYouCount(prs.data)` and
  `liveCount`; `api` follows `useTrackersContext()` (`error` → `down`, `data` → `ok`, else `null`) — no new poller.
- Header: 28 px `GlyphTile` `tone="ink"`, `backlog manager` at 14/700 with the existing `.rail-cursor` (blinks while `working === true`), the `.rail-kicker`
  `this machine` below (uppercase by that rule). Rows: 28 px tile + label + count `Pill`; the open section's row is white (`--strip`) with an ink tile; its
  sub-list rows are 28 px at 12.5 px, the current one a white row at 600 keeping `aria-current="true"` (the white row replaces the dot; the section row holds `"page"`). Counts: Jira = needs-you, `warn`, inside
  a `button.rail-count` (the old `rail-badge` behaviour and name); GitHub = `warn`; Runs = `neutral`; 0 or absent hides the pill. Footer card: dot + version
  (still the releases button with its unseen dot) + `API connected` / `API unreachable` (red dot); nothing while `api` is `null`.
- No page CSS names `ui-pill` or `ui-glyph-tile`: the row's layout classes sit on the row, the pill/tile keep their primitive looks.

- [ ] **Step 1: Write the failing tests** (`rail`): every count is a `.ui-pill`; Jira pill is a button named `2 sessions need you` that opens Sessions with
  the needs-you filter (existing case, new markup); GitHub 3 → amber pill `3`, 0 → none; Runs 2 → neutral pill; the section row keeps
  `aria-current="page"` (spec :289) and the current sub-page row keeps `aria-current="true"` (`SideRail.tsx:319-326`; rail :160-161, :253-259, :268 unchanged); `api='down'` → `API unreachable`; the cursor blinks only for `working === true`. `nav` keeps its cases.
- [ ] **Step 2–4:** FAIL → implement → PASS (`test/rail.test.tsx test/nav.test.tsx test/shell-strip.test.tsx test/design-guards.test.ts
  test/daylight-contrast.test.ts`; guard grep `useOrchestratorRunsContext\|usePullRequestsContext\|needsYouCount`).
- [ ] **Step 5: Commit** `feat(shell): rail tiles and counts`.

### Task 7: Status pills and the popover head (mock `Shell.dc.html`, top right and open popover)

**Files:**
- Create: `client/src/lib/service-status.ts`, `client/src/lib/sweep.ts`, `test/service-status.test.ts`
- Modify: `client/src/components/TrackerChip.tsx`, `client/src/components/JiraChip.tsx` (keeps #472's per-board sweep callback, :67-89, with its
  `sweeping` / `refused` state), `client/src/styles.css`, `test/tracker-chip.test.tsx`, `test/jira-chip.test.tsx` (the `now` button becomes the `Sync <board>` icon: :214's
  `boards/sweep` URL and :253's `off` board keeping its button are re-pointed at that name and keep their assertions), `test/rail-bar-style.test.ts`

**Interfaces:**
- Produces: `serviceTone(input: { down: boolean; rows: readonly { polledAt: string | null; interval: SyncInterval | null }[]; limited: boolean }, now: number):
  StateTone` — `red` when `down`; `grey` when no non-`off` row has ever been polled; `amber` when `limited` or any non-`off` row is late (`now − polledAt >
  2 × SYNC_INTERVALS[interval]`, its OWN interval, never the 15 s tick); else `green`. `newestAge(rows, now): string | null` via `pollAge`. GitHub: `down` =
  no token or every row's `access` ∉ {`ok`, `rate-limited`, `null`}; Jira: `down` = `access` ∉ {`ok`, `rate-limited`}; `limited` = `rate-limited`.
- Produces: `postSweep(service: 'github' | 'jira', target?: string): Promise<SweepOutcome>`, `SweepOutcome = { ok: true } | { ok: false; status: number;
  message: string; retryAt: string | null }` (GitHub: `/api/github/sweep`, body `{ repo }` when targeted; Jira site-wide: `/api/jira/sweep`, no body).
  A Jira ROW does not use `postSweep`: it keeps #472's `/api/jira/boards/sweep { id }` callback in `JiraChip`, unchanged.
- The chips render `<button>` (own class) holding `StatusPill word="GitHub"|"Jira"`, `aria-label` `GitHub: <on time|late|down>, <age>`. The popover (330 px)
  head: initials disc (`login` / `me.name`), name, `● connected · <site>` (GitHub: `github.com`), `Sync now`; two figures (last sweep + interval; Jira
  `calls.sweep` and `last429At`, GitHub `remaining of limit`); then today's rows, each with `polled <age>` and a sync icon button `Sync <repo|board>` (a GitHub row:
  disabled for `off`, title `sync is off`; a Jira row: enabled for `off` too, #472's semantics); then the setup link (`GitHub page` → GitHub › Settings, `Jira setup` → Jira › Setup). Focus lands on `Sync now`. While a
  post runs its button is disabled; 200 → the context `reload()`; 429 → `<Jira|GitHub> asked to wait until <HH:MM>`; 409 → button disabled, title the message;
  a 200 whose reload carries a non-ok `detail` shows that detail.
- `test/rail-bar-style.test.ts`: the four `.tracker-name` / `.tracker-meters` cases (:24-58) are deleted (the chip has neither now; spec §4.9); the ☰ `flex: none` case stays.

- [ ] **Step 1: Write the failing tests.** `service-status`: green on time; amber at 2 × interval + 1 s; a `5m` row 4 min old is green while a `15s` row 31 s
  old is amber; `off` rows ignored; red on no token; grey with nothing polled. Chips: pill tone per fixture; `Sync now` posts once on a double click, is
  disabled while pending, and the pill shows the new age after reload; 429 text; 409 disables; the row icon posts with that target; the setup link navigates.
- [ ] **Step 2–4:** FAIL → implement → PASS (the three suites + `test/rail-bar-style.test.ts test/design-guards.test.ts test/daylight-contrast.test.ts`;
  guard grep `useTrackersContext\|useJiraContext\|pollAge`).
- [ ] **Step 5: Commit** `feat(shell): status pills with Sync now`.

### Task 8: Settings frame and Local (mock `Settings.dc.html`)

**Files:**
- Modify: `client/src/components/ui/SettingsRow.tsx:76`, `client/src/components/settings/SettingsView.tsx` (:123-177 band and page switch, :239 Local),
  `client/src/styles.css` (`.set-*`), `test/settings-view.test.tsx` (:82-92 comment, :387, :1054)

**Interfaces:**
- Produces: `SettingsGroup({ title, scope?, pill?, right?, children })` — `pill?: 'this browser' | 'this machine'` drawn as a neutral `Pill` beside the title;
  `scope` becomes optional (Jira Setup and `SuggestCard` keep passing it). `SettingsRow({ name, hint?, more?, children? })` — `more` is the long text behind a
  `ⓘ more` button with `aria-expanded`.
- The band's pill is replaced by a `Segmented` `Local | Shared | Dashboards` writing `settingsScope` through `update`, with the sub-line `saves in this
  browser only` (Local) / `saved on this machine` (Shared, Dashboards). One column (`.set-cols` goes; the 1100 px fold case goes with it). Local cards:
  Display (pill `this browser`): Theme as picture cards — each a mini board whose preview element carries that theme's `data-theme`, so it draws from the
  theme's own tokens, no hex; Density, Text size, Content width, Opens on as `Segmented`. Orchestrator: Default merge mode as three icon cards writing
  `orchestrateDefaultMergeMode` — `Merge into base` / `each item lands on the run's base` (`merge`), `Leave branches` / `stop at a reviewed branch per item`
  (`branch`), `Open a PR` / `one PR per run, tracker projects` (`pr`); question mode and Dispatch as today's controls in the new rows.
  "this device" → `this browser`.

- [ ] **Step 1: Write the failing tests.** Invert :387 with a comment citing spec §3's override: the page has a `Local | Shared | Dashboards` switch and
  clicking `Shared` shows Sources; the sub-line follows the page; `ⓘ more` has `aria-expanded="false"`, then `true` and the text is visible; clicking the
  `Graphite` theme card sets the theme; the `Open a PR` card sets `orchestrateDefaultMergeMode: 'pr'`; every card on each page has its scope pill. Remove
  :1054 (no columns).
- [ ] **Step 2–4:** FAIL → implement → PASS (`test/settings-view.test.tsx test/settings-legacy-landing.test.tsx test/design-guards.test.ts
  test/daylight-contrast.test.ts`; guard grep `SettingsGroup` → settings-view, settings-watchdog).
- [ ] **Step 5: Commit** `feat(settings): switch, one column, Local`.

### Task 9: Shared — Sources, Read again, Time zone, steppers (mock `SettingsMore.dc.html`, Shared)

**Files:**
- Modify: `SourcesGroup.tsx:35-97`, `TimeZoneGroup.tsx:25-55`, `WatchdogGroup.tsx` (:103-105 ladders, :136, :205-290), `TickGroup.tsx:44-70`,
  `SettingsView.tsx:209-235`, `App.tsx` (`onOpenFilesPage`), `client/src/lib/time-zone.ts`, `test/sources-group.test.tsx`, `test/settings-watchdog.test.tsx`,
  `test/settings-tick.test.tsx`, `test/settings-timezone.test.tsx`

**Interfaces:**
- Sources (pill `this machine`): rows Files, GitHub, Jira, each a `StatusPill` and a link button — `Open` (Files board, new `onOpenFilesPage` threaded like
  `onOpenGithubPage`), `GitHub page`, `Jira setup` — drawn under today's gates. Files' pill is `green` with `N projects` and no age (none is served), `grey`
  before the first answer. GitHub/Jira pills use Task 7's `serviceTone`. Foot: `Last read <age> · Read again` — the button calls both `postSweep`s then
  `projects.reload()`, trackers `reload()`, jira `reload()`; the age is the client time all three last answered; a sweep's 409 is not an error here.
- Time zone (pill `this machine`): option labels `<zone> · UTC±H[:MM]` (`Europe/Belgrade · UTC+1`, `UTC` for zero) from `zoneOffsetLabel(zone, now)` in
  `lib/time-zone.ts`.
- Watchdog (pill `this machine`, was "this server"): `Enabled` switch, then three ladder steppers from `TICK_LADDER`, `GRACE_LADDER`, `ATTEMPT_LADDER` (via
  `ladderWithSelected`) — ladder mode because a free number would be silently clamped (comment :49-73 stays); then the live status line and `Live view in
  Runs`. Tick: three ladder steppers over today's `HALT_OPTIONS` / `PLANS_OPTIONS` / `PRS_OPTIONS`.

- [ ] **Step 1: Write the failing tests.** Sources: three pills and three links; `Read again` posts both sweeps once and reloads all three; a GitHub 409 still
  reloads. Watchdog: `Increase Check every` from 60000 posts `{ tickMs: 120000 }` (the existing post-shape cases move from Select to stepper); an off-ladder
  stored value renders and steps. Tick: `Increase Halt after` posts `{ haltAfter: <next> }` once. Time zone: `zoneOffsetLabel('Asia/Kolkata', …)` →
  `Asia/Kolkata · UTC+5:30`, `UTC` → `UTC · UTC`.
- [ ] **Step 2–4:** FAIL → implement → PASS (the four suites + `test/settings-view.test.tsx test/time-zone.test.ts`; guard grep
  `NumberField\|postSweep\|useProjectsContext`).
- [ ] **Step 5: Commit** `feat(settings): Shared page restyle`.

### Task 10: Dashboards two-pane page (mock `SettingsMore.dc.html`, Dashboards)

**Files:**
- Modify: `DashboardsPage.tsx` (:105, :221-239), `DashboardsList.tsx`, `DashboardDetail.tsx`, `SuggestCard.tsx`, `client/src/styles.css`,
  `test/settings-dashboards.test.tsx`

**Interfaces:**
- Consumes: `usageTone` (`lib/dashboards.ts:233`, amber ≥ 75, red ≥ 90 — the existing threshold, spec §7), `saveSuggestion({ order })`, `Pill off`.
- List: per machine the prefer-order number, status dot, name, `this machine` tag, account pill, 5 h and week meters toned by `usageTone`, then `Add a
  dashboard`. Detail: name with ↑ ↓ (existing `Move <label> up/down`), Edit, Remove; `connected · spawn <on|off>` (no sessions-in-use); two usage tiles with
  reset times; Models and Efforts pills, disallowed ones `off` with title `not run on <label>`; facts (dashboard URL, board URL, machine name, account).
  `SuggestCard` and Home's steps keep their behaviour in the card/row language. Stacks below 1100 px.

- [ ] **Step 1: Write the failing tests.** ↑ on the first row and ↓ on the last are disabled; ↓ on row 1 posts `{ order }` with rows 1 and 2 swapped and the
  list redraws in that order; a disallowed model renders `.ui-pill-off` with its title; a 76 % week meter is amber, 91 % red; no `sessions in use` text. These pass today
  (`DashboardsPage.tsx:175,221-224`, `lib/dashboards.ts:233-236`) — keep them as regression cases; the cases that fail first: a list row holds a status
  dot, two meters each with its own `data-tone`, and the `this machine` tag on the local row only; the detail draws two usage tiles with their reset text,
  a Models and an Efforts pill row, and the four facts (dashboard URL, board URL, machine name, account); the stylesheet stacks the two panes below 1100 px.
- [ ] **Step 2–4:** FAIL → implement → PASS (`test/settings-dashboards.test.tsx test/dashboards-client.test.ts test/dashboards-suggest.test.ts
  test/design-guards.test.ts test/daylight-contrast.test.ts`).
- [ ] **Step 5: Commit** `feat(settings): Dashboards two-pane page`.

### Task 11: DESIGN.md §8.0, §8.9.4, §8.6 and `board.md`'s Settings rule (spec §9)

**Files:**
- Modify: `.claude/DESIGN.md` §8.0 (:166, incl. the chip paragraph :192), §8.6 (:393, incl. :401), §8.9.4 (:518); `.claude/rules/board.md:47-55`, `:65-67`

- [ ] **Step 1:** Rewrite to what Tasks 6–10 built: icon tiles, one count pill (`Pill`, amber waiting / grey otherwise), the white current row, the API
  footer; status pills replacing the meter chips, and the popover is no longer "a reading with no links and no buttons" — it carries Sync now, per-row sync
  icons and the setup link (spec §3 override). §8.6 / `board.md`: the in-page `Local | Shared | Dashboards` switch replaces "the rail is the only switch",
  one column, scope pills, `ⓘ more`, picture and icon cards, steppers, the two-pane Dashboards; the Sources links per Task 9. Each override names spec §3; the site-wide-only Jira sweep is listed as a spec §5 deviation beside them.
- [ ] **Step 2:** `pnpm exec jest test/dialog-count-docs.test.ts test/design-guards.test.ts` — PASS (`design-guards` is the only suite that reads `DESIGN.md`).
- [ ] **Step 3: Commit** `docs: shell and settings restyle in DESIGN.md and board.md`.

### Task 12: `/ui-verify` against the mocks

- [ ] Run `/ui-verify` at 1440 px with fixture data (a GitHub project with PRs that need you, a Jira site with boards, one live run, two dashboards)
  against `Shell.dc.html` (rail, status pills, the Jira popover open), `Settings.dc.html` (Local) and `SettingsMore.dc.html` (Shared, Dashboards). Expected
  differences, not defects: no API port, Jira count amber, `.rail-kicker` uppercase, theme previews in each theme's own tokens, no sessions-in-use, the
  Files pill with no age. Fix any other difference in the owning task's files, re-run that task's suites, and commit `fix(ui): <what> per ui-verify`.
