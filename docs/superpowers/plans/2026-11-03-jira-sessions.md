# Jira page around agent sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Jira Board page into a view of which Claude session works on which ticket — persisted ticket ↔ session links, a Board (deck +
shelves) and List view behind one switch, a Detail dialog replacing the issue modal, and a Needs-you badge on the rail.

**Architecture:** The memory-only live map (`JiraLiveService`) becomes a persisted link store under `~/.backlog-manager/`, still owned by `jira/` and still
written only by the server. The reconciler in `agents/` reads full dashboard rows, ends/re-attaches/detects links and hands the rows to the store's memory;
a new memory-only `GET /api/jira/sessions` serves the client. The client derives labels and button rules from pure helpers and draws three views.

**Tech Stack:** NestJS (server), React + Vite (client), jest (flat `test/`), `node --test` for `skills/jira/tools/jira.test.mjs`.

**Spec:** [docs/superpowers/specs/2026-11-03-jira-sessions-design.md](../specs/2026-11-03-jira-sessions-design.md) — read it whole before Task 1; every
"§n" below is that document's.

**How to read this plan (override of the writing-plans template):** it specifies behaviour, signatures, exact values and exact test *cases* — never
literal code. Where a step names a test, write it yourself from the listed inputs and expected values; where it names a function, the signature is
binding and the body is yours. If the plan and the spec disagree, the spec wins — say so in your report. Size figures anywhere here are soft targets.

## Global Constraints

- Every route under `/api`; `agents/` is the only module that calls the dashboard; the edge runs agents → jira, never back (`.claude/rules/jira.md`).
- The server writes no git and no item files; it spawns no git (the worktree resolution in Task 6 is a plain file read).
- The link store has exactly one writer, the server; written whole and atomically (temp file + `renameSync`), as `server/src/tracker/sync-config.util.ts`
  does. It lives at `~/.backlog-manager/jira-links.json` (override `BM_JIRA_LINKS_FILE`, as `BM_JIRA_FILE` overrides `jira.json`), schema
  `{ version: 1, … }`. An unreadable or wrong-version file is logged and treated as empty, and is never silently replaced: before the first write it is
  renamed aside to `jira-links.json.bad-<ISO>`. This deliberately differs from `jira.json`, whose writers refuse with a 409 forever
  (`server/src/jira/config.util.ts:27`): that file is hand-authored and irreplaceable, this one is machine-written history whose loss costs only past
  lines — refusing would stop every Run from linking. Say so in the store's header comment.
- Nothing is ever written to Jira by this work.
- Before editing a file by any route that does not `Read` it, read its `.claude/rules/` file (CLAUDE.md "Rule files" table): `jira.md` for
  `server/src/jira/**` and `server/src/agents/jira-*.ts`; `dispatch-watchdog.md` for `server/src/agents/**`; `items.md` for `shared/types.ts`; `board.md`
  for `client/src/**` and `shared/agent.ts`; `skills.md` for `skills/**`; `tests.md` for `test/**` and `.claude/rules/**`.
- Comments explain *why*, at the density of the surrounding file. New prose wraps at 160 columns.
- Copy strings are the spec's, verbatim: state names (§6), the Quiet title, C2's two disabled titles, §7.5's labels, the unlink 409 sentence.
- Dashboard row surface is `'local' | 'dashboard' | 'cloud'`; this repo's own launch surface is `'desktop' | 'dashboard'`. Never conflate the two types.
- Scoped tests only, before each commit: the suites the task names, plus `grep -l <symbol> test/` for every shared symbol the diff adds a caller of
  (CLAUDE.md source-guard rule). `pnpm run typecheck` before every commit. Never the full `pnpm test`.
- Commit per task, conventional title (`feat(jira): …`, `docs: …`). No push, no PR — those are held for the user.
- Branch: all six spec sections land on one branch, `feat/jira-sessions`, one commit series per section, so the user can split into six PRs (spec §9)
  or ship one.

## Review Focus

1. **Restart mid-run.** Server restarts while a Run session is live and while another is `starting`: the confirmed one is live again after load and is
   reconciled; the starting one is gone (never persisted) and its key is free; one whose session went idle while the server was down survives the load
   and ends at the first reconcile after the quiet clock, not on load (spec §5, §12). Tests in Task 2 (`after a restart`).
2. **Corrupt or old store file.** Truncated JSON or `version: 2`: the server boots, the page shows no links, the bad file is set aside, not silently
   overwritten. One malformed entry (missing `how`, unknown `how`, no `key`) costs only itself: it is dropped on load and the rest load — the per-entry
   fallback `server/src/jira/config.util.ts` uses. Tests in Task 1.
3. **Dashboard down for a long stretch.** No tick answers for 10 minutes: nothing ends, every live session shows Lost contact, and the badge keeps its
   last count rather than dropping to zero. Tests in Task 3 (server) and Task 13 (badge).
4. **Two tabs, one switch.** Board | List chosen in one tab, the badge clicked in another: both readers of the view store agree (module store, like
   `useJiraPage`). Test in Task 11.
5. **Phone over the tailnet.** `claude://` cannot open there: the Desktop button must not throw or navigate the SPA away. Decide in Task 9 (hide when
   `navigator.userAgent` is a phone — the spec leaves it to the builder) and test the hidden case.

---

## Section 1 — Link store and state (spec §5, §6, §9.1)

### Task 1: Persisted link store

**Files:**
- Create: `server/src/jira/links.store.ts` (file I/O only: load, save, path)
- Modify: `server/src/jira/live.service.ts` (whole file — the map becomes the store's memory), `shared/types.ts:890-960` (`JiraLiveSession` and below)
- Test: `test/jira-live.test.ts` (extend; every existing case must still pass unchanged or be updated with a stated reason in the commit body)

**Interfaces:**
- Produces in `shared/types.ts`:
  - `type JiraLinkHow = 'run' | 'branch' | 'manual'`; `type JiraEndReason = 'idle' | 'stopped' | 'expired' | 'gone'`.
  - `interface JiraLink { key; sessionId: string | null; how: JiraLinkHow; action: JiraAction | null; name: string; repo: string; branch: string | null;
    surface: 'desktop' | 'dashboard' | null; model: string | null; effort: string | null; snapshot: { summary: string; type: string; parentKey: string |
    null }; startedAt: string; endedAt: string | null; endReason: JiraEndReason | null; quietSince: string | null }`.
  - `JiraLiveSession` gains `sessionId: string | null` (Stop needs it; Task 4).
- Produces in `server/src/jira/live.service.ts` (`JiraLiveService`), keeping today's `reserve(key, repo)`, `confirm(key, sessionId)`, `release(key)`,
  `get(key)`, `snapshot()`, `confirmed()`, `hasConfirmed()` with today's semantics, now read over the key's **`run`** entries only: `get(key)` is the
  key's live `run` entry (starting included) or null — a live `branch`/`manual` link never shows through it (its readers are the dispatch's gate, Stop's
  starting check and the run-chip, `jira-dispatch.service.ts:183,201,231`); `release(key)` drops only a starting `run` entry. Plus:
  - `confirm(key, sessionId, meta: Pick<JiraLink, 'action' | 'name' | 'branch' | 'surface' | 'model' | 'effort' | 'snapshot'>)` — the meta argument is new.
  - `end(key: string, sessionId: string, reason: JiraEndReason, now?: number): boolean` — false if that pair is not live.
  - `reattach(key: string, sessionId: string): boolean` — clears `endedAt`/`endReason`/`quietSince` on the pair's own entry.
  - `addLink(link: Omit<JiraLink, 'endedAt' | 'endReason' | 'quietSince'>): 'added' | 'exists' | 'suppressed'` — for `branch`/`manual`.
  - `unlink(key: string, sessionId: string): 'removed' | 'missing' | 'run'` — removes and records the pair in a suppressed list; `'run'` refuses.
  - `isSuppressed(key, sessionId): boolean`, `unsuppress(key, sessionId)` (Task 7's explicit link), `markNeverLink(key, sessionId)`,
    `isNeverLink(key, sessionId): boolean` (Task 6's Jira-404 pairs). Both lists persist with the entries.
  - `markQuiet(key, sessionId, at: string)` / `clearQuiet(key, sessionId)`.
  - `links(): JiraLink[]` (live and ended), `liveLinks(): JiraLink[]`, `hasLive(): boolean`.
  - `snapshot()` now returns only live **`run`** entries (spec §9.1 / review 2: `live[key]` is run-only until Task 10 retires its readers).
- Produces in `links.store.ts`: `jiraLinksFile(env = process.env): string` (`BM_JIRA_LINKS_FILE` or `~/.backlog-manager/jira-links.json`),
  `loadLinks(): { links: JiraLink[]; suppressed: { key: string; sessionId: string }[]; neverLink: { key: string; sessionId: string }[] }`,
  `saveLinks(state)`.

Behaviour:
- `starting` entries (reserved, no session id) live in memory only and are never written. Every other mutation writes the file.
- `reserve` refuses while a live `run` entry exists on the key; it ignores `branch`/`manual` entries (§5).
- Retention (C6), applied on every save: per key keep every live entry plus the 20 newest ended by `endedAt`; drop a key whose newest `endedAt` is more
  than 90 days old and which has no live entry. `JIRA_LIVE_CAP` (100) still bounds **live** entries and keeps today's eviction rule (oldest confirmed by
  `startedAt`, never a starting one).
- The 8-hour TTL now **ends** an entry with `expired` instead of deleting it.
- An ended entry stays ended: a late `confirm` for a key whose pair has ended does not revive it.

- [ ] **Step 1: Write failing tests** in `test/jira-live.test.ts` (point `BM_JIRA_LINKS_FILE` at a fresh temp dir per test):
  - `persists a confirmed run and reloads it`: reserve + confirm `PAY-1`/`s1`, new service instance → `liveLinks()` has `PAY-1`/`s1`, `how: 'run'`.
  - `never persists a starting entry`: reserve `PAY-2` only, new instance → `get('PAY-2')` is null and `reserve('PAY-2', r)` is true.
  - `reserve ignores branch and manual links`: `addLink` a `branch` on `PAY-3` → `reserve('PAY-3', r)` true; with a live `run` on `PAY-3` → false.
  - `end keeps the entry as history`: confirm then `end('PAY-1','s1','idle')` → `links()` has it with `endReason: 'idle'`, `liveLinks()` does not.
  - `reattach reuses the entry`: end then `reattach` → one entry for the pair, live, `endedAt: null`; `links().length` unchanged.
  - `retention keeps 20 ended per key`: 22 ended entries with distinct `endedAt` → 20 remain, the two oldest gone; a live one is never dropped.
  - `drops a key idle for 90 days`: newest `endedAt` 91 days ago, no live → key gone; 89 days → kept.
  - `TTL ends with expired`: confirmed 8 h + 1 ms ago → ended `expired`; exactly 8 h → still live (today's "strictly").
  - `unlink refuses a run link`: `unlink` on a `run` pair → `'run'`, entry untouched; on a `branch` pair → `'removed'` and `addLink` of the same pair →
    `'suppressed'`.
  - `snapshot is run-only`: one live `run` on `PAY-4`, one live `branch` on `PAY-5` → `snapshot()` has `PAY-4` (with its `sessionId`) and not `PAY-5`.
  - `corrupt file`: write `{"version":1,"links":[` → service boots with no links; the file is renamed to `jira-links.json.bad-*` only at the first save.
  - `wrong version`: `{"version":2,"links":[]}` → same as corrupt.
  - `a malformed entry costs only itself`: file with three entries, the middle one missing `how` → the other two load; the file is not set aside.
  - `get is run-only`: `addLink` a live `branch` on `PAY-6` → `get('PAY-6')` null; `release('PAY-6')` leaves the branch link live.
  - `never-link and suppression survive reload`: `markNeverLink('PAY-8','s3')`, `unlink` a branch `PAY-9`/`s4`, new instance → `isNeverLink` and
    `isSuppressed` true for those pairs and false for `PAY-8`/`s4`; `unsuppress('PAY-9','s4')` then `addLink` → `'added'`.
  - `atomic write`: after a save, no `jira-links.json.tmp*` remains in the dir.
- [ ] **Step 2:** `pnpm run test:jest -- test/jira-live.test.ts` → the new cases FAIL.
- [ ] **Step 3:** Implement `links.store.ts` and the reworked `JiraLiveService`. Update `server/src/jira/jira.controller.ts` (`GET /api/jira` `live`,
  `GET /api/jira/issue/:key` `session`) to the run-only snapshot; update `jira-dispatch.service.ts` `launch()` to pass `meta` to `confirm` (snapshot from
  the issue the dispatch already read; `parentKey` from its `parent`).
- [ ] **Step 4:** Run `test/jira-live.test.ts`, `test/agents-dispatch-jira.test.ts`, `test/jira-routes.test.ts`, `pnpm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(jira): persist ticket–session links under ~/.backlog-manager`.

### Task 2: Reconciler — rows, end, re-attach, Quiet, arming, rate

**Files:**
- Modify: `server/src/agents/dashboard-sessions.util.ts` (add a rows read beside `dashboardSessions`), `server/src/agents/jira-live.service.ts`
  (`JiraLiveReconciler`)
- Test: `test/agents-jira-live.test.ts` — **rewritten in part**: the cases at :71, :78, :85 (immediate drop), :125 (one-clock grace) and :205 (disarm when
  nothing is confirmed) assert behaviour this task replaces; rewrite each to the new rule and say so, case by case, in the commit body. Every other case
  keeps its assertion.

**Interfaces:**
- Produces `interface DashboardRow` in **`shared/types.ts`** (not in `agents/`: `JiraLiveService` in `jira/` takes it, and `jira/` imports nothing from
  `agents/`, `.claude/rules/jira.md:103`) — exactly the fields the spec's §5 "The dashboard read carries rows" lists, each
  optional/absent-safe as the dashboard encodes it (`stopState`, `processLive`, `desktopOwned` absent, never `false`).
- Produces `dashboardSessionRows(cfg: AgentsConfig): Promise<{ rows: DashboardRow[]; full: boolean }>` — `GET /api/sessions?limit=50&lookback=168`;
  `full` is `rows.length >= 50`. `dashboardSessions` is re-expressed over it with **unchanged** output for its three readers.
- Produces on `JiraLiveService` (memory, never persisted): `setRows(rows: DashboardRow[], at: string)`, `rowsAt(): string | null`,
  `rowFor(sessionId): DashboardRow | null`, `markUnreachable(at: string)`, `reachable(): boolean`, `notePageRead(now)`, `pageOpen(now): boolean`
  (a read within the last 30 s).
- Produces `JIRA_RECONCILE_FAST_MS = 15_000`; `JIRA_RECONCILE_MS` stays 60 s.

Behaviour per tick (agents enabled; otherwise unchanged no-op):
- One `dashboardSessionRows`. A throw → `markUnreachable`, nothing ends, chain continues.
- For each live entry with a session id, skipping `starting` and entries younger than `JIRA_LIVE_GRACE_MS` by `startedAt`:
  - row `working`/`question` → `clearQuiet`.
  - row present, any other status → `markQuiet` if unset; `end(…, 'idle')` once `quietSince` is also ≥ 120 s old.
  - row absent and `full === false` → treat as quiet with reason `gone` (same two clocks); absent and `full` → leave it.
- For each **ended** entry whose row is now `working`/`question` → `reattach` (C5).
- Verdicts re-check the entry still holds the judged session id after the await (today's rule).
- Arming: `arm()` also from `onApplicationBootstrap` when `hasLive()` or Setup maps a repo (read `repos` from the jira config util the controller uses);
  after a tick, re-arm under the same rule. Period: `pageOpen(now)` ? 15 s : 60 s.

- [ ] **Step 1: Write failing tests** (fake timers, stub fetch, as the suite does today):
  - `incomplete for 120 s after a turn ends with idle`: entry started 10 min ago; tick at t0 row `incomplete` → live, `quietSince = t0`; tick at
    t0 + 119 s → live; t0 + 120 s → ended `idle` (the boundary follows §6's "less than 120 s" and today's `agents-jira-live.test.ts:125`; §5's "more
    than 120 s" is the spec disagreeing with itself — note it in the commit body). Same case with an `idle` row instead of `incomplete` → same result.
  - `working inside the quiet window clears it`: t0 `incomplete`, t0 + 60 s `working` → `quietSince` null; t0 + 180 s `incomplete` → live (new clock).
  - `absent from a short list ends gone`; `absent from a full list of 50 stays live`.
  - `unreachable dashboard ends nothing`: fetch rejects for 10 consecutive ticks → every entry live, `reachable()` false; next good tick → true.
  - `re-attach`: ended `idle` entry `s1` on `PAY-1`, a second live entry `s2` on `PAY-1`, row `s1` `working` → `s1` live again on its own entry, `s2`
    untouched, `links().length` unchanged.
  - `arms on boot with an empty store when a repo is mapped`; `does not arm with no repos and no live`.
  - `15 s while a page is open`: `notePageRead(now)` → next tick scheduled at 15 s; 31 s without a read → 60 s.
  - `dashboardSessions output unchanged`: same fixture through the old reader → identical `id → status` map.
  - `asks with the caps`: the fetched URL carries `limit=50` and `lookback=168`.
  - `after a restart`: store file holding a live `run` on `PAY-1`/`s1` (started 1 h ago) and nothing for `PAY-2`; new service + reconciler, row `s1`
    `idle` → after load `s1` is live (not ended on load); first tick sets `quietSince`; tick 120 s later ends it `idle`. `reserve('PAY-2', r)` true.
- [ ] **Step 2:** Run `test/agents-jira-live.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `test/agents-jira-live.test.ts`, `test/jira-live.test.ts`, plus `grep -l dashboardSessions test/` hits; `pnpm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(jira): reconcile links on dashboard rows with a quiet clock`.

### Task 3: Session state and the client read

**Files:**
- Create: `shared/jira-sessions.ts` (pure: state mapping)
- Modify: `server/src/jira/jira.controller.ts` (new `GET /api/jira/sessions`), `shared/types.ts`
- Test: `test/jira-sessions-state.test.ts` (create), `test/jira-routes.test.ts` (extend)

**Interfaces:**
- Produces `type JiraSessionState = 'starting' | 'plan' | 'permission' | 'reply' | 'answer' | 'working' | 'quiet' | 'lost' | 'ended'` and
  `sessionState(link: JiraLink, row: DashboardRow | null, reachable: boolean): JiraSessionState` in `shared/jira-sessions.ts`, first-match per §6,
  total: a live link that no row of §6 matches (an `idle` or `incomplete` row inside the grace, `quietSince` not yet set, an unknown status, or no row
  while the dashboard answers) is `quiet`.
  `needsYou(state): boolean` — true for `plan | permission | reply | answer` only. `STATE_LABEL: Record<JiraSessionState, string>` with §6's exact names
  (`Starting…`, `Waiting for plan approval`, `Waiting for permission`, `Waiting for a reply`, `Waiting on your answer`, `Working`, `Quiet`,
  `Lost contact`, `Ended`). `QUIET_TITLE = 'Turn finished or stalled — the dashboard cannot tell which'`.
- Produces `GET /api/jira/sessions` → `JiraSessionsPayload { links: (JiraLink & { state: JiraSessionState; row: DashboardRow | null;
  stateSince: string })[]; reachable: boolean; rowsAt: string | null }`. Memory only, no outbound call. Calls `notePageRead` only when the query
  carries `open=1`, which only the Jira section's hook sends — the rail badge's read (Task 13) does not, so a configured Jira does not keep the reconciler
  at 15 s forever (spec §5 "while a Jira page is open"). `stateSince` is when the
  server first saw that state for that pair (memory; reset on a state change).

- [ ] **Step 1: Write failing tests** — `sessionState`: one case per §6 row; `question` + `remotePlan` → `plan`; `question` + `permissionWait` +
  `remoteReply` → `permission` (row order); `question` alone → `answer`; `incomplete` with `quietSince` set → `quiet`; unreachable with a last state of
  `working` → `lost`; `sessionId: null` → `starting`; ended entry → `ended`; live link with an `idle` row and `quietSince` null → `quiet`; live link,
  no row, dashboard reachable → `quiet`. `needsYou`: true for the four waits, false for the rest. Route: unconfigured
  → `{ links: [], reachable: true, rowsAt: null }`; configured → one live and one ended link with their states; `?open=1` marks the page open and a read without it does not.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run both suites + typecheck → PASS.
- [ ] **Step 5:** Commit `feat(jira): derive session state and serve GET /api/jira/sessions`.

### Task 4: Stop names a session

**Files:**
- Modify: `server/src/agents/jira-agents.controller.ts:76-86`, `server/src/agents/jira-dispatch.service.ts:196-210`,
  `client/src/components/jira/JiraIssueModal.tsx` (its Stop caller sends `sessionId` from `live[key].sessionId`)
- Test: `test/agents-jira-stop.test.ts` (extend), `test/jira-modal.test.tsx` (the Stop case's request body)

Behaviour: `POST /api/agents/jira-stop { key, sessionId }`. Missing or malformed `sessionId` → 400 `invalid session id`. A `sessionId` not
live on that key → 409 `<KEY> has no live session <first 8 chars of id>`. Success ends the entry `stopped` (not delete). Today's other answers keep their
status and sentence.

- [ ] **Step 1: Tests** — two live sessions on `PAY-7` (`s1` run, `s2` branch), stop `s1` → `s1` ended `stopped`, `s2` live; stop `s9` → 409;
  `{ key }` alone → 400; dashboard 502 → entry stays live.
- [ ] **Steps 2–4:** fail, implement, pass (`agents-jira-stop`, `jira-modal`, typecheck).
- [ ] **Step 5:** Commit `feat(jira): stop one named session on a ticket`.

### Task 5 (docs for section 1)

**Files:** `.claude/rules/jira.md` (the live-map bullet → the store), `docs/subsystems/invariants.md` (rename the "remembered in server memory only"
entry. `.claude/rules/jira.md:105` takes the **new** heading's slug — `test/claude-rules.test.ts` resolves rule-file anchors against `##`/`###`
headings only, so an HTML anchor cannot satisfy it; an `<a id>` with the old slug serves `docs/subsystems/jira.md`'s link only), `docs/subsystems/api.md` (`GET /api/jira/sessions`, Stop body).
`test/claude-rules.test.ts` must stay green (headline byte-equality, 80-word cap, one anchor per bullet).
- [ ] Edit, run `test/claude-rules.test.ts`, commit `docs: jira link store replaces the memory-only live map`.

---

## Section 2 — Detection and `/jira link` (spec §5, §9.2)

### Task 6: Branch detection

**Files:**
- Modify: `shared/jira-branch.ts` (add `keysInBranch`), `server/src/agents/jira-live.service.ts` (detection in the tick),
  `server/src/jira/poller.service.ts` (add `issueSummary`)
- Create: `server/src/agents/worktree-main.util.ts`
- Test: `test/jira-branch.test.ts`, `test/agents-jira-live.test.ts`, `test/jira-poller.test.ts`

**Interfaces:**
- `keysInBranch(branch: string, projectKeys: readonly string[]): string[]` — every distinct key in the branch whose project is in `projectKeys` and for
  which `branchCarriesKey(branch, key)` holds; upper-cased; order of first appearance. Not mirrored in `jira.mjs` (it does not use it).
- `mainCheckoutOf(path: string): string | null` — if `<path>/.git` is a **file** with `gitdir: <x>/.git/worktrees/<name>`, return `<x>`; if it is a
  directory, return `path`; anything else (missing, unreadable, other shape) → null. Relative `gitdir:` resolves against `path`. No git spawn.
- `JiraPollerService.issueSummary(key: string): Promise<JiraResult<JiraIssue>>` — one `client.issue` read with sweep fields; honours `windowRefusal`
  and routes failures through `routeFailed`, as `splice` does.

Behaviour (per tick, after Task 2's pass): for rows `working`/`question` with a `gitBranch` and a `projectPath`, resolve `mainCheckoutOf(projectPath)`;
the repo matches when the path or its main checkout equals (after normalising) a path Setup maps to the key's project. For each candidate pair not already
linked, not suppressed and not never-link: at most **5** `issueSummary` reads per tick (the rest wait for the next tick); ok → `addLink` with `how:
'branch'`, snapshot from the issue, `surface` from the row (`'dashboard'` → `'dashboard'`, else `null`), `startedAt` now; 404 → never-link the pair; any
other failure → nothing, retry next tick. Detection never runs on `idle`/`incomplete` rows and only ever adds.

- [ ] **Step 1: Tests** — `keysInBranch`: `PAY-151-currency-rounding` → `['PAY-151']`; `feature/PAY-151` → `['PAY-151']`; `XPAY-1510-x` with
  `['PAY']` → `[]`; `PAY-1-and-PAY-2` → `['PAY-1','PAY-2']`; `pay-151-x` → `['PAY-151']`; `OPS-3-x` with `['PAY']` → `[]`.
  `mainCheckoutOf`: dir `.git` → path; file `gitdir: /r/.git/worktrees/w` → `/r`; relative gitdir; missing → null; garbage → null.
  Detection (from spec §12): mapped repo links; unmapped does not; worktree `<mapped>/.worktrees/PAY-151-x` links; worktree of an unmapped repo does not;
  `idle` row never detected; two keys link both; a move from `PAY-151-x` to `PAY-160-y` keeps PAY-151 and adds PAY-160; Jira 404 → never linked and not
  re-read next tick; 429 → re-read next tick; 7 candidates → 5 reads this tick, 2 next; detection runs on an empty store with a mapped repo; a detected
  session beside a live Run → both live and `reserve` still false; only a branch link → `reserve` true.
- [ ] **Steps 2–4:** fail, implement, pass (`jira-branch`, `agents-jira-live`, `jira-poller`, typecheck).
- [ ] **Step 5:** Commit `feat(jira): link sessions whose branch carries a ticket key`.

### Task 7: Link and unlink routes

**Files:**
- Modify: `server/src/agents/jira-agents.controller.ts`, `server/src/agents/dashboard-sessions.util.ts` (add the one-row read)
- Test: `test/agents-jira-link.test.ts` (create; supertest via `listenLoopback` once, `.claude/rules/tests.md`)

**Interfaces:**
- `dashboardSessionRow(cfg, id): Promise<DashboardRow | null>` — `GET /api/sessions/:id/row`; 404 → null; other failures → 502 `HttpException` as
  `dashboardSessions` words them.
- `POST /api/agents/jira-link { key, sessionId }` and `POST /api/agents/jira-unlink { key, sessionId }`, `SameOriginPostGuard`, key shape checked with
  the dispatch's sentence. Link: agents off → 409 as `jira-stop`; `issueSummary` not ok → its status and the poller's sentence; row read null → 409
  `the dashboard does not know session <id8>`; otherwise `addLink` `how: 'manual'` → 200 `{ ok: true, linked: 'added' | 'exists' }`; a previously
  suppressed pair is un-suppressed by an explicit link. Unlink: `'run'` → 409 `<KEY> was started by Run ▾ — stop it from the board instead`;
  `'missing'` → 404 `<KEY> is not linked to session <id8>`; `'removed'` → 200.

- [ ] **Step 1: Tests** — unknown key (poller 404) refused; unknown session (row 404) refused; a session absent from a full list but whose row answers
  200 links; link twice → `exists`; unlink branch → removed and detection never re-adds (drive one tick); unlink run → the 409 sentence verbatim;
  explicit link after unlink → added; cross-origin POST → refused by the guard.
- [ ] **Steps 2–4**, then **Step 5:** commit `feat(jira): link and unlink a session by hand`.

### Task 8: `jira.mjs link` / `unlink` and the skill

**Files:** `skills/jira/tools/jira.mjs` (USAGE, header comment naming the new routes and the new exit code 2 in its exit-code prose, two commands),
`.claude/rules/jira.md:29,40` and `jira.test.mjs:3` (their "one network peer is `/api/jira`" wording now also names `/api/agents/jira-link|unlink`), `skills/jira/tools/jira.test.mjs`,
`skills/jira/SKILL.md` (two subcommands; description mentions linking)

Behaviour: `jira.mjs link <KEY>` / `unlink <KEY>` read `CLAUDE_CODE_SESSION_ID`; absent → exit 2, `jira.mjs link needs CLAUDE_CODE_SESSION_ID — run it
inside a Claude Code session`. Otherwise POST as above and print the server's sentence; non-2xx → its sentence, exit 1; refused connection → today's exit
5 path. USAGE lines: `jira.mjs link <KEY>                    link this session to the ticket (shown on the board; never written to Jira)` and the
`unlink` twin.
- [ ] Tests in `jira.test.mjs` (stub server, as the file does): link success prints and exits 0; missing env → exit 2 and the sentence; 409 →
  sentence, exit 1; unlink success. Run `pnpm run test:skills`. Commit `feat(jira): /jira link and unlink`. Note in the commit body: reaches sessions
  only after push + `pnpm run plugin:sync` (held).

---

## Section 3 — Detail (spec §7.3, §7.5, C2, C3, C9)

### Task 9: Button rules and the open-desktop route

**Files:**
- Create: `client/src/lib/jira-sessions.ts` (pure)
- Modify: `server/src/agents/jira-agents.controller.ts` (+ `POST /api/agents/jira-open-desktop`), do not reuse `desktop.util.ts` — this route
  passes the dashboard's sentence through **unchanged** (unlike the launch sheet's rewording)
- Test: `test/jira-sessions-lib.test.ts` (create), `test/agents-jira-link.test.ts` (extend with the open route)

**Interfaces:**
- `desktopButton(row: DashboardRow, phone: boolean): { show: boolean; enabled: boolean; via: 'href' | 'handover' | null; title: string | null }` —
  C2 exactly. Titles: `Still running — open it in the Dashboard` (dashboard), `Still running in a terminal or the app` (local). `phone` → `show: false`.
- `primaryIsDesktop(row): boolean` — C3 incl. promotion.
- `openButtons(link: JiraLink, row: DashboardRow | null, state: JiraSessionState, opts: { phone: boolean; wide: boolean }): { primary: { label: string;
  target: 'desktop' | 'dashboard' }; secondary: { label: string; target: 'desktop' | 'dashboard' } | null }` — §7.5 first-match table; `wide` spells
  the secondary out for Detail. An ended link (row usually null) gets `Reopen` alone, targeting `link.surface === 'dashboard'` ? Dashboard : Desktop
  (Desktop hidden on a phone → Dashboard).
- `desktopHref(id) = 'claude://resume?session=' + encodeURIComponent(id)`; Dashboard is `sessionUrl(linkBase, id)` (`client/src/lib/agents.ts:466`).
- `POST /api/agents/jira-open-desktop { sessionId }` → dashboard `POST /api/spawn` resume with that id and the desktop surface (read the dashboard's
  `resumeTarget` for the body it expects); status and `{ error }` passed through; unreachable → 502.

- [ ] **Step 1: Tests** — every Buttons case in spec §12 (dashboard working/held/idle+stopState/idle+processLive/idle clean/incomplete clean,
  `desktopOwned`, local working/question/idle, `desktopOwned` in `question` → `Open in Desktop`, permission → `Open in Dashboard`, answer/plan/reply
  labels, ended → `Reopen` only, ended with `row: null` and `surface: 'dashboard'` → Reopen targets Dashboard, `surface: 'desktop'` → Desktop, phone →
  Desktop hidden). Route: 409 `session is still running` passes through verbatim; 501 likewise; dashboard down → 502.
- [ ] **Steps 2–4**, **Step 5:** commit `feat(jira): open-in buttons follow the dashboard's hand-over rules`.

### Task 10: Detail dialog

**Files:**
- Create: `client/src/components/jira/JiraDetail.tsx`, `client/src/components/jira/JiraSessionCard.tsx` (one live card; reused by the deck in Task 11),
  `client/src/hooks/useJiraSessions.ts` (polls `GET /api/jira/sessions` every 15 s while mounted; `JiraContext`-style single instance;
  `useJiraSessions({ open: boolean })` — the Jira section passes `open: true`, which adds `?open=1`)
- Modify: `client/src/components/jira/JiraView.tsx` (open `JiraDetail` where it opened `JiraIssueModal`); move `JiraIssueModal`'s right-side content
  into `JiraDetail` and delete `JiraIssueModal.tsx`; rename it everywhere a guard pins it: `.claude/rules/board.md:12,16,19`, the Escape entry in
  `docs/subsystems/invariants.md`, the comment in `client/src/hooks/useDialogEscape.ts`, `client/src/components/ui/Modal.tsx`'s composer note,
  `docs/subsystems/board.md`, `docs/subsystems/jira.md`, `.claude/DESIGN.md`, `test/ui-modal.test.tsx:97-102` (composers → `ItemModal` + `JiraDetail`),
  `test/dialog-escape.test.tsx:35,305` (import and render), `test/dialog-count-docs.test.ts:46` (`EIGHT` list); the count stays eight; `client/src/lib/jira.ts` run state (`:699`) and `JiraRunMenu` read the **run gate** (live `run`
  link in the sessions payload) instead of `live[key]`
- Test: rename `test/jira-modal.test.tsx` → `test/jira-detail.test.tsx` and keep every existing case; add the new ones

Behaviour: §7.3 as written — left: live cards newest first (state strip with age from `stateSince`, crumb, linked-how tag, short id, Unlink only on a
`branch` link, Stop only with `stopState`), then the history timeline newest first (`<run|name> · ended <when>`, surface, duration, Reopen), then Run ▾
disabled only while a live `run` link exists. Right: everything §8's modal list names. Takes `JiraIssueModal`'s slot on the Escape stack (board.md: the
dialog count stays eight). The waiting question's text is not shown.
- [ ] **Step 1: Tests** — every §8 modal item present and working (the existing suite, moved); two live sessions → two cards newest first; Unlink only on
  the branch card and it POSTs `jira-unlink`; Stop only with `stopState` and its body carries `sessionId`; Run ▾ enabled with only a branch link,
  disabled with a live run link; history line for an ended `run` link 2 h ago reads `run · ended <pollAge> ago` and one for a `branch` link `branch · ended <pollAge> ago` — assert against `pollAge(endedAt, now)` (`client/src/lib/tracker.ts:37`), e.g. `2 h` (the first word is the
  link's `how`, never its action, so `{ skill }` needs no label; ages via `pollAge`); Escape closes; the board.md dialog-count guard still green.
- [ ] **Steps 2–4** (`jira-detail`, `jira-board`, `jira-lib`, `ui-modal`, `dialog-escape`, `dialog-count-docs`, `claude-rules`, typecheck; then
  `grep -rl JiraIssueModal client test .claude docs/subsystems` must print nothing), **Step 5:** commit
  `feat(jira): Detail dialog with the ticket's sessions`.

---

## Section 4 — Board B (spec §7.1, C1, C8)

### Task 11: View switch, deck and shelves

**Files:**
- Create: `client/src/hooks/useJiraView.ts` (module store + `localStorage`, `useJiraPage`'s pattern; values `'board' | 'list'`),
  `client/src/components/jira/JiraAgentDeck.tsx`, `client/src/components/jira/JiraShelves.tsx`
- Modify: `client/src/components/jira/JiraBoardView.tsx` (band gains the `Segmented track` switch, List option `disabled` until Task 12; columns →
  deck + shelves), `JiraCard.tsx` (dense shelf row: today's card content + the newest-ended line), `.claude/DESIGN.md` §8.9
- Test: `test/jira-board.test.tsx` (extend), `test/jira-view-store.test.tsx` (create)

Behaviour: §7.1 and C8 — deck order Needs you, Working, Quiet, Starting/Lost, newest first within; a top issue with a live session on itself or any folded
child leaves the shelves; shelves To Do / In Progress show 8 + `+ N more`, Done collapsed to its 3 newest; filters and `foldMatches` apply to deck and
shelves alike; the minute tick re-ages without re-folding.
- [ ] **Step 1: Tests** — deck order with one of each state; a live session on a folded child removes its top from the shelves and the deck card names the
  top in its crumb; 11 To Do tops → 8 rows + `+ 3 more`; 5 Done → 3 rows; search hit inside a fold rings the top in the shelf; view store: two mounted
  readers agree after one writes, survives remount, a junk stored value reads `'board'` (Review Focus 4); every §8 board item still present; one session
  on `PAY-20`, which two boards both hold → its deck card shows on board A and on board B.
- [ ] **Steps 2–4**, **Step 5:** commit `feat(jira): Board view as agent deck and status shelves`.

## Section 5 — List (spec §7.2, C7)

### Task 12: Session list

**Files:** Create `client/src/components/jira/JiraSessionList.tsx`, `client/src/hooks/useJiraListFilters.ts` (module store: chip, repo, run, window,
allTickets; badge click writes it in Task 13). Modify `JiraBoardView.tsx` (List enabled). Test `test/jira-list.test.tsx` (create).

Behaviour: §7.2 — Live then Ended; Live by state priority then `startedAt` newest first; Ended by `endedAt` newest first; window filters ended rows on
`endedAt` only (default 7 d); All tickets widens from the picked board's keys (and their folds) to every link, using the snapshot for tickets off the board;
Reopen on ended rows; Run ▾ on an ended row only when the ticket has no live `run` link.
- [ ] **Step 1: Tests** — grouping and both sorts; each chip's count and filter; live row started 10 d ago visible under 7 d, ended 10 d ago hidden (dates via `daysAgoDate`, `test/helpers/dates.ts`, never literals);
  All tickets shows a session on a key not on the board with its snapshot summary; Run ▾ present on an ended row whose ticket has only a live branch link;
  search by branch; one session on a ticket two boards hold → one row with All tickets on.
- [ ] **Steps 2–4**, **Step 5:** commit `feat(jira): List view, one row per session`.

## Section 6 — Rail badge (spec §7.4, C4)

### Task 13: Badge

**Files:** Modify `client/src/components/SideRail.tsx` (Jira row), `client/src/styles.css` (`.rail-badge`, modelled on `.filter-bar-badge:443`),
`.claude/DESIGN.md` rail section, `docs/subsystems/board.md`. Test `test/rail.test.tsx` (extend), `test/rail-bar-style.test.ts` if it guards the
rail's classes.

Behaviour: count of `needsYou` across **all** live links (not the picked board); zero → no element; while the sessions read is unreachable the last count
stays (Review Focus 3); click → `setJiraPage('board')`, view `'list'`, filters `{ chip: 'needs-you', allTickets: true }`. The rail reads the sessions
hook only while Jira is configured (no poll otherwise), with `open: false`.
- [ ] **Step 1: Tests** — plan + permission + reply + answer + working → `4`; zero → absent; a session on a key off the picked board counts; one session on a
  ticket on two boards counts once; click lands on List with Needs you and All tickets; unreachable payload keeps the previous count; the rail's request carries no `open=1`.
- [ ] **Steps 2–4**, **Step 5:** commit `feat(jira): Needs-you badge on the Jira rail entry`.

### Task 14: Manual check of `claude://resume` on a live local session (parked #1)

C2's `local` rule ships as written in Task 9 whatever this finds; the result only feeds a follow-up proposal.

Not code. Start `claude` in a terminal on a scratch repo, keep it mid-turn, open `claude://resume?session=<id>` from the board's Detail (temporarily
enabled via devtools). Record what the app does in the final report. If it only focuses or refuses, propose relaxing C2's `local` rule; change nothing
without the user.

---

## Coverage map (spec → task)

§5 store/rules/retention → 1; detach/grace/arming/rate/rows → 2; detection → 6; `/jira link` → 7, 8. §6 → 3. §7.1 → 11. §7.2 → 12. §7.3 → 10 (+4 Stop).
§7.4 → 13. §7.5 + C2/C3 → 9. C1 → 11. C4 → 13. C5 → 2. C6 → 1. C7 → 12. C8 → 11. C9 → 1, 7, 10. §8 → 10, 11. §10 docs → 5, 11, 13; CSP → no change
expected (spec §10). §12 → each task's Step 1.

## Decisions this plan takes where the spec leaves the builder a choice (§11)

- Store file `~/.backlog-manager/jira-links.json`, schema version 1. Client read: a new `GET /api/jira/sessions`. ~15 s: `?open=1` reads mark a page open
  for 30 s. History in Detail: not paged (C6 caps it at 20). `live` stays on `GET /api/jira` (run-only) after Task 10 — removing a field is not in scope.
  Board A's mock files are kept.
