## Verdict: APPROVE WITH FIXES

Narrow re-check of `git diff HEAD~1 -- docs/superpowers/plans/2026-11-13-coderabbit-review.md` (commit `1c843d48`, "address plan review 1") against
`docs/superpowers/specs/2026-11-13-coderabbit-review-design.md` and the code at that commit. Only the changed lines were reviewed.
"plan:N" is a line of the plan, "spec:N" a line of the spec.

## What the diff changed

Seven edits, one per ruling of review 1:

| Ruling | Plan lines | Result |
| ------ | ---------- | ------ |
| 1-1 Pipeline step word | 296-298, 306-307, 345-346 | Fixed for the Pipeline step; the new Task 7 case adds a false "head word" assertion (I1) |
| 1-2 prompt order | 205-209, 224-225 | Fixed; matches `server/src/jira/prompt.util.ts:132-139` |
| 1-3 `JiraAction` widening sites | 87-95 | Fixed; the compile-break list is complete (checked below) |
| 1-4 `parseReviewMr` shape | 212-217 | Fixed; predicate stated, test file pointer off (Minor) |
| 1-5 one check order | 246-252, 267-277 | Order is now single and consistent; one two-fault fixture does not discriminate (I2) |
| 1-6 branch reservation on success | 260-261, 275-277 | Fixed for success; the branch-gate 409's own release of the key is not stated or tested (I3) |
| 1-7 `repos` per Jira project | 177-180 | Fixed |

## Critical

None.

## Important

**I1. plan:345-346 (and plan:296) — the new Task 7 case asserts a Detail "head word" that neither the code nor the mock has.**
The case reads "the head word `2 to fix` (`state-open.png`)". `state-open.png` shows the head as `Delivery`, `!15958 ↗`, `microservice → demo` and
`polled 17 s ago`, with no word. `client/src/components/jira/DeliveryPane.tsx:89-96` draws exactly those four and no `look.word`; the only Detail readers
of `DeliveryLook.word` are line 43 (the Pipeline step, which this diff correctly moves to `pipelineWord`) and line 109 (the `Also:` line's
`jira-dlv-word`). Review 1 already recorded this under C1 ("`DeliveryPane.tsx:89-96` draws no word in the head"). As written the case cannot pass
without the implementer inventing a new head element that no task step, mock or DESIGN.md entry describes. spec:282 makes the same false claim; the plan
should not turn it into a test.
Fix: drop "the head word `2 to fix`" from plan:346 and say "card/List/`Also:` word" at plan:296; if a second assertion is wanted, pin the `Also:` line
instead (an also-MR with pipeline `success` and review `open` reads `2 to fix` in `jira-dlv-word`).

**I2. plan:250-251 — the third two-fault case does not pin the order it names.**
"wrong choice AND a source branch the mapped checkout holds → the choice sentence (it runs before `workspaceFor`)". `resolveWorkspace` refuses on the
CHOICE's branch, not the MR's: `server/src/jira/branch-choice.util.ts:113` is `choice.mode === 'continue' && refs.mainBranch === branch` with `branch`
from the choice (line 108). With a wrong choice (`new`, `none`, or `continue` on another branch) and the SOURCE branch checked out in the mapped
checkout, `workspaceFor` raises nothing, so an implementation that runs `workspaceFor` first still answers `a review continues <sourceBranch>` and the
case passes either way.
Fix: make the wrong choice itself fail in `resolveWorkspace` — `continue` on a second branch that is the mapped checkout's `mainBranch` (would be 409
`<branch> is checked out in the mapped checkout <repo>`, line 114), or `new` on a branch that exists (409 `<branch> exists — switch to Continue`, line
111) — and expect the 400 `a review continues <sourceBranch>`.

**I3. plan:273-275 — a branch-gate 409 after the key was reserved: its release is not stated and no test would catch a leak.**
Step 5 is "`reserve` (key), then the branch gate and branch reservation (409 `a session is live on <branch>`, refusing nothing it did not reserve)", and
the release rule is "Every failure after step 5 releases both reservations through the existing single `catch`". The branch-gate 409 is a failure INSIDE
step 5, after the key reservation was taken. In the code the `catch` wraps only `launch`
(`server/src/agents/jira-dispatch.service.ts:106-112`); a throw placed between `reserve` (line 106) and that `try` leaves the key `starting` until the
8-hour expiry, and every later Start on that ticket 409s `<KEY> is starting`. "refusing nothing it did not reserve" does not parse (presumably
"releasing"), so the implementer has to guess. None of the listed cases would fail on the leak: the race case (plan:258-259) and the gate cases
(plan:255-257) assert only the loser's 409, and "a third dispatch passes" (plan:259) follows the WINNER's failed spawn.
Fix: state it — "a branch-gate 409 releases the key reservation this request just took and touches no branch entry (the entry is the other request's)" —
and add a case: after key B loses the race (or is refused by a live link on the branch) and the branch frees, key B's next dispatch passes rather than
409 `<KEY-B> is starting`.

## Minor

- plan:251-252 — `openMr: true` answers `parseBranchChoice`'s `openMr is only for execute with a branch`
  (`server/src/jira/branch-choice.util.ts:79`, verified; the controller runs it at `jira-agents.controller.ts:65`). spec:331 and spec:375 give
  `a review continues <sourceBranch>` for that input. The plan states the deviation and the sheet never sends it, so behaviour is safe; the spec row
  should gain the exception so the two documents agree.
- plan:205-209, plan:224 — block first, then `readTicket`, is right against `prompt.util.ts:132-139` but is the reverse of spec:385-386 ("opens with
  `readTicket(key)`, … then the workspace block"). Correct the spec sentence; the plan does not flag this as a deviation.
- plan:206 — "equal to the head of an `execute` composition": `head` is not exported and the block may hold blank lines, so say how the test cuts it
  (the `execute` text up to `Work on Jira ticket`, `prompt.util.ts:86`). `readTicket` (`prompt.util.ts:102`) is private too; the sentence can be taken
  from a `context` composition with a `null` workspace (`prompt.util.ts:95`).
- plan:214-217 — `isGitlabProjectPath`'s cases are sent to `test/gitlab-mapping.test.ts`, but `remote.util.ts` is covered by
  `test/gitlab-remote.test.ts` (line 1 imports it; `gitlab-mapping.test.ts` does not). Neither file is in Task 4's Files list (plan:193-195) or its
  Step 2 run line (plan:223), and `server/src/gitlab/remote.util.ts` is missing from Task 4's Modify list. No valid-boundary case (a 255-character
  path → ok) is listed beside the 256 one.
- plan:216-217, plan:225 — `jira/` now imports a `gitlab/` file. No Nest cycle follows (`remote.util.ts` imports nothing), and
  `.claude/rules/gitlab.md:17` only bans the other direction, but spec:348 says "`jira/` cannot import `gitlab/`". Task 9 (plan:395-400) should record
  the one allowed import in the rule files.
- plan:94-95 — the pointer is off: `grep -l links.store test/` returns five files, and the store's own cases are `describe('the persisted link store')`
  at `test/jira-live.test.ts:216`, not `test/agents-jira-live.test.ts` (which only imports `jiraLinksFile`, line 7). That suite, and
  `test/jira-prompt.test.ts` for the new `review needs mr and half` throw (plan:92, no case pins it), are not in Step 2/4's "two suites" (plan:83, 96).
- plan:87-95 — the Task 1 Files list (plan:53-55) does not name the files this step now edits (`client/src/lib/jira-sessions.ts`,
  `client/src/lib/jira-list.ts`, `server/src/jira/prompt.util.ts`). The `JIRA_BUILTIN_LABELS` doc comment (`shared/types.ts:907`, "the same two
  strings") needs the third.
- plan:92-93 — "the callers build the review compose action themselves (Task 4)": the dispatch caller is Task 5, and
  `jira-dispatch.service.ts:84` calls `resolveJiraActionOrThrow` unconditionally at the position of Step 3 item 2 (plan:269), before the cached MR of
  item 3 exists. Say in Task 5 Step 3 that a `review` skips that call and builds its compose action after item 3.
- plan:260-261 — say which key each dispatch uses. The second must be the other key (a sibling sub-task) to get `a session is live on <branch>`; on the
  same key it is the ticket gate's `<KEY> already has a session` and the branch link is never consulted.
- plan:249-251 — no two-fault case separates "MR not open" from "not a candidate", or the choice 400 from the state 409s (e.g. wrong choice AND state
  `clean` → the choice sentence).
- plan:177-180 — the order of `repos` (`jira.json` order or sorted) is not stated and the fixture's two orders coincide; "give the same lists" reads
  better as "give those two lists". `GitlabProjectTarget`'s new per-key shape (plan:155) has no case in `test/gitlab-mapping.test.ts`.
- plan:296-297 — `pipelineWord` is specified only for an open, non-draft MR; say what merged, closed and draft carry (the one reader,
  `DeliveryPane.tsx:39-43`, never asks). Its one test value is `pipeline passed`; a `running` case would stop a constant passing.

## Checklist notes (changed lines only)

1. Coverage: no spec section lost a task. The diff adds coverage for spec:239-240 (per-project `repos`) and spec:254-256 (reservation until `confirm`
   or `release`).
2. Values: `!<iid> is not an open merge request of <key>`, `<repo> is not a review candidate for !<iid>`, `a review continues <sourceBranch>`,
   `mr must be { project, iid }`, `pipeline passed`, `2 open · 1 major`, `2 to fix` match spec:305-336. Deviations: the `openMr` sentence and the
   prompt order (both Minor, both stated), and the head word (I1).
3. Reality, every citation the diff adds was read: `shared/types.ts:908` (`JIRA_BUILTIN_LABELS`), `client/src/lib/jira-sessions.ts:238`,
   `client/src/lib/jira-list.ts:227`, `client/src/components/settings/SettingsView.tsx:508-509`, `client/src/lib/jira.ts:887` (`resolveJiraAction`
   returns `execute` for `'review'`), `server/src/jira/prompt.util.ts:132` and `:149`, `server/src/jira/links.store.ts:87`,
   `server/src/gitlab/poller.service.ts:259-260`, `server/src/gitlab/remote.util.ts:57`, `server/src/jira/branch-choice.util.ts:79`,
   `server/src/agents/jira-dispatch.service.ts:178-181`, `client/src/components/jira/DeliveryPane.tsx:43` — all accurate. `isGitlabProjectPath` and
   `pipelineWord` do not exist yet. With the record widened to three keys, the only sites that stop compiling are `jira-sessions.ts:238-239` and
   `prompt.util.ts:150`, both named; `JiraDetail.tsx:347`, `JiraLaunchSheet.tsx:270`, `jira-list.ts:221` and `jira.ts:904/916/1132` keep compiling
   (read, not typechecked — this reviewer cannot run `pnpm`). Nothing iterates `JIRA_BUILTIN_LABELS`, so no menu gains a third entry.
4. Interfaces: `isGitlabProjectPath` (Task 4) is produced and consumed in the same task; `pipelineWord` is produced in Task 6 and consumed in Task 7.
5. Order: Step 3's list (plan:267-274) agrees with the test list (plan:246-252) and with the existing order in `jira-dispatch.service.ts:77-104`.
   `mainCheckoutOf` is a synchronous file read (`server/src/agents/worktree-main.util.ts:16`), so key reserve, branch gate and branch reservation can
   run with no `await` between them.
6. Tests: I2 and I3.
7. Conventions: the added lines state behaviour and cases, no literal code, no hard size limits.

Autopilot: nothing was logged. This reviewer's Bash is limited to reads, searches, `git show|diff|log` and `codegraph explore`, so `autopilot decide`
and `autopilot park` could not be run. No question blocked the review. The one judgement call a caller may want to log: the `openMr` sentence and the
prompt order were rated Minor (spec to be amended) rather than a spec contradiction, because the plan states both and the code supports them; cost if
wrong is one spec line and one test string.

## Rulings

| id | outcome | evidence |
| -- | ------- | -------- |
| 2-1 | FIX | `DeliveryPane.tsx:89-96` draws no head word; Task 7 drops that assertion and pins the `Also:` line (`DeliveryPane.tsx:109`); Task 6 names the card, List and `Also:` word. Spec §5.3's "head word" sentence has no target in code — noted in the plan, no head word added. |
| 2-2 | FIX | `resolveWorkspace` judges the choice's branch (`branch-choice.util.ts:112`); the two-fault case now uses `continue` on the checkout's `mainBranch` that is not the source branch. |
| 2-3 | FIX | `catch` wraps only `launch` (`jira-dispatch.service.ts:106-112`); step 5 now releases the key on a branch-gate 409 and has a case for it. |
| Minor: openMr / prompt order vs spec | DECLINE | Plan states both and the code supports them; spec §5.5 row and §6 "opens with" are read as covered by the plan's notes. |
