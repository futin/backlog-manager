# Orchestration Archive ("Runs" section) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **OVERRIDE — tests are cases, not code.** This plan deliberately does NOT
> hand you literal test or implementation code, overriding the
> writing-plans template's "code blocks required" rule. Handed code gets
> transcribed verbatim, bugs included, with nobody positioned to catch
> them (7 defects traced to plan-text code in each of two prior projects
> in this workspace). The plan gives exact type definitions (those ARE the
> contract), exact signatures, exact route/URL shapes, and exact test
> CASES — name, setup, input, expected observable result. You write the
> test bodies and the implementation; if a case seems wrong, stop and say
> so rather than transcribing it.

> **Size budgets are soft.** Any line-count or brevity target in this plan
> is a target, not a gate — never compress away a rationale comment or a
> test case to hit one.

**Goal:** A new "Runs" side-rail section that lists every orchestrator run
(live and archived) per project, with aggregate statistics and a roomy
master-detail view replacing the cramped drawer for history.

**Architecture:** The archive already exists on disk
(`<orchHome>/<encodedProject>/runs/<runId>.json`, written only by
`orchestrate.mjs`). The server's existing read-only `orchestrator/` module
gains two GETs (listing with verification tails stripped; single-run
detail verbatim). All statistics are derived client-side in a pure,
tested lib. The UI is a split view (run list left, persistent detail
right) under a stat-tile header.

**Tech Stack:** NestJS (server), React 18 + Vite (client), Jest
(`--runInBand`, jsdom via docblock for component suites), shared types in
`shared/types.ts`.

**Spec:** `docs/superpowers/specs/2026-09-01-orchestration-archive-design.md`
— read it first; every design decision and rejected alternative is there.

## Global Constraints

- pnpm only (`pnpm test`, `pnpm run typecheck`, `pnpm run build`).
- Tests live flat in `test/`, named `*.test.ts` / `*.test.tsx`; component
  suites opt into jsdom with a `/** @jest-environment jsdom */` docblock.
- Every server route stays under `/api` (`test/vite-proxy.test.ts` gates).
- The server NEVER writes anything under `orchHome()`; reads are fresh per
  request, never cached. `orchestrate.mjs` is not touched by any task.
- Comments explain *why*, at length — match the codebase's density; do not
  strip or thin existing comments.
- Copy the repo's existing patterns when a task names one (e.g. "the
  `useOrchestratorRuns` mountedRef pattern") — open that file and mirror
  it rather than inventing a variant.

---

### Task 1: Server — archive listing endpoint

**Files:**
- Modify: `shared/types.ts` (after `OrchestratorRunsPayload`, ~line 493)
- Modify: `server/src/orchestrator/orchestrator.service.ts`
- Modify: `server/src/orchestrator/orchestrator.controller.ts`
- Test: `test/orchestrator-archive.test.ts` (new)

**Interfaces:**
- Consumes: existing `orchHome()`, `isPlausibleRun()` (both in
  `orchestrator.service.ts`), `OrchestratorRun`, `RunQueueItem`,
  `RunVerification` (`shared/types.ts`).
- Produces (later tasks rely on these exact names):

```ts
// shared/types.ts — these definitions are the contract; copy them exactly.
export type VerificationSummary = Pick<RunVerification, 'cmd' | 'ok'>;

export type ArchiveQueueItem = Omit<RunQueueItem, 'verification'> & {
  verification: VerificationSummary[];
};

export type OrchestratorArchiveRun = Omit<OrchestratorRun, 'queue'> & {
  queue: ArchiveQueueItem[];
  /** true when this entry came from run.json (the current/latest run),
   *  false for an archived runs/<runId>.json file. */
  current: boolean;
};

export interface OrchestratorArchivePayload {
  runs: OrchestratorArchiveRun[];
}
```

- Produces on the service: `archive(): OrchestratorArchivePayload`.
- Produces on the controller: `GET /api/orchestrator/archive` returning
  that payload.

**Behaviour to implement:**
- Walk `readdirSync(orchHome())` exactly as `runs()` does (missing root →
  `{ runs: [] }`).
- Per project dir: parse `run.json` (skip-and-warn on
  unreadable/implausible — reuse `isPlausibleRun` and the existing
  `console.warn` style) → one entry with `current: true`; then every file
  in the `runs/` subdir the same way → entries with `current: false`
  (missing `runs/` dir → no entries, no warning).
- Strip every queue item's verification entries to `{cmd, ok}` — build
  new objects; never mutate the parsed run before some future field is
  added to it.
- Sort each project's entries by `runId` descending with plain string
  comparison (a `-2` suffix correctly sorts newer than its base); append
  projects in `readdirSync` order (client re-sorts globally).
- No `fresh`/`pastRuns` annotations here — those belong to `/runs`.

**Steps:**

- [ ] **Step 1: Write the failing tests.** New file
  `test/orchestrator-archive.test.ts` (node env, no jsdom). Build a
  scratch orchestrator home per test with `fs.mkdtempSync` +
  `process.env.BM_ORCH_HOME` (save/restore the env var in
  beforeEach/afterEach; `orchHome()` reads it fresh so no module reset is
  needed). Helper writes a minimal plausible run object (all
  `OrchestratorRun` fields; queue items need every `RunQueueItem` key —
  copy the field list from `shared/types.ts`, not from memory). Cases:
  1. `lists current and archived runs with correct flags` — project A has
     `run.json` (runId `run-20260901-150701`, status `done`) and
     `runs/run-20260831-211011.json`; `archive().runs` has 2 entries;
     the `run-20260901-150701` entry has `current: true`, the other
     `current: false`.
  2. `strips verification tails but keeps cmd and ok` — a queue item with
     `verification: [{cmd: 'pnpm test', ok: true, tail: 'BIG'}]` comes
     back as exactly `[{cmd: 'pnpm test', ok: true}]` (assert `'tail' in
     entry === false`, not just undefined).
  3. `sorts a project's runs newest first including suffix collisions` —
     archived runIds `run-20260901-112815`, `run-20260901-112815-2`,
     `run-20260901-073202` plus current `run-20260901-150701` come back
     in order: `150701`, `112815-2`, `112815`, `073202`.
  4. `skips an unreadable archived file without failing the payload` —
     `runs/garbage.json` containing `not json` alongside one good file →
     payload holds the good run only.
  5. `skips an implausible archived file` — `runs/run-20260901-000000.json`
     containing `{"hello": 1}` → not in payload.
  6. `returns empty runs for a missing state dir` — `BM_ORCH_HOME`
     pointing at a path that does not exist → `{ runs: [] }`.
  7. `a project with runs/ but no run.json still lists its archive` —
     covers a crashed-then-cleaned project dir; only `current: false`
     entries appear.
- [ ] **Step 2: Run the new suite; verify every case fails** with
  "archive is not a function" (or equivalent), not with fixture errors.
  Run: `pnpm test -- orchestrator-archive`
- [ ] **Step 3: Add the shared types** (block above, verbatim) with a doc
  comment explaining WHY tails are stripped (bytes: tails are ~90% of a
  real run file) and why `current` exists (the latest finished run lives
  in `run.json` until the next `init` archives it — without the flag the
  client cannot tell "latest" from "history").
- [ ] **Step 4: Implement `archive()` + controller route** following the
  behaviour list above. The controller method mirrors `runs()`:
  `@Get('archive')` returning `this.orchestrator.archive()`.
- [ ] **Step 5: Run the suite to green, then the full gates.**
  Run: `pnpm test -- orchestrator-archive`, then `pnpm run typecheck`.
- [ ] **Step 6: Commit** — `feat(server): orchestrator archive listing endpoint`.

---

### Task 2: Server — archived-run detail endpoint

**Files:**
- Modify: `server/src/orchestrator/orchestrator.service.ts`
- Modify: `server/src/orchestrator/orchestrator.controller.ts`
- Test: `test/orchestrator-archive.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's service/controller; `OrchestratorRun`.
- Produces: service `archivedRun(project: string, runId: string):
  OrchestratorRun | null`; controller
  `GET /api/orchestrator/archive/run?project=<abs path>&runId=<id>` —
  200 with the run file verbatim (tails included), or 404 with
  `{ error: 'not found' }` for every failure mode alike (the
  `GET /api/items/body` stance: the caller has no business learning
  which check failed).

**Behaviour to implement (guards in this order, before any file read):**
1. `runId` must match `^run-\d{8}-\d{6}(-\d+)?$` — a module-level
   `const RUN_ID_RE` with a comment naming traversal as the threat.
2. `encodeURIComponent(project)` must be string-equal to one of
   `readdirSync(orchHome())`'s entries (missing root → null). This is the
   allowlist-by-listing shape `allow.util.ts` uses — never `path.join`
   the raw project into the tree first.
3. Prefer `runs/<runId>.json`; if absent, read `run.json` and serve it
   only when its own `runId` field equals the requested id.
4. Any parse failure or `isPlausibleRun` failure → null → 404. In the
   controller, null becomes `throw new HttpException({ error: 'not found' }, 404)`
   (match the import/usage style in `agents.controller.ts`).

**Steps:**

- [ ] **Step 1: Write the failing tests** (same file, new `describe`).
  Instantiate the controller directly:
  `new OrchestratorController(new OrchestratorService())`; assert 404s by
  catching `HttpException` and checking `getStatus() === 404`. Cases:
  1. `serves an archived run verbatim, tail included` — write an archived
     run whose verification entry has `tail: 'the tail'`; response deep-
     equals the fixture object (tail present, no `current` key added).
  2. `serves the current run when runId matches run.json` — no archived
     file; `run.json` runId `run-20260901-150701` requested → 200 body is
     that run.
  3. `404 for a well-formed runId that exists nowhere`.
  4. `404 for traversal-shaped runIds` — each of `'../../run'`,
     `'run-20260901-150701/../x'`, `'run-1; rm -rf'`, `''` → 404, and
     (for the first two) assert no error escapes about ENOENT paths
     outside the scratch dir.
  5. `404 for an unregistered project` — a real absolute path that is not
     a listing entry, plus a PREFIX of a registered path (e.g. the
     registered path minus its last segment) — both 404.
  6. `404 when run.json exists but its runId differs from the request`.
- [ ] **Step 2: Run; verify failures** are "archivedRun is not a
  function" / missing route, not fixture errors.
  Run: `pnpm test -- orchestrator-archive`
- [ ] **Step 3: Implement** service + controller per the behaviour list.
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `feat(server): archived-run detail endpoint`.

---

### Task 3: Client — run statistics lib

**Files:**
- Create: `client/src/lib/run-stats.ts`
- Test: `test/run-stats.test.ts` (new, node env — pure functions)

**Interfaces:**
- Consumes: `RunStage`, `RunQueueItem`, `OrchestratorArchiveRun`,
  `ArchiveQueueItem` (`shared/types.ts`); reuse
  `isTerminalStage` from `client/src/lib/run-time.ts` where noted —
  do NOT re-implement span/format primitives that file already exports.
- Produces (exact signatures later tasks import):

```ts
export interface StageSpan { stage: RunStage; ms: number }

/** Spans between consecutive recorded stage arrivals, sorted by time.
 *  Accepts live or archive queue items (verification shape irrelevant). */
export function itemStageSpans(
  item: Pick<RunQueueItem, 'stageAt'>
): StageSpan[];

/** Last recorded arrival minus first; null with fewer than two parseable stamps. */
export function itemWallMs(item: Pick<RunQueueItem, 'stageAt'>): number | null;

/** updatedAt − startedAt for finished runs; now − startedAt while running;
 *  null on unparsable stamps. */
export function runWallMs(
  run: Pick<OrchestratorArchiveRun, 'status' | 'startedAt' | 'updatedAt'>,
  now: number
): number | null;

/** Per-stage ms summed over every queue item's spans. */
export function runStageTotals(
  run: Pick<OrchestratorArchiveRun, 'queue'>
): Partial<Record<RunStage, number>>;

export interface RunAggregates {
  runs: number;
  byStatus: Record<OrchestratorArchiveRun['status'], number>;
  itemsMerged: number;
  itemsQueued: number;          // total queue length across runs
  avgItemWallMs: number | null; // mean over merged items with a wall time
  fixLoopsPerMerged: number | null; // total fixLoops / merged; null when 0 merged
  verifyPassRate: number | null;    // ok entries / all entries; null when none
}

export function aggregateRuns(
  runs: readonly OrchestratorArchiveRun[],
  now: number
): RunAggregates;

/** Grouping key for the run list: 'YYYY-MM-DD' in LOCAL time. */
export function dayKey(iso: string): string | null;

/** 'mon 1 sep' style label, lowercase, from a dayKey/ISO — hand-rolled
 *  fixed English names so tests are locale-independent. */
export function dayLabel(iso: string): string | null;
```

**Behavioural rules (encode these in the doc comments too):**
- Every function tolerates corrupt/missing ISO stamps by skipping the
  entry or returning `null` — never throws (hand-editable JSON feeds
  this; there is no ErrorBoundary above the render).
- `itemStageSpans` sorts recorded arrivals by TIMESTAMP, never nominal
  stage order; consecutive deltas are labeled by the EARLIER stage; the
  last arrival contributes no span (zero-length terminal). Document the
  spec's approximation: `stageAt` keeps first arrivals only, so fix-loop
  re-passes fold into an earlier span.
- `now` is always a parameter — no `Date.now()` inside the lib (the
  drawer's one-clock-read-per-render rule).

**Steps:**

- [ ] **Step 1: Write failing tests.** Cases with exact expected values:
  1. `spans for a clean progression` — stageAt
     `{pending: T+0s, dispatched: T+10s, reviewing: T+70s, merged: T+100s}`
     → `[{pending,10000},{dispatched,60000},{reviewing,30000}]` in that
     order.
  2. `spans sort by time even when insertion order differs` — object
     literal keys deliberately out of chronological order; same result.
  3. `single stamp → no spans, itemWallMs null`.
  4. `corrupt stamp skipped` — `{pending: 'garbage', dispatched: T,
     merged: T+5s}` → one span `{dispatched, 5000}`; wall 5000.
  5. `itemWallMs = last − first` on case 1 → 100000.
  6. `runWallMs finished` — status done, started T, updated T+90s, any
     `now` → 90000; `running` — started T, now T+30s → 30000; corrupt
     startedAt → null.
  7. `runStageTotals sums across items` — two items whose spans share
     `dispatched` → the totals entry is the sum; stages with no span
     absent from the record.
  8. `aggregateRuns` over: one done run (2 merged of 2, fixLoops 1+2,
     verification 3 ok + 1 fail), one failed run (1 merged of 2,
     fixLoops 0, no verification), one running run (0 merged of 3) →
     `runs: 3`, `byStatus {done:1, failed:1, running:1, aborted:0}`,
     `itemsMerged: 3`, `itemsQueued: 7`, `fixLoopsPerMerged: 1`,
     `verifyPassRate: 0.75`; avgItemWallMs asserted against the fixture
     stamps you choose (pick round numbers).
  9. `aggregateRuns over [] → zeros and nulls` (`avgItemWallMs`,
     `fixLoopsPerMerged`, `verifyPassRate` all null).
  10. `dayKey/dayLabel` — `'2026-09-01T15:07:01.181Z'` → key matches
      `^\d{4}-\d{2}-\d{2}$` and label matches `^(mon|tue|wed|thu|fri|sat|sun) \d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$`
      (regex, not literal — local-time conversion varies by TZ);
      `'garbage'` → both null.
- [ ] **Step 2: Run; verify module-not-found failures.**
  Run: `pnpm test -- run-stats`
- [ ] **Step 3: Implement** with the behavioural rules above.
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `feat(client): run statistics derivation lib`.

---

### Task 4: Client — archive fetchers and hook

**Files:**
- Modify: `client/src/lib/agents.ts`
- Create: `client/src/hooks/useOrchestratorArchive.ts`
- Test: `test/agents-client.test.ts` (extend), `test/orchestrator-archive-hook.test.tsx` (new, jsdom)

**Interfaces:**
- Consumes: Task 1/2 endpoints and types; `unwrap`/`ApiError` (existing,
  file-internal); the `useOrchestratorRuns` hook as the pattern to
  mirror.
- Produces:

```ts
// lib/agents.ts
export async function fetchOrchestratorArchive(): Promise<OrchestratorArchivePayload>;
export async function fetchArchivedRun(project: string, runId: string): Promise<OrchestratorRun>;

// hooks/useOrchestratorArchive.ts
export function useOrchestratorArchive(): {
  runs: OrchestratorArchiveRun[];
  refresh: () => void;
};
```

**Behaviour:**
- `fetchOrchestratorArchive` GETs `/api/orchestrator/archive`, guards the
  payload with a new `isOrchestratorArchivePayload` type guard checking:
  `runs` is an array and every entry has string `runId`, string
  `project`, boolean `current`, and array `queue` (the fields RunsView
  dereferences on every row — same "lies quietly in hook state"
  rationale as the existing guards; malformed → throw
  `new Error('malformed /api/orchestrator/archive response')`).
- `fetchArchivedRun` GETs
  `/api/orchestrator/archive/run?project=${encodeURIComponent(project)}&runId=${encodeURIComponent(runId)}`.
  No shape guard: the response is rendered once by the pane that fetched
  it (the "fails in the same round trip" case), and a 404 already
  arrives as `ApiError` via `unwrap`.
- The hook mirrors `useOrchestratorRuns` — mount + window-focus refresh,
  the `mountedRef` re-arm pattern (copy the StrictMode rationale), state
  starts `[]`, failed fetch keeps prior state — but has NO polling
  interval (history changes on run boundaries, not per heartbeat; the
  focus refresh picks those up).
- Update `agents.ts`'s header comment ("the board's five calls") to the
  new count.

**Steps:**

- [ ] **Step 1: Write failing tests.**
  In `test/agents-client.test.ts` (mirror the existing fetch-mock style):
  1. `fetchOrchestratorArchive returns a valid payload`.
  2. `fetchOrchestratorArchive throws on malformed payload` — `{runs: [{}]}`.
  3. `fetchArchivedRun hits the right URL` — assert the mocked fetch was
     called with the exact query string for
     `project '/tmp/my project'` (space must arrive `%20`-encoded... use
     whatever `encodeURIComponent` actually produces) and
     `runId 'run-20260901-150701'`.
  4. `fetchArchivedRun surfaces a 404 as ApiError with status 404`.
  In the new hook test (jsdom, mirror `test/orchestrator-hook.test.tsx`'s
  harness):
  5. `fetches on mount and exposes runs`.
  6. `refetches on window focus`.
  7. `does NOT install any interval` — with fake timers, advancing 30s
     after mount triggers no additional fetch.
  8. `failed fetch keeps previous runs`.
- [ ] **Step 2: Run; verify failures.**
  Run: `pnpm test -- agents-client orchestrator-archive-hook`
- [ ] **Step 3: Implement** fetchers + guard + hook.
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `feat(client): archive fetchers and hook`.

---

### Task 5: Runs section wiring (rail tab + empty shell)

**Files:**
- Modify: `client/src/components/SideRail.tsx` (TABS)
- Modify: `client/src/App.tsx` (lazy import + render branch)
- Modify: `client/src/components/settings/SettingsView.tsx` (its labeled
  `LANDINGS` list — the derived one in `lib/settings.ts` picks the new
  section up automatically; the labeled one is manual)
- Create: `client/src/components/runs/RunsView.tsx` (shell)
- Test: `test/nav.test.tsx` (extend)

**Interfaces:**
- Produces: `Section` union gains `'runs'`; `RunsView` default-exported
  lazy component (match how `ArchiveView`/`SettingsView` are lazy-loaded
  in `App.tsx` — copy that import shape exactly).

**Behaviour:**
- TABS order: `board, runs, archive, settings` — Board's companions
  first, per spec.
- Shell `RunsView` renders a heading and the empty state `no runs yet`
  (final copy — Task 6 keeps it for the genuinely-empty case) inside the
  wide wrap (`App.tsx` already gives every non-settings section
  `wrap wide`; verify, don't change).
- SettingsView's landing picker gains `{ value: 'runs', label: 'Runs' }`
  in rail order.

**Steps:**

- [ ] **Step 1: Extend `test/nav.test.tsx` (failing first).** Cases:
  1. `rail shows four tabs in order` — Board, Runs, Archive, Settings.
  2. `clicking Runs renders the runs view` — the empty-state text
     appears.
  3. `resolveSection('runs') === 'runs'` and legacy `'projects'` still
     falls back to `'board'`.
  4. `clampSettings accepts landing 'runs'` (import from lib/settings;
     proves the derived LANDINGS picked it up).
- [ ] **Step 2: Run; verify failures.** Run: `pnpm test -- nav`
- [ ] **Step 3: Implement** the four file changes.
- [ ] **Step 4: Run nav suite + FULL suite** (SECTIONS is load-bearing —
  a stored-section or landing test elsewhere may pin the list).
  Run: `pnpm test`
- [ ] **Step 5: Commit** — `feat(board): Runs side-rail section (shell)`.

---

### Task 6: RunsView — header tiles, filter, run list

**Files:**
- Modify: `client/src/components/runs/RunsView.tsx`
- Modify: `client/src/styles.css` (new `runs-*` block, at the end,
  commented like the existing sections)
- Test: `test/runs-view.test.tsx` (new, jsdom)

**Interfaces:**
- Consumes: `useOrchestratorArchive` (Task 4), `useOrchestratorRuns`
  (existing — live payload), `aggregateRuns`/`runWallMs`/`dayKey`/
  `dayLabel` (Task 3), `projectLabel` from wherever `RunDrawer.tsx`
  imports it (check that import and reuse), `stageGlyph`/`stageChipClass`
  (`lib/run-stage.ts`), `formatSpanCompact` (`lib/run-time.ts`).
- Produces: internal only, plus the selection contract Task 7 consumes:
  `RunsView` holds `selected: { project: string; runId: string } | null`
  state, defaulting to the newest visible run, and renders
  `<RunDetail run={...} live={...} />` (Task 7 defines RunDetail; until
  then render a `data-testid="run-detail-slot"` placeholder div with the
  selected runId as text — Task 7 replaces it).

**Behaviour:**
- Merge the two payloads by `runId`: archive listing is the master list;
  a run also present in the live payload (matched by runId) is
  "live-backed" — its list row shows the live accent while `fresh`, and
  Task 7 will render it from the live object. Dedupe defensively (same
  runId twice in the merged list keeps the first).
- Global sort: `startedAt` descending; group rows under `dayLabel`
  headings by `dayKey`; entries with a null key group under `unknown`.
- Project filter: `all` + one entry per distinct `project` across the
  merged list, labeled via `projectLabel`; a `<select>` (Settings-style
  control), component state, filters list AND tiles.
- Stat tiles from `aggregateRuns(filteredRuns, now)`: runs (with
  by-status glyph line), items merged / of queued, avg item
  (formatSpanCompact, `—` when null), fix loops per merged (1 decimal,
  `—` when null), verify pass (percent, 0 decimals, `—` when null).
  One `Date.now()` per render, threaded down (the RunDrawer rule).
- Each list row: status glyph+word (reuse the strip's tone vocabulary —
  running=live accent, done=ok, aborted=warn, failed=bad), project
  label, `merged/total`, wall time via `runWallMs` + `formatSpanCompact`.
  Row click sets selection; `aria-current="true"` on the selected row.
- Empty merged list → the shell's `no runs yet` line and nothing else.
- Styles: split layout (`.runs-split` grid, list column ~200px), stacks
  to one column under the app's existing 700px breakpoint (find the
  media query the rail uses and match its threshold); tiles row
  `.runs-tiles` (strip paper, hairline border, 2px radius — copy the
  visual grammar of `.run-strip`'s CSS rather than inventing).

**Steps:**

- [ ] **Step 1: Write failing tests.** Mock both fetchers via
  `jest.mock('../client/src/lib/agents', ...)` (match the module-path
  style existing component suites use). Fixtures: two projects, four
  runs total (one running+fresh in the live payload with matching
  archive entry, two done, one failed; distinct startedAt across two
  days). Cases:
  1. `groups runs by day, newest first` — day headings in order; rows
     within a day ordered by startedAt desc.
  2. `defaults selection to the newest run` — detail slot shows its
     runId.
  3. `live run row carries the live marker` — assert the class or glyph
     you implement for fresh rows (pick one and assert it).
  4. `project filter narrows rows and tiles` — select project B → only
     its rows; the "runs" tile count drops to B's count.
  5. `tiles render aggregate numbers` — against the fixture, assert the
     exact rendered strings for merged count and verify pass rate.
  6. `empty payloads render the empty state`.
  7. `clicking a row moves selection` — detail slot text changes.
- [ ] **Step 2: Run; verify failures.** Run: `pnpm test -- runs-view`
- [ ] **Step 3: Implement** view + styles.
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `feat(board): Runs list, filter and stat tiles`.

---

### Task 7: RunDetail pane

**Files:**
- Create: `client/src/components/runs/RunDetail.tsx`
- Modify: `client/src/components/runs/RunsView.tsx` (replace the slot)
- Modify: `client/src/styles.css` (detail + stage-bar classes; add the
  six `.run-seg-<tone>` background classes mapping `StageTone` →
  `--cyan/--green/--red/--amber/--mustard/--ink3` — same tone→color
  pairing `stageChipClass` documents)
- Test: `test/run-detail.test.tsx` (new, jsdom); `test/runs-view.test.tsx`
  (extend with one integration case)

**Interfaces:**
- Consumes: `fetchArchivedRun` (Task 4), `itemStageSpans`/`itemWallMs`/
  `runWallMs` (Task 3), `stageChipClass`/`stageGlyph`/`STAGE_TONE`
  (`lib/run-stage.ts`), `formatClock`/`formatSpanCompact`
  (`lib/run-time.ts`), `OrchestratorRun`, `OrchestratorArchiveRun`.
- Produces:

```ts
export function RunDetail(props: {
  /** The archive entry (always available — drives header + rows). */
  summary: OrchestratorArchiveRun;
  /** The live payload's full run when this runId is live-backed;
   *  null → the pane fetches the archived file itself for tails. */
  live: OrchestratorRun | null;
}): JSX.Element;
```

**Behaviour:**
- Data source: `live` when given (poll keeps it ticking — no fetch);
  otherwise `useEffect`-fetch `fetchArchivedRun(summary.project,
  summary.runId)` keyed on those two values, with a stale-response guard
  (ignore a resolution for a runId that is no longer the prop —
  the selection can change mid-flight). Render states: rows from
  `summary` immediately (everything but tails is already there);
  verification `<details>` per item shows `cmd` + ok/failed from the
  summary at once, and the tail body fills in when the fetch lands;
  fetch failure → one inline `couldn't load verification output` note
  (`run-detail-error` class), rows stay.
- Header: runId (mono), status chip (reuse the tone the list row used),
  `started HH:MM · <wall> elapsed` via `formatClock`/`runWallMs` —
  mirror RunDrawer's null-tolerant join (each half renders only if it
  parsed).
- Count chips: merged / skipped / attention / fix loops (sum of
  `fixLoops`); when the run is live-backed and fresh, append active /
  queued chips (`ACTIVE_RUN_STAGES` from `ItemCard.tsx`, the drawer's
  import).
- Per item row: id (mono), title (ellipsis), stage chip
  (`stageChipClass` + `stageGlyph` + stage word), wall time right-
  aligned; below it the segmented stage bar — one flex child per
  `itemStageSpans` entry, width proportional to ms (min-width 2px so a
  short stage stays visible), class `run-seg-<tone>` from
  `STAGE_TONE[span.stage]`; caption line joins
  `` `${span.stage} ${formatSpanCompact(span.ms)}` `` with ` · `.
  Items with no spans render no bar and no caption.
- Verification `<details open={!ok}>` — the drawer's one-way seed
  pattern, copy its comment's reasoning in brief.
- Attention section under the items: kind + detail per entry, drawer
  wording; `nothing needs a look` when empty.

**Steps:**

- [ ] **Step 1: Write failing tests.** `test/run-detail.test.tsx`:
  1. `renders header, chips and item rows from the summary alone` —
     archived summary, fetch mocked pending (never resolves): status
     chip word, merged/skipped/attention/fix-loop chip numbers, item
     stage chip + wall time all present.
  2. `fetches tails for an archived run and fills the details body` —
     resolve the mock; the tail text appears inside the item's
     `<details>`.
  3. `failed verification seeds its details open; passing stays closed` —
     assert the `open` attribute.
  4. `live run renders tails without fetching` — `live` prop set;
     `fetchArchivedRun` mock not called; tail text present.
  5. `stale fetch resolution is ignored` — rerender to a new summary
     while the first fetch is unresolved; resolve the first; its tail
     never renders.
  6. `fetch failure shows the inline error and keeps rows`.
  7. `stage bar renders one segment per span with the tone class` —
     fixture with known stageAt; assert segment count and one expected
     `run-seg-*` class; caption text matches
     `pending 10s · dispatched 1m 00s`-style joins (use the exact
     `formatSpanCompact` output for your fixture values — check that
     function's format before writing the expectation).
  In `test/runs-view.test.tsx` add:
  8. `selecting an archived run mounts RunDetail which fetches that
     project+runId` — assert the mock's call args.
- [ ] **Step 2: Run; verify failures.** Run: `pnpm test -- run-detail runs-view`
- [ ] **Step 3: Implement** RunDetail + slot replacement + styles.
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `feat(board): run detail pane with stage bars and verification`.

---

### Task 8: Docs + final verification

**Files:**
- Modify: `CLAUDE.md` (layout bullets: side-rail section list + Runs
  view; `orchestrator/` module route list; invariant bullet — the
  run-state reader now covers `runs/` and the archive endpoints, one
  writer/one reader unchanged)
- Modify: `docs/invariants.md` (same wording extension where the run-file
  invariant is elaborated)

**Interfaces:** none — prose only, argued from the spec.

**Steps:**

- [ ] **Step 1: Make the doc edits.** Keep each existing bullet's voice;
  extend, don't rewrite. CLAUDE.md's side-rail line must name the new
  tab order and that `SECTIONS` stays the single runtime list.
- [ ] **Step 2: Full gates.**
  Run: `pnpm test` then `pnpm run typecheck` then `pnpm run build` — all
  green, no skipped suites.
- [ ] **Step 3: Commit** — `docs: record the Runs section and archive read paths`.

---

## Self-review notes (already applied)

- Spec coverage: listing endpoint (T1), detail endpoint + guards (T2),
  stats lib incl. day grouping (T3), fetchers/hook (T4), rail/section/
  landing (T5), tiles+filter+list+live pinning (T6), detail pane incl.
  live-vs-fetch split and one-way-seeded details (T7), docs/invariants
  (T8). Non-goals honored: no orchestrate.mjs task, no pruning, no
  Archive-tab work.
- Type consistency: `OrchestratorArchiveRun`/`ArchiveQueueItem`/
  `VerificationSummary` defined once in T1 and consumed by name in
  T3/T4/T6/T7; `RunDetail`'s `summary`/`live` props defined in T7 and
  pre-wired via T6's placeholder slot contract.
- The one deliberate placeholder: T6 renders a `run-detail-slot` div that
  T7 replaces — named in both tasks so neither implementer is surprised.
