# CodeRabbit review on the board — design

Project 2 of the mr-review-loop integration. Project 1 ([2026-11-12-gitlab-connection-design.md](2026-11-12-gitlab-connection-design.md), PR #506) put each
ticket's GitLab merge requests on the Jira views. That band shows Pushed, MR open, Pipeline and Merged. This project adds the missing step, **Review**, and
one button that starts a session to act on it.

Picked mocks, in [2026-11-13-coderabbit-review-mockups/](2026-11-13-coderabbit-review-mockups/). They were drawn over the live board in the daylight theme
by `shoot.cjs`, which sits in the same folder:

| File | Shows |
| ---- | ----- |
| `state-none.png`, `state-reviewing.png`, `state-open.png`, `state-clean.png`, `state-stale.png` | the Review step's five states on the Detail track |
| `opt-b-open.png`, `opt-b-none.png` | **picked button placement B**: a CodeRabbit row under the track with an ink button |
| `card-x.png` | **picked card variant X**: the MR chip itself reads `!15958 · 2 to fix` |
| `list.png` | the List's fifth compact cell and the `Review open` filter chip |

`list.png` was drawn before the card pick, so it shows a separate `2 to fix` chip that clips `not merged` and pushes `+1 MR` out of the 256 px Delivery
cell. **The List uses variant X as well.** Its chip text changes in place and nothing is added, so that overflow does not happen. Read `list.png` for the
fifth dot and the filter chip only.

## 1. Why

The user's loop for every MR runs like this:

1. Push.
2. Comment `@coderabbitai review`.
3. Wait.
4. Read the findings.
5. Fix or skip each one.
6. Push again.
7. Reply and resolve.

The `mr-review-loop` skill (timify-experimental plugin) already automates steps 2–7 inside a session. What is missing is on the board:

- **Seeing where each MR stands.** Has it been reviewed, are findings still open, has new code gone in since the review?
- **Starting that loop from the ticket**, without opening a terminal and typing the trigger.

Success means:

- Every open MR's review state is visible at a glance, on Detail, card and List.
- One click starts the right half of the loop.

## 2. Goals, non-goals, anti-goals

**Goals**

- A **Review** step between Pipeline and Merged on the Detail track, and a fifth cell on the List's compact track.
- A five-state reading of each open MR: not reviewed, reviewing, findings open, clean, out of date. Findings open carries a count and the worst severity
  (`2 open · 1 major`).
- The card's and the List's MR chip says `!N · K to fix` when findings are open (variant X).
- A `Review open` quick filter beside `Done, not merged`.
- **One smart button** in a CodeRabbit row under the Detail track (placement B):
  - **Request review** when the MR is not reviewed or out of date. It starts a session that runs `mr-review-loop` from its trigger step.
  - **Fix review** when findings are open. It starts a session that runs `mr-review-loop` from its fetch-findings step.
  - Nothing while a review is running or the MR is clean.

**Non-goals**

- The board never writes to GitLab. No trigger, reply or resolve goes through this server. All of that is the session's, with the user's own credentials.
- No review state for merged or closed MRs. They are not read, same as their pipeline today.
- No reviewer other than CodeRabbit, and no generic "review bot" abstraction.
- No change to the `mr-review-loop` skill. It lives in another repository. See §8 for the fallback if a prompt-only entry turns out not to be enough.
- No findings list on the board. The count and the worst severity are the board's job, and the threads themselves stay on GitLab.

**Anti-goals** (this fails even if it technically works when)

- A finished or unreadable review reads as clean. Unknown must never look green: this is the rule the pipeline fold already follows.
- The button appears and starts a session for an MR the user cannot act on, or for a branch the session cannot check out.
- The sweep's request count grows with every open MR on every tick. Discussions are read only when something could have changed (§4.3).

## 3. Approaches

| | Approach | Trade-off |
|---|---|---|
| **A · Poller (picked)** | The existing 120 s GitLab sweep also reads `/discussions` for each open MR whose `updated_at` moved since its last read, and folds them into a `review` field on `GitlabMr`. | Reuses the token, cache, 429/401 handling, failure-keeps-last-good and age rendering Project 1 built. The cost is one extra read per changed open MR per sweep. |
| B · On demand | Detail asks a new `GET /api/gitlab/review/:project/:iid` when it opens. | Fresh when looked at, but cards and List would need a read per ticket, or show nothing. It also duplicates the poller's error handling and opens a second outbound path. |
| C · Webhook | GitLab pushes note events to the server. | Instant, but a loopback-bound local app is not reachable from GitLab, and it needs admin setup per project. Ruled out by how this app runs. |

The user picked A.

## 4. Server: reading the review

### 4.1 What CodeRabbit leaves on an MR (observed on Timify GitLab, `!15958`)

- It never reviews on its own. A person posts a note whose body is `@coderabbitai review`. That note is the **trigger**.
- It answers with an immediate acknowledgement note, then, when the review is done, a note containing `Actionable comments posted: N`. That second note is
  the **landing**.
- Each finding is a **resolvable discussion** opened by the bot. Its first note's body carries `**<category>** | **<severity>**`, with severity one of
  `Major`, `Minor`, `Trivial`, often after a 🔴/🟠/🟡/🔵 emoji.
- The person replies `Addressed in <sha>.` or `Skipped: …` and resolves the thread.
- An MR can have several rounds, each a trigger followed by a landing. `!15958` had three.
- Pushing commits leaves a system note, `added N commit(s)`.

### 4.2 The fold

`GitlabMr` gains `review: GitlabReview | null`. `null` means not read: a merged or closed MR, an open MR not read yet, or a read that has never succeeded. It
never means "no review"; that is the `none` state.

`GitlabReview` carries:

- `state`: `'none' | 'reviewing' | 'open' | 'clean' | 'stale'`
- `open`: the number of unresolved bot threads
- `resolved`: the number of resolved bot threads
- `worst`: `'major' | 'minor' | 'trivial' | null`, the worst severity among the unresolved threads (`null` when there are none, or none parse)
- `bySeverity`: counts of unresolved threads per severity, plus `other` for a thread whose severity did not parse
- `triggeredAt`: the latest trigger, or `null`
- `landedAt`: the latest landing, or `null`
- `commitsSince`: commits pushed after `landedAt`, counted from system notes

The state is derived in this order. The first rule that matches wins:

| # | Condition | State | Step word | Tone |
|---|-----------|-------|-----------|------|
| 1 | no trigger note | `none` | `not reviewed` | off |
| 2 | latest trigger is newer than the latest landing (or there is no landing), and is under 30 min old | `reviewing` | `reviewing… 4m` | grey |
| 3 | `open > 0` | `open` | `2 open · 1 major` | amber |
| 4 | `commitsSince > 0` | `stale` | `3 commits since review` | grey |
| 5 | otherwise | `clean` | `0 open · 25 resolved` | green |

Details:

- **A stuck review.** A trigger older than 30 minutes with no landing after it falls through rule 2, so the MR reads as whatever the earlier rounds left.
  If there were no earlier rounds it reads `none`, and the button offers Request review again. 30 min is my call: the skill itself gives up at 15.
- **Open beats stale.** Unresolved findings are still the next thing to do even after a push, and the fix session's own push is what makes a round stale
  until it resolves the threads.
- **Bot identity.** A note is the bot's when its author's username is the CodeRabbit account. The username is a server constant with an env override,
  `BM_GITLAB_REVIEW_BOT`. The builder confirms the real username on `!15958` before writing the constant (§9).
- **Trigger match.** A note by anyone, not a system note, whose body contains `@coderabbitai review` (case-insensitive) on a line of its own or as the
  whole body. `@coderabbitai full review` counts too.
- **Severity parse.** A thread's first note, matched against `| **Major**` / `**Minor**` / `**Trivial**`, case-insensitive. Anything else is `other`.
  An unparsed thread still counts in `open` (unknown never reads as clean) and never sets `worst`.

### 4.3 When it is read

There is one extra request per open MR per sweep, made only when one of these holds:

1. its `updated_at` differs from the value at its last successful review read, or
2. its last review state is `reviewing` or `open` and the last read is over 10 minutes old, or
3. it has never been read.

Rule 2 exists because GitLab may not bump an MR's `updated_at` when a thread is resolved. The builder checks this first (§9). If resolving does bump it,
rule 2 goes.

The read is `GET /projects/:id/merge_requests/:iid/discussions?per_page=100&page=N`, at most 3 pages per MR. An MR whose discussions run past that keeps
the fold of what was read and is marked `capped`, and its step word gets a `+` (e.g. `5+ open`).

The read goes after the detail (pipeline) read, under the same `run.stop` guard, with the same handling:

- a 429 opens the window and stops the sweep
- a 401 re-reads the identity
- an unanswered status is recorded once
- a 403, 404 or anything else is that MR's own problem and keeps its last good review

A failed read keeps the last good `review`. It never resets it to `null` or `none`.

`read_api` covers `/discussions`, so no token change is needed. This stays strictly read-only, and `.claude/rules/gitlab.md`'s request-budget line gains
the discussion read.

## 5. Client

### 5.1 Detail: the Review step (mocks `state-*.png`)

- `DeliveryTrack` gains a fifth step, `Review`, between Pipeline and Merged. It uses the existing `jira-dlv-step` markup and `data-mark` tones with the
  step words from §4.2's table.
- A merged lead MR shows the step in the merged tone (magenta) with no word, same as its other steps.
- A closed lead MR, or an open MR with `review === null`, shows the step `off` with no word.
- The track's step list is data. Project 1's spec §9 left room for this step, so nothing else in the track changes.

### 5.2 Detail: the CodeRabbit row and button (mocks `opt-b-open.png`, `opt-b-none.png`)

A row under the track, separated by a hairline:

- On the left, a word in the state's tone:
  - `CodeRabbit · 2 open findings · 1 major, 1 minor · reviewed 1h ago` (open)
  - `CodeRabbit · not reviewed yet` (none)
  - `CodeRabbit · 3 commits since the last review` (stale)
- On the right, an ink `ui-split ui-split-28` button with a play icon. It reads `Fix review` when open, and `Request review` when none or stale.

The row is absent while the state is `reviewing` or `clean`, when `review === null`, and for a non-open lead MR.

It acts on the **lead MR** only, the one the track draws. "Also" MRs get no row. A ticket with two open MRs reviews its lead, and the others are reached
by opening their tickets or their MR.

The button is disabled, with a tooltip naming the session, while a session is live on the ticket, which is the same rule Run follows. It is hidden when
agents are off. It is also hidden when the MR's GitLab project maps to no local repo. The session needs a checkout to fix in, and `mrRepo()` already answers
which one.

### 5.3 Card and List chip (mocks `card-x.png`, `list.png`)

`deliveryLook()` decides the MR chip's tone and text. Worst first:

1. failed pipeline: red, as today
2. findings open: amber, `!15958 · 2 to fix`
3. otherwise the pipeline word, as today

No chip is added anywhere. That keeps the List's 256 px Delivery cell within width (see the note on `list.png` at the top). The other review states do not
change the chip: the Detail step and the List's fifth cell carry them.

The List's compact track gains the fifth `jira-dlv-cell`, toned as in §5.1.

### 5.4 Filter

`DeliveryFilter` gains `'review-open'`, labelled `Review open` and placed after `Done, not merged`. It matches a ticket whose lead MR's `review.state` is
`open`. `effectiveDeliveryFilter` treats it like the other delivery filters when delivery is hidden.

## 6. The session the button starts

The button goes through the existing Jira Run dispatch (`POST /api/agents/dispatch-jira`) with a new built-in action, **`review`**:

- `JiraAction` becomes `'execute' | 'context' | 'review' | { skill: string }`.
- The client sends only `review`. **The server derives which half from its own GitLab cache at dispatch time**, the same way item dispatch derives its
  action:
  - `open` → fix
  - `none` or `stale` → request
  - `reviewing` or `clean` → a 409 `nothing to review`
  - no lead open MR, or `review === null` → a 409 `no review state`
- The client's idea of the state may be up to one sweep old, so a stale click cannot start the wrong half.
- The workspace is `continue` on the lead MR's `sourceBranch`, in the repo `mrRepo()` names, with `openMr: false`. This goes through the existing
  `branch-choice.util.ts` checks. A source branch that fails the name checks, or that is the repo's main branch, is a 400 and the button never starts a
  session.
- For a sub-task whose MR is its parent story's, the branch is the parent's. That is correct: the session fixes the MR's code, whichever ticket the button
  was pressed on.
- The session is linked to the ticket the button was pressed on, like any Jira Run.

The prompt comes from a new built-in composer in `prompt.util.ts`, after the workspace block:

- **request**: Use the `mr-review-loop` skill on merge request `!<iid>` in `<project>`, which already exists for this branch. Skip discovery, push and
  MR creation. Start at the trigger step: post `@coderabbitai review`, wait for the review, then triage, fix, verify, push, and reply and resolve as the
  skill says.
- **fix**: Use the `mr-review-loop` skill on merge request `!<iid>` in `<project>`. A review has already landed and has open findings. Start at the step
  that fetches the open findings, and do not post a new trigger.
- **both**: If the `mr-review-loop` skill is not installed, stop and say so. Do not improvise the loop by hand.

The exact wording is the builder's. The prompt names the MR and the starting step, and carries no copy of any finding: the session reads them itself,
which is the rule Jira prompts already follow for the ticket. `execute`'s closing rule already sends sessions to `mr-review-loop` (`closingRule`), so this
is the same skill reached from a different starting point.

**Credentials.**

- The session writes with the user's own GitLab login. `mr-review-loop` finds it through the git credential helper (the macOS keychain), its token
  source 3. The server's `read_api` token is never passed to it.
- **Risk:** a keychain approval prompt during the headless first turn would hang it. The fallback is the user setting `GITLAB_TOKEN` in `~/.zshenv`,
  which the skill reads first.
- The builder runs one real Request review on a test MR before calling this done (§9).

**Questions.** `mr-review-loop` gates its reply-and-resolve step on an AskUserQuestion. A Jira Run's first turn is headless and then handed to the
desktop app (`docs/subsystems/jira.md`, the hand-over section). The gate lands in the desktop session the user opens, which is the same path `execute` +
`mr-review-loop` already takes. No new mechanism.

## 7. Docs to update with the code

- `.claude/rules/gitlab.md`: the request budget, the `review` fold and its failure rule.
- `.claude/rules/jira.md`: the `review` action and its server-side derivation.
- `docs/subsystems/` gitlab and jira pages.
- `.claude/DESIGN.md`: the fifth step, the CodeRabbit row, the chip precedence and the filter.
- Project 1's spec §9: points to this spec.

## 8. Constraints and risks

- **Read-only server.** `gitlab/` stays a reader. The only new outbound call is a GET under the same client, the same `redirect: 'manual'` and the same
  token header.
- **Prompt-only entry into another repo's skill.** `mr-review-loop` has no "start at step N" argument. The prompt describes where to start, and the skill
  is a procedure the model follows, so that is expected to hold.
  - If the first real run shows the session redoing discovery or posting a second trigger in fix mode, the fallback is a small edit to `mr-review-loop`
    in the timify-experimental repo: an explicit `--from trigger|findings` entry.
  - That edit is a separate change in that repo and not part of this project.
- **Keychain prompt in a headless turn.** See §6.
- **`updated_at` and resolves.** See §4.3. This decides whether rule 2 exists.
- **Request budget.** A project with many open MRs that all change at once costs one extra read each, once. Unchanged MRs cost nothing. The 429 window
  already bounds the worst case.

## 9. Left to the builder, checked first

1. **The bot's username**, read from `!15958`'s discussions. It becomes the default of `BM_GITLAB_REVIEW_BOT`.
2. **Whether resolving a thread bumps the MR's `updated_at`.** Resolve and unresolve one thread on a test MR and compare. This decides whether §4.3
   rule 2 stays.
3. **Whether `added N commit(s)` system notes appear in `/discussions`** (they should, as individual-note discussions). If they do not, count commits from
   `GET …/merge_requests/:iid/commits` instead, newest first, first page only, and cap the word at `20+`.
4. **One end-to-end Request review and one Fix review from the button** on a real MR, watching the first turn for a keychain prompt. If one appears, the
   `GITLAB_TOKEN` fallback goes in `docs/subsystems/jira.md`.
5. Prompt wording, test cases, and the exact constant and type names.

The last task of the plan is `/ui-verify` against the mocks above.
