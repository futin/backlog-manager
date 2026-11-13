## Verdict: REVISE

Document: `docs/superpowers/specs/2026-11-13-coderabbit-review-design.md` (cited below as `spec:<line>`).

## What this proposes

The GitLab poller gains one more read per open merge request: its discussions, folded into a `review` record (open and resolved CodeRabbit threads, worst
severity, latest trigger and landing times, commits since). A pure `reviewState(review, now)` turns that into one of five states, drawn as a fifth
**Review** step on the Detail track and the List's compact track, as `!N · K to fix` on the MR chip, and as a `Review open` filter. Under the Detail track a
CodeRabbit row carries one button, `Request review` or `Fix review`, which opens the existing Jira launch sheet pre-set to a new built-in `review` action.
The server re-derives which half to start from its own cache and composes a prompt that sends the session into the `mr-review-loop` skill at the trigger or
the fetch-findings step. The server stays read-only toward GitLab.

## How the existing system works, per this document

Project 1 put a 120 s GitLab sweep on the server that lists each mapped project's MRs, reads one detail per open MR for its pipeline, keeps the last good
answer on failure, and has 429/401 handling. The client draws that as a four-step track (Pushed, MR open, Pipeline, Merged) on Detail and the List, an MR
chip on the card, and delivery filters, all derived in `client/src/lib/delivery.ts`. Jira Runs start through `POST /api/agents/dispatch-jira` from a launch
sheet with a picked action (`execute`, `context` or a skill), a repo, a branch choice checked by `branch-choice.util.ts`, and a server-composed prompt that
can be previewed and edited. `mr-review-loop` is a skill in another repository that already runs push, trigger, wait, triage, fix and resolve inside a
session with the user's own GitLab credentials.

Every section could be paraphrased.

## Critical

### C1. A stuck first review reads `clean` (green) by the table, not `none` as the text says
`spec:115-123` against `spec:127-128` and the anti-goal at `spec:67`.

Walk the table for one trigger older than 30 minutes with no landing: rule 1 fails (a trigger exists), rule 2 fails (too old), rule 3 fails (`open` is 0),
rule 4 has no defined value (`commitsSince` is "commits pushed after `landedAt`" and `landedAt` is `null`, `spec:108`), so rule 5 answers `clean`: green,
`0 open · 0 resolved`, and no button (`spec:55`, `spec:184`). The text at `spec:128` says this case reads `none` with Request review offered. An
implementer who builds the table ships the exact failure the anti-goal names: an unfinished review that looks green.

Fix: make the table say it. For example rule 1 becomes "no trigger, or no landing at all and rule 2 did not match", and rule 5 requires
`landedAt !== null`. Define `commitsSince` when `landedAt` is `null`.

## Important

### I1. `state` is both a stored field and "never stored"
`spec:101` lists `state` as a field of `GitlabReview`. `spec:110` says the cache stores raw facts, "never a frozen state". `spec:143` reads "its last
review state" and `spec:233` matches on `review.state`. Fix: drop `state` from the field list and write `reviewState(review, now)` at `spec:143` and
`spec:233`.

### I2. `capped` is not in the type, and a capped fold can read green
`spec:149-150` marks an MR `capped` and adds `+` to the word, but `spec:99-108` has no such field. GitLab returns discussions oldest first, so the three
pages kept are the oldest 300; the newest trigger, landing and findings are the ones dropped. The fold can then read `clean`, and dispatch (`spec:247-251`)
picks a half from it. Fix: add the field, and say what a capped review reads as (never `clean`), what its word is in each state, and what dispatch does.

### I3. No rule for what counts as a landing
`spec:86-87` describes the landing note, and `spec:131-136` gives match rules for the bot, the trigger and the severity, but none for the landing. Missing:
the author must be the bot, the body match (`Actionable comments posted:`), whether it must be created after the trigger, and the zero-findings case. The
skill itself requires a `coderabbitai` note created after the trigger. Fix: add a "Landing match" bullet.

### I4. `commitsSince` is ambiguous
`spec:108`, `spec:92`. "Counted from system notes" does not say whether it sums the N in `added N commit(s)` or counts notes; the example
`3 commits since review` (`spec:122`) reads as a sum. Fix: state the sum and the value when `landedAt` is `null` (see C1).

### I5. "One extra request" is up to three, and a restart reads every open MR
`spec:140` says one extra request per open MR per sweep; `spec:149` allows 3 pages. The cache is in memory and lost on restart
(`.claude/rules/gitlab.md:21-22`), so the first sweep hits "never been read" (`spec:144`) for every open MR: up to 3 requests each, on top of the detail
read (`server/src/gitlab/poller.service.ts:502`). `spec:309-310` describes this as "one extra read each". Fix: state the real bound (3 × open MRs on a cold
sweep) and whether that is accepted or spread over sweeps.

### I6. A kept last-good review has no age and no failure mark
`spec:157-159`. A discussions read that keeps failing (a 403 on that MR, say) leaves the old review drawn under a project `polledAt` that keeps moving
(`server/src/gitlab/poller.service.ts:520-527`), so the board claims a freshness the review does not have. `reviewed 1h ago` (`spec:179`) is the landing's
age, not the read's. Also unspecified: a failure on page 2 of 3. Fix: carry the review's own read time (and a failed flag) and say where it is drawn, or
state that it is deliberately not shown.

### I7. Two answers for which repo the session runs in
`spec:255` says the workspace is "in the repo `mrRepo()` names". `spec:204-205` says `mrRepo()` cannot decide this, and `spec:193`, `spec:241` and
`spec:245` say the sheet's repo select chooses among candidates. `mrRepo` is a client function returning a basename
(`client/src/lib/delivery.ts:130-132`). Fix: `spec:255` should read "in the repo the request names, checked as a review candidate".

### I8. The main-branch refusal is a 409, not a 400, and it is not "the repo's main branch"
`spec:255-257`. `resolveWorkspace` answers 409 `<branch> is checked out in the mapped checkout <repo>`
(`server/src/jira/branch-choice.util.ts:113-115`), only when the refs could be read, and `mainBranch` is whatever branch the main working tree holds
(`server/src/jira/refs.util.ts:172`). That is the common case of a user who has the MR's branch checked out in the mapped checkout, so the button will 409
at Start for them. Fix: correct the status and meaning, and say what the button or sheet shows in that case.

### I9. Who supplies the branch and mode is not stated
`spec:192` locks the sheet to `continue`; `spec:241` lists the fields sent and omits the branch; `spec:255` reads as if the server sets it.
`parseBranchChoice` today accepts `new` and `none` for any non-execute action (`server/src/jira/branch-choice.util.ts:52-53`). Fix: say whether the server
derives the branch from the cached MR and ignores the body, or refuses a `review` whose mode is not `continue` or whose branch is not the MR's
`sourceBranch`, with the sentence.

### I10. An edited prompt defeats "a stale click cannot start the wrong half"
`spec:254` against `spec:196` and `spec:241`. An edited prompt is spawned as written with no composition
(`server/src/agents/jira-dispatch.service.ts:141-142`). The sheet previews one half; if the state moved, the server derives the other half but spawns the
edited text of the first. The unedited case also changes under the user: the sheet said `Fix review` and a Request starts. Fix: have the client send the
half it previewed and 409 on disagreement, or define what happens, and say whether the result names the half started.

### I11. "Skip discovery" skips the step that finds the token
`spec:264-265`. The skill's Step 1 is "Discover host, project, token, branches"; the token sources `spec:277-280` rely on live there. A prompt that says to
skip discovery tells the session to skip getting credentials. Fix: word it as "skip push and MR creation (Steps 2-3); run Step 1 for host and token only".

### I12. The surface description is reversed
`spec:285-287` says the dashboard surface's first turn is headless and then handed to the desktop app, and the desktop surface asks in place.
`docs/subsystems/jira.md:479` says the opposite: a `desktop` launch's first turn runs headless and is then handed to the app; a dashboard launch stays on
the dashboard. So on the desktop surface the whole request loop, including the up-to-15-minute wait and the AskUserQuestion gate, starts in a headless
turn. Fix: correct the two bullets and say where the gate is answered on each surface.

### I13. The List has no MR chip to change
`spec:18`, `spec:50`, `spec:216`. The card draws `DeliveryLook.chip` (`client/src/components/jira/MrChip.tsx:21-25`); the List draws a `!iid` link and
`DeliveryLook.word` as two elements (`client/src/components/jira/JiraIssueList.tsx:117-126`). The spec gives the chip text but not the `word` for findings
open, nor the cell's `title`. `deliveryLook(mr)` also takes no clock (`client/src/lib/delivery.ts:167`) while the state needs `now`. Fix: give `chip`,
`word` and tone for the findings-open row, and say that `deliveryLook` gains `now`.

### I14. The stored-filter list is a second place `review-open` must go
`spec:233-234`. `DELIVERY_VALUES` (`client/src/lib/jira.ts:699`) is a hand-kept list the stored value is checked against; it is not exhaustive over the
type, so a missed entry drops a saved `Review open` on reload with no type error. Fix: name it.

### I15. Error and plural copy is missing
- `spec:246`: four 400s with no sentences, where every other refusal in this route has an exact one
  (`server/src/agents/jira-dispatch.service.ts:89`, `.claude/rules/dispatch-watchdog.md:28`).
- `spec:207-209`: the tooltip's text and the two 409 sentences for the live-session gate.
- `spec:121-123`, `spec:179-181`, `spec:220`: singular forms (`1 open findings`, `1 commits since review`), the step word when `worst` is `null`, and how
  `other` appears in `1 major, 1 minor`.
- `spec:241`: the shape rules and 400 for the `{ project, iid }` reference.

### I16. The docs list misses two rule files and compose
`spec:290-296`. `.claude/rules/dispatch-watchdog.md:27-28` holds the closed set `parseJiraAction` accepts and the controller's 400 sentence
(`server/src/agents/jira-agents.controller.ts:54`), and lists what a caller can influence; `review` and the MR reference change both.
`.claude/rules/board.md:119` governs Run controls on Jira surfaces and needs the new button's hide/disable rule. CLAUDE.md makes each rule file the one home
of its mechanism. Separately, `BM_GITLAB_REVIEW_BOT` (`spec:131-132`) reaches a compose-run server only if `docker-compose.yml:122-123` passes it; the spec
does not say so.

### I17. Candidates are defined by ticket key, but repos map by project key
`spec:200-201`. `jira.json` maps repo paths to a Jira project key, and dispatch checks the repo against the key's project prefix
(`server/src/agents/jira-dispatch.service.ts:84-90`). Fix: say "the ticket's project". Also unsettled: whether `GitlabProjectView.repos` (`spec:202`)
carries every path of the GitLab project or only those under that Jira key, since one view is copied per key
(`server/src/gitlab/poller.service.ts:259-260`).

### I18. A stuck later round after a clean one leaves no way to re-request
`spec:127-128`, `spec:55`. Round 1 clean, round 2 triggered and never lands, no commits since: after 30 minutes the MR reads `clean`, and the row and
button are absent. Fix: say whether this is accepted or whether a trigger newer than the landing and past 30 minutes reads as something actionable.

## Minor

- `spec:133`: "a note by anyone" includes the bot; exclude bot-authored notes from the trigger match.
- `spec:133-134`: "contains `@coderabbitai review`" does not literally match `@coderabbitai full review`; give the pattern.
- `spec:279-280`: `GITLAB_TOKEN` is the skill's source 2, after a token embedded in the remote, not "first". It is still ahead of the keychain.
- `spec:128`: "the skill itself gives up at 15" is true (`~15 min` hard cap in its Step 5).
- `spec:172`: "nothing else in the track changes" is close but not exact: `TrackStep['step']` (`client/src/lib/delivery.ts:143`), `STEP_LABEL`
  (`client/src/components/ui/DeliveryTrack.tsx:19-25`) and the three hard-coded tracks (`client/src/lib/delivery.ts:155-160`, `174`, `182-187`) all gain
  the step.
- `spec:14`, `spec:17-19`: `shoot.cjs` line 57 removes the card's second chip (`not merged`) for `card-x.png`. The spec calls out the `list.png` difference
  but not this one; say that `not merged` stays.
- `spec:244`: the server's parent check is looser than the client's inheritance rule, which is sub-task only and only when the ticket has no MR of its own
  (`client/src/lib/delivery.ts:107-110`). Harmless, but say it is deliberate.
- `spec:242-246`: the checks are not placed in dispatch's ordered contract (`server/src/agents/jira-dispatch.service.ts:39-62`); the parent-key check needs
  the detail read, which happens after the reservation.
- `spec:256-257`: a source branch that fails `branchNameProblem` leaves a visible button that always answers 400; the rule is in `shared/`, so the client
  could hide or disable it.
- `spec:212` against `.claude/rules/board.md:119`: the button opens the Jira launch sheet, whose `Copy prompt` works with agents off. Hiding follows the
  Board's environment rule instead; say which rule this control follows.
- `spec:262`: the composer is in `server/src/jira/prompt.util.ts`; there is a second `prompt.util.ts` under `agents/`. Whether the `review` built-in
  carries the "read the ticket first with `jira.mjs show`" order the other built-ins do is not stated.
- `spec:272`: `closingRule` names `mr-review-loop` only when `openMr` is set (`server/src/jira/prompt.util.ts:67-72`).

## Checked and true

- 120 s sweep, detail read per open MR, `run.stop`, 429/401/unanswered handling, last-good pipeline: `server/src/gitlab/poller.service.ts:419-517`,
  `shared/types.ts:686`.
- Merged and closed MRs carry `pipeline: null`: `server/src/gitlab/poller.service.ts:489-490`.
- `GitlabProjectView` keeps only a basename: `shared/types.ts:723-729`, `server/src/gitlab/mapping.util.ts:6-7`.
- `mrRepo()` falls back to a path segment: `client/src/lib/delivery.ts:130-132`.
- `deliveryLook` returns `draft` before the pipeline: `client/src/lib/delivery.ts:190`.
- 256 px Delivery column: `client/src/styles.css:1799`. `ui-split ui-split-28`: `client/src/styles.css:4370-4371`.
- The reconciler reads each row's `gitBranch`: `server/src/agents/jira-live.service.ts:227`.
- `continue` does not require the branch to carry the ticket's key, so a parent's branch passes: `server/src/jira/branch-choice.util.ts:72`.
- Project 1's spec §9 left room for the step: `docs/superpowers/specs/2026-11-12-gitlab-connection-design.md:299-304`.
- Assign defaults off in the sheet today: `client/src/components/jira/JiraLaunchSheet.tsx:117`.
- Age words (`4m`, `1h`) match `client/src/lib/item-age.ts:77`.
- Hard rules: the server stays read-only toward GitLab, one client, `redirect: 'manual'`, token never passed to the session; no new route outside `/api`;
  no git write. No violation found beyond I16's missing rule-file updates.

Not checked: the claims in §4.1 about what CodeRabbit leaves on `!15958` (needs the GitLab token), and the mock PNGs pixel by pixel (copy was checked
against `shoot.cjs`).

## Rulings

Numbered in the order the reviewer returned them.

| id | outcome | evidence |
|---|---|---|
| 1-1 [C] | FIX | true: with no landing, `commitsSince` 0 fell to `clean`. The table now has rule 3 (no landing → `none`) and rule 7 requires a landing. |
| 1-2 | FIX | `state` dropped from the stored fields. Every reader calls `reviewState(review, now)`: §4.3 rule 2, §5.4. |
| 1-3 | FIX | `capped` added. A capped fold reads `open N+` or `unknown`, never `clean`. Dispatch 409s `unknown`. |
| 1-4 | FIX | added a landing-match bullet. The zero-findings wording is a §9 check. |
| 1-5 | FIX | `commitsSince` is the sum of N, and 0 with a null `landedAt`. |
| 1-6 | FIX | the bound is stated: up to 3 pages per changed MR, all open MRs on a cold sweep. Accepted. |
| 1-7 | FIX | `readAt` and `failed` added; a failure on any page fails the whole read; Detail shows `not refreshed since <age>`. |
| 1-8 | FIX | `mrRepo()` wording replaced with "the repo the request names, a review candidate". |
| 1-9 | FIX | confirmed `branch-choice.util.ts:113-115` is a 409 on the main tree's checked-out branch; the spec now says so. |
| 1-10 | FIX | the server refuses a non-`continue` / wrong-branch / `openMr` review choice with a 400; confirmed `parseBranchChoice` accepts `new`/`none`. |
| 1-11 | FIX | confirmed an edited prompt spawns as written (`jira-dispatch.service.ts:141-142`); the client sends `half`, and a mismatch is a 409. |
| 1-12 | FIX | the prompt runs Step 1 for host and token only, and skips Steps 2–3. |
| 1-13 | FIX | confirmed via `docs/subsystems/jira.md:479` that a desktop launch's first turn is headless; the gate's behaviour is a §9 check; default surface `desktop`. |
| 1-14 | FIX | confirmed the List draws a link plus `jira-issues-dlv-word` (`JiraIssueList.tsx:117-126`); `deliveryLook(mr, now)`; card and List text are separate. |
| 1-15 | FIX | confirmed `DELIVERY_VALUES` at `client/src/lib/jira.ts:699`; named in §5.4. |
| 1-16 | FIX | new §5.5 Copy: step and row words, singulars, tooltips, the shape of `mr` and every dispatch refusal. |
| 1-17 | FIX | added `dispatch-watchdog.md`, `board.md`, the compose pass-through and `compose-env.test.ts` to §7. |
| 1-18 | FIX | confirmed repos map per project (`jira-dispatch.service.ts:84-90`); candidates and `GitlabProjectView.repos` are scoped to the Jira project. |
| 1-19 | FIX | rule 6: a later round that never landed reads `stale` (`last review didn't land`), and the button offers Request review. |
| 1-P | — | the paraphrase matches the intent. No change. |
