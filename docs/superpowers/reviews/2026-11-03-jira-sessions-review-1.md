# Plan review 1 — Jira page around agent sessions

Date: 2026-11-03. Reviewer: a fresh Fable session, from paths and the fixed checklist only.
Plan: `docs/superpowers/plans/2026-11-03-jira-sessions.md` (391 lines). Spec: `docs/superpowers/specs/2026-11-03-jira-sessions-design.md` (354 lines).
Also read: `CLAUDE.md`, `.claude/rules/jira.md`, `board.md`, `skills.md`, `tests.md`; the dashboard repo's `server/api.ts` and `shared/types.ts` for the
row shape and query params. Every file:line below was read, not taken from the plan. Line numbers are the plan's unless prefixed `spec`.

## Verdict: REVISE

One Critical: Task 10 deletes `JiraIssueModal.tsx` and names none of the three source guards, the rule bullet and the invariants entry that pin that file
by name, while claiming the dialog-count guard stays green. Fourteen Important findings, most of them interface gaps an implementer would have to invent
(un-suppress, never-link, `get(key)` under several entries per key, the state function's fallback, two disagreeing signatures) and a jira → agents import the
rule file forbids. The spec coverage is otherwise good: every spec section maps to a task, and the §12 cases are nearly all present.

## What was checked

1. **Coverage.** Every spec section (§5, §6, §7.1–7.5, C1–C9, §8, §9, §10, §12) was mapped to a task. Gaps: §12's "ended while the server was down ends at
   the first reconcile" (no case), "several boards: shows on both, once in the List" (only the badge half), and Review Focus 2's "entry missing `how`".
2. **Values.** State names, the Quiet title, C2's two titles, §7.5's labels and the unlink 409 sentence match the spec verbatim. `limit=50&lookback=168`
   matches the dashboard (`claude-agents-dashboard/server/api.ts:99,117-118`). The 120 s boundary is where the spec disagrees with itself (Minor).
3. **Reality.** All 29 Modify paths exist; all 17 Create paths do not. Cited lines verified: `jira-agents.controller.ts:76-86` (jiraStop at 74-86),
   `jira-dispatch.service.ts:196-210` (stop at 196-209), `config.util.ts:27`, `lib/jira.ts:699` (`runChipState` 695-699), `lib/agents.ts:466`,
   `styles.css:443`, `shared/types.ts:890-960` (`JiraLiveSession` 894-901). `GET /api/sessions/:id/row` exists (dashboard `server/api.ts:2005`).
4. **Interfaces.** Three gaps (findings 2, 6, 7, 8) and one disagreement (finding 8).
5. **Order.** Task 3 consumes T1/T2 names; T7 consumes T6's `issueSummary`; T9 consumes T7's test file; T10 consumes T9's lib; T13 consumes T12's filter
   store. Task 14 (manual `claude://` check) sits after Task 13 but informs Task 9's C2 decision (Minor).
6. **Tests.** Reviewed per task; see findings 4, 5, 9, 11, 14, 15 and the Minor list.
7. **Conventions.** The plan states its override of the writing-plans template (line 18-20) and gives no literal code. Sizes are soft. Good.

## Critical

**[C] plan:308-326 (Task 10) — deleting `JiraIssueModal.tsx` breaks three source guards and leaves a rule bullet naming a file that no longer exists;
line 324 says "the board.md dialog-count guard still green" with no edit named.**
Evidence: `test/dialog-escape.test.tsx:35` imports `JiraIssueModal` (a compile failure once deleted); `test/ui-modal.test.tsx:97-102` asserts `ui/Modal`'s
composers are exactly `board/ItemModal.tsx` and `jira/JiraIssueModal.tsx` (a source scan — red when `JiraDetail.tsx` composes it instead);
`test/dialog-count-docs.test.ts:46,67` pins the eight names including `JiraIssueModal` in `.claude/rules/board.md`'s bullet and in `invariants.md`;
`client/src/hooks/useDialogEscape.ts:39-47` carries the same list in its comment (pinned by `dialog-count-docs.test.ts:87`); `.claude/rules/board.md:12,16,19`
names `JiraIssueModal` three times (the eight, `Modal`'s composers, the `Stop session` Confirm). Task 10's Files (310-316) list none of these, and the
"docs" coverage line (390) sends §10 docs to Tasks 5, 11, 13 only.
→ Add to Task 10: Modify `.claude/rules/board.md` (the three mentions → `JiraDetail`), `docs/subsystems/invariants.md`'s Escape entry,
`client/src/hooks/useDialogEscape.ts`'s comment, `test/ui-modal.test.tsx` (composer list), `test/dialog-escape.test.tsx` (import and render),
`test/dialog-count-docs.test.ts` (`EIGHT`); run all three guards plus `test/claude-rules.test.ts` in Step 4. The count stays eight — say so.

## Important

**[I] plan:128-132 (Task 2) — `JiraLiveService.setRows(rows: DashboardRow[])` makes `jira/` import a type from `agents/`.** `DashboardRow` is produced in
`server/src/agents/dashboard-sessions.util.ts` (128) and consumed by `JiraLiveService` in `server/src/jira/live.service.ts` (132). `.claude/rules/jira.md:103`:
"`jira/` imports nothing from `agents/` except `SameOriginPostGuard`"; the plan restates it at line 24. Task 3 (177) moves a type to `shared/types.ts` only
one task later. → Produce `DashboardRow` in `shared/types.ts` in Task 2 (the agents util imports it from there); Task 3 derives `DashboardRowView` from it
or drops the second name.

**[I] plan:207-208 (Task 5) — "keep an HTML anchor with the old slug so `jira.md`'s ... links still land" cannot keep the rule file's link.**
`test/claude-rules.test.ts:365` ("every invariants.md anchor a rule file cites resolves to a heading") slugifies `##`/`###` headings only
(`:154-161`); an `<a id>` does not count. `.claude/rules/jira.md:105` cites the old slug; `docs/subsystems/jira.md:367` does too. → State: the rule file's
anchor moves to the renamed heading; the HTML anchor serves `docs/subsystems/jira.md` and other prose links only.

**[I] plan:46-47 (Review Focus 1) says "Test in Task 2"; spec §12:326 wants "ended while the server was down ends at the first reconcile, not on load" —
Task 2's Step 1 (148-158) has no restart case.** Task 1's `persists a confirmed run and reloads it` (99) proves the load, not the first-tick end. → Add to
Task 2: a file holding a live `run` whose row is `idle` → after construction `liveLinks()` has it; first tick marks `quietSince`; ended `idle` only once the
quiet clock passes; and a reloaded store never carries a `starting` key.

**[I] plan:48-49 (Review Focus 2) names "an entry missing `how`"; Task 1's cases (110-112) cover truncated JSON and `version: 2` only.** → Add the case
and decide the rule (whole file treated as empty and set aside at the first save, or that entry dropped with a warn) — the store's header comment (31)
must say which.

**[I] plan:75-76 — `get(key)` "with today's semantics" is undefined once a key holds several live entries.** Today one `Entry` per key
(`server/src/jira/live.service.ts:40,68-72`); Task 1 allows run + branch + manual live on one key (91, 101). `get` is read by `busy()`
(`jira-dispatch.service.ts:231`), `launch` (:183) and `stop` (:201, rewritten in Task 4). → Define `get(key)` as the live `run` entry (starting included)
or null, `release(key)` as dropping only the starting run entry, and add a test: `addLink` a branch on `PAY-6` → `get('PAY-6')` is null.

**[I] plan:80-81, 234-236, 259 — Task 6 needs "not suppressed and not never-link" reads and a "404 → never-link the pair" write; Task 7 needs "a previously
suppressed pair is un-suppressed by an explicit link" — Task 1's Produces (75-87) has no `isSuppressed`, `isNeverLinked`, `markNeverLink` or `unsuppress`,
and `addLink` answers `'suppressed'` with no override.** `loadLinks` carries both lists (86) but nothing exposes them. → Add the four methods (or
`addLink(link, { force: true })`) to Task 1 with cases: never-link survives a reload; `unsuppress` then `addLink` → `'added'`.

**[I] plan:297-298 — `openButtons(link, row, state, phone)` is given as the binding signature (19), then "`wide: boolean` param spells the secondary out";
and `row: DashboardRowView` is non-null while the Ended case (305) usually has no row.** → One signature: `openButtons(link, row: DashboardRowView | null,
state, phone, wide)`; say Reopen's target comes from `link.surface` (`'desktop'` → Desktop, else Dashboard) when the row is null, and test it.

**[I] plan:172-173 — `sessionState` "first-match per §6" is not total.** §6 (spec:180-190) has no row for a live link whose row is `idle` inside the grace
(the dashboard lists an exited session as `idle` — `jira-live.service.ts:29-30`), `incomplete` with `quietSince` still null, `unknown`, or absent while
`reachable`. → Name the fallback (`quiet` is the natural one: "the dashboard cannot tell") and add two cases: live link + `idle` row inside the grace; live
link + no row, reachable.

**[I] plan:373-374 (Task 13) — the rail polls `useJiraSessions` whenever Jira is configured, so the server's page-open clock never stops.**
`useJiraSessions` polls every 15 s while mounted (312); `GET /api/jira/sessions` calls `notePageRead` (179); the rail is always mounted. So `pageOpen` is
always true and the reconciler ticks at 15 s forever, contradicting spec §5:167-169 (~15 s only while a Jira page is open, 60 s otherwise) and Task 2's
own `31 s without a read → 60 s` case (156). → Decide: the badge's read passes a flag (e.g. `?quiet=1`) that skips `notePageRead`, or only the Jira
section's mount marks the page open; test it in Task 13 (`rowsAt` cadence or the server-side `pageOpen` after a badge-only read).

**[I] plan:125 (Task 2) says "extend" `test/agents-jira-live.test.ts`, but five existing cases assert the behaviour Task 2 replaces.**
`:71` `drops an entry whose session is idle`, `:78` `...missing from the list`, `:85` `...no status string`, `:125` `the grace is exact` (one clock),
`:205` `disarms once a tick leaves nothing confirmed` (Task 2 arms while a repo is mapped). → Say these are rewritten to the two-clock `end` and the
repo-mapped arming, with the reason in the commit body, as Task 1 does at line 66.

**[I] plan:390-391 — "Task 9 confirms by test that the Desktop href renders under the served CSP's `test/csp.test.ts` unchanged" is a test Task 9 does
not list (303-305), and `test/csp.test.ts` has no href case.** → Drop the sentence (spec §10:313 expects no change) or add the test to Task 9.

**[I] plan:33-34 — the rule-file list omits two files CLAUDE.md's table scopes over the plan's paths.** `dispatch-watchdog.md` covers `server/src/agents/**`
(`dashboard-sessions.util.ts`, `worktree-main.util.ts`); `items.md` covers `shared/types.ts` (edited in Tasks 1 and 3). → Add both to the Global
Constraint.

**[I] spec §12:354 "Several boards: one session on a ticket present on two boards shows on both, once in the List" — Task 11 (344-346) and Task 12
(359-361) have no two-board case; only the badge half is in Task 13 (376).** → Add a fixture with one key on two picked boards: Task 11 the deck card on
both, Task 12 one row.

**[I] plan:324 "history line text for an ended `execute` 2 h ago" gives no expected string, and `JiraAction` is `'execute' | 'context' | { skill: string }`
(`shared/types.ts:814`) so a skill run's label is undefined.** The plan promises exact values (18). → State the line (e.g. `execute · ended 2 h ago`) and
the `{ skill }` form's label (the skill's name? its `/command`?), and a case for it.

## Minor

- plan:53 Review Focus 4 "Test in Task 10" — the view-store test is Task 11 (339, 346).
- plan:54-55 Review Focus 5 "Decide in Task 7" — the phone decision is Task 9's `desktopButton(row, phone)` (294-295).
- plan:149-150 "t0 + 120 s → ended" — spec §5:160 says "more than 120 s old" (strict) while §6:188 says Quiet is "less than 120 s ago"; the plan follows
  §6 and today's `test/agents-jira-live.test.ts:125` ("the full 2 minutes is judged"). Say so, since the spec wins on disagreement (20).
- plan:196 "400 with the key-shape sentence's style" — name it (`invalid session id`), as every other sentence is named.
- plan:273-274 exit 2 — `jira.mjs` uses 0/1/3/4/5 today (`skills/jira/tools/jira.mjs:725,739`, the exit-5 comment at :79); 2 is new. Add it to the
  header's exit-code prose so the table stays complete.
- plan:270 (Task 8) — `.claude/rules/jira.md:29,40` says `jira.mjs` goes through `/api/jira`, and `jira.test.mjs:3` repeats "one network peer is
  `/api/jira`". Adding `/api/agents/jira-link` calls should touch that wording (the token rule itself is intact). Task 8's Files omit the rule file.
- plan:252, 291 — the new supertest suite `test/agents-jira-link.test.ts` must `listenLoopback` once (`.claude/rules/tests.md`; `test/supertest-bind.test.ts`
  guards it). Say so.
- plan:359 "live row started 10 d ago" — a jsdom fixture date must be relative to the clock (`test/helpers/dates.ts`, tests.md); `startedAt`/`endedAt` are
  outside `fixture-clock.test.ts`'s four keys, so the plan has to say it.
- plan:314-315 — whether `live` leaves `GET /api/jira` once Task 10 retires its readers is not decided (spec §9.1:295 retires readers, not the field).
- plan:141 — every Task 2 fixture is `incomplete`; spec §12:328 pins `idle` past the grace too. Add one `idle` row case so a status-specific implementation
  fails.
- plan:154 — spec §12:328-329 re-attaches "even when the ticket already has a live session"; add a second live entry to the fixture.
- plan:289 "reuse `desktop.util.ts` for nothing" — say "do not reuse `desktop.util.ts`".
- plan:379-383 Task 14 is filed under Section 6 but its outcome is Task 9's C2 `local` rule. Place it before Task 9 or mark it parked with the C2 rule
  shipping as written.
- spec §11:322 leaves "whether Board A's files are deleted from the mock folder" to the builder; the plan does not decide. Say "kept".
- plan:299 `desktopHref`, `sessionUrl(linkBase, id)` at `client/src/lib/agents.ts:466` — verified; fine.
- plan:130 `?limit=50&lookback=168` — verified against the dashboard's `SCAN_CAPS` (`server/api.ts:99`); fine.

## Decisions logged

- Task 10's missing guard edits rated Critical rather than Important: as written the Task 10 commit fails to compile (`dialog-escape.test.tsx:35`) and goes
  red on two source guards, which is "breaks the build". Cost if wrong: one severity grade on a finding the author must address either way.
