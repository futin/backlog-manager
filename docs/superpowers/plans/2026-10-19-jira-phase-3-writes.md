# Jira integration — phase 3, the writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board's first writes to Jira itself: `Assign to me` and `Move to…` in the issue modal, behind two guarded routes, each followed by a fresh
re-read of the issue that is spliced into every board cache holding it — so the card moves on the next client poll, not the next sweep.

**Architecture:** Server: `JiraClient` gains the two write calls; `JiraPollerService` gains `assignToMe` and `transitionIssue` (they need its gate, its
failure bookkeeping and its caches, all private there) plus the splice and the sweep's newest-`updated`-wins rule; `jira-write.controller.ts` gains the two
routes behind the `SameOriginPostGuard` it already applies. Client: the modal draws a controls row under its facts, posts through the two routes, re-reads
its own detail, reloads the shell's status, and nudges the board's list through a counter `JiraView` owns.

**Tech Stack:** NestJS 11 on Node 22, React 18 + Vite, TypeScript strict, jest (node and jsdom) + supertest + Testing Library, pnpm. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-10-15-jira-integration-design.md](../specs/2026-10-15-jira-integration-design.md) — §5 the two issue-write routes,
§6.1 "every write reloads both the board and `GET /api/jira`", §6.3 the modal's controls, §8 Assign / Transition / the splice / the error table, §10, §11
(`jira-poller`'s "the splice after a write and newest-`updated`-wins", `jira-routes`' "transition not offered → 400"), §12 phase 3, §13 the write rule and
the item-write widening. Phase 2's plan ([2026-10-16-jira-phase-2-section.md](2026-10-16-jira-phase-2-section.md)) is what the client already holds.

**Plan conventions (they override the writing-plans template where the two differ):**
- Every task states BEHAVIOUR and EXACT TEST CASES — inputs, expected values, edge cases — never literal code. The implementer writes the code and the test
  bodies, and is expected to disagree with a case here when the spec or the code says otherwise (and to say so in the commit). Reason: handed code gets
  transcribed verbatim, bugs included (the user's CLAUDE.md, "Learnings").
- Signatures in **Interfaces** are the one place a name is fixed; a later task that consumes a name spells it exactly as the producing task does.
- Size budgets are soft targets, never a reason to drop a rule or a comment. Comments explain WHY at the density `server/src/jira/poller.service.ts` has;
  new prose wraps at 160.
- Branch `feat/jira-phase-3-writes`, cut from `main` in a worktree (never switch branches in the shared checkout). Commit after every task with the message
  given; nothing is pushed by this plan. PR title (`ci / pr-title`): `feat(jira): assign and transition from the issue modal`.
- Run only the suites a task touches (`pnpm run test:jest -- test/<name>.test.ts[x]`) and `pnpm run typecheck` before each commit; CI runs the whole suite.

## Global Constraints

- Jira calls, verbatim from §8: assign is `PUT issue/{key}/assignee` with body `{ accountId: <me.accountId> }`; transition is a fresh
  `GET issue/{key}/transitions`, then `POST issue/{key}/transitions` with body `{ transition: { id } }`. Both on the gateway base every other call uses.
- Never send an assign while the identity is unknown: Jira reads `{ accountId: null }` as UNASSIGN (§8).
- Error mapping is `jiraHttpError` (`server/src/jira/errors.util.ts`) and nothing new: 401 → 503, 403 → 502 `Jira refused: <m>`, 429 → 503 with `retryAt`,
  0 → 502, 400 → 409 `Jira refused: <m>`, 404 → 404 `issue not found`, other → 502. The one new status is the route's own 400 `transition not offered`.
- Inside a 429 window an issue write is refused up front with the stored instant and sends nothing (§8; `windowRefusal`'s P1 rule).
- Every `:key` passes `isJiraKey`. Write routes: `application/json` + same origin (`SameOriginPostGuard`), 503 `Jira is not configured` while unconfigured.
  Config writes stay open under `unauthorized`; ISSUE writes do not (§8).
- The browser never talks to Jira; every write goes through `/api/jira/issue/*`.

## Rulings this plan makes where the spec is silent

- **R1 — Both routes answer `200 { ok: true, reread: boolean }`** (`JiraIssueWriteResult` in `shared/types.ts`). `reread` says whether the post-write
  `GET issue/{key}` succeeded. A failed re-read after a LANDED write is still a 200: the write happened and cannot be un-happened, and an error would invite
  a retry of a write that already stood. The re-read's own failure still goes through `routeFailed`, so a 401 or a 429 there moves the site state as any read
  does. The next sweep corrects the cache.
- **R2 — Identity refusal, before any call.** `this.boot.me === null` → 503. While `access` is `unauthorized` the body is `jiraHttpError`'s 401 body
  (`Jira rejected the credentials`, `access: unauthorized`); otherwise `{ error: 'no identity' }`. Transition does not need the identity: it is refused
  ONLY while `access === 'unauthorized'` (same 401 body), never for `me === null` alone (§8: "every ISSUE write a 503 until the next successful `myself`") — `boot.reset()` leaves `cloudId` set, so the existing
  `gate()` alone would let it through.
- **R3 — `transitionId` is a non-empty string of at most 64 characters**, else 400 `transitionId must be a non-empty string`. Its shape is not checked
  further: the offered-list check is the real validation, and guessing Jira's id format would refuse a valid one some day.
- **R4 — The splice maps with the sweep's context** (`now: Date.now()`, the Done window ON) and replaces the issue IN PLACE (same index) in every cache that
  already holds the key. It never adds a key to a board: membership is the board's queries' and roots' business, and a splice that added would let a write
  put an issue on a board whose JQL excludes it. A re-read that maps to `null` (unreadable, or windowed out) leaves every cache untouched.
- **R5 — Newest `updated` wins, compared with `Date.parse`.** At the end of `sweepBoard`, for each issue the sweep returned whose key the CURRENT cache holds
  with a strictly newer parseable `updated`, the cached copy is kept. Equal or unparseable on either side → the sweep's copy. The rule only replaces; a key
  the sweep did not return is gone as before (a lagging index can make a just-assigned issue vanish from an `assignee = currentUser()` board for one sweep —
  accepted, and named in the jira.md doc so nobody files it as a bug).
- **R6 — No server-side per-key queue.** The modal disables both controls while one write is out; two browsers racing are Jira's last-write-wins, and R5
  keeps the caches on the newest answer. The tracker's per-item serialisation exists because those writes are read-modify-write on a body; these are not.
- **R7 — The board is nudged, not reached into.** `useJiraBoard` takes a third argument, `nudge: number`; a change re-requests at once, whatever the
  interval (`off` included — §6.1). `JiraView` owns the counter, bumps it from the modal's `onWrote`, and passes it to `JiraBoardView`. The modal also calls
  `useJiraContext().reload()`.
- **R8 — The modal re-reads its own detail after a write**, and keeps showing the previous detail of the SAME key while that re-read is out (no `loading…`
  flash, no controls blinking to disabled-for-no-detail and back).

## Review Focus

1. **A second click while a write is out** — Assign double-clicked, or a Move picked while Assign is in flight: exactly one POST leaves. (Task 4 test.)
2. **The modal swapped to another issue (a Children row) while a write is out** — the late answer neither shows its error on the new issue nor re-reads the
   old key's detail into it. (Task 4 test.)
3. **A sweep that lands after the splice carrying the pre-write copy** (in flight, or a lagging index) — the cache keeps the spliced issue. (Task 2 test.)
4. **A 401 on the write itself** — 503, `GET /api/jira` then says `unauthorized`, and a following assign or transition is refused with no Jira call. (Task 3.)
5. **A write that lands but whose re-read fails** — 200 `reread: false`, the modal shows no error, the cache is untouched. (Tasks 2 and 3.)

---

### Task 1: The two write calls, and a fake Jira that answers them

**Files:**
- Modify: `server/src/jira/jira.client.ts` (beside `transitions`; its doc comment "read only in phase 1" is now false — fix it)
- Modify: `test/helpers/jira.ts` (`FakeJira.gateway`)
- Test: `test/jira-client.test.ts`

**Interfaces:**
- Produces: `JiraClient.assign(auth: JiraAuth, key: string, accountId: string): Promise<JiraResponse<null>>` and
  `JiraClient.transition(auth: JiraAuth, key: string, transitionId: string): Promise<JiraResponse<null>>`.
- Produces (fake): `PUT /issue/{key}/assignee` and `POST /issue/{key}/transitions` on `FakeJira`; every successful fake write sets the issue's
  `fields.updated` to `new Date().toISOString()`, which Task 2's newest-wins cases rely on.

- [ ] **Step 1: Failing client tests** (style of the file's existing request-shape cases):
  - `assign` sends `PUT` to `https://api.atlassian.com/ex/jira/c1/rest/api/3/issue/PAY-1/assignee`, `content-type: application/json`, body
    `{"accountId":"acc-1"}`; a 204 is `{ status: 204, data: null, message: null, retryAfter: null }`.
  - `transition` sends `POST` to `…/issue/PAY-1/transitions` with body `{"transition":{"id":"31"}}`; 204 as above.
  - A 400 `{ errorMessages: ['User cannot be assigned'] }` on either reads `message: 'User cannot be assigned'`.
  - A key with a character `encodeURIComponent` changes is encoded in the path (the existing `issue` case's pattern).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-client.test.ts` — the four new cases FAIL (methods undefined).
- [ ] **Step 3: Implement** both methods through the private `request`. Then the fake: `PUT /issue/{key}/assignee` → 404 `Issue does not exist` for an
  unseeded key; for `accountId === fake.me.accountId` sets `fields.assignee` to `{ accountId, displayName }` from `me`, any other id → 400
  `errorMessages: ['User \'<id>\' cannot be assigned issues.']`; 204. `POST /issue/{key}/transitions` → 404 for an unseeded key; an id not in
  `fake.transitions.get(key)` → 400 `errorMessages: ['Transition id \'<id>\' is not valid for this issue.']`; else sets `fields.status` to
  `{ name: t.to.name, statusCategory: t.to.statusCategory }` (and `resolutiondate` to now when the category is `done`); 204. Both honour `failNext`,
  `failWith`, `unauthorized` and `rateLimit` exactly as reads do — they already run before routing, so this is free; check it.
- [ ] **Step 4: Run** the suite — PASS. `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(jira): client assign and transition calls`

### Task 2: The poller — writes, the splice, newest-`updated`-wins

**Files:**
- Modify: `server/src/jira/poller.service.ts`, `shared/types.ts`
- Test: `test/jira-poller.test.ts`

**Interfaces:**
- Consumes: Task 1's two client methods.
- Produces (shared): `interface JiraIssueWriteResult { ok: true; reread: boolean }`.
- Produces (poller): `JiraIssueWriteOutcome = JiraResult<JiraIssueWriteResult> | { ok: false; refusal: 'no identity' | 'transition not offered' }`;
  `assignToMe(key: string): Promise<JiraIssueWriteOutcome>`; `transitionIssue(key: string, transitionId: string): Promise<JiraIssueWriteOutcome>`.
  Under R2's `unauthorized` case they return the plain `JiraResult` failure carrying a synthesised 401 (so the controller's `jiraHttpError` path answers it),
  not a `refusal`.
- Private: `splice(auth: JiraAuth, key: string): Promise<boolean>` — the re-read and R4; returns `reread`.

- [ ] **Step 1: Failing tests**, against the service over `FakeJira` as the file's existing cases build it (one board whose query returns `PAY-1`, swept):
  - `assignToMe('PAY-1')` → `{ ok: true, value: { ok: true, reread: true } }`; the fake recorded one PUT with `{ accountId: 'acc-1' }`; `boardIssues(id)`
    now shows `PAY-1`'s assignee `{ accountId: 'acc-1', name: 'Ada Lovelace' }` at the same index it had.
  - Two boards both holding `PAY-1` and a third that does not: after `assignToMe`, both holders show the new assignee and the third still lacks `PAY-1` (R4).
  - `transitionIssue('PAY-1', '31')` with `transitions` seeded `[{ id: '31', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }]`
    → reread true; the cached issue reads status `In Progress`, category `indeterminate`; the calls are GET transitions THEN POST transitions, in that order.
  - `transitionIssue('PAY-1', '99')` (not offered) → `{ ok: false, refusal: 'transition not offered' }` and NO POST was sent.
  - Identity unknown (the gateway `myself` answering 403 at boot, as the file's `myself 403: forbidden` case does — NOT a 401, which makes `access`
    `unauthorized` and R2's other branch) → `assignToMe` returns `refusal: 'no identity'` and no PUT; `transitionIssue('PAY-1', '31')` in the same state
    → `{ ok: true, value: { ok: true, reread: true } }` (transition needs no identity).
  - After a 401 on some later read (`fake.unauthorized = true`, one route read): `assignToMe` and `transitionIssue` both fail with response status 401 and
    the fake records NO PUT and NO transitions call from them (R2).
  - Inside a 429 window: both return a failure with status 429 and `retryAt` equal to the stored instant; no call sent.
  - Write lands, re-read fails (`failNext` answering 500 only to the `GET /issue/PAY-1` that follows the PUT) → `{ ok: true, value: { reread: false } }`
    and the cache is byte-for-byte what it was (Review Focus 5).
  - **Newest wins (Review Focus 3):** sweep; `assignToMe` (cache now has the newer `updated`); then put the fake's `PAY-1` back to its pre-write copy (the
    old assignee and the old `updated` — a lagging index); force a sweep (`boardSaved(id)`) → the cache still shows the new assignee. Then set the fake's copy
    to a strictly NEWER `updated` with a different summary and sweep again → the sweep's copy wins.
  - Equal `updated` on both sides → the sweep's copy wins (R5).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-poller.test.ts` — the new cases FAIL.
- [ ] **Step 3: Implement.** Order inside each write: `gate()` (unconfigured / window / unsupported / no `cloudId`) → R2's `unauthorized` and `me` checks →
  for transition, `windowRefusal()` then the fresh `client.transitions` read and the offered check → `windowRefusal()` again right before the write (the
  `issueDetail` pattern: a window opened while the read was out) → the write. A non-2xx write returns `routeFailed(res)` and splices nothing; a 2xx proceeds
  to `splice`. The splice is a
  `client.issue` read with `sweepFields()`, mapped with `{ site, sprintField, now: Date.now() }`. R5 lives in `sweepBoard`, just before `caches.set`, reading
  the cache as it is AT THAT MOMENT (a splice that landed while the sweep was out must count).
- [ ] **Step 4: Run** the suite — PASS. `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(jira): assign and transition in the poller, spliced into every board cache`

### Task 3: The two routes

**Files:**
- Modify: `server/src/jira/jira-write.controller.ts` (header comment: five routes, two of them Jira writes)
- Create: `test/jira-issue-writes.test.ts` (built like `test/jira-write-routes.test.ts`: `AppModule`, a `JiraClient` over `FakeJira`, `listenLoopback`)

**Interfaces:**
- Consumes: `assignToMe`, `transitionIssue`, `JiraIssueWriteResult`.
- Produces: `POST /api/jira/issue/assign` `{ key }` and `POST /api/jira/issue/transition` `{ key, transitionId }`, both `@HttpCode(200)`,
  `@UseGuards(SameOriginPostGuard)`, answering `JiraIssueWriteResult`.

- [ ] **Step 1: Failing route tests:**
  - Guard, both routes: another origin → 403; no content type → 403 (`server/src/agents/origin.guard.ts`; copy `jira-write-routes.test.ts`'s case).
  - Unconfigured → 503 `Jira is not configured`, no Jira call.
  - `{ key: 'pay-1' }`, `{}`, `{ key: 7 }` → 400 `invalid issue key`, no Jira call. Transition with `transitionId` absent, `''`, a number, or 65 characters
    → 400 `transitionId must be a non-empty string`.
  - Assign happy path → 200 `{ ok: true, reread: true }`; then `GET /api/jira/boards/:id/issues` shows the assignee WITHOUT any sweep in between.
  - Transition happy path → 200, and the board list shows the new status; transition `'99'` → 400 `{ error: 'transition not offered' }`.
  - Jira answers the PUT 400 `User cannot be assigned` → 409 `Jira refused: User cannot be assigned`; 403 → 502 `Jira refused: …`; 404 → 404
    `issue not found`; transport failure → 502 `Jira unreachable: …`.
  - 429 on the PUT with `retry-after: 30` → 503 with `retryAt`; a second assign straight after → 503 with the SAME `retryAt` and the fake records no second
    PUT.
  - **Review Focus 4:** set `fake.unauthorized = true` (persistent, not a one-shot `failNext` — `routeFailed` calls `wake()`, and a boot retry whose
    `myself` recovered would restore `me` and let the next write through), then assign: the PUT answers 401 → 503 `Jira rejected the credentials`; a
    recorded `myself` retry after it is expected; `GET /api/jira` reads `access: 'unauthorized'`, `me: null`; a following assign
    and a following transition are both 503 and the fake records no further write or transitions call. A board save (`POST /api/jira/boards`) in the same
    state is still 200 (config writes stay open).
  - Identity not yet known (boot's gateway `myself` answering 403, not 401) → assign 503 `{ error: 'no identity' }`, no PUT.
  - **Review Focus 5:** write lands, re-read 500 → 200 `{ ok: true, reread: false }`.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira-issue-writes.test.ts` — FAIL (404 on the routes).
- [ ] **Step 3: Implement** the two handlers: validate body (`isJiraKey`; R3) → `requireConfigured()` → the poller call → `refusal` mapped to 503
  `no identity` or 400 `transition not offered`, any other failure through `jiraHttpError(response, { retryAt, access })` exactly as `JiraController.unwrap`
  does (share one function between both controllers rather than copying `unwrap` — exported from `jira.controller.ts` or a small new
  `server/src/jira/unwrap.util.ts`; `errors.util.ts` stays free of poller types).
- [ ] **Step 4: Run** the new suite plus `test/jira-routes.test.ts` and `test/jira-write-routes.test.ts` — PASS. `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(jira): POST /api/jira/issue/assign and /issue/transition`

### Task 4: The modal's controls, and the board nudge

**Files:**
- Modify: `client/src/hooks/useJiraBoard.ts` (third parameter, R7), `client/src/components/jira/JiraView.tsx`, `client/src/components/jira/JiraBoardView.tsx`
  (accept and forward `nudge`), `client/src/components/ui/Select.tsx` (an optional `title?: string` prop on the `<select>` — the primitive has none today),
  `client/src/components/jira/JiraIssueModal.tsx` (header: drop "Phase 2 has no controls", describe the row, cite §8.9.2),
  `client/src/styles.css` (the controls row and the inline error, in the Jira block)
- Test: `test/use-jira.test.tsx`, `test/jira-modal.test.tsx`

**Interfaces:**
- Consumes: the two routes; `JiraIssueWriteResult`; `useJiraContext()`'s `data.me` and `reload`.
- Produces: `useJiraBoard(id: string | null, interval: SyncInterval | null, nudge: number): JiraBoardState`; `JiraBoardView` prop `nudge: number`;
  `JiraIssueModal` prop `onWrote: () => void`.

Behaviour (DESIGN.md §8.9.2, written in Task 5): a controls row under the facts list, inside the facts column. **`Assign to me`** — a 28 px `Chip`; disabled
with title `no identity` while `data.me` is null, `already assigned to you` while `src.assignee?.accountId === data.me.accountId`. **`Move to…`** — the `Select`
primitive; its first option is value `''` labelled `Move to…`, then one option per `detail.transitions` entry labelled `name`, or `name → to.name` when the
two differ; a pick posts at once and the select returns to `''`; disabled while the detail has not landed (or failed — title `transitions unavailable`) or
offers none. While a write is out BOTH controls are disabled. A failure draws its server sentence (`{ error }`, else `HTTP <status>`, else the network's
message — `failureOf`'s rule) in a `role="alert"` line under the row; the modal stays open; the line clears on the next write and on a key change. A
success calls `reload()`, `onWrote()`, and re-reads the detail (R8).

- [ ] **Step 1: Failing tests.** `use-jira.test.tsx`: with interval `off`, changing `nudge` 0 → 1 fetches the board list once more; an unchanged `nudge`
  across a re-render fetches nothing. `jira-modal.test.tsx` (its existing fetch stub, `CARD` `PAY-131`, and `status()` whose `me` is `ADA` `acc-ada` —
  the default `CARD.assignee` is ALSO `ADA`, so every case that clicks Assign mounts `{ ...CARD, assignee: null }` or another person):
  - With an unassigned card, Assign posts `/api/jira/issue/assign`, method POST, `content-type: application/json`, body `{"key":"PAY-131"}`; on 200 the
    context's `reload` and `onWrote` were each called once and `/api/jira/issue/PAY-131` was fetched a second time.
  - `status({ me: null })` → Assign disabled, title `no identity`; the default `CARD` (assignee `acc-ada` = `me`) → disabled, title `already assigned to you`.
  - Move lists `Move to…`, `Start → In Progress`, `Done` for transitions `[{id:'31',name:'Start',to:{name:'In Progress',category:'indeterminate'}}, {id:'41',name:'Done',to:{name:'Done',category:'done'}}]`;
    picking `Done` posts `/api/jira/issue/transition` with `{"key":"PAY-131","transitionId":"41"}` and the select reads `Move to…` afterwards.
  - Move disabled while the detail read is pending; disabled with title `transitions unavailable` after a failed detail read; Assign still enabled then.
  - A 409 `{ error: 'Jira refused: User cannot be assigned' }` → that sentence in the alert, the modal still open, both controls enabled again, `onWrote`
    NOT called.
  - **Review Focus 1:** with the assign POST held unresolved, a second Assign click and a Move pick send nothing (exactly one POST observed).
  - **Review Focus 2:** with the assign POST held, swap the modal to a child (the existing Children-row case); resolve the POST with a 409 → no alert on the
    child, and no re-read of `PAY-131` is fetched after the swap.
  - R8: after a successful write the description stays on screen while the re-read is held unresolved (no `loading…`).
- [ ] **Step 2: Run** `pnpm run test:jest -- test/use-jira.test.tsx test/jira-modal.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** The write is one function with a synchronous in-flight guard (a ref, not state — two clicks in one tick must not both pass; the
  `RunControls` reason in DESIGN.md §8.4.1) and an issue-key stamp checked on settle (Review Focus 2). A `rev` counter in `useFetched`'s deps only TRIGGERS
  the re-read: `useFetched` answers `PENDING` on any dep change (`client/src/hooks/useFetched.ts:73`), so the modal keeps the last landed detail for the
  same key in its own state and draws that while the re-read is pending (R8).
- [ ] **Step 4: Run** both suites plus `test/jira-board.test.tsx` and `test/dialog-escape.test.tsx` — PASS. `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(jira): Assign to me and Move to… in the issue modal`

### Task 5: The rule and the docs

**Files:**
- Modify: `CLAUDE.md`, `.claude/rules/jira.md`, `docs/subsystems/invariants.md`, `docs/subsystems/jira.md`, `docs/subsystems/api.md` (its jira module
  paragraph, which counts only the read routes), `.claude/DESIGN.md` §8.9.2
- Test: `test/claude-rules.test.ts` (runs as is)

- [ ] **Step 1: The new rule, three homes** (spec §13, headline verbatim): **The board's Jira writes are assign and transition, nothing else; each re-reads
  the issue and splices it into every board cache holding the key.** CLAUDE.md gets the headline with a `Why:` link; `.claude/rules/jira.md` gets the
  mechanism bullet (the two routes, R2's refusals, the fresh offered-list check, the splice's in-place-never-add rule R4, newest-`updated`-wins R5, R1's
  `reread`); `invariants.md` gets the section — the reasoning: why a re-read and not a local patch (Jira's workflow may run post-functions that change more than
  the field written), why never add to a board, why `{ accountId: null }` is never sent, why no per-key queue (R6).
- [ ] **Step 2: The widenings.** CLAUDE.md's "A TRACKER project's items are the one thing this server writes" gains "and a Jira issue's assignee and
  status, through `/api/jira/issue/assign` and `/issue/transition`" (an unlinked bullet: stay under `UNLINKED_WORD_CAP`); `api.md`'s jira paragraph
  (`docs/subsystems/api.md:136–137`) drops "and no write route yet" and names the three config writes and the two issue writes beside its read routes; the layout line's
  "`jira.json`'s three guarded write routes" names the two issue writes beside them.
- [ ] **Step 3: Subsystem doc and design.** `jira.md`: its opening "Nothing yet writes to Jira itself", the routes table, the "Not there yet, by phase" line
  (phase 3 removed), the modal line "No controls in phase 2", and R5's accepted lag. DESIGN.md §8.9.2: replace **No controls in phase 2** with the row as
  Task 4 built it (28 px chip, the select, disabled titles, the alert line at 12 px `--red`), noting `Run ▾` and `Stop session` and the `session` fact
  are still phase 5 and absent, not disabled.
- [ ] **Step 4: Run** `pnpm run test:jest -- test/claude-rules.test.ts test/dialog-count-docs.test.ts` — PASS.
- [ ] **Step 5: Commit** `docs(jira): the board's Jira writes rule and phase 3 docs`

## Self-review notes

- Spec coverage: §5 two routes → Task 3; §8 assign/transition/splice/newest-wins/error table → Tasks 1–3; §6.3 controls and inline error → Task 4; §6.1
  reload board + status → Task 4 (R7); §13 rule + item-write widening → Task 5; §11 `jira-poller` and route cases → Tasks 2–3. Out of this phase: `Run ▾`,
  `Stop session`, the `session` fact, the skills routes, `dispatch-jira` (phase 5), `skills/jira` (phase 4).
- Not covered by a test, by choice: two browsers writing the same issue at once (R6 — Jira's ordering, and R5 keeps the cache on the newest copy).
