## Verdict: REVISE

Reviewed: `docs/superpowers/plans/2026-11-13-coderabbit-review.md` (382 lines) against
`docs/superpowers/specs/2026-11-13-coderabbit-review-design.md` and the code at `e88b0d13`.
"plan:N" is a line of the plan, "spec:N" a line of the spec.

## What this proposes

Ten tasks that add CodeRabbit review state to the Jira views. The GitLab poller additionally reads each open MR's `/discussions` (at most 3 pages of 100)
and folds them into raw facts on `GitlabMr.review`; a pure `reviewState(review, now)` in `shared/` turns the facts into one of six states. The client draws
a fifth `Review` track step, a CodeRabbit row with a `Fix review` / `Request review` button, an amber `<n> to fix` chip word and a `Review open` filter.
The button opens the existing Jira launch sheet locked to a new built-in `review` action, and `dispatch-jira` checks the MR, the candidate repo, the branch
choice, the derived half and a new per-branch live-session gate before spawning an `mr-review-loop` prompt.

## How the existing system works, per this document

The GitLab poller keeps an in-memory cache per GitLab project, rebuilds MRs each sweep with one detail (pipeline) read per open MR under a `run.stop`
guard with 429/401/unanswered handling, and `payload()` publishes MRs plus one `GitlabProjectView` per Jira project. `gitlab/` is read-only and all calls go
through `GitlabClient.request`. Jira dispatch takes a closed action pick (`execute`, `context`, `{ skill }`), rebuilds the body field by field in the
controller, runs its checks, reserves the key, composes the prompt once with `composeJiraPrompt` (the same function the preview route uses), spawns and
confirms a `run` link. On the client, `lib/delivery.ts` owns the word, tone and track that `DeliveryPane`, `MrChip` and the List draw, and
`DELIVERY_VALUES` in `lib/jira.ts` is a hand-kept second list of stored filter values.

## Critical

**C1. plan:265-266, plan:286, plan:312 — the Pipeline step will read `2 to fix`.**
Task 6 puts `<n> to fix` into `DeliveryLook.word` ahead of the pipeline word, and Task 6 Step 3 only tells callers to pass `now`. But the Detail track's
Pipeline step takes its word from that same field: `client/src/components/jira/DeliveryPane.tsx:43` is `else words.pipeline = deliveryLook(mr).word;`.
Built as written, an MR with a passed pipeline and open findings draws `2 to fix` under Pipeline and `2 open · 1 major` under Review. That contradicts
spec:282-283 ("the Pipeline step keeps its own mark from the pipeline") and mock `state-open.png`, which shows `pipeline passed` under Pipeline. No task
separates the two words and no test pins the Pipeline step's word when findings are open (plan:312 asserts `data-mark` only). Note also that spec:282 calls
`DeliveryLook.word` "Detail's head word", but `DeliveryPane.tsx:89-96` draws no word in the head; the only Detail readers are line 43 (Pipeline step) and
line 109 (the `Also:` line).
Fix: in Task 6 produce the pipeline-only word separately (a second field on `DeliveryLook` or a small exported function) and say `stepWords` reads it;
in Task 7 add a case "pipeline `success` + review `open` → Pipeline step word `pipeline passed`, Review step word `2 open · 1 major`".

## Important

**I1. plan:194 and plan:207 — the stated prompt order is false against the composer, and the test compares the wrong thing.**
plan:194 says the review text "starts with the same read-ticket sentence `execute` starts with (assert equality of the first paragraph against an `execute`
composition)", with a `continue` workspace. In code the workspace block is always first (`server/src/jira/prompt.util.ts:132`, `head + body` at 139), and
`execute`'s body does not start with the read-ticket sentence: it starts `Work on Jira ticket ${key} in this repository, end to end.` and only then
`readTicket` (`prompt.util.ts:86`). Only `contextText` opens on it (`prompt.util.ts:95`). So with a workspace, "first paragraph equals `execute`'s" compares
two identical workspace blocks and passes for any body. plan:207 lists "`readTicket(key)`, workspace block, half text", copying spec:385-386, which
contradicts the composer's block-first rule (`prompt.util.ts:18`).
Fix: state the order as workspace block, then `readTicket(key)`, then the half; assert the paragraph after the block starts with the same sentence a
`context` composition's body starts with.

**I2. plan:85-87 — Task 1 cannot reach "typecheck PASS" with only the fixes it names.**
Step 3 tells the implementer to fix compile errors from the two new required fields. Widening `JiraAction` with `'review'` (plan:63) also breaks
`return { kind: action }` at `server/src/jira/prompt.util.ts:150` (`kind` is `'execute' | 'context'`, line 36), whose intended behaviour (throw) is only
defined in Task 4 (plan:188), and every index of `JIRA_BUILTIN_LABELS` (`shared/types.ts:908`, typed `Record<'execute' | 'context', string>`) by a
`JiraAction` string; its consumers are in `JiraLaunchSheet.tsx`, `JiraRunMenu.tsx`, `JiraSkillsGroup.tsx`, `SettingsView.tsx` (not opened individually —
the failing sites should be listed from a real typecheck). The plan never says what label a `review` link shows where sessions are listed.
Fix: either move the `JiraAction` widening to Task 4, or name these sites in Task 1 with their interim behaviour, and state the `review` label
(or that the record gains a `review` entry and its text).

**I3. plan:199-200 — the `parseReviewMr` shape the plan points to accepts the inputs the test says are refused.**
The test wants `('../x', 1)` and `('grp proj', 1)` → `null` and says "use the path shape `remote.util.ts`/`gitlabProjectId` accepts; read it, don't invent
one". There is no project-path predicate there: `gitlabProjectId` is `encodeURIComponent(path)` (`server/src/gitlab/remote.util.ts:57-59`) and the remote
regexes capture the path as `(.+)` (`remote.util.ts:13-14`), which accepts both `../x` and `grp proj`. The implementer has to invent a shape.
Fix: state the predicate in the plan (segments, allowed characters, no `.`/`..` segment, max length) and where it lives.

**I4. plan:229-231 vs plan:244-247 — the check order is stated two ways, and neither matches the spec for the branch choice.**
The test list titled "check order" puts the keys/parent check second; Step 3 runs MR, candidate and choice before `reserve` and the parent check after it
(it needs `JiraIssueDetail.parent`, read inside `launch` at `server/src/agents/jira-dispatch.service.ts:136`). Step 3 also places the new 400s after "the
existing pre-reservation checks", which include `workspaceFor` (`jira-dispatch.service.ts:104`, `resolveWorkspace`'s 409s) and the dashboard gate
(lines 92-96); spec:375-377 puts the `a review continues <sourceBranch>` 400 before `resolveWorkspace`. And spec:331 makes `openMr: true` part of that
400, but the controller's `parseBranchChoice` runs first and answers `openMr is only for execute with a branch`
(`server/src/jira/branch-choice.util.ts:79`); the plan's case (plan:231) names only "not `continue` on `sourceBranch`".
Fix: write one ordered list (which checks sit before `workspaceFor`, which after `reserve`), add an `openMr: true` case with the spec's sentence, and
one two-fault case that pins the order (e.g. a `new` choice on a branch that would also 409 in `resolveWorkspace` → 400 `a review continues …`).

**I5. plan:223-224, plan:238, plan:246-247 — the branch reservation's release on success is never stated or tested.**
spec:254-256 holds it "until `confirm` or `release`". The plan only says failures release it through the existing `catch`, and tests only the failed
spawn. The success paths are `live.confirm` (`jira-dispatch.service.ts:186-194`) and the no-session-id desktop path, which calls `live.release` outside
the catch (`jira-dispatch.service.ts:178-181`). An implementation that never drops the entry on success passes every listed test and 409s that branch
until restart once the link ends.
Fix: say the reservation is dropped at `confirm` and at the no-id release; add a case "dispatch succeeds, its link ends, a second dispatch on the same
branch passes", and one for the no-id desktop path.

**I6. plan:168-169 — the `repos` fixture has one Jira project, so per-project scoping is not tested.**
spec:239-240 says `repos` is every path under **that** Jira project. `payload()` builds one view per GitLab project and copies it under every Jira key
(`server/src/gitlab/poller.service.ts:259-260`), so the easy implementation lists every path of the GitLab project under every key, and the `PAY`-only
fixture passes it. Dispatch would then accept a repo mapped to another Jira project as a review candidate. `reposFor(jiraProject, gitlabProject)`
(plan:155) has no test case at all.
Fix: add a second Jira project (say `OPS`) mapping `/b/four` to `grp/proj`; assert `PAY`'s view lists `/a/one`, `/a/two` only and `OPS`'s lists
`/b/four` only; same two assertions through `reposFor`, plus an unknown pair → `[]`.

## Minor

- plan:39 — "Open findings beat everything after rule 0" is inexact: rule 1 (`reviewing`) precedes rule 2 (spec:127-128, and the plan's own case at
  plan:72). The second example ("a trigger newer than 30 min with open threads") reads `reviewing`, not `open`; say "older than 30 min" or reword.
- plan:162 — §4.3 rule 2 is tested for `open` only; add the `reviewing` + `readAt` 11 min case (spec:165).
- plan:164 — Review Focus 2 names 403/429/5xx, the case is a 500 only; add a 403 on page 2, and assert the unanswered status is recorded once (spec:185).
- plan:188 — `resolveJiraActionOrThrow('review', …)` "throws" with no status or sentence; no test pins it.
- plan:30-31 — `elapsedSince` returns `now` under a minute (`client/src/lib/item-age.ts:74`), giving `reviewing… now` and `reviewed now ago`; say what
  the copy does there. `DeliveryPane` ages use `pollAge` (`DeliveryPane.tsx:36`); the claim that it reaches the same ladder was not verified.
- plan:281-283 — no case for the singular row `CodeRabbit · 1 commit since the last review` (spec:303, 316).
- plan:313-316 — no case that a draft lead gets the row and button (spec:285-286), that `Also:` MRs get none (spec:215), or that a `starting` reservation
  on the key disables the button (spec:248).
- plan:303 — Task 7/8 jsdom suites need clock-relative fixture dates (`.claude/rules/tests.md`, `test/fixture-clock.test.ts`); the plan does not say so,
  and the review fixtures are all time-dependent.
- plan:248, plan:367 — `test/server-layering.test.ts` does not pin module edges (it checks controller imports and `agents.service` exports only,
  lines 77-107), so the new agents → gitlab edge is guarded by prose alone. Not a defect; worth a line in Task 9.
- plan:215-216 — line hints are slightly off (`dispatch` is 76-113, `launch` 127-203 in `jira-dispatch.service.ts`); harmless given "~".
- plan:55 — `test/review-state.test.ts` sits beside existing `test/review-*.test.ts` suites about a different "review" (execute `pr` mode); a name such as
  `gitlab-review-state.test.ts` would avoid confusion.

## Checklist notes

1. Coverage: every spec section maps to a task (§4.1-4.2 → T1/T2, §4.3 → T3, §5.1-5.3 → T6/T7, §5.2 sheet → T8, §5.4-5.5 → T6, §6 → T4/T5, §7 → T3/T9,
   §9 → plan:381-382). Gaps are the untested behaviours listed under Minor and C1.
2. Values: the 400/409 sentences (plan:203-204, 227-239) and the copy strings (plan:280-284) match spec:305-336. Step marks and track order match
   spec:124-132 and 200-203.
3. Reality: every Modify path and named symbol exists; every Create path is absent at `e88b0d13`. `shared/types.ts` line hints are accurate.
4. Interfaces: Consumed names are produced by earlier tasks with the same spelling. The one gap is the pipeline-only word (C1).
5. Order: I2.
6. Tests: every Review Focus item has a test. Fixture problems are I1 and I6.
7. Conventions: tasks state behaviour and cases, not code; no hard size limits. Nothing contradicts a CLAUDE.md hard rule.

Autopilot: no decision or park was logged; this reviewer's Bash is limited to `codegraph explore`, `git show|diff|log` and `curl`, so `autopilot` could
not be run. No question blocked the review.

## Rulings

| id | outcome | evidence |
| -- | ------- | -------- |
| 1-1 | FIX | `DeliveryPane.tsx:43` reads `deliveryLook(mr).word` for the Pipeline step; Task 6 adds `DeliveryLook.pipelineWord`, Task 7 pins Pipeline `pipeline passed` beside Review `2 open · 1 major`. |
| 1-2 | FIX | `prompt.util.ts:132-139` prepends the block for every action; Task 4 now asserts block first, then a body opening with `readTicket`. |
| 1-3 | FIX | `JIRA_BUILTIN_LABELS` (`shared/types.ts:908`) and `resolveJiraActionOrThrow` (`prompt.util.ts:150`) break on the widened union; Task 1 names each site, adds the `review` label, pins `resolveJiraAction` still never returning `review` and a `review` link round-trip. |
| 1-4 | FIX | `gitlabProjectId` only encodes (`remote.util.ts:57`); Task 4 adds `isGitlabProjectPath` with its shape and cases. |
| 1-5 | FIX | One ordered list in Task 5 Step 3; two-fault cases; `openMr: true` pinned to `parseBranchChoice`'s existing 400 (`branch-choice.util.ts:79`), which runs in the controller first. |
| 1-6 | FIX | Branch reservation dropped at `confirm` and on the no-id desktop path (`jira-dispatch.service.ts:178-181`); two success cases added. |
| 1-7 | FIX | `payload()` copies one view per key (`poller.service.ts:259-260`); Task 3 fixture adds a second Jira project on the same GitLab project and `reposFor` cases. |
