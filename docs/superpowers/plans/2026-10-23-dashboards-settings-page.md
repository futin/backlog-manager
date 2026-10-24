# Settings › Dashboards Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `Dashboards` card off Shared Settings onto a third Settings page, `Dashboards`, redrawn as a machine list + a selected machine's detail,
with each machine's health and usage read through one new read-only route.

**Architecture:** One new server read, `GET /api/dashboards/machines`, judges every configured machine's `/api/health` (a new health-only method on
`DashboardStatusService`) and, only for an enabled and reachable one, its usage through the existing `UsageService` cache. One shared predicate decides every
health dot. The client gains a `dashboards` settings scope, a polling hook on `useRefreshing`, pure derivations in `lib/dashboards.ts`, and page components that
replace `DashboardsGroup.tsx` while keeping every function it has.

**Tech Stack:** NestJS 10 server, React 18 client (Vite), jest (`--runInBand`, jsdom suites by docblock), supertest through `listenLoopback`, pnpm.

**Spec:** [docs/superpowers/specs/2026-10-23-dashboards-settings-page-design.md](../specs/2026-10-23-dashboards-settings-page-design.md) — read it in full before
any task. Its parity checklist is the acceptance list for Tasks 5–6.

**How to read this plan.** It states behaviour, signatures, exact copy and exact test cases — deliberately **not** literal code (a repo-wide rule: handed
code gets transcribed, and a bug in the plan becomes a bug in the branch). Write the bodies yourself; where you disagree with a decision here, say so in your
report rather than silently diverging. Any size mentioned is a soft target.

## Global Constraints

- Every route under `/api`; the new GET is read-only, Host-allowlisted like every route, and NOT behind `SameOriginPostGuard` (GETs never are).
- The browser never talks to a dashboard: every health/usage figure comes from this API.
- No token value and no URL in the new route's body. `DashboardsView` keeps carrying URLs; the new route carries none.
- `BM_AGENTS` off → the new route makes no outbound call at all, Home's usage included.
- A remote's new outbound reads are held to 5 s (`REMOTE_BUDGET` / `USAGE_TIMEOUT_MS`); Home's health keeps its 4 s (`HOME_BUDGET.healthMs`).
- `agents/dashboards/` stays part of the `agents/` outbound module; no fourth outbound-calling module.
- Primitives only (design guard 7): meters `Meter`, dots `Dot`, pills `Pill`, buttons `Chip`, cards `Sheet`/`SettingsGroup`. No page-local look for any of them.
- Every component cites its `.claude/DESIGN.md` subsection in a header comment (§8.6 for the page).
- Comments explain *why*, at the repo's existing density. New text wraps at 160 columns; commit bodies at 72.
- Tests: jest suites flat in `test/`; jsdom suites carry the `@jest-environment jsdom` docblock; a supertest suite listens once via `listenLoopback`; jsdom
  fixture dates relative to the clock (`test/helpers/dates.ts`) where they hit `created`/`updated`/`lastCommit`/`started` (not expected here).
- Run only the suites a task touches (`pnpm run test:jest -- <files>`) plus `pnpm run typecheck`; never the whole `pnpm test` (CI is the full gate).
- Commits: `git add <files>` then `git commit` as separate commands; never `git add -A`. Message prefix per task below; trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Exact copy fixed by the spec (copy verbatim):
  - Remove confirm: `Remove {label}? Launches can no longer go there; its token stays in .env.` (accept `Remove`, dismiss `Keep`).
  - Null-view failure hint: `Could not read the dashboards — {error}. This page will fill in once the API answers GET /api/dashboards again.`
  - Add cap title: `at most 8 dashboards`.
  - No-usage lines: `unreachable`, `no fresh figure · {usageAgeText(ageMs)}`, `no usage figure`; not-answered: `checking…`.
  - Reset lines: `resets 23:39`, `resets Sun 05:59`, `resets now`.
  - Meter labels in the list: `5 H`, `WEEK`. Home pill and band pill: `this machine`. No account: `no account set`.

## Review Focus

1. **Health and usage are slow or dead.** The list, the detail's config facts and every control must draw from `GET /api/dashboards` alone; a machines read
   that hangs, fails or answers late leaves quiet dots and `checking…`, never a blank page or a disabled control. (Task 5: the "machines never answer" case.)
2. **A machine appears or disappears between the two reads** (`/api/dashboards` and `/machines` disagree — a remote just added, removed or renamed). A
   machine the machines answer lacks reads as not answered (quiet dot, `checking…`); a status for a machine the view lacks is ignored. (Task 4 lookup helper
   test; Task 5 case.)
3. **Selection after a reorder / Remove / rename / Add.** Moving the selected machine keeps it selected; removing the selected remote falls back to the first machine; renaming it through Edit keeps it selected under
   its new name; Add selects the new machine once the view holds it. (Task 4 `pickSelected` tests; Task 5 cases.)
4. **`BM_AGENTS` off or unreadable `dashboards.json`.** Off: zero outbound calls, every dot quiet, Home's usage area says `no usage figure`. Unreadable: the
   machines answer has Home only, the banner shows, every control is disabled, the list still draws Home. (Task 3 route cases; Task 5 case.)
5. **Reset clock at day boundaries and over a week.** A reset later today vs. just past midnight tomorrow vs. six days out; a reset already passed; a
   `resetsAt` that is `null` or not a date. (Task 4 `resetClockText` cases.)

---

## File map

| File | Change |
| --- | --- |
| `shared/types.ts` | `MachineHealth`, `MachineStatus`, `MachinesStatus` beside `MachineUsage` |
| `shared/agent.ts` | `dispatchDotTone` predicate; `USAGE_FRESH_MS` moves here |
| `server/src/agents/dashboards/usage.service.ts` | imports `USAGE_FRESH_MS` from shared and re-exports it |
| `server/src/agents/dashboard-status.service.ts` | new `healthOf` |
| `server/src/agents/dashboards/machines.service.ts` | Create — the route's logic |
| `server/src/agents/dashboards/dashboards.controller.ts` | `@Get('machines')` |
| `server/src/agents/agents.module.ts` | provide `MachinesService` |
| `client/src/components/settings/DispatchStatus.tsx` | local `Dot`/tier/`dispatchHealthy` → `ui/Dot` + `dispatchDotTone` |
| `client/src/components/ui/Pill.tsx`, `client/src/styles.css` | `off` prop; `.set-dot-*` and dead `.dash-*` rules go; new page rules |
| `client/src/lib/dashboards.ts` | `fetchMachines`, `machineIds`, `pickSelected`, `statusFor`, `resetClockText`, `noUsageText`, `SETTINGS_HREF` |
| `client/src/hooks/useMachines.ts` | Create — the polling hook |
| `client/src/components/settings/DashboardsPage.tsx` (+ `DashboardsList.tsx`, `DashboardDetail.tsx`, `SuggestCard.tsx`) | Create — replaces `DashboardsGroup.tsx` (deleted) |
| `client/src/lib/settings.ts`, `client/src/components/SideRail.tsx`, `client/src/lib/deep-link.ts`, `client/src/components/settings/SettingsView.tsx` | third scope + page |
| Docs | `CLAUDE.md`, `.claude/rules/board.md`, `.claude/rules/dispatch-watchdog.md`, `.claude/DESIGN.md`, `docs/subsystems/{invariants,board,api}.md` |

Component names inside the page are a recommendation; keep them or merge list row and detail head into one component if that reads better.

---

### Task 1: Shared types and the health predicate

**Files:**
- Modify: `shared/types.ts` (after `MachineUsage`, ~line 1984), `shared/agent.ts`, `server/src/agents/dashboards/usage.service.ts:12`
- Modify: `client/src/components/settings/DispatchStatus.tsx`, `client/src/styles.css:957-959`, `test/daylight-contrast.test.ts:246-247`
- Test: `test/dispatch-dot-tone.test.ts` (Create), the existing Settings suites that render `AgentsStatusLines` (`test/settings-view.test.tsx`, `test/settings-dashboards.test.tsx`)

**Interfaces:**
- Produces (shared/types.ts):
  - `MachineHealth { enabled: boolean; reachable: boolean; remoteAnswer: boolean; spawnAvailable: boolean; spawnMaxPermission: PermissionMode | null; error?: string }`
    — `AgentsStatus` minus `projectPaths`; `AgentsStatus` should be assignable to it (check, do not restructure `AgentsStatus`).
  - `MachineStatus extends MachineHealth { machine: string; usage: MachineUsage | null; usageAgeMs: number | null }`.
  - `MachinesStatus { machines: MachineStatus[] }` — the route's answer.
- Produces (shared/agent.ts):
  - `dispatchDotTone(h: Pick<MachineHealth, 'enabled' | 'reachable' | 'remoteAnswer' | 'spawnAvailable'> | null): 'live' | 'paused' | 'crashed' | null`
  - `USAGE_FRESH_MS = 10 * 60_000` (moved; `usage.service.ts` imports it and re-exports it under the same name so its importers stay unchanged).

- [ ] **Step 1: Write the failing test** `test/dispatch-dot-tone.test.ts`, one `it` per rung, fixtures differing in exactly the field under test:
  - `null` → `null`.
  - `{ enabled: false, reachable: true, remoteAnswer: true, spawnAvailable: true }` → `null` (off wins over everything).
  - `{ enabled: true, reachable: false, remoteAnswer: true, spawnAvailable: true }` → `'crashed'`.
  - `{ enabled: true, reachable: true, remoteAnswer: false, spawnAvailable: true }` → `'paused'`.
  - `{ enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: false }` → `'paused'` (the rung the old tier was blind to).
  - all four true → `'live'`.
  - A full `AgentsStatus` value (with `projectPaths`) type-checks as the argument.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/dispatch-dot-tone.test.ts` — FAIL (`dispatchDotTone` not exported).
- [ ] **Step 3: Implement** the types and `dispatchDotTone` (checked in the spec's order: null/!enabled, !reachable, !(spawnAvailable && remoteAnswer), else
  live), with a doc comment saying it is the one reading of "a launch could go there now" and that it replaced `dispatchDotTier`/`dispatchHealthy`. Move
  `USAGE_FRESH_MS`.
- [ ] **Step 4: Rewire `DispatchStatus.tsx`.** Delete `DotTier`, `dispatchDotTier`, the local `Dot` and `dispatchHealthy`. `AgentsStatusLines` draws
  `ui/Dot` with `tone={dispatchDotTone(status) ?? undefined}` (no tone = quiet, size 8); `DispatchSetupSteps` hides when `status === null` or the tone is
  `'live'`. Text of every line is unchanged. Rewrite the tier comment to describe the four rungs. Keep the file's other comments. Remove the three
  `.set-dot-*` rules (`styles.css:957-959`; there is no bare `.set-dot` rule) and the two entries in `test/daylight-contrast.test.ts`.
  If any remaining code imports `dispatchHealthy`, repoint it at the predicate (grep shows only `DispatchStatus.tsx` today).
- [ ] **Step 5: Assertions that change behaviour.** In `test/settings-view.test.tsx` (`the dispatch report · Shared`, ~:306 — the Dashboards card's
  `Dispatch` row, the only place `AgentsStatusLines` draws today; there is no `Claude Agents` card any more), add: an unreachable status draws a
  `.ui-dot-crashed` inside the dispatch line; a reachable status with `spawnAvailable: false` draws `.ui-dot-paused` and the setup steps. Fix any existing
  assertion that queried `.set-dot-*`.
- [ ] **Step 6: Run** `pnpm run test:jest -- test/dispatch-dot-tone.test.ts test/settings-view.test.tsx test/settings-dashboards.test.tsx test/daylight-contrast.test.ts test/dashboards-usage.test.ts test/ui-dot.test.tsx` and `pnpm run typecheck` — PASS.
- [ ] **Step 7: Commit** — `refactor(settings): one dispatch health predicate for every dot`.

### Task 2: `Pill` gains `off`

**Files:**
- Modify: `client/src/components/ui/Pill.tsx`, `client/src/styles.css` (beside the `.ui-pill-*` rules)
- Test: `test/ui-pill.test.tsx`. No `test/daylight-contrast.test.ts` entry unless `.ui-pill-off` paints its own fill (then the fill-site list, ~:280) or
  tint (then the `PINNED` table, ~:403); its `--ink3` text is already measured by the general case (~:243)

**Interfaces:**
- Produces: `Pill({ children, tone?, title?, off? }: { …; off?: boolean })` — `off` adds class `ui-pill-off` on top of the tone class; nothing else changes.

- [ ] **Step 1: Failing tests** in `test/ui-pill.test.tsx`: `<Pill off>opus</Pill>` has classes `ui-pill`, `ui-pill-neutral` and `ui-pill-off`;
  `<Pill>opus</Pill>` lacks `ui-pill-off`; `<Pill off tone="live" title="t">` keeps `ui-pill-live` and the title.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/ui-pill.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** The look from existing tokens only: dashed border, muted ink (`--ink3`), struck through — or another treatment from existing
  tokens that clearly reads "not allowed" in all five themes. Extend the header comment: `off` is not a sixth tone, it is a state of any tone, for a fact
  that does not hold (a model a machine may not run).
- [ ] **Step 4: Run** the same suite plus `test/design-guards.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(ui): Pill off state`.

### Task 3: Server — `healthOf` and `GET /api/dashboards/machines`

**Files:**
- Modify: `server/src/agents/dashboard-status.service.ts` (beside `statusOf`, ~line 76), `server/src/agents/dashboards/dashboards.controller.ts`,
  `server/src/agents/agents.module.ts` (providers, ~line 82)
- Create: `server/src/agents/dashboards/machines.service.ts`
- Test: `test/dashboards-machines.test.ts` (Create)

**Interfaces:**
- Consumes: `MachineHealth`, `MachineStatus`, `MachinesStatus` (Task 1); `DashboardsService.machines()` (`Machine` with `id`, `home`, `cfg`);
  `UsageService.read(m, nowMs)`; `HOME_BUDGET.healthMs`; `REMOTE_BUDGET.healthMs` (`offers.service.ts:16`).
- Produces:
  - `DashboardStatusService.healthOf(cfg: AgentsConfig, healthMs: number): Promise<MachineHealth>` — `!cfg.enabled` → the all-false answer with no fetch; a
    failed `/api/health` → `enabled: true, reachable: false, error` (same wording `judge` gives); otherwise the three health fields read exactly as `judge`
    reads them. Reads `/api/health` and nothing else — never the project map. `judge` may reuse it for its health half, provided `statusOf` and
    `remoteStatusOf` behave byte-for-byte as before.
  - `MachinesService.read(nowMs: number): Promise<MachinesStatus>` — for each machine in `machines()` order, in parallel: `healthOf` with Home's 4 s or a
    remote's 5 s; then, only if `enabled && reachable`, `usage.read(m, nowMs)`, else `usage: null, usageAgeMs: null`. Builds each `MachineStatus` field by
    field (never spreads a `Machine` or its `cfg`). Never throws for a machine; reads no file `source` (so Home's usage is read under `default` too).
  - `GET /api/dashboards/machines` → 200 `MachinesStatus`. Declared so it does not collide with `@Get()`/`@Get('offers')`.

- [ ] **Step 1: Failing tests** `test/dashboards-machines.test.ts`. Copy `test/dashboards-offers.test.ts`'s harness (real `127.0.0.1` stub servers that
  record every path; an origin nothing listens on for "refused"; `BM_DASHBOARDS_FILE` in a temp dir; `AppModule` via `listenLoopback`). Stubs answer
  `/api/health` with `{ remoteAnswer, spawnAvailable, spawnMaxPermission }` and `/api/account` + `/api/usage/profile` with a valid usage pair (copy the offers
  suite's fixture). Distinct values per machine: Home 5 h `12`, week `30`; Linux 5 h `64`, week `81`. Cases:
  1. **Order and shape** — file with Linux and Pro, order `['Linux', 'home', 'Pro']`: `machines.map(m => m.machine)` equals `machines()`' order (assert
     against `DashboardsService.machines()` ids read in the test, not a literal you assume); Linux `reachable: true`, `usage.fiveHour.pct` `64`,
     `usageAgeMs` a number ≥ 0.
  2. **Unreachable remote** — Pro's URL is the refused origin: status 200; Pro `enabled: true`, `reachable: false`, `error` a non-empty string,
     `usage: null`, `usageAgeMs: null`; the other machines still answered.
  3. **Unreachable machine's usage is not read** — Linux's health stub answers 500: Linux's stub log has `/api/health` and neither `/api/account` nor
     `/api/usage/profile`.
  4. **Reachable but cannot take a launch** — Linux health `remoteAnswer: false`: `reachable: true`, `remoteAnswer: false`, usage still read and present.
  5. **Health only** — after one request, Home's and Linux's stub logs contain no `/api/configs`.
  6. **No token, no URL** — with `BM_AGENTS_TOKEN` and `BM_AGENTS_TOKEN_LINUX` set to distinct secrets: the raw body contains neither secret, no `http://`,
     and no key named `url`, `bmUrl`, `projectPaths` or `tokenVar`.
  7. **`BM_AGENTS` off** — every stub log is empty after the request; every machine `enabled: false`, `reachable: false`, `usage: null`.
  8. **Unreadable file** — file content `not json`: `machines` has exactly one entry, `machine: 'home'`.
  9. **Default source** — no file: one entry, Home, `usage.fiveHour.pct` `12` (Home's `/api/account` was asked).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/dashboards-machines.test.ts` — FAIL (404).
- [ ] **Step 3: Implement** `healthOf`, `MachinesService` (doc comment: why health-only, why sequential health-then-usage per machine and parallel across
  machines, the ~9–10 s worst case, why it reads Home's usage under `default` unlike the offers; `usage.read`'s `ageMs` lands in `usageAgeMs`), the controller GET and the module provider. Update the
  `agents.module.ts` provider comment block with one line for `MachinesService`.
- [ ] **Step 4: Run** `pnpm run test:jest -- test/dashboards-machines.test.ts test/dashboards-offers.test.ts test/dashboards-routes.test.ts test/dashboards-usage.test.ts test/agents-origin-guard.test.ts` and `pnpm run typecheck` — PASS. If the Host-allowlist or route-list suites enumerate GET routes, add the new one there.
- [ ] **Step 5: Commit** — `feat(api): GET /api/dashboards/machines — health and usage per machine`.

### Task 4: Client lib and the polling hook

**Files:**
- Modify: `client/src/lib/dashboards.ts`
- Create: `client/src/hooks/useMachines.ts`
- Test: `test/dashboards-client.test.ts` (extend), `test/machines-hook.test.tsx` (Create, jsdom)

**Interfaces:**
- Consumes: `MachinesStatus`, `MachineStatus`, `USAGE_FRESH_MS` (Task 1); `useRefreshing` (`hooks/useRefreshing.ts:22`); `usageAgeText`; `HOME_MACHINE`.
- Produces (`lib/dashboards.ts`):
  - `fetchMachines(): Promise<MachinesStatus>` — `GET /api/dashboards/machines` through `unwrap`, guarded by a private `isMachinesStatus` (array; each entry
    `machine` string, `enabled`/`reachable` booleans, `usage` null or both windows pass `isWindow`); a bad body throws `unexpected /api/dashboards/machines response`.
  - `machineIds(view: DashboardsView): string[]` — today's derivation lifted verbatim in behaviour from `DashboardsGroup.tsx:131-133`.
  - `pickSelected(ids: string[], wanted: string | null): string` — `wanted` when it is in `ids`, else `ids[0]`.
  - `statusFor(machines: MachinesStatus | null, id: string): MachineStatus | null`.
  - `resetClockText(resetsAt: string | null, now: number): string | null` — local clock, 24 h, zero-padded `HH:MM`; same local calendar day as `now` →
    `resets HH:MM`; later day → `resets <Ddd> HH:MM` with a fixed English three-letter weekday (`Sun`…`Sat`, not `Intl`, so tests are locale-proof); at or
    before `now` → `resets now`; `null`/unparseable → `null`.
  - `noUsageText(s: Pick<MachineStatus, 'enabled' | 'reachable' | 'usageAgeMs'>): string` — `enabled && !reachable` → `unreachable`; `usageAgeMs !== null &&
    usageAgeMs > USAGE_FRESH_MS` → `no fresh figure · ${usageAgeText(usageAgeMs)}`; else `no usage figure`. Called only when `usage` is null.
  - `SETTINGS_HREF` is NOT changed here (Task 6).
- Produces (`hooks/useMachines.ts`): `useMachines(): { machines: MachinesStatus | null; reload: () => Promise<void> }` — `useRefreshing(fetchMachines,
  { armed: true, intervalMs: MACHINES_POLL_MS })` with `MACHINES_POLL_MS = 60_000` exported; mount + focus come from `useRefreshing`. A failed read keeps the
  previous answer (or `null`) and is swallowed — the next timer/focus/reload tries again. State set behind `useMountedRef`. The hook is mounted only by the
  Dashboards page, which is what keeps it from running on another page.

- [ ] **Step 1: Failing tests** in `test/dashboards-client.test.ts`:
  - `machineIds`: order `['Pro', 'home']` with dashboards Pro, Linux → `['Pro', 'home', 'Linux']`; order `['Pro']` (home missing) → `['home', 'Pro']`;
    order naming a removed `Gone` → `Gone` absent.
  - `pickSelected(['home', 'Pro'], 'Pro')` → `'Pro'`; `(…, 'Gone')` → `'home'`; `(…, null)` → `'home'`.
  - `statusFor`: answers the entry for `'Pro'`; `null` for an id the answer lacks; `null` for a `null` answer.
  - `resetClockText`, with `now = new Date(2026, 9, 23, 10, 0).getTime()` (a Friday; local constructor so the suite is TZ-proof):
    `new Date(2026, 9, 23, 23, 39).toISOString()` → `resets 23:39`; `new Date(2026, 9, 24, 0, 5)` → `resets Sat 00:05`;
    `new Date(2026, 9, 25, 5, 59)` → `resets Sun 05:59`; `new Date(2026, 9, 29, 9, 0)` → `resets Thu 09:00`; `new Date(2026, 9, 23, 9, 59)` →
    `resets now`; exactly `now` → `resets now`; `null` → `null`; `'soon'` → `null`.
  - `noUsageText`: `{ enabled: true, reachable: false, usageAgeMs: null }` → `unreachable`; `{ true, true, 14 * 60_000 }` →
    `no fresh figure · usage 14 min ago`; `{ true, true, 40_000 }` → `no usage figure`; `{ true, true, null }` → `no usage figure`;
    `{ enabled: false, reachable: false, usageAgeMs: null }` → `no usage figure`.
  - `fetchMachines`: a valid body resolves; `{ machines: [{ machine: 'home' }] }` rejects with `unexpected /api/dashboards/machines response`.
- [ ] **Step 2:** `test/machines-hook.test.tsx` (jsdom, jest fake timers as `test/watchdog-hook.test.tsx` uses them): fetches once on mount; again after
  `MACHINES_POLL_MS`; a rejected second read leaves the first answer in place; `reload()` triggers a read at once; nothing fires after unmount.
- [ ] **Step 3: Run** both suites — FAIL.
- [ ] **Step 4: Implement.** Add `useMachines` to the list of `useRefreshing` callers wherever that list is written in code comments (`useRefreshing.ts`
  header) — the docs lists are Task 7.
- [ ] **Step 5: Run** both suites and `pnpm run typecheck` — PASS.
- [ ] **Step 6: Commit** — `feat(client): machine status hook and dashboards derivations`.

### Task 5: The Dashboards page components

**Files:**
- Create: `client/src/components/settings/DashboardsPage.tsx`, `DashboardsList.tsx`, `DashboardDetail.tsx`, `SuggestCard.tsx` (names recommended)
- Modify: `client/src/styles.css` (new `.dash-page*` rules beside the sheet's `.dash-*`)
- Test: `test/settings-dashboards.test.tsx` (rewritten to render `<DashboardsPage />`)

**Interfaces:**
- Consumes: Tasks 1, 2 and 4; `useDashboards`, `useAgents`, `useMountedRef`; `saveEntry`, `deleteEntry`, `saveHome`, `saveSuggestion`; `DashboardSheet`,
  `ticked` (unchanged); `AgentsStatusLines`, `DispatchSetupSteps`; `Meter`, `Dot`, `Pill`, `Chip`, `Confirm`, `NumberField`, `Sheet`, `SettingsGroup`,
  `SettingsRow`; `usagePercent`, `usageTone`; `MODELS`, `EFFORTS`.
- Produces: `DashboardsPage(): JSX.Element` (default or named — Task 6 imports it) — the whole page body under the band: Suggest card, list, detail, footer.

**Behaviour** (the spec's "The page", "Selection", "Widths" and "States" sections are normative; this is the checklist):
- State and writes move from `DashboardsGroup` unchanged: `written ?? loaded`, `write(scope, send)` single-flight on a ref + `busy`, notices scoped `form` /
  `list` / `suggest`, `Editing`, `asking`, `thresholdNonce`, `MAX_REMOTES = 8`. Every successful write also calls `useMachines().reload()`.
- `ids = machineIds(view)`; `selected = pickSelected(ids, wanted)`, `wanted` in component state (initial `null`). A row click sets `wanted` to the clicked
  id; a ↑/↓ move sets `wanted` to the moved machine's id (it may still be `null` from load), so the selection follows the moved machine by id rather than by
  position. A successful rename via Edit sets `wanted`
  to the entry's new name; a successful Add sets `wanted` to the added entry's name (it is in the fresh view the write answered); Remove needs nothing —
  `pickSelected` falls back.
- **Suggest card** (`SettingsGroup`, full width, title `Suggest`, hint `Which machine a launch sheet starts on. You can still pick another there.`): the three
  radios exactly as today (`role="radiogroup"`, `aria-label="Suggestion strategy"`, `name`, `aria-labelledby`, `aria-describedby` ids), each label a tile
  drawing its name and line; `STRATEGIES` lines verbatim except `the order above` → `the prefer order` in `prefer` and `runway` (the order is no longer
  above them). Threshold row unchanged. `noticeFor('suggest')`.
- **List**: one `button` row per id (`aria-pressed` on the selected one; click selects): order number box (1-based), `Dot` with
  `tone={dispatchDotTone(health) ?? undefined}` — Home's health is `useAgents().status`, a remote's `statusFor(machines, id)` —, the name (Home's `view.home.label`),
  `Pill` `this machine` on Home, the account `Pill` or a muted `no account set`, then two `Meter`s `5 H` and `WEEK` (`value` `${usagePercent(pct)}%`,
  `fraction` pct/100, `tone` `usageTone(pct)`) only when that machine's status has `usage`. Then the Add `Chip` with today's disabled rules and title; its accessible name stays `Add dashboard` (existing
  queries use it), any `+` glyph `aria-hidden`.
- **Detail** (`Sheet`): head = same order box, dot, name, pills; right side `↑` `↓` `Edit` and (remotes) `Remove` with today's aria-labels and disabled rules,
  or the `Confirm` in their place. Under it `noticeFor('list')`. Status line: Home → `dispatch <AgentsStatusLines status={status} />` + `DispatchSetupSteps`;
  remote → the same three readings from its `MachineStatus` (`checking…` while absent; `unreachable — <error>`; `connected — no CLAUDE_BIN, remote answers off`
  gaps or `connected · spawn on`, plus ` · ceiling: <mode|unknown>`; never a project count). Usage: two full-width `Meter`s `5 h` / `week` each with
  `resetClockText(window.resetsAt, now)` under it when non-null; no usage → `noUsageText(status)`; no status yet → `checking…`. Models / Efforts rows: every
  member of `MODELS` / `EFFORTS` as a `Pill`, `off` when not in the machine's allowed list,
  `title` `not run on <label>` on the off ones; "allowed" is `ticked(list, ALL)` (`DashboardSheet.tsx:38` — an empty list means every member). Facts grid: `Dashboard` (Home: `view.home.url` + a small `BM_AGENTS_URL` tag), `Board` and `Machine name`
  (remotes; `—` when empty), `Token` (`<tokenVar> ✓ set` or today's `tokenLine` sentence for not set). Every value from a named field, never a spread.
- **Footer**: `Saved to <file>` and the old lead line `Listed in prefer order — move a machine with ↑ ↓. Tokens are never entered here: each is an
  environment variable, set in .env.` (or put the lead line in the band subtitle in Task 6 — pick one, keep it once).
- **States**: `view === null` → the null-view block (dispatch line, setup steps, `checking…` or `Unavailable` + the page hint sentence); `unreadable` →
  banner row with today's sentence naming `view.file`, every control disabled, Home still listed.
- **Widths**: two columns ≥ 1100 px (list ~360 px, detail fills); stacked below; detail head controls wrap below 700 px; no horizontal scroll. Use the
  existing breakpoints in `styles.css`.
- Header comment on `DashboardsPage.tsx` carries every paragraph of `DashboardsGroup.tsx`'s header (lines 17–56) rewritten for "page", plus why the
  health/usage read is separate and never blocks the config.

- [ ] **Step 1: Port the suite.** Rewrite `test/settings-dashboards.test.tsx` to render `<DashboardsPage />`; `stubFetch` also answers
  `/api/dashboards/machines` (default: Home and Pro and Max with distinct usage — Home 12/30, Pro 64/81, Max unreachable). Replace `.dash-machine`-based
  helpers (`rowOf`, `names`) with list-row / detail queries. Keep EVERY existing `it` (all of lines 125–600) with its assertions adapted to the new place,
  then add:
  - list draws rows in `machineIds` order with 1-based order numbers;
  - the first machine is selected on load; clicking `Pro` selects it (`aria-pressed`) and the detail shows Pro's `Board` and `Machine name`;
  - Pro's row shows `5 H` `64%` and `WEEK` `81%`; Max's row shows no meter and its detail says `unreachable` with `.ui-dot-crashed`;
  - a remote with `remoteAnswer: false` draws `.ui-dot-paused`; a healthy one `.ui-dot-live`;
  - Home's dot follows `useAgents` (healthy agents + an unreachable Home entry in `/machines` → still `.ui-dot-live`);
  - models: with Pro's models `['opus']`, `opus` is a `Pill` without `ui-pill-off` and every other `MODELS` member has it;
  - reset lines: Pro's 5 h `resetsAt` later today renders `resets HH:MM` (compute expected with `resetClockText` in the test, from a fixed fake `now`);
  - machines never answer (fetch pending forever): list, detail facts and every control draw; dots carry no tone class; usage area `checking…`;
  - a machine in `/machines` the view lacks is ignored; a view machine `/machines` lacks reads `checking…`;
  - select `Pro` (not first), move it up → `Pro` is still `aria-pressed` and the detail still shows Pro;
  - with no click at all, move the default-selected first machine down → it is still `aria-pressed`, now at position 2;
  - remove the selected `Pro` → selection falls back to the first machine; rename `Pro` → `Pro2` through Edit → `Pro2` stays selected; Add `Linux` →
    `Linux` selected;
  - every successful write is followed by a `GET /api/dashboards/machines`;
  - `BM_AGENTS`-off shape (`/machines` answers every machine `enabled: false`): quiet dots, `no usage figure`;
  - null view failing: `Unavailable` and the exact page hint sentence.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/settings-dashboards.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the components and CSS. Do not touch `DashboardsGroup.tsx` or `SettingsView.tsx` yet.
- [ ] **Step 4: Run** `pnpm run test:jest -- test/settings-dashboards.test.tsx test/design-guards.test.ts test/daylight-contrast.test.ts` and
  `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** — `feat(settings): Dashboards page — list, detail, health and usage`.

### Task 6: The third Settings scope, wired in

**Files:**
- Modify: `client/src/lib/settings.ts:49,286`, `client/src/components/SideRail.tsx:392`, `client/src/lib/deep-link.ts:10`,
  `client/src/lib/dashboards.ts:20` (`SETTINGS_HREF`), `client/src/components/settings/SettingsView.tsx` (band ~122-131, switch ~145, `SharedPage` 167-190)
- Delete: `client/src/components/settings/DashboardsGroup.tsx`; its dead CSS (`.dash-machine` ×3, `.dash-line`, `.dash-strategies`, `.dash-strategy`,
  `.dash-strategy input`, `.dash-strategy-text`, `.dash-threshold`, and the `.dash-strategy input` half of the shared `.dash-check input, …` rule unless
  Task 5's radios kept that class) — grep each class for remaining users first
- Test: `test/rail.test.tsx`, `test/deep-link.test.ts`, `test/deep-link-app.test.tsx` (if it lists scopes), `test/run-on.test.tsx:102`,
  `test/settings-view.test.tsx` (:205-242 and wherever `Dashboards` on Shared is asserted), `test/settings.test.ts` (the clamp)

**Interfaces:**
- Consumes: `DashboardsPage` (Task 5).
- Produces: `SettingsScope = 'local' | 'shared' | 'dashboards'`; `SETTINGS_SCOPES = ['local', 'shared', 'dashboards']`; `RAIL_SCOPE_LABEL.dashboards =
  'Dashboards'`; `SETTINGS_HREF = '/?section=settings&settings=dashboards'`.

- [ ] **Step 1: Failing tests:**
  - rail: the Settings tree has exactly `Local`, `Shared`, `Dashboards`, in that order; picking `Dashboards` sets `settingsScope` to `dashboards`.
  - deep link: `?section=settings&settings=dashboards` → `settingsScope: 'dashboards'`; `settings=machines` → `null`; `settings=dashboards` without
    `section=settings` → `null`.
  - clamp: stored `settingsScope: 'dashboards'` survives `clampSettings`; `'bogus'` clamps to the default.
  - run-on: the Settings link's href is `/?section=settings&settings=dashboards`.
  - settings-view: Shared renders `Orchestrator watchdog` (and the tick card) and NOT `Dashboards`; the Dashboards page renders the `Suggest` group and the
    machine list and none of Local's or Shared's cards; the band pill on Dashboards reads `this machine` with `ui-pill-neutral`; the band title is `Settings`
    on all three pages; Dashboards' subtitle is its own (assert it differs from Shared's). After this task Shared draws no dispatch line at all: move the
    `the dispatch report · Shared` cases (~:306) and `puts the dispatch status row in the Dashboards card` (~:735–738) to the Dashboards page's Home detail in
    `test/settings-dashboards.test.tsx` (or render `settings='dashboards'` here), and the Shared group list (~:715) becomes
    `['Orchestrator watchdog', 'Backlog tick', 'Trackers']` with scopes `['this server', 'this machine', 'this machine']`.
- [ ] **Step 2: Run** those suites — FAIL.
- [ ] **Step 3: Implement.** Band per page: Dashboards subtitle `The machines a launch can run on, in prefer order, and how the launch sheet picks one. Saved
  on the API host — change it here and it changes for everyone.`; pill `this machine`. Third page renders `DashboardsPage`. `SharedPage` drops
  `DashboardsGroup`; watchdog and tick on the left column, `Trackers` on the right; rewrite its header comment to say why. Deep-link doc comment names the
  three scopes and the Dashboards page. Delete `DashboardsGroup.tsx` and the dead CSS.
- [ ] **Step 4: Run** `pnpm run test:jest -- test/rail.test.tsx test/deep-link.test.ts test/deep-link-app.test.tsx test/run-on.test.tsx test/settings-view.test.tsx test/settings-dashboards.test.tsx test/design-guards.test.ts`
  plus the clamp suite, and `pnpm run typecheck` — PASS. `grep -rn DashboardsGroup client test` → only historical mentions in comments, if any, reworded.
- [ ] **Step 5: Commit** — `feat(settings): Dashboards is its own Settings page`.

### Task 7: Docs and invariants

**Files:**
- Modify: `CLAUDE.md` (the Settings headline and its anchor link), `.claude/rules/board.md` (the Settings bullet — headline, `local | shared` mechanism,
  anchor; the `useRefreshing` callers list gains `useMachines`; the Escape bullet's "Dashboards card's add/edit sheet" → "page"),
  `docs/subsystems/invariants.md` (section heading = new headline, body, "Settings (Local, Shared)"), `.claude/rules/dispatch-watchdog.md` (the
  `dashboards.json` bullet: the new route beside the four POSTs and offers, and that it — unlike the offers — reads Home's usage under a `default` source),
  `.claude/DESIGN.md` §8.6 (a Dashboards paragraph: list + detail, Suggest card on top, the 1100 px fold; Shared's balance sentence; "TWO pages" →
  three; "Settings' Local and Shared (§8.6)"), `docs/subsystems/board.md` (Settings section, "Settings (Local, Shared)", anchor links),
  `docs/subsystems/api.md` (the new route: shape, budgets, gates, always-200)
- Test: `test/claude-rules.test.ts`

- [ ] **Step 1:** New headline (exact text is yours; it must say three pages and that a page is one scope, e.g. **"Settings is three pages, a page is one
  scope, and the rail is the only thing that switches them."**). Put it byte-equal in `CLAUDE.md`, `.claude/rules/board.md` and as the `invariants.md`
  heading; compute the new GitHub anchor and replace every link to the old anchor (`grep -rln "settings-is-two-pages" CLAUDE.md .claude docs/subsystems` →
  zero hits after; the dated files under `docs/superpowers/` are history and keep theirs).
- [ ] **Step 2:** Body edits listed above. `grep -rn "Local, Shared\|two pages\|Dashboards card" CLAUDE.md .claude docs/subsystems` → only text that is
  still true.
- [ ] **Step 3: Run** `pnpm run test:jest -- test/claude-rules.test.ts` — PASS.
- [ ] **Step 4: Commit** — `docs: Settings has a Dashboards page`.
