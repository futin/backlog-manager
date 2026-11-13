# CodeRabbit review on the board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each open GitLab MR's CodeRabbit review state on the Jira views (Detail step + row, card/List chip, List cell, filter) and add one button that
opens the Jira launch sheet pre-set to a `review` action, which starts an `mr-review-loop` session for the right half of the loop.

**Architecture:** The existing GitLab poller also reads `/discussions` for open MRs that may have changed and folds them into raw facts (`GitlabMr.review`). A
pure `reviewState(review, now)` in `shared/` turns facts into one of six states; the client draws from it, the poller uses it to decide re-reads, and Jira
dispatch uses it to check the half. The `review` action rides the existing Jira Run dispatch; `agents/` gains a one-way import of `gitlab/` for the cache.

**Tech Stack:** NestJS server, React client, TypeScript `shared/`, jest (flat in `test/`).

**Spec:** [docs/superpowers/specs/2026-11-13-coderabbit-review-design.md](../specs/2026-11-13-coderabbit-review-design.md) — read it whole before Task 1.
Mocks: [docs/superpowers/specs/2026-11-13-coderabbit-review-mockups/](../specs/2026-11-13-coderabbit-review-mockups/).

**How to read this plan (override of the writing-plans template):** tasks state behaviour, signatures, exact values and test *cases* — never literal code.
Where a step names a test, write it yourself with the listed inputs and expected values; disagree with the plan when the code says otherwise, and say so in
the task report. Line counts anywhere are soft targets, never limits.

## Global Constraints

- `gitlab/` stays read-only: the only new outbound call is a GET through `GitlabClient.request` (same `redirect: 'manual'`, token only in `PRIVATE-TOKEN`).
- The bot username default is `coderabbitai`; env override `BM_GITLAB_REVIEW_BOT` (trimmed, blank = default), passed through compose as
  `BM_GITLAB_REVIEW_BOT: '${BM_GITLAB_REVIEW_BOT:-}'`.
- Discussion read: `GET /projects/:id/merge_requests/:iid/discussions?per_page=100&page=N`, at most **3** pages per MR per read.
- Stuck window: **30 min** (`reviewing` → `none`/`stale`). Re-read window: **10 min** (§4.3 rule 2).
- States: `'none' | 'reviewing' | 'open' | 'stale' | 'clean' | 'unknown'`. Severities: `'critical' | 'major' | 'minor' | 'trivial'` plus `other` in counts.
- Copy is spec §5.5's table, verbatim; counts take the singular at 1. Ages are `elapsedSince(iso, now)` (`client/src/lib/item-age.ts:65` — `4m`, `2h`,
  `3d`, `now` under a minute), the ladder Detail's existing delivery ages reach through `pollAge`.
- The ticket gate's 409s keep their existing text (`<KEY> is starting` / `<KEY> already has a session`); the new branch 409 is `a session is live on <branch>`.
- Every `.claude/rules/` file touched keeps `paths:`; mechanism goes there, reasoning stays in `docs/subsystems/invariants.md`.
- Every new component cites its `.claude/DESIGN.md` subsection in a header comment; inline styles only through CSSOM (CSP).
- Wrap new prose at 160 columns.

## Review Focus

1. **Open findings beat everything after rule 0.** An MR with unresolved bot threads and an unmatched landing, or a trigger newer than 30 min with open
   threads from an earlier round, must never read `none` and never offer Request review — pinned in Task 1 (rule table) and Task 6 (button).
2. **A failed or partial discussions read never changes the facts.** A 403/429/5xx on page 2 of 3 keeps the last good facts with `failed: true`; it never
   builds a fold from page 1 alone and never resets `review` to `null` — Task 3.
3. **A stale click starts nothing.** Sheet previewed `fix`, the review landed clean meanwhile → dispatch 409 `nothing to review on !<iid>`; previewed `fix`,
   state now `none` → 409 `the review on !<iid> moved on — reopen the sheet` — Task 5.
4. **Two sub-tasks of one parent pressed together:** exactly one dispatch passes; the other gets 409 `a session is live on <branch>` — Task 5.
5. **A saved `Review open` filter survives reload** (`DELIVERY_VALUES`) and reads `all` while delivery is hidden — Task 6.

---

### Task 1: Shared review types and `reviewState`

**Files:**
- Modify: `shared/types.ts` (`GitlabMr` at ~703, `GitlabProjectView` at ~723, `JiraAction` at ~905 and its parsers ~935-960, `JiraDispatchRequest` ~1491)
- Create: `shared/review.ts`
- Test: `test/review-state.test.ts` (Create), `test/jira-lib.test.ts` (extend, for the action parsers)

**Interfaces:**
- Produces:
  - `GitlabReview` in `shared/types.ts`: `{ open: number; resolved: number; worst: ReviewSeverity | null; bySeverity: Record<ReviewSeverity | 'other', number>;
    triggeredAt: string | null; landedAt: string | null; commitsSince: number; capped: boolean; readAt: string; failed: boolean }` (ISO strings).
  - `ReviewSeverity = 'critical' | 'major' | 'minor' | 'trivial'`.
  - `GitlabMr.review: GitlabReview | null`; `GitlabProjectView.repos: string[]`.
  - `JiraAction = 'execute' | 'context' | 'review' | { skill: string }`; `parseJiraAction`, `parseJiraActionParam`, `jiraActionParam` accept/emit `review`.
  - `ReviewHalf = 'request' | 'fix'`; `JiraDispatchRequest` gains optional `mr?: { project: string; iid: number }` and `half?: ReviewHalf`.
  - In `shared/review.ts`: `ReviewState` (six values), `REVIEW_STUCK_MS = 30 * 60_000`, `REVIEW_REREAD_MS = 10 * 60_000`,
    `reviewState(review: GitlabReview, now: number): ReviewState`, `reviewHalf(state: ReviewState): ReviewHalf | null` (`open` → `fix`; `none`/`stale` →
    `request`; else `null`), and `reviewStaleKind(review, now): 'commits' | 'unlanded' | null` (which stale rule fired, for the copy).

- [ ] **Step 1: Write the failing tests** in `test/review-state.test.ts`, one case per row of spec §4.2's table plus its precedence edges. Fixture: a base
  review with every count 0, `triggeredAt`/`landedAt` null, `capped: false`; `now` fixed. Cases (expected state):
  - rule 0: `capped: true, open: 0` → `unknown`; `capped: true, open: 3` → `open` (not unknown).
  - rule 1: trigger 4 min old, no landing → `reviewing`; trigger 4 min old, landing older than trigger, `open: 2` → `reviewing` (rule 1 before rule 2).
  - rule 2: no trigger, no landing, `open: 2` → `open` (open beats `none`); trigger 45 min old unlanded with `open: 1` → `open`; landed, `commitsSince: 3`,
    `open: 1` → `open` (open beats stale).
  - rule 3: nothing at all → `none`; trigger 31 min old, no landing ever → `none`; trigger exactly 30 min old, no landing → `none` (spec: only "under 30
    min" is reviewing); 29 min 59 s → `reviewing`.
  - rule 4: landed, `commitsSince: 3` → `stale`, `reviewStaleKind` = `commits`.
  - rule 5: landed at T, later trigger 40 min old with no landing after it → `stale`, kind `unlanded`.
  - rule 6: landed, nothing open, no commits → `clean`.
  - `reviewHalf` for all six states.
  - Action parsers: `parseJiraAction('review')` → `'review'`; `parseJiraActionParam('review')` → `'review'`; `jiraActionParam('review')` → `'review'`;
    `'Review'` and `{ review: true }` → `null`.
- [ ] **Step 2: Run** `pnpm exec jest test/review-state.test.ts test/jira-lib.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the types and `shared/review.ts`. `reviewState` is the spec's ordered table, first match wins; "latest trigger newer than latest
  landing" compares `Date.parse` of the two ISO strings, and an unparseable stamp reads as absent. Fix every compile error the new required fields cause
  (`GitlabMr.review`, `GitlabProjectView.repos`) by setting `review: null` / `repos: []` where MRs and views are built today, so `pnpm run typecheck` passes.
  Widening `JiraAction` also breaks these sites; give each its final behaviour now:
  - `JIRA_BUILTIN_LABELS` (`shared/types.ts:908`) becomes `Record<'execute' | 'context' | 'review', string>` with `review: 'Review the MR'` (the label a
    review link shows on Sessions and the List — plan's call, spec names none). `client/src/lib/jira-sessions.ts:238` and `client/src/lib/jira-list.ts:227`
    take `review` beside the two built-ins. `SettingsView.tsx:508-509` stays two options, and `resolveJiraAction` (`client/src/lib/jira.ts:887`) is unchanged
    — it never returns `review`, so a stored `jiraDefaultAction: 'review'` still reads `execute` (add that case to `test/jira-lib.test.ts`).
  - `resolveJiraActionOrThrow` (`server/src/jira/prompt.util.ts:149`): `'review'` throws 400 `review needs mr and half` — the callers build the review
    compose action themselves (Task 4) and never send `review` through it.
  - `links.store.ts:87` reads stored links through `parseJiraAction`, so a persisted `review` link round-trips; pin it beside the existing `links.store` cases
    (`grep -l links.store test/` — `test/agents-jira-live.test.ts` at the plan's base).
- [ ] **Step 4: Run** the two suites plus `pnpm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(gitlab): review facts and reviewState in shared`.

### Task 2: The fold and the discussions read

**Files:**
- Create: `server/src/gitlab/review.util.ts`
- Modify: `server/src/gitlab/gitlab.client.ts` (add a method beside `mergeRequest`, ~81; extend the header comment's endpoint list), `server/src/gitlab/env.util.ts`
  (bot name)
- Test: `test/gitlab-review-fold.test.ts` (Create), `test/gitlab-client.test.ts`, `test/gitlab-env.test.ts`

**Interfaces:**
- Consumes: `GitlabReview`, `ReviewSeverity` (Task 1).
- Produces:
  - `RawNote` / `RawDiscussion` types (the subset read: discussion `id`, `individual_note`, `notes[]` with `id`, `body`, `author.username`, `system`,
    `resolvable`, `resolved`, `created_at`, `updated_at`).
  - `GitlabClient.mergeRequestDiscussions(site, token, projectPath, iid, page): Promise<GitlabResponse<RawDiscussion[]>>` — `per_page=100&page=N`.
  - `GITLAB_REVIEW_PAGES = 3`, `DEFAULT_REVIEW_BOT = 'coderabbitai'`, `gitlabReviewBot(env = process.env): string`.
  - `foldReview(discussions: RawDiscussion[], bot: string, capped: boolean, readAt: string): GitlabReview` (pure; `failed: false`).
  - `isTrigger(note, bot): boolean`, `parseSeverity(body): ReviewSeverity | 'other'`, `countAddedCommits(body): number | null` — exported for tests.

- [ ] **Step 1: Write failing tests.** Fixtures are hand-built discussions in GitLab's shape; use `bot = 'coderabbitai'`.
  - `isTrigger`: true for `@coderabbitai review`, `@CodeRabbitAI Review`, `@coderabbitai review changes`, `@coderabbitai review chnages`,
    `@coderabbitai full review`, `thanks\n@coderabbitai review changes from the following commits only\nabc123`; false for `@coderabbitai reviewer`,
    `please run @coderabbitai review later` (mid-line), the same text authored by `coderabbitai`, and a `system: true` note.
  - `parseSeverity` on first lines: `**🔒 Security & Privacy** | **🟠 Major** | **⚡ Quick win**` → `major`; `**Minor**` → `minor`;
    `**🔴 Critical**` → `critical`; `**🔵 Trivial** | x` → `trivial`; `_Nitpick_` → `other`; a severity word on line 2 only → `other`.
  - `countAddedCommits`: `added 1 commit` → 1; `added 3 commits\n\n* abc…` → 3; `added 91 commits` → 91; `changed the description` → null.
  - `foldReview` cases (each asserts the full `GitlabReview` except `readAt`):
    - empty list → all zero, nulls.
    - one trigger (person, 10:00) whose discussion holds a bot reply created 10:00 and updated 10:07, plus a top-level bot note 10:07 with
      `Actionable comments posted: 2`, plus two bot finding discussions (Major unresolved, Minor resolved) → `triggeredAt` 10:00, `landedAt` 10:07 (the
      earlier of the two signals — make the note 10:06 in a variant and expect 10:06), `open: 1`, `resolved: 1`, `worst: 'major'`,
      `bySeverity.major: 1`, others 0.
    - zero-findings round: trigger 08:28, bot ack created 08:28 updated 08:35, no landing note → `landedAt` 08:35, `open: 0`.
    - ack never edited (`updated_at === created_at`) and no landing note → `landedAt: null`.
    - `added 2 commits` system note at 11:00 and `added 1 commit` at 12:00 after a 10:07 landing, one `added 5 commits` at 09:00 before it →
      `commitsSince: 3`; no landing → `commitsSince: 0`.
    - two rounds: round 1 lands 10:07, round 2 trigger 14:00 never lands → `triggeredAt` 14:00, `landedAt` 10:07.
    - the trigger's own discussion (resolvable, unresolved, by a person) is not counted in `open`.
    - a bot discussion with `resolvable` notes where one is resolved and one not → counts as open; all resolvable notes resolved → resolved.
    - a bot finding whose first line does not parse → `open: 1`, `bySeverity.other: 1`, `worst: null`.
    - `capped` is copied through.
  - Client: `mergeRequestDiscussions('gitlab.example.com', t, 'grp/sub/proj', 15958, 2)` requests exactly
    `https://gitlab.example.com/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/15958/discussions?per_page=100&page=2` with `redirect: 'manual'` and the
    token only in the header (copy the pattern of the existing `mergeRequest` test).
  - Env: unset → `coderabbitai`; `'  cr-bot  '` → `cr-bot`; `'   '` → `coderabbitai`.
- [ ] **Step 2: Run** `pnpm exec jest test/gitlab-review-fold.test.ts test/gitlab-client.test.ts test/gitlab-env.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Landing per round: for each trigger, the earlier of (a) the first bot non-system note created after the trigger whose body
  contains `Actionable comments posted:` and (b) the `updated_at` of the bot's first reply inside the trigger's discussion when `updated_at > created_at`;
  `landedAt` = latest landing over all rounds. Severity regex: case-insensitive, a bold run `**(<non-space emoji> )?(Critical|Major|Minor|Trivial)**`
  anywhere on the first line. Comment the *why* of each rule with the spec section it implements.
- [ ] **Step 4: Run** the suites — expect PASS.
- [ ] **Step 5: Commit** `feat(gitlab): fold CodeRabbit discussions into review facts`.

### Task 3: Poller reads reviews; project views carry repos

**Files:**
- Modify: `server/src/gitlab/poller.service.ts` (`ProjectCache` ~65, `sweepProject` ~433-529, `payload()` ~219), `server/src/gitlab/mapping.util.ts`
  (`GitlabProjectTarget` ~7 gains every repo path, not one), `server/src/gitlab/gitlab.module.ts` (add `exports: [GitlabPollerService]`),
  `docker-compose.yml`
- Test: `test/gitlab-poller.test.ts`, `test/helpers/gitlab.ts` (`FakeGitlab`, `rawMr` — serve `/discussions` here), `test/gitlab-mapping.test.ts`,
  `test/compose-env.test.ts`

**Interfaces:**
- Consumes: `foldReview`, `mergeRequestDiscussions`, `GITLAB_REVIEW_PAGES`, `gitlabReviewBot` (Task 2); `reviewState`, `REVIEW_REREAD_MS` (Task 1).
- Produces: `GitlabPollerService.payload()` MRs carry `review`; each `GitlabProjectView.repos` lists every `jira.json` path under that Jira project whose
  origin resolves to that GitLab project (normalised spelling, the one dispatch compares). New public read for dispatch:
  `GitlabPollerService.findMr(project: string, iid: number): GitlabMr | null` (exact match on both) and `reposFor(jiraProject: string, gitlabProject: string): string[]`.
  `GitlabModule` exports `GitlabPollerService`.

- [ ] **Step 1: Write failing tests** in `test/gitlab-poller.test.ts` over the existing `FakeGitlab` (extend it to serve `/discussions` pages):
  - first sweep reads discussions for each open MR, none for merged/closed; merged/closed MRs carry `review: null`.
  - second sweep with the same `updated_at` and state `clean`, 1 min later → no discussions request (rule 1 not met, rule 2 not met).
  - `updated_at` changed → re-read.
  - state `open` and `readAt` 11 min old, `updated_at` unchanged → re-read; 9 min old → no read.
  - 250 discussions (pages 100, 100, 50) → 3 requests, `capped: false`; 300+ (three full pages) → `capped: true`.
  - page 2 answers 500 → MR keeps the previous sweep's facts with `failed: true` and the previous `readAt`; first-ever read failing → `review: null`.
  - page 1 answers 429 → window opens, sweep stops, remaining MRs keep last good review (and pipeline, as today).
  - 401 → identity re-read, as the detail read does.
  - after a 429 stop (`run.stop`), unread MRs keep their last good review unchanged (not `failed`).
  - payload view `repos`, per Jira project: `PAY` maps `/a/one` and `/a/two` to `grp/proj` and `/a/three` to `grp/other`; `OPS` maps `/b/four` to
    `grp/proj` → `jiraProjects.PAY`'s `grp/proj` view lists `['/a/one', '/a/two']`, `jiraProjects.OPS`'s lists `['/b/four']` (today `payload()` copies one
    view under every key, `poller.service.ts:259-260` — build `repos` per key). `reposFor('PAY', 'grp/proj')` and `reposFor('OPS', 'grp/proj')` give the
    same lists; `reposFor('PAY', 'grp/none')` and `reposFor('XYZ', 'grp/proj')` → `[]`.
  - `findMr('grp/proj', 15958)` returns the cached MR; `findMr('GRP/proj', 15958)` returns `null` (exact).
  - Compose: `test/compose-env.test.ts` expects `BM_GITLAB_REVIEW_BOT: '${BM_GITLAB_REVIEW_BOT:-}'` beside the GitLab pair.
- [ ] **Step 2: Run** `pnpm exec jest test/gitlab-poller.test.ts test/gitlab-mapping.test.ts test/compose-env.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** The review read goes after each open MR's detail read, under the same `run.stop` guard and the same 429/401/unanswered
  handling; the "updated_at at last successful review read" is server-only cache state beside the MR (not in `GitlabMr`). All pages succeed or the read
  fails as a whole. Keep the "lists were read" `cache.set` as is.
- [ ] **Step 4: Run** the suites, then `grep -l 'GitlabPollerService\|payload()' test/` and run every hit — expect PASS.
- [ ] **Step 5: Commit** `feat(gitlab): read CodeRabbit discussions in the sweep`.

### Task 4: The `review` prompt and its preview

**Files:**
- Modify: `server/src/jira/prompt.util.ts` (`JiraComposeAction` ~36, `composeJiraPrompt` ~125, `resolveJiraActionOrThrow` ~149), `server/src/jira/jira.controller.ts`
  (preview route ~186-224)
- Test: `test/jira-prompt.test.ts`, `test/jira-routes.test.ts`

**Interfaces:**
- Consumes: `ReviewHalf`, `JiraAction` with `review` (Task 1).
- Produces: `JiraComposeAction` gains `{ kind: 'review'; half: ReviewHalf; mr: { project: string; iid: number } }`; `composeJiraPrompt(detail, action, repo,
  workspace)` composes it; `resolveJiraActionOrThrow('review', …)` throws (review needs `mr` and `half`, which only the callers have — they build the
  compose action themselves); `parseReviewMr(project: unknown, iid: unknown): { project: string; iid: number } | null` and
  `parseReviewHalf(raw: unknown): ReviewHalf | null` exported from `prompt.util.ts` for both the preview and the dispatch controller.

- [ ] **Step 1: Write failing tests.**
  - `composeJiraPrompt` with `review`/`request` on `PAY-151`, MR `{ project: 'development/backend/microservice', iid: 15958 }`, a `continue` workspace:
    the text starts with the workspace block (equal to the head of an `execute` composition with the same workspace — `composeJiraPrompt` puts the block
    first for every action, `prompt.util.ts:132`), and the body after it contains `readTicket('PAY-151')`'s sentence before any review wording; it contains
    `mr-review-loop`, `!15958`, `development/backend/microservice`, the words that say to post `@coderabbitai review`, and the "if not installed, stop and
    say so" line. With a `null` workspace the text starts with the body.
  - `fix`: same, says not to post a new trigger, names fetching the open findings; contains no `@coderabbitai review` instruction to post.
  - No finding text is ever in the prompt (the composer takes none — assert the signature by the cases above).
  - `parseReviewMr`: `('grp/proj', '15958')` → ok (query strings), `('grp/proj', 15958)` → ok, `('', 1)`, `('grp/proj', 0)`, `('grp/proj', 1.5)`,
    `('grp/proj', '-3')`, `('../x', 1)`, `('grp proj', 1)`, `('grp//proj', 1)`, `('/grp/proj', 1)`, `('grp', 1)`, a 256-character path → `null`.
    The shape is new — `remote.util.ts` has none (`gitlabProjectId` only encodes, `remote.util.ts:57`): add `isGitlabProjectPath(path: string): boolean` to
    `server/src/gitlab/remote.util.ts` — at most 255 characters, two or more `/`-separated segments, each `[A-Za-z0-9_.-]+` and not `.` or `..`, no leading
    or trailing `/` — with its own cases in `test/gitlab-mapping.test.ts`; `prompt.util.ts` imports it (a pure helper, not the poller, so `jira/` still never
    reaches `gitlab/`'s poller).
  - `parseReviewHalf`: `request`, `fix` ok; `Fix`, `''`, `undefined` → `null`.
  - Preview route (`test/jira-routes.test.ts`): `GET /api/jira/prompt?key=PAY-151&action=review&repo=…&mrProject=grp%2Fproj&mrIid=15958&half=fix` → 200
    `text/plain` containing `!15958`; missing `mrIid` → 400 `mr must be { project, iid }`; `half=both` → 400 `half must be request or fix`;
    `action=bogus` → 400 `action must be execute, context, review or skill:<id>`. The route makes no GitLab call (the test module provides no GitLab
    provider at all).
- [ ] **Step 2: Run** `pnpm exec jest test/jira-prompt.test.ts test/jira-routes.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the composer: the existing head (workspace block) stays first, then a body that opens with `readTicket(key)` and continues with
  the half text per spec §6 (wording is yours); and the preview params. The preview imports nothing from `gitlab/` but `isGitlabProjectPath`.
- [ ] **Step 4: Run** the suites — expect PASS.
- [ ] **Step 5: Commit** `feat(jira): review prompt and its preview`.

### Task 5: Dispatch a review

**Files:**
- Modify: `server/src/agents/agents.module.ts` (imports gain `GitlabModule`, ~85), `server/src/agents/jira-agents.controller.ts` (parse ~51-95: read `mr`
  and `half` for `review`, rebuild them into the request), `server/src/agents/jira-dispatch.service.ts` (`dispatch` ~76-117, `launch` ~127-190),
  `server/src/jira/live.service.ts` (a read of every kept dashboard row, beside `rowFor`)
- Test: `test/agents-dispatch-jira.test.ts`

**Interfaces:**
- Consumes: `GitlabPollerService.findMr`, `reposFor` (Task 3); `reviewState`, `reviewHalf` (Task 1); `parseReviewMr`, `parseReviewHalf`, review compose
  action (Task 4); `JiraLiveService.reserve/confirm/release/links()` (existing).
- Produces: `JiraLiveService.activeRows(): DashboardRow[]` (rows with status `working` or `question`); dispatch-local branch reservations keyed
  `<main checkout>\0<branch>`.

- [ ] **Step 1: Write failing tests** (extend the existing fakes; give every field a distinct value — two Jira keys, two repos, two branches):
  - controller: `action: 'review'` without `mr` → 400 `mr must be { project, iid }`; without `half` → 400 `half must be request or fix`; bad action → 400
    `action must be execute, context, review or { skill: <id> }`.
  - the 400s, each with spec §5.5's text, in Step 3's order: MR not in cache or not open → `!<iid> is not an open merge request of <key>`; repo not in
    `reposFor` → `<repo> is not a review candidate for !<iid>`; choice not `continue` on `sourceBranch` (`new`, `none`, `continue` on another branch) →
    `a review continues <sourceBranch>`; MR keys carry neither the key nor its parent (from `JiraIssueDetail.parent`) → `!<iid> is not an open merge request
    of <key>`, with no Jira write made. A sub-task whose parent's key is on the MR passes. Two-fault cases pin the order: MR not open AND wrong choice → the
    MR sentence; not a candidate AND wrong choice → the candidate sentence; wrong choice AND a source branch the mapped checkout holds → the choice
    sentence (it runs before `workspaceFor`). `openMr: true` → 400 `openMr is only for execute with a branch` from `parseBranchChoice`
    (`branch-choice.util.ts:79`), which runs in the controller first — the sheet never sends it, and spec §5.5's `a review continues` row covers the rest.
  - state 409s: `reviewing` and `clean` → `nothing to review on !<iid>`; `review: null` → `no review state for !<iid> yet`; `unknown` →
    `!<iid> has too many threads to read`; sent `half: 'fix'` while state is `none` → `the review on !<iid> moved on — reopen the sheet`.
  - branch gate 409 `a session is live on <branch>` for: a live `manual` link on another key with that stored `branch` in a candidate repo; an ACTIVE row
    whose `gitBranch` is the branch and whose `projectPath` is a linked worktree of the candidate (`mainCheckoutOf` maps it); not for an `idle` row or a
    row in a non-candidate repo.
  - race: two concurrent dispatches for two sub-tasks of one parent on the same MR branch → exactly one spawns, the other 409 `a session is live on <branch>`;
    after a failed spawn the branch reservation is released (a third dispatch passes).
  - branch reservation on success: a dispatch succeeds (the link now holds the branch, so a second dispatch 409s on the link), then the link ends → a third
    dispatch on that branch passes; a no-id desktop spawn (`jira-dispatch.service.ts:178-181`) → the next dispatch on that branch passes at once.
  - ticket gate unchanged: a live `run` link on the key → 409 `<KEY> already has a session`.
  - spawned prompt equals `composeJiraPrompt` over the **cached** MR's project and iid (and an edited prompt spawns as written, as today); the confirmed
    link stores `action: 'review'` and the workspace's branch.
  - Jira writes: with `assign: false, transitionId: null` nothing is written to Jira.
- [ ] **Step 2: Run** `pnpm exec jest test/agents-dispatch-jira.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** One order, first failure wins:
  1. Controller: action, `mr`, `half`, then `parseBranchChoice` (existing) — 400s.
  2. `dispatch`, existing: configured (503), unreadable `jira.json` (409), repo mapped (400), agents gate, desktop surface (409).
  3. Review, cache only: MR in cache and open (400), repo a candidate (400), choice `continue` on `sourceBranch` (400), then the state 409s
     (`reviewState` over the cached review, `reviewHalf` against the sent `half`).
  4. `workspaceFor` (existing; its name and checked-out refusals).
  5. `reserve` (key), then the branch gate and branch reservation (409 `a session is live on <branch>`, refusing nothing it did not reserve).
  6. `launch`: the detail read, then the keys/parent check (400, before the assign or transition), then the rest unchanged.
  Every failure after step 5 releases both reservations through the existing single `catch`. On success the branch reservation is dropped where the key's
  is: at `confirm` (the link's stored `branch` takes over the gate) and on the no-id desktop path beside its `release`. Comment the why (spec §5.2
  live-session gate).
- [ ] **Step 4: Run** the suite, then `grep -l 'JiraDispatchService\|AgentsModule' test/` and run every hit — expect PASS.
- [ ] **Step 5: Commit** `feat(agents): dispatch the review action`.

### Task 6: Client delivery lib — look, track, filter, copy

**Files:**
- Modify: `client/src/lib/delivery.ts` (`TrackStep` ~142, `openTrack` ~155, `deliveryLook` ~167, filter ~248-290), `client/src/lib/jira.ts`
  (`DELIVERY_VALUES` ~699, `defaultModeFor` ~914 treats `review` like `execute`)
- Create: `client/src/lib/review-copy.ts` (every §5.5 string, one function per row)
- Test: `test/delivery-lib.test.ts`, `test/jira-lib.test.ts`, `test/review-copy.test.ts` (Create)

**Interfaces:**
- Consumes: `reviewState`, `reviewStaleKind`, `reviewHalf` (Task 1).
- Produces:
  - `TrackStep.step` gains `'review'`; `deliveryLook(mr: GitlabMr, now: number): DeliveryLook`. Open track order: pushed, open, pipeline, review, merged.
    Merged: five magenta steps. Closed: review `off`, ends on `closed`. Review step mark per state: `none`/`unknown` → `off`, `reviewing`/`stale` → `grey`,
    `open` → `amber`, `clean` → `green`; `review === null` → `off`.
  - Word precedence (open MRs): draft → failed pipeline → findings open (`<n> to fix`, `<n>+ to fix` when capped, amber, chip `!<iid> · <n> to fix`) →
    pipeline word. That is the card/List/head word only: `DeliveryLook` gains `pipelineWord: string` (the pipeline word alone, never `<n> to fix`), and
    Detail's Pipeline step (`DeliveryPane.tsx:43`, today `deliveryLook(mr).word`) reads `pipelineWord` — spec §5.3 and `state-open.png` keep `pipeline
    passed` on the Pipeline step while the Review step reads `2 open · 1 major`.
  - `DeliveryFilter` gains `'review-open'`, label `Review open`, after `Done, not merged`; `matchesDelivery(filter, d, now)` — `review-open` matches when the
    lead (own or inherited) is opened and `reviewState` is `open`.
  - `review-copy.ts`: `reviewStepWord(review, now)`, `reviewStepTitleSuffix(review, now)` (the ` · not refreshed since <age>` part when `failed`, age from
    `readAt`), `reviewRowText(review, now): string | null` (null where §5.2 says no row), `reviewButtonLabel(state): 'Fix review' | 'Request review' | null`.
    Ages through `elapsedSince` (Global Constraints).

- [ ] **Step 1: Write failing tests.**
  - `deliveryLook`: open MR, pipeline `success`, review `open` (2 open, worst major) → chip `!15958 · 2 to fix`, word `2 to fix`, tone `amber`, track marks
    `on, on, green, amber, off`, `pipelineWord` `pipeline passed`; same with pipeline `failed` → word `pipeline failed`, red (failed beats findings); draft with open findings → `draft`,
    grey; capped with 5 open → `5+ to fix`; `review: null` → pipeline word, review step `off`; merged → five magenta; closed → review step `off`.
  - Filter: stored `review-open` with delivery hidden → `all`; `matchesDelivery('review-open', …)` true for an inherited lead with open findings, false for
    clean, false for a `hidden` ticket; `clampJiraPanelFilters({ delivery: 'review-open' })` keeps it.
  - `defaultModeFor('review', '')` → `acceptEdits`; with setting `plan` → `plan`.
  - Copy (every §5.5 row, exact strings): step words `not reviewed`, `reviewing… 4m`, `2 open · 1 major`, `1 open` (worst null), `5+ open` (capped),
    `3 commits since review`, `1 commit since review`, `last review didn't land`, `0 open · 25 resolved`, `too long to read`; rows
    `CodeRabbit · 4 open findings · 1 major, 1 minor, 2 other · reviewed 2h ago`, `CodeRabbit · 1 open finding · 1 critical` (no landing → no age part),
    `CodeRabbit · not reviewed yet`, `CodeRabbit · 3 commits since the last review`, `CodeRabbit · the last review didn't land`, failed suffix
    ` · not refreshed since 1h`; row `null` for reviewing, clean, unknown; buttons per state.
- [ ] **Step 2: Run** `pnpm exec jest test/delivery-lib.test.ts test/jira-lib.test.ts test/review-copy.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**, then update every `deliveryLook(` and `matchesDelivery(` caller to pass `now`: `DeliveryPane.tsx:43,87,102`, `MrChip.tsx:21`,
  `JiraIssueList.tsx:117`, `JiraBoardView.tsx:166` (re-grep — the list is as of the plan's base).
- [ ] **Step 4: Run** the suites, `pnpm run typecheck`, and `grep -l 'deliveryLook\|matchesDelivery\|DELIVERY_FILTER_LABELS' test/` hits — expect PASS.
- [ ] **Step 5: Commit** `feat(jira): review in the delivery look, track and filter`.

### Task 7: Surfaces — Detail step and CodeRabbit row, card and List

**Mocks:** `state-none.png`, `state-reviewing.png`, `state-open.png`, `state-clean.png`, `state-stale.png` (Detail step); `opt-b-open.png`, `opt-b-none.png`
(CodeRabbit row and button); `card-x.png` (card chip); `list.png` (List fifth cell and filter chip only — the List chip follows variant X, see spec top note).
Open each mock before drawing its view.

**Files:**
- Modify: `client/src/components/jira/DeliveryPane.tsx` (track ~65-110: fifth step; the row under the track), `client/src/components/jira/MrChip.tsx`,
  `client/src/components/jira/JiraIssueList.tsx` (~117: fifth `jira-dlv-cell`), `client/src/components/jira/JiraBoardView.tsx` (~45: `DELIVERY_OPTIONS`
  is built from `DELIVERY_FILTER_LABELS`, so the new label appears once Task 6 adds it — test it here),
  `client/src/styles.css` (row hairline, if the existing classes do not cover it)
- Create: `client/src/components/jira/ReviewRow.tsx`
- Test: `test/jira-delivery-pane.test.tsx`, `test/jira-delivery-surfaces.test.tsx`, `test/jira-list.test.tsx`

**Interfaces:**
- Consumes: Task 6's look and copy; `useDeliveryIndex`/`useGitlabContext` (existing) for the view's `repos`; the sessions context (`useJiraSessions`) and
  agents status for the gate.
- Produces: `ReviewRow({ issue, lead, now, onReview })` — `onReview(half: ReviewHalf, mr: GitlabMr, repos: string[])`; `DeliveryPane` gains an optional
  `onReview` prop threaded from `JiraDetail` to `JiraView`'s launch state (Task 8).

- [ ] **Step 1: Write failing tests.**
  - Detail track renders five steps with `data-mark` per state (one case per mock state) and the step's `title` carries the failed suffix when `failed`.
  - Pipeline `success` + review `open` (2 open, worst major) → the Pipeline step's word is `pipeline passed`, the Review step's `2 open · 1 major`, the
    head word `2 to fix` (`state-open.png`).
  - Row: open → `CodeRabbit · 2 open findings · 1 major, 1 minor · reviewed 4m ago` and a button `Fix review`; none → `Request review`; reviewing, clean,
    unknown, `review === null`, merged lead → no row; no candidate repos → row without button; agents off → no button.
  - Gate: a live `run` link on the key → button disabled, tooltip `<session name> is live on this ticket`; a live link on another key whose stored branch is
    the MR's source branch → disabled, `<session name> is live on <branch>`; a link whose row's `gitBranch` is the source branch → disabled the same way.
  - Clicking the enabled button calls `onReview('fix', lead, ['/a/one', '/a/two'])`.
  - Card: chip text `!15958 · 2 to fix`; List: link `!15958` then word `2 to fix`, five `jira-dlv-cell`s; the filter offers `Review open` after
    `Done, not merged`.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-delivery-pane.test.tsx test/jira-delivery-surfaces.test.tsx test/jira-list.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement**, matching the mocks: ink `ui-split ui-split-28` button with the play icon, hairline above the row, word in the state's tone.
  Header comments cite the DESIGN.md subsection (added in Task 9 — name it now: "Delivery track › Review step / CodeRabbit row").
- [ ] **Step 4: Run** the suites and `pnpm exec jest test/design-guards.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(jira): draw the review step, CodeRabbit row and to-fix chip`.

### Task 8: The launch sheet in review mode

**Mocks:** none for the sheet — it reuses the existing sheet; the one review tile uses the existing tile look with the `play` glyph.

**Files:**
- Modify: `client/src/components/jira/JiraView.tsx` (launch state ~80-125 gains an optional review pre-set), `client/src/components/jira/JiraLaunchSheet.tsx`
  (action tiles ~280-296 / ~362-387, surface seed ~122-125, mode ~175, branch section, repo select, preview query, dispatch body),
  `client/src/components/jira/JiraBranchSection.tsx` (locked `continue` with no open-MR option), `client/src/lib/jira.ts` (preview URL builder, if it
  lives there)
- Test: `test/jira-launch.test.tsx`

**Interfaces:**
- Consumes: `ReviewRow`'s `onReview` (Task 7); preview params (Task 4); dispatch body `mr`, `half` (Task 5); `reviewHalf` (Task 1).
- Produces: `JiraLaunchSheet` prop `review?: { half: ReviewHalf; mr: { project: string; iid: number; sourceBranch: string }; repos: string[] }`.

- [ ] **Step 1: Write failing tests.**
  - With `review` set: exactly one action tile, pressed, title `Fix review` (or `Request review`), sub-line `mr-review-loop on !15958`; the three usual tiles
    are absent.
  - Without `review`: the three usual tiles, no review tile.
  - Branch section shows `continue` on `PAY-151-x` (the MR's source branch), not editable, no open-MR control.
  - Repo select lists exactly `review.repos`.
  - Assign and transition default off.
  - Surface: `desktopAvailable` true and `launchSurfaceDefault: 'dashboard'` → `desktop`; desktop unavailable → `dashboard` with `Open in` absent.
  - Permission: `defaultModeFor('review', setting)`.
  - Preview request carries `action=review&mrProject=…&mrIid=15958&half=fix`.
  - Start posts `{ action: 'review', mr: { project, iid }, half: 'fix', choice: continue on the source branch, openMr: false, … }`.
  - A 409 answer's `error` shows in the sheet as for any Run.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-launch.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement.** Run ▾ (`JiraRunMenu`) is unchanged: it never offers `review`.
- [ ] **Step 4: Run** the suite and `grep -l 'JiraLaunchSheet\|useJiraSessions' test/` hits — expect PASS.
- [ ] **Step 5: Commit** `feat(jira): open the launch sheet pre-set for a review`.

### Task 9: Docs

**Files:**
- Modify: `.claude/rules/gitlab.md` (request budget: the discussions read and its three triggers; the fold; failure keeps last good; `findMr`/export),
  `.claude/rules/jira.md` (the `review` action, its derivation, the branch reservation), `.claude/rules/dispatch-watchdog.md` (closed action set, the 400
  sentence, the `review` composition and what a caller influences — `mr` and `half`, validated; the prompt uses the cached MR — and the agents → gitlab
  edge), `.claude/rules/board.md` (Run ▾ never offers review; the CodeRabbit row opens the sheet pre-set), `.claude/DESIGN.md` (Review step, CodeRabbit
  row, chip precedence, `Review open` filter), `docs/subsystems/gitlab.md` and `docs/subsystems/jira.md` (or the files those subsystems use — check
  `docs/overview.md`), `docs/superpowers/specs/2026-11-12-gitlab-connection-design.md` §9 (points to this spec)
- Test: `test/design-guards.test.ts` and any rule-file guard under `test/` (`grep -l '.claude/rules' test/`)

- [ ] **Step 1: Edit** each file; new prose at 160 columns; mechanism in rule files, reasoning in `docs/subsystems/invariants.md` only if a new invariant
  is stated (the agents → gitlab edge is one: add it beside "agents/, tracker/, jira/ and gitlab/ are the server's only outbound-calling modules").
- [ ] **Step 2: Run** the guard suites found above — expect PASS.
- [ ] **Step 3: Commit** `docs: CodeRabbit review on the board`.

### Task 10: `/ui-verify` against the mocks

- [ ] **Step 1:** Invoke `/ui-verify` with the mock folder `docs/superpowers/specs/2026-11-13-coderabbit-review-mockups/` and fixture data covering every
  review state (the live board's MRs are mostly un-reviewed). Compare Detail (five states + row), card (`card-x.png`) and List (`list.png`, minus its
  separate chip) at 1440 px and at phone width; report overflow numbers for the List's 256 px Delivery cell.
- [ ] **Step 2:** Fix every defect on the branch, re-run the touched suites, commit `fix(jira): match the review mocks`.

**Not verifiable here, for the final report:** spec §9 items 2 (resolve bumps `updated_at` — needs a GitLab write), 4 and 6 (a real `mr-review-loop` run
from the button, its keychain prompt and its headless question gate). Each needs the user.
