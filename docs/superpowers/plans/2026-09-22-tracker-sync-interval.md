# Per-repo tracker sync interval — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Override of the writing-plans template, on purpose:** this plan gives behaviour, signatures, exact expected values and test CASES — never literal code, test
> scaffolding included. Handed code gets transcribed verbatim, and a bug in the plan becomes a bug in the branch. Where the plan and the code disagree about a
> name or a line number, the code wins; say so in the task report. Where you think the plan is wrong, say that too rather than implementing it.

**Goal:** Per tracker repo, a `15s` / `1m` / `5m` / `off` sync setting on Shared › Trackers; `off` freezes that repo's cache and refuses every write path for it.

**Architecture:** One host-side file (`~/.backlog-manager/settings/tracker-sync.json`) written only by a new guarded POST. The poller keeps its 15 s base tick
and syncs only the repos that are due; an `off` repo gets one cold-boot sync and then nothing. The effective interval rides on the existing `SourceSummary`, so
`/api/projects` and `/api/trackers` both carry it with no second derivation, and one poller method answers "is this project's sync off, and in what words".

**Tech Stack:** NestJS, React, jest (`pnpm run test:jest`), node `--test` for skills, pnpm.

**Spec:** [docs/superpowers/specs/2026-09-22-tracker-sync-interval-design.md](../specs/2026-09-22-tracker-sync-interval-design.md). Read it before Task 1.
Three amendments this plan makes to it are listed under **Spec amendments** and land in the spec itself in Task 6.

## Global Constraints

- Interval tokens are exactly `15s`, `1m`, `5m`, `off`, mapping to `15000`, `60000`, `300000`, and no milliseconds. The default is `15s`.
- The refusal sentence is exactly: `sync is off for <owner/name> — turn it on in Settings › Shared › Trackers` (em dash, `›` separators).
- The file is `~/.backlog-manager/settings/tracker-sync.json`; `BM_TRACKER_SYNC_FILE` overrides the path. Keyed by `owner/name`, exact-string match.
- `TRACKER_POLL_MS` stays `15_000`; `BOARD_TRACKER_POLL_MS` stays `15_000`.
- Every server route under `/api`. The new POST is guarded by `SameOriginPostGuard` (`server/src/agents/origin.guard.ts`), not a new guard.
- Authored prose (comments, docs) wraps at 160 columns. Comments explain _why_, at this repo's existing density — match it.
- Every client component touched keeps (or gains) its header comment citing its `.claude/DESIGN.md` subsection.
- Before editing any file under `server/src/tracker/`, read `.claude/rules/tracker.md` — it is not injected when you edit via `Write` or read via `codegraph_explore`.
- Tests: jest suites flat in `test/`; supertest suites listen once via `listenLoopback` (`test/helpers/app.ts`); fixture dates relative to the clock the assertion
  runs under; the fake GitHub client in `test/helpers/github.ts` is the only GitHub in any test.
- pnpm only. No new dependencies.
- `pnpm test` (both runners) and `pnpm run typecheck` green at the end of every task.

## Spec amendments

1. **The 409 on `off` covers `paused` runs too**, not only `running`. A paused run's resume goes through the driver, which writes through this server, so
   switching off under a paused run would park its resume. Condition: some run file for a project on that repo reads `running` or `paused`, or a `starting`
   entry exists for such a project.
2. **Resume is refused while `off`** as well as dispatch and orchestrate (belt and braces for amendment 1 — a hand-edited file can still turn a repo off).
3. **The route lives in `OrchestratorModule`**, as its own controller, because that module already imports `TrackerModule` and provides `OrchestratorService`
   and `StartingRunsService`. Hosting it in `TrackerModule` would need those two and create a module cycle (orchestrator → tracker → orchestrator).

## Review Focus

1. **A paused run, then sync off, then Resume** — expected: the `off` POST is refused with 409 while the run is paused (amendment 1); if the file is
   hand-edited to `off` anyway, Resume answers 409 with the refusal sentence and spawns nothing. Pinned in Task 3 and Task 4.
2. **The setting changes while a tick is in flight** — expected: the in-flight sync of that repo finishes normally (no abort, no half-absorbed page), and the
   NEXT tick honours the new value. Pinned in Task 2.
3. **Two registered projects on one repo** — expected: both Trackers rows show the same selected value; changing either row changes both after the refetch;
   the file holds one key. Pinned in Task 3 (server) and Task 5b (client).
4. **A repo asleep under a rate limit** (`sleepUntil` in the future) at a `5m` interval — expected: the asleep early return makes no request and does NOT
   stamp the last-sync time, so the repo is retried on the first tick after it wakes, not five minutes after that. Pinned in Task 2.
5. **A hand-edited key in the wrong case** (`Futin/Guide-Manager` for `futin/guide-manager`) — expected: no match, so the repo reads `15s`; the file is not
   rewritten, and a POST for the real repo adds the correct key beside it. Pinned in Task 1.

---

### Task 1: The vocabulary and the file

**Files:**
- Modify: `shared/types.ts` — the interval constant and type; `interval` on `ProjectSummary` and `TrackerProjectRow`
- Modify: `server/src/items/sources/source.ts:249` — `SourceSummary` picks `interval` too
- Create: `server/src/tracker/sync-config.util.ts`
- Test: `test/tracker-sync-config.test.ts`

**Interfaces:**
- Produces:
  - `SYNC_INTERVALS` in `shared/types.ts`: a readonly record, token → milliseconds or `null` for `off`, in the order `15s`, `1m`, `5m`, `off`.
  - `type SyncInterval` — the union of its keys. `DEFAULT_SYNC_INTERVAL: SyncInterval` = `'15s'`. `isSyncInterval(value: unknown): value is SyncInterval`.
  - `ProjectSummary.interval: SyncInterval | null` and `TrackerProjectRow.interval: SyncInterval | null` — `null` for every non-`github` project.
  - `sync-config.util.ts`: `syncConfigFile(): string` (env override, else the default path), `readSyncConfig(): Record<string, SyncInterval>` (only the
    valid entries), `intervalFor(repo: string): SyncInterval`, `writeSyncInterval(repo: string, interval: SyncInterval): void`.

Model the util on `server/src/orchestrator/watchdog-config.util.ts` — its header explains why `settings/` is the directory, why reads are never cached, and why
the write is temp-file-plus-rename. Reference that header rather than repeating it; say what differs (keyed map, not a fixed shape).

- [ ] **Step 1: Write the failing tests** in `test/tracker-sync-config.test.ts`, each case pointing `BM_TRACKER_SYNC_FILE` at a fresh temp path:
  - file missing → `intervalFor('a/b')` is `'15s'`; `readSyncConfig()` is `{}`.
  - file contains `not json` → `'15s'`, no throw.
  - file contains `[]` → `'15s'`; `null` → `'15s'`; `"15s"` (a JSON string) → `'15s'`.
  - file `{"a/b":"off","c/d":"2m"}` → `a/b` is `'off'`, `c/d` is `'15s'`, and `readSyncConfig()` equals `{"a/b":"off"}`.
  - file `{"Futin/Guide-Manager":"off"}` → `intervalFor('futin/guide-manager')` is `'15s'` (Review Focus 5).
  - `writeSyncInterval('a/b','5m')` into a missing file (and missing `settings/` dir) creates it; `intervalFor('a/b')` is then `'5m'`.
  - a file `{"gone/repo":"off","Futin/X":"1m"}` then `writeSyncInterval('a/b','1m')` → the file parses to exactly those three keys (unknown keys survive).
  - a write over a malformed file replaces it with a file holding only the written key.
  - no `*.tmp` sibling remains after a write.
  - `isSyncInterval`: true for the four tokens; false for `'15'`, `'1M'`, `15000`, `null`, `undefined`.
  - `Object.keys(SYNC_INTERVALS)` equals `['15s','1m','5m','off']` and the values equal `[15000, 60000, 300000, null]`.
- [ ] **Step 2: Run** `pnpm exec jest test/tracker-sync-config.test.ts` — expected: FAIL, module not found.
- [ ] **Step 3: Implement** the constant, type, guard and util. Add `interval` to the three types; make every existing producer of a `SourceSummary` /
  `TrackerProjectRow` compile by returning `interval: null` (files source, the unsupported branch, `items.service.ts:125`, `github.source.ts:198`,
  `tracker.controller.ts` row literal). The poller's `summary()` returns `null` too for now — Task 2 gives it the real value.
- [ ] **Step 4: Run** the suite, then `pnpm run typecheck` and `pnpm test` — expected: all PASS.
- [ ] **Step 5: Commit** — `feat(tracker): per-repo sync interval vocabulary and settings file`.

### Task 2: The poller honours the interval

**Files:**
- Modify: `server/src/tracker/poller.service.ts` — `RepoState`, `stateOf`, `sweep`, `shouldPoll`, `syncRepo`, `summary`, plus one new public method
- Modify: `server/src/orchestrator/remote-runs.service.ts:42-61` — skip `off` repos
- Test: `test/tracker-sync-interval.test.ts`

**Interfaces:**
- Consumes: `intervalFor`, `SYNC_INTERVALS`, `SyncInterval` (Task 1).
- Produces:
  - `TrackerPollerService.summary(repo)` now returns `interval: intervalFor(repo)`.
  - `TrackerPollerService.syncOffBlock(projectPath: string): string | null` — resolves the project's marker the way `connectedRepos` does; returns the Global
    Constraints refusal sentence when it is a `github` project whose repo reads `off`, else `null` (files, unsupported, missing, or on). The ONE home of that
    sentence on the server; Tasks 3 and 4 call it and never compose the string.

Behaviour:
- `RepoState` gains `lastSyncAt: number | null` (ms), `null` in `stateOf`. Stamped when `syncRepo` returns having made at least one request — success,
  failure and 304 alike. The asleep early return (`sleepUntil`) makes no request and stamps nothing (Review Focus 4).
- A repo is **due** when: its interval is not `off` and (`lastSyncAt` is `null` or `now - lastSyncAt >= ms`); OR its interval is `off` and `polledAt` is
  `null` and `lastSyncAt` is `null` (the one cold-boot sync — one ATTEMPT, so a failing cold sync is not retried every tick).
- `sweep` reads the config once per tick (via `intervalFor` per repo is fine — the file is small), syncs the due repos in the existing order, then schedules.
  If no connected repo is due AND none will ever be due again (every repo `off` and already attempted), it does not schedule — that is the disarm.
- `shouldPoll` = token present and some connected repo is not `off` or still owed its cold attempt.
- Timing in tests: drive `tick()` directly and move the clock with jest's modern fake timers / `setSystemTime`, the way the existing `test/tracker-poll.test.ts`
  drives the poller — read it first and reuse its setup helpers rather than writing new ones.

- [ ] **Step 1: Write the failing tests** (fake client counts `issues()` calls per repo):
  - repos `a/one` at `15s` and `a/two` at `1m`; ticks at t=0, 15 s, 30 s, 45 s → `a/one` synced 4 times, `a/two` once. A fifth tick at 60 s → `a/two` twice.
  - `a/off` at `off`, empty cache; ticks at 0, 15 s, 30 s → synced exactly once.
  - `a/off` at `off` whose cold sync answers 500 → still exactly one attempt over three ticks.
  - every repo `off`, after their cold ticks → `armed` is `false` and no timer is pending.
  - then `writeSyncInterval('a/off','15s')` + `arm()` → the next tick syncs it and `armed` reads `true`.
  - a repo at `1m` whose first sync fails (500) → no retry at 15 s, 30 s, 45 s; retried at 60 s.
  - a repo at `5m` with `sleepUntil` 20 s in the future → no request at t=0 and t=15 s; a request at t=30 s (Review Focus 4).
  - a repo `15s` → `1m` between ticks, last synced 70 s ago → synced on the next tick (already older than the new interval).
  - mid-flight: start a tick whose `issues()` response is held open, write `off` for that repo, release the response → that tick's sync completes and absorbs
    its page (the issue is in `issues(repo)`); no further `issues()` call on the next two ticks (Review Focus 2).
  - `summary('a/one')` carries `interval: '15s'`; after `writeSyncInterval('a/one','5m')`, `'5m'` with no restart.
  - `syncOffBlock(path)` → exact refusal sentence for an `off` github project; `null` for the same project at `1m`, for a files project, and for a path with
    no `backlog/`.
  - remote runs: an `off` repo whose cache holds a live claim comment derives no remote run; the same repo at `15s` derives one.
- [ ] **Step 2: Run** `pnpm exec jest test/tracker-sync-interval.test.ts` — expected: FAIL.
- [ ] **Step 3: Implement.** Keep `arm`/`tick`/`schedule`'s existing single-chain guarantees untouched; the change is WHICH repos a sweep syncs and whether it
  reschedules. Update the header comments that state "every connected repo every tick" and the `shouldPoll` doc comment.
- [ ] **Step 4: Run** the new suite plus every existing `test/tracker-*.test.ts` and `test/remote-runs*.test.ts` — expected: all PASS unchanged (they run at
  the default `15s` with no file, so their tick counts must not move). Then `pnpm test`.
- [ ] **Step 5: Commit** — `feat(tracker): sync each repo only when its interval is due`.

### Task 3: The route

**Files:**
- Create: `server/src/orchestrator/tracker-sync.controller.ts`
- Modify: `server/src/orchestrator/orchestrator.module.ts` — register the controller and provide `SameOriginPostGuard` (see how `agents.module.ts:50` does it and
  why its header says so)
- Test: `test/tracker-sync-route.test.ts`

**Interfaces:**
- Consumes: `isRepo` (`github.client.ts`), `isSyncInterval`, `writeSyncInterval`, `TrackerPollerService.connectedRepos()`, `.summary()`, `.arm()`,
  `OrchestratorService.runs()`, `StartingRunsService`'s list, the registry.
- Produces: `POST /api/trackers/sync`, body `{ repo, interval }`, answering 200 with `{ repo, interval, polledAt, access, detail }` (the repo's `summary()`).

Order of checks, each its own status: `repo` not a string or not `isRepo` → 400; `interval` not `isSyncInterval` → 400; `repo` not in `connectedRepos()` →
404; `interval === 'off'` and some registered project whose marker names that repo has a run reading `running` or `paused`, or a starting entry → 409 with
`{ error }` naming the project and, when there is one, the runId (amendment 1). Otherwise write, call `arm()`, answer 200. A request for a non-`off` interval
during a live run is 200.

- [ ] **Step 1: Write the failing tests** (supertest via `listenLoopback`, a registry fixture with one github project `a/one` and one files project):
  - `{repo:'a/one', interval:'5m'}` → 200, body `interval: '5m'`; the file holds `{"a/one":"5m"}`; `GET /api/trackers` row for `a/one` shows `'5m'`.
  - `{repo: 42, interval:'5m'}` → 400. `{repo:'not a repo', interval:'5m'}` → 400. `{repo:'a/one', interval:'2m'}` → 400. `{repo:'a/one'}` → 400.
  - `{repo:'x/unknown', interval:'off'}` → 404, and no file is created.
  - a run file for the github project reading `running` → `off` is 409 and the file is unchanged; `1m` is 200.
  - the same with `paused` → 409 (amendment 1). With `done` → 200.
  - a starting entry for the github project, no run file → `off` is 409.
  - wrong content type → refused by the guard; foreign `Origin` → refused by the guard (assert the same statuses the agents POST tests assert).
  - two registered projects on `a/one`: one POST → both rows in `GET /api/trackers` show the new value; the file has one key (Review Focus 3).
  - after `off` → `15s` the poller reports `armed` (a spy on `arm()` is enough).
- [ ] **Step 2: Run** — expected: FAIL, 404 route.
- [ ] **Step 3: Implement.** The controller header explains why it lives here (amendment 3) and why the 409 exists (spec §6). Update
  `tracker.controller.ts`'s header, which says "nothing POSTs here", to point at the new controller.
- [ ] **Step 4: Run** the suite, `test/vite-proxy.test.ts` (must stay green: the route is under `/api`), `pnpm test`.
- [ ] **Step 5: Commit** — `feat(tracker): POST /api/trackers/sync`.

### Task 4: Refusals while `off`

**Files:**
- Modify: `server/src/items/items-write.controller.ts:240-254` — `writable()` (or immediately after it, in the one place every route passes through)
- Modify: `server/src/agents/agents.service.ts` — `dispatch` (~408), `orchestrate` (~507), and the resume path (~822)
- Modify: `server/src/agents/agents.module.ts` — import `TrackerModule` (no cycle: it imports only `RegistryModule`)
- Test: `test/tracker-sync-refusals.test.ts`; one case added to the node suite covering `backlog.mjs`'s `apiPost` refusals (find it with
  `grep -ln "holder" skills/backlog/tools/*.test.mjs`)

**Interfaces:**
- Consumes: `TrackerPollerService.syncOffBlock(projectPath)` (Task 2).
- Produces: 409 `{ error: <refusal sentence> }` from each of those entry points. No new `code` — the existing `RUN_IN_PROGRESS_CODE` is for a different
  fact and must not be reused.

Placement: in the write routes, after the project lookup, INSIDE the existing per-item serialisation (spec §8 — a write queued behind another reads the
setting as it is when its turn comes, not when it was queued) and before any outbound call. In dispatch / orchestrate / resume,
after the existing 404 for an unknown project and before anything spawns; its position relative to the other 409s is: after the run-in-progress checks (a
reader told "a run is already running" learns more than "sync is off").

- [ ] **Step 1: Write the failing tests** (github project `a/one` set `off` via the file):
  - each of the seven write routes → 409 with the exact refusal sentence, and the fake client records zero requests. (One `it.each` over the seven routes
    with a minimal valid body for each — reuse the bodies `test/tracker-write.test.ts` already uses.)
  - the same project at `1m` → the create route succeeds (proves the check reads the value, not the file's existence).
  - `POST /api/agents/dispatch` for an item in that project → 409, sentence exact, nothing spawned (the dashboard fake records no spawn).
  - `POST /api/agents/orchestrate` for that project → 409, same.
  - resume for a paused run of that project → 409, same (Review Focus 1).
  - a files project's dispatch is unaffected.
  - node: `backlog.mjs` against a stub API answering 409 `{error: <sentence>}` with no `holder` → stderr contains the sentence verbatim, exit code 1.
- [ ] **Step 2: Run** — expected: FAIL (writes go through; the node case may already pass — if so, keep it as the pin and say so in the report).
- [ ] **Step 3: Implement.** Each check is one call to `syncOffBlock`; no call site composes wording.
- [ ] **Step 4: Run** the suite, all `test/tracker-*.test.ts`, `test/agents*.test.ts`, `pnpm test`.
- [ ] **Step 5: Commit** — `feat(tracker): refuse writes and dispatch while a repo's sync is off`.

### Task 5a: Board readings and the dispatch block

**Files:**
- Modify: `client/src/lib/tracker.ts` — `trackerLine`, `hasTracker`'s sibling, a new block derivation
- Modify: `client/src/hooks/useBoard.ts:89-94`
- Modify: `client/src/components/board/DispatchButton.tsx` (~177, the item-level block chain) and `client/src/components/board/OrchestrateSheet.tsx`
- Modify: the Trackers row's `ProjectLine` in `client/src/components/settings/TrackersGroup.tsx` only for the wording (Task 5b adds the control)
- Test: extend `test/tracker-lib.test.ts` and `test/tracker-board.test.tsx`

**Interfaces:**
- Consumes: `ProjectSummary.interval`, `TrackerProjectRow.interval` (Task 1).
- Produces, in `lib/tracker.ts`:
  - `syncOffReason(project: Pick<ProjectSummary, 'repo' | 'interval'>): string | null` — the Global Constraints sentence when `interval === 'off'` and `repo` is
    set, else `null`. The client's one home of that sentence; it must be byte-equal to the server's (pin below).
  - `hasSyncingTracker(projects: ProjectSummary[] | null): boolean` — some `github` project whose interval is not `off`.

Behaviour:
- `trackerLine` for an `off` project reads `<repo> · sync off · polled <age> ago`, or `<repo> · sync off · never polled` when `polledAt` is null. An access
  reason still wins over both (a broken token is the more urgent reading). The Trackers row uses the same wording.
- `useBoard` arms its interval on `hasSyncingTracker`, not `hasTracker`. `hasTracker` keeps its other callers.
- `DispatchButton`: the sync-off reason joins the chain of item-level `disabled` blocks — control shown, disabled, reason as its title/tooltip exactly like
  the existing `progressBlock ?? runBlock` reasons. It is NOT an `environmentBlock` and must not hide the control.
- `OrchestrateSheet`: an `off` project cannot be launched — the launch control disabled with the same reason, in the way the sheet already presents a
  project it cannot launch. Read the sheet's existing unavailable-project handling first and extend it rather than adding a second one.

- [ ] **Step 1: Write the failing tests:**
  - `trackerLine` with `interval:'off'`, `polledAt` 3 h before `now` → `futin/x · sync off · polled 3h ago` (match `pollAge`'s actual format — read it).
  - same with `polledAt: null` → `futin/x · sync off · never polled`.
  - same with `access: 'no-token'` → the access reason, not `sync off`.
  - `interval:'1m'` → unchanged from today's line.
  - `hasSyncingTracker`: `[]` → false; one github at `off` → false; one at `off` + one at `5m` → true; only files → false.
  - `syncOffReason({repo:'futin/x', interval:'off'})` equals the literal `sync is off for futin/x — turn it on in Settings › Shared › Trackers`. The client
    cannot import the server's composer, so both sides pin the same literal (Task 2's `syncOffBlock` case asserts it too); a wording change goes red in both.
  - jsdom: board with only an `off` tracker project → `useBoard` creates no interval (spy `setInterval`); with one at `5m` → one interval of 15000.
  - jsdom: an item card in an `off` project renders the dispatch control disabled with the reason; in a `15s` project, enabled.
  - jsdom: Orchestrate sheet, `off` project → launch disabled with the reason.
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched suites, `test/design-guards.test.ts`, `pnpm test`.
- [ ] **Step 5: Commit** — `feat(board): show sync off and block dispatch for it`.

### Task 5b: The Trackers card's picker

**Files:**
- Modify: `client/src/components/settings/TrackersGroup.tsx`
- Modify: `client/src/hooks/useTrackers.ts` — a `refetch` if it lacks one, and the POST helper below
- Test: extend `test/settings-view.test.tsx` (or a new `test/settings-trackers.test.tsx` if that file has no Trackers coverage — check first)

**Interfaces:**
- Consumes: `SYNC_INTERVALS` keys as the options (never a second list), `POST /api/trackers/sync` (Task 3), `Segmented` from `client/src/components/ui/`
  with its `pill` prop (as the Settings rows use it).
- Produces: `useTrackers()` gains `saveInterval(repo: string, interval: SyncInterval): Promise<void>` — POSTs, then refetches; on a non-2xx it resolves (does
  not throw) and exposes the answer's `error` for that repo until the next successful read.

Behaviour:
- Each `github` row renders the pill in its right slot with the row's `interval` selected. `files`, `unsupported` and store-less rows render no control.
- Selecting posts; the pill shows the SERVER's value after the refetch, never an optimistic one. A 409 leaves the old value selected and shows the 409's
  `error` as the row's hint until the next successful read.
- The header comment stops saying the card never sets anything and cites DESIGN.md §8.6.

- [ ] **Step 1: Write the failing tests** (jsdom, `fetch` stubbed):
  - rows: github at `'1m'` → pill with `1m` selected and exactly the four options in order; files row → no pill.
  - click `off` → one POST to `/api/trackers/sync` with `{"repo":"futin/x","interval":"off"}` and content type JSON; after the stubbed refetch answers `off`,
    `off` is selected.
  - stub answers 409 `{error:'a run is running in guide-manager (run r1)'}` → `1m` stays selected and that text is shown in the row.
  - two rows on the same repo, one answers → after the refetch both show the new value (Review Focus 3).
  - the pill's option labels equal `Object.keys(SYNC_INTERVALS)`.
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, `test/design-guards.test.ts`, `pnpm test`, `pnpm run build`.
- [ ] **Step 5: Commit** — `feat(settings): per-repo sync picker on the Trackers card`.

### Task 6: Docs, rules, invariants, and the spec amendments

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-tracker-sync-interval-design.md` — fold in the three amendments (§6's 409 condition, §8's resume, §6's module)
- Modify: `docs/subsystems/invariants.md` — the files-the-server-writes entry (+`tracker-sync.json`); the poller-armed entry (narrowed condition, cold-boot
  attempt); one new entry "A repo whose sync is off refuses every write path, and cannot be switched off under a live or paused run"
- Modify: `CLAUDE.md` — one new invariant headline + `Why:` link to that entry, placed beside the GitHub-token/poller headline
- Modify: `.claude/rules/tracker.md` — mechanism bullets: the file and its defaults, the due rule and the cold attempt, `syncOffBlock` as the one server home
  of the sentence, the 409s. Each bullet anchored per `test/claude-rules.test.ts`'s rules (read that test first)
- Modify: `docs/subsystems/api.md` — the route, `interval` on both payloads, the new 409s
- Modify: `docs/subsystems/board.md` — the `sync off` reading and the dispatch block
- Modify: `.claude/DESIGN.md` §8.6 — the Trackers card now sets one thing, through `Segmented`'s pill

- [ ] **Step 1: Edit** each file. New prose wraps at 160; do not reflow existing lines.
- [ ] **Step 2: Run** `pnpm exec jest test/claude-rules.test.ts` and `pnpm test` — expected: PASS (guard 3: no mechanism text in a CLAUDE.md bullet; headlines
  byte-equal between CLAUDE.md and the rules file).
- [ ] **Step 3: Verify in the running stack**: `pnpm run docker:sync`; on Shared › Trackers set `test-claude-issues` to `off` and confirm the board band reads
  `sync off`, that item's dispatch control is disabled with the sentence, and `~/.backlog-manager/settings/tracker-sync.json` holds the key; set it back to `15s`.
- [ ] **Step 4: Commit** — `docs(tracker): sync interval invariants, rules and API`.
