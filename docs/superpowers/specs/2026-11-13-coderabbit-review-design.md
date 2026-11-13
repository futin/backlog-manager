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
- One button opens a Run already set up for the right half of the loop.

## 2. Goals, non-goals, anti-goals

**Goals**

- A **Review** step between Pipeline and Merged on the Detail track, and a fifth cell on the List's compact track.
- A five-state reading of each open MR: not reviewed, reviewing, findings open, clean, out of date (plus `unknown` for an MR too long to read, §4.2). Findings open carries a count and the worst severity
  (`2 open · 1 major`).
- The card's and the List's MR chip says `!N · K to fix` when findings are open (variant X).
- A `Review open` quick filter beside `Done, not merged`.
- **One smart button** in a CodeRabbit row under the Detail track (placement B). It opens the Run launch sheet pre-set to the review action:
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
| **A · Poller (picked)** | The existing 120 s GitLab sweep also reads `/discussions` for each open MR whose `updated_at` moved since its last read, and folds them into a `review` field on `GitlabMr`. | Reuses the token, cache, 429/401 handling, failure-keeps-last-good and age rendering Project 1 built. The cost is up to 3 page reads per changed open MR per sweep (§4.3). |
| B · On demand | Detail asks a new `GET /api/gitlab/review/:project/:iid` when it opens. | Fresh when looked at, but cards and List would need a read per ticket, or show nothing. It also duplicates the poller's error handling and opens a second outbound path. |
| C · Webhook | GitLab pushes note events to the server. | Instant, but a loopback-bound local app is not reachable from GitLab, and it needs admin setup per project. Ruled out by how this app runs. |

The user picked A.

## 4. Server: reading the review

### 4.1 What CodeRabbit leaves on an MR (observed on Timify GitLab, `!15958`)

- It never reviews on its own. A person posts a note that starts `@coderabbitai review`. That note is the **trigger**, and it opens a resolvable discussion of
  its own. Real triggers read `@coderabbitai review`, `@coderabbitai review changes`, `@coderabbitai review chnages` (sic) and
  `@coderabbitai review changes from the following commits only` followed by a commit list.
- It answers at once with a reply **inside the trigger's discussion** (the acknowledgement: `Action performed … Review finished`, `I'll review the changes…`,
  or an analysis chain), and **edits that reply when the review ends**. A review with findings also posts a top-level note containing
  `Actionable comments posted: N`, created the same minute as the edit. A review that finds nothing posts no such note: the edit is all it leaves.
  Observed on 12 rounds across `!15958`, `!15976`, `!15993`, `!15998` and `!16022` (builder check, §9).
- Each finding is a **resolvable discussion** opened by the bot. Its first note's first line reads `**<emoji> <category>** | **<emoji> <severity>** | …`,
  e.g. `**🔒 Security & Privacy** | **🟠 Major** | **⚡ Quick win**`: the emoji sits **inside** the bold. Severity is one of `Critical` (🔴), `Major` (🟠),
  `Minor` (🟡) or `Trivial` (🔵).
- The person replies `Addressed in <sha>.` or `Skipped: …` and resolves the thread.
- An MR can have several rounds, each a trigger followed by a landing. `!15958` had three.
- Pushing commits leaves a system note, `added N commit(s)`.

### 4.2 The fold

`GitlabMr` gains `review: GitlabReview | null`. `null` means not read: a merged or closed MR, an open MR not read yet, or a read that has never succeeded. It
never means "no review"; that is the `none` state.

`GitlabReview` carries the facts below and no state. The state is computed from them (next paragraph).

- `open`: the number of unresolved bot threads
- `resolved`: the number of resolved bot threads
- `worst`: `'critical' | 'major' | 'minor' | 'trivial' | null`, the worst severity among the unresolved threads (`null` when there are none, or none parse)
- `bySeverity`: counts of unresolved threads per severity, plus `other` for a thread whose severity did not parse
- `triggeredAt`: the latest trigger, or `null`
- `landedAt`: the latest landing, or `null`
- `commitsSince`: the **sum of N** over system notes `added N commit(s)` created after `landedAt`; `0` when `landedAt` is `null`
- `capped`: the discussions ran past the page budget (§4.3), so the fold saw only part of them
- `readAt`: when these facts were last read successfully
- `failed`: the latest read attempt failed, so these are the last good facts

**The cache stores those raw facts, never a frozen state.** The state is derived from them against the clock by one pure function in `shared/`,
`reviewState(review, now)`. The client calls it to draw, the poller calls it to decide re-reads (§4.3), and dispatch calls it to pick the half (§6). Rule 1
below depends on the time, so a review that never lands stops reading `reviewing` once 30 minutes pass, whether or not anything re-reads the MR. *(My call,
after the builder check: a state folded once at read time would keep a stuck review `reviewing` forever, with the button hidden.)*

The state is derived in this order. The first rule that matches wins:

| # | Condition | State | Step word | Tone |
|---|-----------|-------|-----------|------|
| 0 | `capped` and `open === 0` | `unknown` | `too long to read` | off |
| 1 | latest trigger is newer than the latest landing (or there is no landing), and is under 30 min old | `reviewing` | `reviewing… 4m` | grey |
| 2 | `open > 0` | `open` | `2 open · 1 major` | amber |
| 3 | no landing at all (no trigger, or the only rounds are over 30 min old and never landed) | `none` | `not reviewed` | off |
| 4 | `commitsSince > 0` | `stale` | `3 commits since review` | grey |
| 5 | latest trigger is newer than the latest landing and over 30 min old (a later round never landed) | `stale` | `last review didn't land` | grey |
| 6 | otherwise (a landing exists, nothing open, no commits since) | `clean` | `0 open · 25 resolved` | green |

`clean` therefore always has a landing behind it. A review that never landed, or whose page budget ran out, never reads green. Open bot threads read `open`
whatever else the fold saw or missed — a landing in wording the match does not know, or a trigger past the page cap — so the button never offers Request
review over open findings. *(Review 1-1, 1-3, 1-19, 2-1.)*

Details:

- **A stuck review.** A trigger older than 30 minutes with no landing after it is caught by rule 3 (no round ever landed) or rule 5 (an earlier round
  landed). Either way the button offers Request review again, unless rule 2's open findings come first. 30 min is my call: the skill itself gives up at 15.
- **Six states, not five.** `reviewState` returns `'none' | 'reviewing' | 'open' | 'stale' | 'clean' | 'unknown'`. `unknown` (rule 0) gets no CodeRabbit
  row, and dispatch refuses it (§6). A capped review with open findings still reads `open`, with a `+` on its count.
- **Landing match.** A round lands at the **earlier** of two times, each after its trigger was created:
  - the `created_at` of a bot note, not a system note, whose body contains `Actionable comments posted:`;
  - the `updated_at` of the bot's first reply inside the trigger's own discussion, when that `updated_at` is later than its `created_at` (the bot edits
    its acknowledgement when the review ends; a review that finds nothing leaves only this). `landedAt` is the latest such landing over all rounds.
- **Open beats stale.** Unresolved findings are still the next thing to do even after a push, and the fix session's own push is what makes a round stale
  until it resolves the threads.
- **Bot identity.** A note is the bot's when its author's username is the CodeRabbit account. The username is a server constant with an env override,
  `BM_GITLAB_REVIEW_BOT`. The builder confirms the real username on `!15958` before writing the constant (§9).
- **Trigger match.** A note by anyone but the bot, not a system note, with a line that **starts** `@coderabbitai review` or `@coderabbitai full review`
  (case-insensitive) followed by the end of the line or whitespace. So `@coderabbitai review changes …` counts, `@coderabbitai reviewer` does not, and a
  sentence that only mentions the command mid-line does not. The trigger's own discussion is a person's, so it never counts in `open`.
- **Severity parse.** The first line of a bot thread's first note, matched case-insensitively against a bold run holding one of the four words after an
  optional emoji and space — `**🟠 Major**` and `**Major**` both parse. Anything else is `other`. An unparsed thread still counts in `open` (unknown never
  reads as clean) and never sets `worst`.
- **Resolved.** A discussion is resolved when GitLab marks its resolvable notes resolved; `open` and `resolved` count only discussions the bot opened.

### 4.3 When it is read

A discussions read, of up to 3 pages, happens per open MR per sweep only when one of these holds:

1. its `updated_at` differs from the value at its last successful review read, or
2. `reviewState(review, now)` is `reviewing` or `open` and `readAt` is over 10 minutes old, or
3. it has never been read.

**Bound.** A warm sweep reads only the MRs that changed. A cold sweep, the first after a restart (the cache is in memory), reads every open MR: at most
3 × the number of open MRs requests on top of today's sweep. That is accepted rather than spread over sweeps. Most MRs fit in one page, and the existing
429 window already stops a sweep that GitLab throttles. *(Review 1-6.)*

Rule 2 exists because GitLab may not bump an MR's `updated_at` when a thread is resolved. The builder checks this first (§9). If resolving does bump it,
rule 2 goes.

The read is `GET /projects/:id/merge_requests/:iid/discussions?per_page=100&page=N`, at most 3 pages per MR. GitLab returns discussions oldest first, so
past the cap it is the **newest** trigger, landing and findings that go unread. Such an MR is marked `capped`:

- with open findings among what was read, it reads `open` with a `+` (e.g. `5+ open`)
- otherwise it reads `unknown` (rule 0), never `clean`

The read goes after the detail (pipeline) read, under the same `run.stop` guard, with the same handling:

- a 429 opens the window and stops the sweep
- a 401 re-reads the identity
- an unanswered status is recorded once
- a 403, 404 or anything else is that MR's own problem and keeps its last good review

A failed read keeps the last good facts and `readAt`, and sets `failed: true`. It never resets `review` to `null` or `none`. A failure on any page fails
the whole read, so a fold is never built from a partial set of pages. The Detail CodeRabbit row and the step's `title` then add `· not refreshed since <age>`,
counted from `readAt`, because the project's own `polledAt` keeps moving and would otherwise vouch for an old review. The card and List show nothing
extra. *(Review 1-7.)*

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

- On the left, a word in the state's tone. The exact copy is in §5.5.
- On the right, an ink `ui-split ui-split-28` button with a play icon. It reads `Fix review` when open, and `Request review` when none or stale.

The row is absent while the state is `reviewing`, `clean` or `unknown`, when `review === null`, and for a non-open lead MR.

It acts on the **lead MR** only, the one the track draws. "Also" MRs get no row. A ticket with two open MRs reviews its lead, and the others are reached
by opening their tickets or their MR.

**Pressing the button opens the existing Run launch sheet, pre-set to the review action** (the user's pick). It does not dispatch on its own. In the sheet:

- The Action field is three picture tiles today (`JiraLaunchSheet.tsx`). Opened from this button, it draws **one** tile instead, pressed and not
  switchable: title `Fix review` or `Request review` by the half, sub-line `mr-review-loop on !<iid>`, the `play` glyph. The three usual tiles are not drawn,
  so no switch can unlock the branch or change the half. The ordinary Run entry never offers `review`. *(Review 2-2.)*
- The branch section is locked to `continue` on the MR's source branch, with no "open MR" option.
- The repo select lists the review candidates (below).
- Assign and transition default to off. A review does not move the ticket.
- Model takes the sheet's usual default. Permission mode defaults as for `execute` (`defaultModeFor`: the Settings value, else `acceptEdits`), because the
  session edits code and pushes; the spawn ceiling still clamps it.
- Surface defaults to `desktop` whenever the dashboard offers it (`desktopAvailable`), whatever `launchSurfaceDefault` says, so `mr-review-loop`'s
  question gate is answered in the app after the hand-over (§6). Without desktop it is `dashboard` and the `Open in` control stays hidden, as today.
  *(Review 2-3.)*
- The prompt preview and edit work as they do for every action. The preview is `GET /api/jira/prompt` with `action=review`, `mrProject`, `mrIid` and
  `half` added to its query (§6).

**Review candidates.**

- A candidate is a `jira.json` repo path mapped to the ticket's **Jira project**, the key's prefix: `jira.json` maps repos per project, not per ticket
  (`jira-dispatch.service.ts`, the `is not mapped to` check). It must also have an `origin` that resolves to the MR's GitLab project. A sub-task and the
  parent it inherits an MR from share a project.
- `GitlabProjectView`, which `GitlabPayload.jiraProjects` already keys by Jira project, gains `repos: string[]`: every `jira.json` path under **that** Jira
  project whose origin is this GitLab project. Today the view keeps only a basename, which is for messages only. These are local paths on this machine,
  already in `jira.json`, so no secret is exposed. *(Review 1-18.)*
- The button is hidden when there are no candidates. With several, the sheet's repo select chooses. *(My call: `mrRepo()` falls back to a path segment
  and never answers "none", so it cannot decide this.)*

**Live-session gate.** Two sessions pushing one MR branch is the failure to prevent. A sub-task's review continues its parent's branch, possibly in the
very worktree the parent's session is using. *(My call.)* The button is disabled, with a tooltip naming the session, while either holds:

- **On the ticket:** a live `run` link or a `starting` reservation on the key — exactly the one-run gate `reserve` already applies to every Run. A
  `branch` or `manual` link on the key does not count here; it is caught by the branch check when it is on the MR's branch.
- **On the branch:** any of
  - a live link of any `how` (`run`, `branch`, `manual`) on any key whose stored `branch` is the MR's source branch and whose `repo` is a candidate;
  - an ACTIVE dashboard row (`working` or `question`, the rows `JiraLiveService` keeps) whose `gitBranch` is the source branch and whose `projectPath`,
    or that path's main checkout (`mainCheckoutOf`, as detection maps a worktree today), is a candidate;
  - an in-flight review dispatch on the same (candidate main checkout, source branch) pair. A dashboard row has no `gitBranch` until the session starts,
    and a reservation holds only a key, so dispatch also holds a memory-only branch reservation from its key reservation until `confirm` or `release`.
    After `confirm`, the `run` link's stored `branch` (the workspace's) takes over. Two sub-tasks of one parent pressed together therefore cannot both
    start.

Dispatch enforces both as 409s: the existing `<KEY> is starting` / `<KEY> already has a session`, and `a session is live on <branch>`. The client draws
the same two checks from the links and rows it already reads. It cannot see another tab's in-flight reservation; dispatch's 409 covers that.
*(Review 2-5.)*

The button is hidden when agents are off.

### 5.3 Card and List chip (mocks `card-x.png`, `list.png`)

`deliveryLook(mr)` becomes `deliveryLook(mr, now)`, since the review state depends on the clock. It decides the tone and word that both views draw:

- the card's MR chip shows `!<iid> · <word>`
- the List cell keeps its `!<iid>` link (`JiraIssueList.tsx`, `jira-issues-dlv-link`) and shows the word beside it in `jira-issues-dlv-word`, which has no
  chip

Worst first:

1. draft: as today. `deliveryLook` already returns `draft` before it looks at the pipeline, and this keeps that.
2. failed pipeline: red, as today
3. findings open: amber, word `2 to fix`, so the card chip reads `!15958 · 2 to fix` and the List shows `!15958` then `2 to fix`
4. otherwise the pipeline word, as today

*(Review 1-14.)*

`DeliveryLook.word` is also Detail's head word, so Detail reads `2 to fix` in amber the same way, over a passed or running pipeline. The track itself is
unchanged by this: the Pipeline step keeps its own mark from the pipeline, and the Review step carries the review (§5.1). *(Review 2-7.)*

*Drafts (my call):* a draft is an open MR. It is read for review, draws the Review step, and gets the CodeRabbit row and button, so people can review
before marking it ready. Only its chip keeps saying `draft`.

No chip is added anywhere. That keeps the List's 256 px Delivery cell within width (see the note on `list.png` at the top). The other review states do not
change the chip: the Detail step and the List's fifth cell carry them.

The List's compact track gains the fifth `jira-dlv-cell`, toned as in §5.1.

### 5.4 Filter

`DeliveryFilter` gains `'review-open'`, labelled `Review open` and placed after `Done, not merged`. It matches a ticket whose lead MR's
`reviewState(review, now)` is `open`. `effectiveDeliveryFilter` treats it like the other delivery filters when delivery is hidden.

`DELIVERY_VALUES` in `client/src/lib/jira.ts` is a second, hand-kept list of the stored values that `clampJiraPanelFilters` accepts. It gains
`'review-open'` too. Without it, a saved `Review open` filter is dropped on reload with no type error. *(Review 1-15.)*

### 5.5 Copy

Counts take the singular at 1 (`1 open`, `1 commit since review`, `1 open finding`). `<age>` is the board's existing relative age (`4m`, `1h`, `2d`).

| Where | State | Exact text |
|---|---|---|
| Step word | none | `not reviewed` |
| Step word | reviewing | `reviewing… <age>`, counted from `triggeredAt` |
| Step word | open | `<n> open · <k> <worst>` (`2 open · 1 major`). With `worst` null: `<n> open`. Capped: `<n>+ open` |
| Step word | stale (commits) | `<c> commits since review` |
| Step word | stale (unlanded) | `last review didn't land` |
| Step word | clean | `0 open · <r> resolved` |
| Step word | unknown | `too long to read` |
| Row | open | `CodeRabbit · <n> open findings · <breakdown> · reviewed <age> ago`, where `<breakdown>` is the non-zero severities in the order critical, major, minor, trivial, other (`1 major, 1 minor, 2 other`), and the age counts from `landedAt`. With `landedAt` null, the ` · reviewed <age> ago` part is left out |
| Row | none | `CodeRabbit · not reviewed yet` |
| Row | stale (commits) | `CodeRabbit · <c> commits since the last review` |
| Row | stale (unlanded) | `CodeRabbit · the last review didn't land` |
| Row suffix | `failed` | ` · not refreshed since <age>` |
| Chip / List word | open | `<n> to fix` (`<n>+ to fix` when capped) |
| Button tooltip | disabled, live on the ticket | `<session name> is live on this ticket` |
| Button tooltip | disabled, live on the branch | `<session name> is live on <branch>` |

Dispatch refusals, each `{ error }` (§6):

| Status | Text |
|---|---|
| 400 | `mr must be { project, iid }`, when `project` is not a non-empty string or `iid` is not a positive integer |
| 400 | `half must be request or fix` |
| 400 | `!<iid> is not an open merge request of <key>` |
| 400 | `<repo> is not a review candidate for !<iid>` |
| 400 | `a review continues <sourceBranch>`, when the branch choice is not `continue` on the MR's source branch with `openMr` off |
| 409 | `nothing to review on !<iid>` (reviewing or clean) |
| 409 | `no review state for !<iid> yet` (`review === null`) |
| 409 | `!<iid> has too many threads to read` (unknown) |
| 409 | `the review on !<iid> moved on — reopen the sheet` (the half derived now differs from the half the sheet previewed) |
| 409 | `a session is live on <branch>` |

*(Review 1-16.)*

## 6. The session the button starts

The button goes through the existing Jira Run dispatch (`POST /api/agents/dispatch-jira`) with a new built-in action, **`review`**:

- `JiraAction` becomes `'execute' | 'context' | 'review' | { skill: string }`.
- The client sends `review`, the MR it drew as `{ project, iid }`, and the half the sheet previewed, `half: 'request' | 'fix'`. The sheet's other fields
  (repo, branch choice, model, surface, prompt) are sent as for any Run.
- **The preview composes; it does not derive.** `GET /api/jira/prompt` takes `mrProject`, `mrIid` and `half` beside `action=review` and composes the half it
  was sent, still `text/plain`. It never reads the GitLab cache: `jira/` cannot import `gitlab/`, since `GitlabModule` already imports `JiraModule`. The
  client picks the half from `reviewState` over the review it drew (`open` → `fix`, `none` or `stale` → `request`), the same function dispatch runs. The
  preview's 400s: `mr must be { project, iid }` (`mrProject` fails the GitLab path shape `remote.util.ts` accepts, or `mrIid` is not a positive integer),
  `half must be request or fix`, plus the existing ones; the route's action sentence becomes `action must be execute, context, review or skill:<id>`.
- **Dispatch reads the cache.** `GitlabModule` exports `GitlabPollerService` and `AgentsModule` imports `GitlabModule`; the edge agents → gitlab is new and
  one-way, like agents → jira. Dispatch composes the prompt from the cached MR's own project path and iid, never the request's spelling, and requires the
  request's `{ project, iid }` to match a cached MR exactly, so the composed text equals the preview the sheet showed. *(Review 2-4.)*
- An edited prompt spawns as written (`jira-dispatch.service.ts`), so the half is the only thing that ties the click to the state. If the server derives a
  different half at dispatch, it answers 409 rather than starting a session whose prompt says the opposite. *(Review 1-11.)*
- **The server checks that MR, then derives which half from its own GitLab cache at dispatch time**, the same way item dispatch derives its action.
  - The MR must be in the cache and open.
  - Its `keys` must carry the ticket's key, or the parent key from the ticket's `JiraIssueDetail.parent`.
  - The repo must be one of its review candidates (§5.2).
  - Each failed check is a 400.
  - The state, from `reviewState(review, now)`:
    - `open` → fix
    - `none` or `stale` → request
    - `reviewing` or `clean` → a 409
    - `unknown` → a 409
    - `review === null` → a 409
    - a derived half that differs from the sent `half` → a 409
    - The sentences are in §5.5.
  - *(My call: the client already picked the lead it drew, so the server checks that pick instead of re-implementing `leadMr` and the sub-task
    inheritance rule.)*
- The client's idea of the state may be up to one sweep old, so a stale click cannot start the wrong half.
- The workspace is `continue` on the MR's `sourceBranch`, with `openMr: false`, in the repo the request names, which must be a review candidate.
  - The sheet sends that branch choice, locked.
  - The server refuses a `review` whose choice is anything else with the 400 `a review continues <sourceBranch>`. `parseBranchChoice` alone would accept
    `new` or `none`.
  - It then goes through the existing `resolveWorkspace` checks unchanged. A source branch that fails the name checks is their 400.
  - A source branch that the repo's **main working tree currently has checked out** is their 409 `<branch> is checked out in the mapped checkout <repo>`
    (`branch-choice.util.ts`). The sheet shows that sentence as it does for any Run, and the user frees the branch from that checkout first.
  - *(Review 1-8, 1-9, 1-10.)*
- For a sub-task whose MR is its parent story's, the branch is the parent's. That is correct: the session fixes the MR's code, whichever ticket the button
  was pressed on.
- The session is linked to the ticket the button was pressed on, like any Jira Run.

The prompt comes from a new built-in composer in `prompt.util.ts`. Like `execute` and `context`, it opens with `readTicket(key)` (the ticket the button
was pressed on), then the workspace block, then the half *(Review 2-6)*:

- **request**: Use the `mr-review-loop` skill on merge request `!<iid>` in `<project>`, which already exists for this branch. Run its discovery step
  (Step 1) for the host, project and token only. Skip push and MR creation (Steps 2–3). Start at the trigger step: post `@coderabbitai review`, wait for
  the review, then triage, fix, verify, push, and reply and resolve as the skill says. *(Review 1-12: Step 1 is where the token is found.)*
- **fix**: Use the `mr-review-loop` skill on merge request `!<iid>` in `<project>`. A review has already landed and has open findings. Run Step 1 for the
  host, project and token only, then start at the step that fetches the open findings, and do not post a new trigger.
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

**Questions.** `mr-review-loop` gates its reply-and-resolve step on an AskUserQuestion.

- On **both** surfaces, the first turn runs headless. A `desktop` launch is handed to the app (`claude://resume`) only once that turn ends
  (`docs/subsystems/jira.md`, the dispatch order paragraph).
- So the skill's wait of up to 15 minutes for the review, and its reply-and-resolve AskUserQuestion gate, both start headless.
- What a headless turn does at that gate decides whether a review session can finish without the user. It is denied, answered by question mode, or ends
  the turn so the desktop hand-over picks it up.
- This is the same path `execute` + `mr-review-loop` already takes. The builder observes it on a real run (§9), and the sheet defaults the review action
  to the `desktop` surface so the gate is answered in the app after the hand-over. *(Review 1-13; the default surface is my call.)*

## 7. Docs to update with the code

- `.claude/rules/gitlab.md`: the request budget, the `review` fold and its failure rule.
- `.claude/rules/jira.md`: the `review` action and its server-side derivation.
- `.claude/rules/dispatch-watchdog.md`: its closed action set and the controller's 400 sentence `action must be execute, context or { skill: <id> }`,
  which gains `review` (`jira-agents.controller.ts`); the `review` composition and what a caller can influence in it (`mr` and `half` are validated, the
  prompt names only the cached MR's project and iid); and the new module edge agents → gitlab. *(Review 2-4.)*
- `.claude/rules/board.md`: the Run ▾ / launch-sheet rule, which gains the review entry point.
- `docker-compose.yml`: pass `BM_GITLAB_REVIEW_BOT: '${BM_GITLAB_REVIEW_BOT:-}'` through beside the GitLab pair, and add it to
  `test/compose-env.test.ts`'s pinned spellings. *(Review 1-17.)*
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
- **Request budget.** A project with many open MRs that all change at once costs up to 3 page reads each, once (a cold sweep after a restart reads them all; §4.3). Unchanged MRs cost nothing. The 429 window
  already bounds the worst case.

## 9. Left to the builder, checked first

1. **The bot's username**, read from `!15958`'s discussions. It becomes the default of `BM_GITLAB_REVIEW_BOT`.
2. **Whether resolving a thread bumps the MR's `updated_at`.** Resolve and unresolve one thread on a test MR and compare. This decides whether §4.3
   rule 2 stays.
3. **Whether `added N commit(s)` system notes appear in `/discussions`** (they should, as individual-note discussions). If they do not, count commits from
   `GET …/merge_requests/:iid/commits` instead, newest first, first page only, and cap the word at `20+`.
4. **One end-to-end Request review and one Fix review from the button** on a real MR, watching the first turn for a keychain prompt. If one appears, the
   `GITLAB_TOKEN` fallback goes in `docs/subsystems/jira.md`.
5. **The bot's zero-findings landing wording**, from a real MR whose review found nothing. Add it to the landing match (§4.2).
6. **What a headless first turn does at `mr-review-loop`'s AskUserQuestion gate**, observed on the end-to-end run in item 4.
7. That `jira-live.service.ts`'s session rows expose `gitBranch` for every live session, Runs included, so the branch gate in §5.2 can be computed on
   both sides. If Runs lack it, use the Run's workspace branch, which the dispatcher knows.
8. Prompt wording, test cases, and the exact constant and type names.

**Results, 2026-11-13** (read-only GETs with the server's `read_api` token on `development/backend/microservice`, 40 recent MRs):

- **1:** the bot is `coderabbitai`.
- **2:** not run — it needs a write on GitLab, held. Until it is, §4.3 rule 2 stays as written.
- **3:** `added N commit(s)` system notes are in `/discussions` as individual notes, `system: true`; a merge push reads `added 91 commits`. The
  `/commits` fallback is not needed.
- **5:** there is no zero-findings wording; such a round posts no landing note at all. §4.1 and §4.2's landing match were rewritten on that evidence.
- **7:** every dashboard row carries `gitBranch` and `projectPath` (`dashboard-sessions.util.ts`), Runs included. The branch gate in §5.2 stands.
- **4 and 6** need a real `mr-review-loop` run and stay with the builder.

The last task of the plan is `/ui-verify` against the mocks above.
