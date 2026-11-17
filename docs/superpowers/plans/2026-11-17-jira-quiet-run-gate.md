# Jira quiet-only Run gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a new Jira Run on a key starts as soon as every live `run` link on it is Quiet, instead of waiting for the link to end.

**Architecture:** two pure predicates in `shared/jira-sessions.ts` decide "does this live Run yield, and if not, why"; the server's `JiraLiveService.reserve`
and the dispatch's 409 wording read them, and the client's `runChipState`, the chip/menu titles and the Detail band line read the same ones. Review dispatch
keeps today's strict gate.

**Tech Stack:** NestJS server, React client, Jest (`test/jira/`), TypeScript shared module.

**Spec:** `docs/superpowers/specs/2026-11-17-jira-quiet-run-gate-design.md`

**This plan specifies behaviour, signatures and exact test cases, never literal code** (the user's standing rule): write the bodies yourself, and disagree
with the plan where the code shows it is wrong — say so in the commit body.

## Global Constraints

- Phrases, exactly: `not seen by the dashboard`, `waiting on you`, `still working`, `not quiet yet`.
- 409 for a refused non-review Run: `<KEY> has a Run <phrase>`. Kept word for word: `<KEY> is starting`, `too many Jira sessions are starting — try again in
  a moment`; `<KEY> already has a session` only for a review.
- Chip / menu-row titles: `a Run on <KEY> is <phrase>`, `a Run on <KEY> is starting`; the `no-repo` title is unchanged.
- Band line: `Next Run can start once this one is quiet.` / `Quiet — a new Run can start now.` / none.
- Comments explain why, at length (repo convention); new prose wraps at 160 columns; every edited rule keeps its `Why:` link.
- `reserve` stays a synchronous check-and-set; no `await` enters the dispatch between `reserve` and the branch hold.

## Review Focus

1. **Server restart with a persisted `quietSince`.** Rows are empty after boot; a live link with `quietSince` set must still block (`not seen by the
   dashboard`) until a good read carries its row. Test in Task 1 (predicate, null row) and Task 2 (`reserve` with no `setRows`).
2. **Dashboard unreachable after a good read.** `markUnreachable` leaves old rows; the link must block (`lost`). Test in Task 1 and Task 2.
3. **Two live Runs on one key, one quiet, one working.** `reserve` refuses, the 409 names the working one, the chip is disabled with the same phrase. Tests
   in Task 2 and Task 3.
4. **Review over a quiet Run.** A review on a key whose only live Run is quiet is still refused (`already has a session`). Test in Task 2.
5. **Per-key scoping.** A working Run on PAY-2 must not block a Run on PAY-1, whose only live Run is quiet. Test in Task 2. (The cap cannot refuse while any
   confirmed link is live — `evictOldestConfirmed` ends one — so `busy`'s last branch is a defensive fallback, not a tested path.)

---

### Task 1: The shared predicates

**Files:**
- Modify: `shared/jira-sessions.ts` (beside `sessionState`)
- Test: `test/jira/jira-sessions-state.test.ts`

**Interfaces:**
- Produces: `type RunBlockPhrase = 'not seen by the dashboard' | 'waiting on you' | 'still working' | 'not quiet yet'`;
  `runBlockPhrase(link: JiraLink, row: DashboardRow | null, reachable: boolean): RunBlockPhrase | null`;
  `runYields(link: JiraLink, row: DashboardRow | null, reachable: boolean): boolean`.

Rules (spec, Design → One predicate / Refusal text): `runBlockPhrase` is `null` exactly when `quietSince !== null`, `row !== null` and
`sessionState(link, row, reachable) === 'quiet'`. Otherwise, first match wins: `!reachable` or `row === null` → `not seen by the dashboard`; state `plan`,
`permission`, `reply` or `answer` → `waiting on you`; `working` → `still working`; anything else → `not quiet yet`. `runYields` is true only for a LIVE `run`
link (`how === 'run'`, `endedAt === null`) whose phrase is `null`.

- [ ] **Step 1: Write the failing table test** — one `it.each` over these rows (link fields not named are a live `run` link with a session id):

  | quietSince | row | reachable | phrase | yields |
  | --- | --- | --- | --- | --- |
  | set | `{status:'idle'}` | true | `null` | true |
  | set | `null` | true | `not seen by the dashboard` | false |
  | set | `{status:'idle'}` | false | `not seen by the dashboard` | false |
  | set | `{status:'question', remoteReply:true}` | true | `waiting on you` | false |
  | set | `{status:'idle', permissionWait:true}` | true | `waiting on you` | false |
  | set | `{status:'idle', remotePlan:true}` | true | `waiting on you` | false |
  | set | `{status:'question'}` | true | `waiting on you` | false |
  | set | `{status:'working'}` | true | `still working` | false |
  | null | `{status:'idle'}` | true | `not quiet yet` | false |
  | null | `{status:'incomplete'}` | true | `not quiet yet` | false |

  Plus: `runYields` is false for an ended link and for a `branch` link with the first row's inputs (phrase may be `null`; yields is not).
- [ ] **Step 2: Run** `pnpm exec jest test/jira/jira-sessions-state.test.ts` — expect FAIL (`runBlockPhrase` is not exported).
- [ ] **Step 3: Implement** both functions with a header comment carrying the spec's reasoning (why the row is required: persisted `quietSince` vs memory-only
  rows, a full 50-row list).
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(jira): runYields and runBlockPhrase decide whether a live Run yields`.

### Task 2: Server gate and refusal text

**Files:**
- Modify: `server/src/jira/live.service.ts` (`reserve`, `snapshot`, a new `runBlock`), `server/src/agents/jira-dispatch.service.ts` (step 4's `reserve`
  call, `busy`, the header's step 4 text)
- Modify (docs): `.claude/rules/jira.md` (the link-store bullet's one-run gate sentences), `docs/subsystems/invariants.md` (the matching entry),
  `docs/subsystems/jira.md` (the one-run-per-key gate and its 409 table)
- Test: `test/jira/jira-live.test.ts`, `test/jira/agents-dispatch-jira.test.ts`

**Interfaces:**
- Consumes: `runYields`, `runBlockPhrase` (Task 1).
- Produces: `reserve(key: string, repo: string, kind: 'run' | 'reply' = 'run', yieldToQuiet = false): boolean` — with `yieldToQuiet` true and kind `run`,
  a live `run` link on the key no longer refuses when `runYields(link, rowFor(id) ?? null, reachable())` holds for every live `run` link on it; a `run`
  reservation on the key still refuses; default `false` is today's strict rule. `runBlock(key: string): RunBlockPhrase | null` — the phrase of the NEWEST
  (by `startedAt`) live `run` link on the key that does not yield, else `null`. `snapshot()` reports, per key, the newest live `run` link by `startedAt` (a
  `starting` entry still wins).

The dispatch passes `yieldToQuiet = req.action !== 'review'` for kind `run`. `busy(key, strict)`: `get(key)` null → `too many…`; a starting entry → `<KEY> is
starting`; strict (review) → `<KEY> already has a session`; else `runBlock(key)` non-null → `<KEY> has a Run <phrase>`; else → `too many Jira sessions are
starting — try again in a moment` (defensive: with a confirmed link live the cap evicts instead of refusing, so this branch is not reachable today).

- [ ] **Step 1: Write failing `jira-live.test.ts` cases** (new `describe('the quiet gate')`; build links through the existing confirm + `markQuiet` +
  `setRows` helpers the file already uses):
  - quiet link (`quietSince` set, row `idle`) → `reserve(key, repo, 'run', true)` is `true`; `reserve(key, repo, 'run')` (strict) is `false`.
  - same link, `setRows([])` never called (fresh service after loading a store whose link has `quietSince`) → `reserve(…, true)` `false`, `runBlock` is
    `not seen by the dashboard`.
  - quiet link, then `markUnreachable` → `false`, `not seen by the dashboard`.
  - row `working` → `false`, `still working`; row `question` + `remoteReply` → `waiting on you`; `quietSince` null with row `idle` → `not quiet yet`.
  - two live Runs on one key: A quiet (older), B working (newer) → `false`, `runBlock` `still working`; A working (older), B quiet (newer) → `still working`;
    A working (older), B `question` + `remoteReply` (newer) → `waiting on you`; the swap (A question older, B working newer) → `still working`.
  - per key: a working Run on PAY-2 beside a quiet Run on PAY-1 → `reserve('PAY-1', …, true)` `true`, `runBlock('PAY-1')` `null`, `runBlock('PAY-2')` `still
    working`.
  - a `run` reservation on the key (`reserve` then no confirm) → a second `reserve(…, true)` is `false`.
  - `snapshot()` newest-wins: write a links file (`BM_JIRA_LINKS_FILE`) holding two live `run` links on PAY-1 with distinct `startedAt`, the NEWER one first
    in the array, load a fresh service → `snapshot()['PAY-1'].sessionId` is the newer one's (today's last-in-store code returns the older one).
- [ ] **Step 2: Write failing `agents-dispatch-jira.test.ts` cases** next to the existing 409 tests (~line 318–330):
  - a confirmed, quiet Run on PAY-1 (row `idle`, `quietSince` set) → a second execute dispatch on PAY-1 is 200 and spawns.
  - a confirmed Run with row `working` → 409 `{ error: 'PAY-1 has a Run still working' }`.
  - change the existing "409 `<KEY>` already has a session for a confirmed key" case: with no row and no `quietSince` it is now `PAY-1 has a Run not seen by
    the dashboard`.
  - a review dispatch over a quiet Run → 409 `PAY-2 already has a session` (the existing review case near line 953 keeps passing unchanged).
  - The concurrent case near line 664: its regex becomes `/^PAY-1 (is starting|has a Run not seen by the dashboard)$/` — an execute can no longer answer
    `already has a session`, and a refusal after the first confirms (no rows) reads `not seen by the dashboard`; still exactly one 200 and one spawn.
- [ ] **Step 3: Run** `pnpm exec jest test/jira/jira-live.test.ts test/jira/agents-dispatch-jira.test.ts` — expect the new cases to FAIL.
- [ ] **Step 4: Implement** `reserve`'s argument, `runBlock`, `snapshot`'s newest-wins, the dispatch's argument and `busy`. Update the comments that state
  the one-run gate (`reserve`'s doc, the dispatch header's step 4, `busy`'s doc) and the three docs listed above, keeping each `Why:` link.
- [ ] **Step 5: Run** the Step 3 command plus `test/jira/agents-jira-live.test.ts test/jira/agents-jira-stop.test.ts test/jira/jira-routes.test.ts` — expect
  PASS. Then `grep -l "reserve\|already has a session" test/ -r` and run any further hit.
- [ ] **Step 6: Commit** `feat(jira): a quiet Run no longer blocks the next Run on its key`.

### Task 3: Client chip, titles and band line

**Files:**
- Modify: `client/src/lib/jira.ts` (`runChipState` and its header; a new `runBlockTitle`), `client/src/components/jira/JiraRunMenu.tsx` (the chip's own
  `title` at ~line 98–103, `blockTitle` at ~line 158 and the header's `live` bullet at ~line 29),
  `client/src/components/jira/JiraDetail.tsx` (the `.jira-detail-next` span and the header comment)
- Modify (docs): `.claude/rules/board.md` (the `Run ▾` bullet's "a live key a disabled one"; the CodeRabbit bullet says `reviewGate` stays strict),
  `.claude/DESIGN.md` (the Run chip entry's `a session is running on <KEY>`)
- Test: `test/jira/jira-lib.test.ts`, `test/jira/jira-run-menu.test.tsx`, `test/jira/jira-detail.test.tsx`

**Interfaces:**
- Consumes: `runYields`, `runBlockPhrase` (Task 1).
- Produces: `runChipState(issue, status, sessions = null): 'no-repo' | 'live' | 'ready'` (signature unchanged);
  `runBlockTitle(issue: JiraIssue, status: Pick<JiraStatusPayload, 'repos' | 'live'>, sessions: JiraSessionsPayload | null): string | null` — the `live`
  title, `null` when the state is not `live`.

`runChipState` is `live` when any of (spec, Design → Client): `status.live[key]` is `starting`; `status.live[key]` is confirmed and its `sessionId` is not a
live `run` link in `sessions`; some live `run` link on the key in `sessions` fails `runYields(link, link.row, sessions.reachable)`; or `sessions` is null and
`status.live[key]` exists. `runBlockTitle`, in that order: starting → `a Run on <KEY> is starting`; unseen confirmed or no payload → `a Run on <KEY> is not
quiet yet`; else `a Run on <KEY> is <runBlockPhrase of the newest non-yielding live run link>`. The chip's own `title` (today a second copy of `a session is
running on <KEY>`) and `blockTitle` both use `runBlockTitle` for `live` (so a parent's rows follow); `blockTitle` gains the `status` and `sessions` it needs. The band line follows `runChipState`: `live` → `Next Run can start once this one is quiet.`; `ready` with a live `run` link on the key → `Quiet
— a new Run can start now.`; otherwise no span.

- [ ] **Step 1: Write failing `jira-lib.test.ts` cases** for `runChipState` / `runBlockTitle` on PAY-1 (mapped project):
  - one live quiet run link (`quietSince` set, `row: {status:'idle'}`, `reachable: true`) + `status.live` naming the same session → `ready`, title `null`.
  - same, `row: {status:'working'}` → `live`, `a Run on PAY-1 is still working`.
  - same, `reachable: false` → `live`, `a Run on PAY-1 is not seen by the dashboard`.
  - quiet link A in the payload + `status.live` naming a different session B (`starting: false`) → `live`, `a Run on PAY-1 is not quiet yet`.
  - `status.live` starting entry → `live`, `a Run on PAY-1 is starting`.
  - `sessions` null + confirmed `status.live` entry → `live`, `a Run on PAY-1 is not quiet yet`.
  - two live run links on PAY-1: A quiet (older), B working (newer) → `live`, `a Run on PAY-1 is still working`; A working (older), B `question` (newer) →
    `a Run on PAY-1 is waiting on you`.
  - only a live `branch` link (working) → `ready`; unmapped project → `no-repo` (unchanged cases keep passing).
- [ ] **Step 2: Update `jira-run-menu.test.tsx:227`** (parent row title) to `a Run on P-1 is not seen by the dashboard`, and **`jira-detail.test.tsx`**:
  lines 644 and 645 → `a Run on PAY-131 is not quiet yet`, line 887 → `a Run on PAY-131 is not seen by the dashboard` (recheck each against its fixture
  and say so in the commit body if one differs); line 935's band text becomes `Next Run can start once this one is quiet.` for a non-quiet fixture; add one
  case where the only live Run is quiet → `Run ▾` enabled and the band reads `Quiet — a new Run can start now.`; and one with only a live `branch` link →
  no `.jira-detail-next`. Line 1547 and `test/jira/jira-setup.test.tsx:1006` are the worktree `Remove` button (`JiraWorktreeRow.tsx:79`), a different
  control out of scope: both keep `a session is running on <KEY>`.
- [ ] **Step 3: Run** `pnpm exec jest test/jira/jira-lib.test.ts test/jira/jira-run-menu.test.tsx test/jira/jira-detail.test.tsx test/jira/jira-setup.test.tsx`
  — expect the new cases to FAIL.
- [ ] **Step 4: Implement** `runChipState`, `runBlockTitle`, `blockTitle`, the band line; rewrite the `runChipState` header (ruling 95's union, now
  narrowed) and the `JiraDetail.tsx` header sentence; update `board.md` and `DESIGN.md`.
- [ ] **Step 5: Run** the Step 3 command, then `grep -l "runChipState\|blockTitle" test/ -r` and run every hit, then `pnpm run typecheck` — expect PASS.
- [ ] **Step 6: Commit** `feat(jira): Run ▾ opens once every live Run on the ticket is quiet`.

### Task 4: Verify live

- [ ] **Step 1:** With the stack on this branch (`pnpm run dev` + `pnpm run dev:web` on the worktree, pid-owned), read `GET /api/jira/sessions` during a
  finished, held Run and confirm its row is `status: 'idle'` with `remotePlan`, `permissionWait`, `remoteReply` false. If it reads `question`, stop and return
  to the user (spec, Intent).
- [ ] **Step 2:** Run `/ui-verify` on the Detail band: a working Run (chip disabled, title with phrase, `Next Run can start once this one is quiet.`) and a
  quiet one (chip enabled, `Quiet — a new Run can start now.`). Fix defects on the branch.
