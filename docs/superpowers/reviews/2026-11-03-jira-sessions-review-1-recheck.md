# Re-check of the review-1 edits to `docs/superpowers/plans/2026-11-03-jira-sessions.md`

Scope: only the lines the diff (`plan-review1.diff`) touched. Every code claim below was checked against the worktree at
`.claude/worktrees/jira-sessions-spec`. The spec is `docs/superpowers/specs/2026-11-03-jira-sessions-design.md`.

## Verdict: APPROVE WITH FIXES

The edits answer review 1 well: the rule-file list is now complete against CLAUDE.md's table, the Review Focus task numbers are right (view store →
Task 11, phone → Task 9), the `DashboardRow` move to `shared/types.ts` is justified by a real rule (`jira.md:103`), the `JiraIssueModal` rename sweep
names real pins, and the new §11 decisions section records what the spec left open. Four Important findings, all local.

## Important

**I1 — plan:294 (Task 8 files) — "the new exit code 2" is not new, and the behaviour it points at inverts the tool's own exit table.**
`skills/jira/tools/jira.mjs:21-22` already defines `2` as "a 4xx the server answered" and `1` as "usage (including a key that is not one — nothing is
sent)"; `exitForStatus` (`jira.mjs:110-112`) maps every 4xx to 2. Task 8's behaviour line (plan:298-299, unchanged) gives the missing-env case exit 2 and
a non-2xx exit 1 — the opposite of both. A missing `CLAUDE_CODE_SESSION_ID` sends nothing, which is the tool's definition of usage.
→ Fix: missing env → exit 1 (usage), server refusal → `exitForStatus` (2 for the 409/404), and drop "new" from the files line; the tests at plan:302
follow (`missing env → exit 1`, `409 → exit 2`).

**I2 — plan:364-365 (Task 10 Step 1) — the history-line age example `2 h` is not what `pollAge` prints.**
`client/src/lib/tracker.ts:37-45`: under a minute `pollAge` returns `${n} s`; above it delegates to `elapsedSince` (`client/src/lib/item-age.ts:65-79`),
which returns `2h` — no space — then `3d`. A test asserting `run · ended 2 h ago` would fail against the helper the same sentence tells it to use.
→ Fix: `e.g. \`2h\`` (or state the assertion as `\`run · ended ${pollAge(endedAt, now)} ago\`` and give no literal).

**I3 — plan:364 vs plan:350 — the history line's first word is defined two ways.**
The changed test text says the first word is the link's `how` (`run · …`, `branch · …`, "never its action"); the unchanged behaviour line at plan:350
still reads `<run|name> · ended <when>`, where `name` is a `JiraLink.name`. An implementer reading the behaviour paragraph prints the session name
for a non-run link; one reading the test prints `branch`/`manual`. Spec §7.3 gives only `run · ended <when>`.
→ Fix: reword plan:350 to `<how> · ended <age> ago` so both agree.

**I4 — plan:48-49 and plan:177-178 (Review Focus 1, Task 2 `after a restart`) — the test does not pin spec §12's sentence; it pins a different case.**
Spec §12 and §5: "a session that ended while the server was down ends at the **first** reconcile, not on load". The plan's fixture holds a live `run`
with (implicitly) `quietSince: null`, so the first tick only *starts* the quiet clock and the entry ends 120 s later — a correct consequence of §5's
two-clock rule, but not the sentence the Review Focus cites. The case that matches the spec verbatim — the file persisted `quietSince` 10 min ago
before the server died, so both clocks are already past 120 s at the first tick — is the one that actually proves "ended at the first reconcile, not on
load", and the plan has no fixture for it.
→ Fix: add a second fixture to `after a restart` with `quietSince` 10 min old: after load live; first tick ends it `idle`. Keep the `quietSince: null`
variant as it is and say which spec sentence each covers.

## Minor

- plan:294 — `.claude/rules/jira.md:40` does not carry the "one network peer is `/api/jira`" wording; it says `jira.mjs` dials
  `http://127.0.0.1:${BM_API_PORT || 4322}` and nothing else, which stays true after Task 8. Only `jira.md:29` ("both go through `/api/jira`") and
  `jira.test.mjs:3` need widening; `jira.mjs:4-6`'s own header also lists the routes and is already covered by "header comment naming the new routes".
- plan:342-345 — the `JiraIssueModal` pin list omits `test/dialog-count-docs.test.ts:67` (`expect(bullet).toContain('JiraIssueModal')`) and the
  comment at `:10`. The Steps 2–4 `grep -rl JiraIssueModal client test .claude docs/subsystems` guard catches both, so no behaviour is lost; listing
  `:46,67` would save the implementer one red run.
- plan:80-82 — `jira.md:103` reads "`jira/` imports nothing from `agents/` **except `SameOriginPostGuard`**"; the plan's paraphrase drops the exception.
  Harmless here (a type import from `shared/` is the point), but quote it whole so nobody "fixes" the existing guard import.
- plan:177-178 — the fixture has "nothing for `PAY-2`", so `reserve('PAY-2', r)` is true trivially. Review Focus 1 says this test shows "the starting
  one is gone … and its key is free"; a `starting` entry is never persisted, so the only way to pin that is a file entry with `sessionId: null` on
  `PAY-2` that load drops. Add it or drop the claim from Review Focus 1.
- plan:87-88 vs plan:257-258, 283 — Task 1 names `markNeverLink` / `unsuppress` "for Task 6 / Task 7", but Tasks 6 and 7 describe the actions in
  prose ("never-link the pair", "un-suppressed by an explicit link") without the method names. Name them there so the interface is traceable.
- plan:189-191 — `sessionState` is made total by mapping "no row while the dashboard answers" to `quiet`, whose title is "Turn finished or stalled —
  the dashboard cannot tell which". Defensible (the spec's §6 table has no row for it, and §5 keeps such an entry live inside the grace), but say in
  the comment that the title is approximate for the no-row case.
- plan:167-168 — the boundary note ("§5's 'more than 120 s' is the spec disagreeing with itself") is right: §5:160 says "more than 120 s old",
  §6:188 says "less than 120 s ago", so t = 120 s is neither Quiet nor ended by the spec's words. Following today's `agents-jira-live.test.ts:125`
  ("the full 2 minutes is judged") is the right pick.

## Verified as stated (no finding)

- CLAUDE.md rule-file table: `dispatch-watchdog.md` ⊃ `server/src/agents/**`, `items.md` ⊃ `shared/types.ts`, `board.md` ⊃ `shared/agent.ts`,
  `tests.md` ⊃ `.claude/rules/**` — all match the table.
- `server/src/jira/config.util.ts` per-entry `drop()` fallback (`:104-106`, `readQuery`, `readBoard`) — exists, warns once per entry, keeps the rest.
- `jira-dispatch.service.ts:183,201,231` — the run-chip `startedAt`, Stop's `starting` check and `busy()`'s message, as the plan says.
- `test/agents-jira-live.test.ts:71,78,85,125,205` — each case exists and asserts what the plan says it replaces.
- `.claude/rules/jira.md:103,105` — the import rule and the invariants anchor are on those lines; `test/claude-rules.test.ts:153,365` resolves anchors
  against `##`/`###` headings only, so an `<a id>` cannot satisfy it (and `invariants.md` holds no `<a id>` today — the Task 5 one would be the first).
  No other test resolves `docs/subsystems/jira.md:367`'s anchor, so the `<a id>` for it is safe.
- `.claude/rules/board.md:12,16,19`, `client/src/hooks/useDialogEscape.ts:24`, `client/src/components/ui/Modal.tsx:26`, `docs/subsystems/board.md`,
  `docs/subsystems/jira.md:293,533`, `.claude/DESIGN.md:468`, `test/ui-modal.test.tsx:97-102`, `test/dialog-escape.test.tsx:35,305`,
  `test/dialog-count-docs.test.ts:46` (`EIGHT`) — all name `JiraIssueModal` where the plan says.
- `client/src/lib/agents.ts:466` `sessionUrl`, `client/src/lib/tracker.ts:37` `pollAge`, `test/helpers/dates.ts:28` `daysAgoDate`,
  `.claude/rules/tests.md:19` `listenLoopback` — exist.
- `shared/types.ts` has no `DashboardRow` yet; `DashboardRowView` no longer appears anywhere in the plan (rename complete).
- `openButtons` is defined once (plan:321) with the `opts` object; no other signature survives.
- Task 4's `400 invalid session id` matches the controller's `invalid issue key` (`jira-agents.controller.ts:39,85`) style.
- Review Focus 4 → Task 11 (view store, plan:378), Review Focus 5 → Task 9 (`desktopButton` phone) — correct.
- §11 decisions (plan:429-433) are consistent with Task 2's `pageOpen` 30 s / `15 s` test and Task 10's run-gate reader change.
- Spec §12 coverage claimed by the changed text — restart, idle/incomplete past grace, re-attach with a second live session, Reopen targets, two-board
  deck/List/badge cases, `?open=1` — each has a case in the task it names.
