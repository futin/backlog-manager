## Verdict: REVISE

Review round 2 of `docs/superpowers/specs/2026-11-13-coderabbit-review-design.md` (at `a201edf7`). `spec:<n>` is a line of that document.

## What this proposes

The GitLab poller additionally reads each open merge request's discussions (at most three pages of 100, and only when the MR changed, was never read, or
has a review in flight) and stores raw facts about the CodeRabbit review on the MR: open and resolved bot threads, worst severity, latest trigger and
landing times, commits since the landing, and whether the read was capped or failed. One pure function in `shared/` turns those facts plus the clock into
one of six states, and the Jira views draw it: a fifth Review step on the Detail track and List's compact track, a `!N · K to fix` chip word, and a
`Review open` filter. On Detail, a CodeRabbit row carries one button (`Request review` or `Fix review`) that opens the existing launch sheet pre-set to a
new built-in action `review`, locked to the MR's source branch. Dispatch re-derives which half applies from the server's own GitLab cache, refuses a
mismatch, and hands the session a prompt that sends it into the external `mr-review-loop` skill at the right step. The server never writes to GitLab.

## How the existing system works, per this document

Project 1 (PR #506) already sweeps GitLab every 120 s with a read-only token, keeps each mapped project's MRs in an in-memory cache with last-good
semantics, a 429 window and a rendered age, and draws a four-step Delivery track (Pushed, MR open, Pipeline, Merged) on the Jira views through
`deliveryLook`. Jira Runs start through `POST /api/agents/dispatch-jira`, whose action is a validated pick from a closed set, whose repo is proved
against `jira.json`'s per-project mapping, and whose prompt is composed server-side by one function shared with the sheet's preview unless the person
edited it. A Run's branch choice is parsed and then checked against the repo's refs, and a `continue` on the branch the mapped checkout holds is a 409.
A `desktop` launch runs its first turn headless and is handed to the app afterwards. `execute` with `openMr` already points sessions at `mr-review-loop`.

## Critical

- **C1 — `spec:124` (rule 3) contradicts `spec:135`, `spec:137`, `spec:141` and `spec:168`: open findings can read `none`.** Rules 1 and 3 answer `none`
  before rule 4 looks at `open`. An MR with unresolved bot threads and no matched landing — a capped read whose landing lies past page 3
  (`spec:165-166`), or a landing whose wording the match does not know (`spec:138-139` admits the wording is not fully recorded) — reads `not reviewed`
  once the trigger is 30 minutes old, shows `Request review`, and dispatch starts the `request` half (`spec:323`), posting a new trigger over open
  findings. `spec:135` says the stuck case offers Request review "unless rule 4's open findings come first", which rule 3's position makes impossible;
  `spec:137` and `spec:168` say a capped review with open findings "still reads `open`" without condition; `spec:141` says open beats stale. The same
  holds for rule 1 (bot threads present, no note matching the trigger pattern). Fix: move `open > 0` ahead of rules 1 and 3 (or add `open === 0` to
  both), and then say what the row's `reviewed <age> ago` (`spec:281`, counted from `landedAt`) prints when `landedAt` is `null`.

## Important

- **I1 — `spec:210`: "The Action select gains the built-in `review`" describes a control that does not exist.** The sheet's Action is three picture
  tiles — `End to end`, `Ticket loaded`, `A skill` (`client/src/components/jira/JiraLaunchSheet.tsx:280-296`, `:362-387`); the only `Select` there is the
  skill pick (`:388-398`). The spec does not say whether a fourth tile is drawn (its title, sub-line and glyph are user-facing copy missing from §5.5),
  whether the other tiles stay pressable when the sheet was opened for a review, or what happens to the locked branch and the sent `half` if the person
  switches action. Fix: specify the tile and its copy, or state the action is fixed for this entry and the tiles are not drawn.
- **I2 — `spec:214` and `spec:373` contradict each other on the surface.** One says surface takes "the sheet's usual defaults", the other that the sheet
  "defaults the review action to the `desktop` surface". Today the sheet seeds the surface from the dashboard's `launchSurfaceDefault` and draws `Open in`
  only while desktop is available (`JiraLaunchSheet.tsx:122-125`, `:402-407`; its comment `:80-82` says the seed is never from anything else). Fix: one
  rule, including what `review` defaults to when desktop is not available. The permission-mode default for `review` is also unstated, and
  `defaultModeFor` is per action (`JiraLaunchSheet.tsx:175`).
- **I3 — `spec:215`, `spec:313`, `spec:316-319`: where the half is derived for the preview is not named, and the obvious place is a module cycle.**
  `GET /api/jira/prompt` lives in `jira/` (`server/src/jira/jira.module.ts:10-12`), and to return "the half it composed for" it must read the GitLab
  cache. `GitlabModule` already imports `JiraModule` (`server/src/gitlab/gitlab.module.ts:16`; `.claude/rules/gitlab.md:17-19`), and exports nothing, so
  `jira/` → `gitlab/` closes a cycle and `agents/` → `gitlab/` needs a new export. `composeJiraPrompt` is pure and has no MR or half input
  (`server/src/jira/prompt.util.ts:125`). Also unstated: the preview's changed response shape, and what it answers when no half exists (`reviewing`,
  `clean`, `unknown`, `review === null`) or the MR/candidate checks fail — §5.5's refusal table is headed "Dispatch refusals" only (`spec:290`). Fix:
  name the module edge, who derives the half for the preview, the response shape, and the preview's refusals.
- **I4 — `spec:228-231`, `spec:302`: the live-session gate is ambiguous and does not close the race it exists for.** "The same rule Run follows" is the
  one-run gate, which counts live `run` links and `starting` reservations only; `branch` and `manual` links block nothing
  (`.claude/rules/jira.md`, the "one-run gate is `run`-only" passage), and its 409 sentences are `<KEY> is starting` / `<KEY> already has a session`
  (`server/src/agents/jira-dispatch.service.ts:346-350`) — the spec does not say whether the button follows that or "any live session". The branch gate
  reads dashboard rows' `gitBranch` (`server/src/agents/jira-live.service.ts:227`), which a just-spawned session does not report yet, and a reservation
  holds only the key (`jira-dispatch.service.ts:106`), so two sub-tasks of one parent pressing the button together both pass. A row's path may be a
  linked worktree, not the candidate repo (`jira-live.service.ts:231-234`), and the spec does not say how it is matched. `spec:413-414` leaves the data
  source to the builder but not these rules. Fix: say which links count, that live `run` links' stored `branch` (`jira-dispatch.service.ts:186-194`) and
  in-flight reservations are checked as well, and how a session's path maps to a candidate repo.
- **I5 — `spec:344-355` against `.claude/rules/dispatch-watchdog.md` (the "Jira prompt is the same shape" passage): a built-in's prompt is defined there
  as "its instruction, the key, and an order to read the ticket first with `jira.mjs show <KEY>`".** The `review` prompt as described names the MR and
  the skill and says nothing of the key or the read-ticket order (`readTicket`, `server/src/jira/prompt.util.ts:102-107`), and it adds two new
  caller-influenced values (`mr`, `half`) to a rule that enumerates them ("What a caller can influence is `key`, the `repo` and the action pick"). §7
  (`spec:379-380`) lists only the action set and the 400 sentence for that rule file. Fix: state whether `review` carries the key and read-ticket order,
  and add the composition and caller-influence changes to §7.
- **I6 — `spec:237-248`: Detail's head word is left to a guess.** `DeliveryLook.word` is documented as "the List/Detail word"
  (`client/src/lib/delivery.ts:147-153`), and the spec changes what `deliveryLook` returns while naming only the card and the List. Whether Detail's
  head word becomes `2 to fix` over a passed or running pipeline, and which tone it takes, is not said. Fix: state Detail's word and tone for findings
  open, and that the track's Pipeline step keeps its own mark.

## Minor

- `spec:48`, `spec:55`: "five-state reading" beside `spec:136` "Six states, not five"; the goal's button list omits `unknown` (no button).
- `spec:154`: the `updated_at` "at its last successful review read" is not among the stored fields (`spec:101-110`); say it is server-only cache state.
- `spec:297`: "with `openMr` off" can never be reached — `parseBranchChoice` already answers 400 `openMr is only for execute with a branch`
  (`server/src/jira/branch-choice.util.ts:79`) for a `review` with `openMr` true.
- `spec:336`: the name checks are `parseBranchChoice`'s (`branch-choice.util.ts:38-42`, `:58`), not `resolveWorkspace`'s.
- `spec:316-320`: the new checks are not placed in dispatch's ordered contract (`jira-dispatch.service.ts:39-62`); the parent-key check needs the detail
  read, which today happens after the reservation (`:106`, `:136`).
- `spec:379-380`: the new exact 400 sentence for the action parse is not given (today's is at `server/src/agents/jira-agents.controller.ts:54`); the
  controller rebuilds the body field by field (`:81-95`), so `mr` and `half` must be added there.
- `spec:262-263`: `matchesDelivery(filter, d)` has no `now` (`client/src/lib/delivery.ts:272`); say it gains one, and whether an inherited lead matches
  as `failing` does (`delivery.ts:269`).
- `spec:222-223`: say `repos` paths are in the normalised spelling dispatch compares (`jira-dispatch.service.ts:84-90`).
- `spec:295`: after a restart the GitLab cache is empty (`spec:158`), and the answer `!<iid> is not an open merge request of <key>` misstates the cause.
- `spec:194`: "nothing else in the track changes" — `TrackStep.step`'s union has no `review` member (`delivery.ts:143`).
- `spec:145-146`: the trigger match is "a note by anyone", bot included, and `@coderabbitai full review` does not contain `@coderabbitai review`.
- `spec:361-362`: `GITLAB_TOKEN` "which the skill reads first" beside `spec:359-360` "token source 3" — the order is asserted, not cited.
- `spec:354`: `closingRule` names `mr-review-loop` only when `openMr` is on, and "if it is installed" (`server/src/jira/prompt.util.ts:67-75`).
- `spec:344`: say `server/src/jira/prompt.util.ts`.
- `spec:17-19`: `card-x.png` also removes the card's second chip (`shoot.cjs:57`, `chips[1].remove()`); not called out. No mock exists for `unknown`,
  stale-unlanded, capped or the `failed` suffix; they are text-only in §5.5.
- `spec:233` beside `.claude/rules/board.md` (the `Run ▾` on a Jira card is never hidden for agents off, because Copy prompt is its second exit): the
  button opens the same sheet; name which rule it follows.
- The Sessions list label for a link whose stored `action` is `review` (`jira-dispatch.service.ts:186-194`) is not given.
- `spec:281`, `spec:270`: singular for `1 open finding` is given; `<n>+ open findings` for a capped row is not.

## Checked and true

- PR #506 is project 1 (`git log`, `64fef4ec`). Four-step track (`client/src/lib/delivery.ts:155-160`); room left for a `review` step (`:138-139`).
- `is not mapped to` check (`server/src/agents/jira-dispatch.service.ts:84-90`); edited prompt spawns as written (`:141-142`).
- 409 `<branch> is checked out in the mapped checkout <repo>` (`server/src/jira/branch-choice.util.ts:113-115`); `parseBranchChoice` accepts `new`/`none`
  for a non-execute action (`:52-53`).
- Controller 400 sentence (`server/src/agents/jira-agents.controller.ts:54`). `DELIVERY_VALUES` and `clampJiraPanelFilters`
  (`client/src/lib/jira.ts:699`, `:713-722`).
- Draft returned before the pipeline (`delivery.ts:190`); `mrRepo` falls back to a path segment (`:130-132`).
- The project view keeps only a basename (`server/src/gitlab/poller.service.ts:259`; `server/src/gitlab/mapping.util.ts:6-7`); `polledAt` keeps moving
  (`poller.service.ts:520-527`); the sweep's 429/401/unanswered handling and `run.stop` guard (`:498-516`).
- `gitBranch` is read from session rows (`server/src/agents/jira-live.service.ts:227`). Desktop's first turn is headless (`docs/subsystems/jira.md:479`).
- Assign and transition default off (`JiraLaunchSheet.tsx:117-118`).
- Mock words in `shoot.cjs:9-13` and the row copy at `:102` agree with §4.2's table and §5.5.
- Budget statements at `spec:75`, `spec:158-160`, `spec:399` agree. The server stays read-only toward GitLab, adds no route outside `/api`, no git write,
  and the token stays in `GitlabClient`.

## Not checked

- §4.1's observations on `!15958` (needs the GitLab token; the document names no URL), the mock PNGs themselves, the external `mr-review-loop` skill's
  step numbers and token-source order, `docker-compose.yml` and `test/compose-env.test.ts` spellings (verified in review 1).

## Rulings

Findings numbered in the order the report lists them: C1 = 2-1, I1–I6 = 2-2 … 2-7.

| Id | Outcome | Evidence |
|---|---|---|
| 2-1 | FIX | Rule table reordered: `open > 0` (rule 2) now precedes `none` (3) and both stale rules; capped-with-open reads `open`; row drops `reviewed <age> ago` when `landedAt` is null; breakdown gains `critical`. |
| 2-2 | FIX | §5.2: opened from the button the sheet draws one pressed review tile (`Fix review` / `Request review`, `mr-review-loop on !<iid>`, `play`); the three usual tiles are not drawn; ordinary Run never offers `review`. |
| 2-3 | FIX | §5.2: one surface rule (`desktop` when `desktopAvailable`, else `dashboard`, Open in hidden as today) and permission via `defaultModeFor` as for `execute`. |
| 2-4 | FIX | §6: preview takes `mrProject`/`mrIid`/`half`, composes the half sent, never reads the GitLab cache (module cycle); client derives the half with `reviewState`; preview 400s named; `GitlabModule` exports `GitlabPollerService`, `AgentsModule` imports it; dispatch composes from the cached MR. §7 records the edge. |
| 2-5 | FIX | §5.2: ticket gate = existing `run`-link + reservation gate with its 409s; branch gate = live link of any `how` with stored `branch`, ACTIVE row by `gitBranch` and `projectPath`/`mainCheckoutOf`, plus a memory-only branch reservation until `confirm`/`release`; 409 `a session is live on <branch>`. |
| 2-6 | FIX | §6: review prompt opens with `readTicket(key)` like the other built-ins; §7 adds the composition and caller-influence note to `dispatch-watchdog.md`. |
| 2-7 | FIX | §5.3: Detail's head word follows `deliveryLook` (`2 to fix`, amber); the Pipeline step keeps its own mark. |
| Minor `spec:145-146` | FIX | Trigger match now excludes the bot and system notes and matches `@coderabbitai full review` explicitly (§4.2, from builder check extras). |
| Builder checks 1, 3, 5, 7 | FIX | Run read-only on 2026-11-13; results recorded in spec §9 and §4.1/§4.2 rewritten on check 5's evidence. Check 2 needs a GitLab write: parked. |

Other Minors stay as written for the builder; the spec has reached its 2-round limit.
