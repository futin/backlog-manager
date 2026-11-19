## Verdict: REVISE

Review 2 of `docs/superpowers/specs/2026-11-19-jira-detail-tabs-design.md` (`spec` below), read at `2862baa8` against the code, the four mocks,
`00-mock-audit.md`, `CLAUDE.md`, `.claude/rules/board.md`, `jira.md`, `gitlab.md` and `.claude/DESIGN.md`.

One Critical, nine Important, thirteen Minor. Review 1's findings are fixed as its rulings say, with two exceptions re-raised here on new evidence (I1, I2).
The Critical is new: it comes from the stamp review 1's I10 asked for, combined with the guard review 1's I1 asked for.

One claim could not be checked from this repo and is parked with autopilot (`parked #1`): whether the external `mr-review-loop` skill defines its own
trigger comment (I9).

## What this proposes

Jira Detail stops being a two-column dialog and becomes one body component — heading, a summary strip (status, assignee, sprint, parent, one delivery pill per
target branch, the agent's state) and four tabs: Ticket, Delivery, Agent, Children & comments — with the last tab used remembered in localStorage. Two frames
draw that body: the existing `ui/Modal` composer, and a new fifth Jira page `ticket`, held by a key in a second store, reached by `Open full page`, a
Cmd/Ctrl/middle click on any surface that opens Detail, or a rail row drawn only while a key is held. The Delivery tab groups the ticket's MRs by
(project, target branch), draws each group's lead as a fold row that expands into today's pane, folds the group's older MRs under it, and replaces "skipped"
with a next-step marker, one row button per state and a browser-local `Ignore`. History folds, Stop leaves review sessions' cards, and the review bot's
product name leaves every drawn string and the `request` prompt.

## How the existing system works, per this document

Detail is `JiraDetail`, the one composer of `ui/Modal`'s split shape: an Agent column (session band with `Run ▾`, `DeliveryPane`, History) and a Ticket
column (facts with `Move to` and `Assign to me`, description, children, worktrees, the comments note). It opens on the card's `JiraIssue` and then reads
`GET /api/jira/issue/:key`; `JiraView` holds the walk (`OpenSlot`s), the one launch sheet and the write counter. Delivery is `lib/delivery.ts`:
`ticketDelivery` picks a lead MR with `leadOrder`, `deliveryLook` gives words, tone and a five-step track (pushed, open, review, pipeline, merged), and
`ReviewRow` under the lead's track opens the launch sheet in review mode. The Jira section has four pages in `JIRA_PAGES`, held by a `persistedStore` and
switched only by the rail's tree or `onOpenJiraPage` threaded from `App`; there is no router.

## Critical

### C1. The ignore store's guard drops the very ignore decision 12 exists for

`spec:329-334` stores a Review ignore as `review?: { state, landedAt }` and has the guard keep "only well-formed entries (… string stamps) and drops the
rest"; test 29 (`spec:460`) pins it: "a non-string stamp … reads those entries as absent".

`GitlabReview.landedAt` is `string | null` (`shared/types.ts:752`), and a review reads `none` exactly when no landing exists
(`shared/review.ts:41`, rule 3: `at(review.landedAt) === null`). So every ignore taken on rows 1, 3 and 11 carries `landedAt: null`, as can one on `open`
or `unknown` (neither needs a landing: `shared/review.ts:34,39`). The guard throws each of them away on the next read. Decision 12's named case
(`spec:115-116`, "a repo with no review bot, where Review would otherwise read `next` forever") therefore cannot be ignored at all: the click writes an
entry the store then refuses to return. Test 7's "an ignored `none` review over a success pipeline → row 9" (`spec:421-422`) hands `ignored` to
`deliveryNext` directly, so it stays green while the feature is broken.

Suggested fix: let the review stamp be `string | null` in the shape, the guard and test 29 (a `null` stamp compares equal to a `null` `landedAt`), and add a
store-level case: ignore a `none` review, re-read the store, the entry is still there.

## Important

### I1. `review: null` is not only "the first poll's gap" (re-raise of 1-I9, on the rule text)

`spec:297` (row 2: "transient, the next poll answers") and `spec:316` ("it is the first poll's gap, not a state"). `.claude/rules/gitlab.md:39`: "an MR
never read successfully stays `null`". An open MR whose discussions read keeps failing sits on row 2 for good: no button, no `Ignore`, never `merge` —
the dead end `unknown` was given `Ignore` to avoid (`spec:315-316`). Fix: correct the sentence and either offer `Ignore` on row 2 too or state the dead
end as accepted.

### I2. Rows 2, 7, 13 and 14 name a pill the mock does not draw, and the audit is silent (rest of 1-I7)

`spec:297,302,308,309` set the pill to `deliveryLook(mr).chip`. `chip` carries the iid and a glyph (`!482 · ◷ running`, `!482 · merged`:
`client/src/lib/delivery.ts:197,231,250`), and the compact line already prints `!<iid>` (`spec:257`), so the row would read the iid twice.
`States.dc.html` draws `open`, `pipeline running`, `merged`, `closed` there — no iid, and `pipeline running` is `DeliveryLook.word`, not `chip`.
`00-mock-audit.md` has no row for it. Fix: name the field that matches what should be drawn (or say the doubled iid is meant) and add the audit row.

### I3. Test 25's stored value contradicts §4.5.1's shape

`spec:455` — "`Ignore` on a failed pipeline writes `{ pipeline: 'failed' }` under `<project>!<iid>`". §4.5.1 (`spec:329-330`) fixes the entry as
`pipeline?: { status, updatedAt }`, and the guard (`spec:333`) would drop the test's value as malformed. Fix: `{ pipeline: { status: 'failed', updatedAt:
<the MR's> } }`.

### I4. "Pruned of MRs not in the current delivery on every write" can delete other tickets' ignores

`spec:338`. The store is one object for the whole browser (`spec:329`). If "the current delivery" is the ticket on screen — the natural reading inside
Detail — one `Ignore` on ticket A removes every ignore on tickets B, C, …. If it is the whole GitLab payload, a write made while the payload is `null`
(`client/src/lib/delivery.ts:50`) or missing a project prunes everything. Fix: say what the prune compares against and that it never runs on an absent
payload.

### I5. The page has no specified shape while the read is pending or failed

`spec:190-193` says the page shows `loading…`, then on failure today's line, and that "the body draws it"; `spec:383-384` says the failure line is carried
by "the Ticket tab". But the page has no card (`spec:74`), so with no detail there is no `issue` to build a heading, strip, tab row or Ticket tab from
(`spec:127`: the body draws "from `{ issue, detail, ... }`"). Unstated: whether the heading/strip/tabs are drawn at all in those two states, what the top
bar's crumbs hold beyond `<KEY>`, what `Run ▾` is (`JiraRunMenu` needs an issue: `client/src/components/jira/JiraDetail.tsx:357`), and whether the walk's
`← <key>` chip (in the heading, `spec:132`) survives a failed step so the reader can go back rather than `Forget`. Each walk step on the page is a fresh
read, so these states are seen on every step, not once. Fix: state the page's loading and failed frames (what of top bar, heading and Back is drawn).

### I6. The strip's Delivery cell has no empty state

`spec:147` defines the cell only for targets. Not said: what it draws for `kind: 'none'` and `'unknown'` (zero groups — the anti-goal at `spec:65-66`
says "`unknown` still says unknown"), and whether the cell is drawn when the Delivery tab is not (`hidden`, or `deliveryShown` false, `spec:163`). Sprint
and Parent say "absent → cell not drawn"; Delivery says nothing. Fix: one line per case.

### I7. `+N` can hide the alarm the strip promises to show

`spec:147` caps the pills at three then `+N`; `spec:153-155` and the anti-goal (`spec:61-62`) say a failed pipeline or findings to fix "are all visible on
every tab". Groups are ordered by `leadOrder` (`spec:246`: open first, then newest `updatedAt` — `client/src/lib/delivery.ts:76-83`), not by badness, so
with four or more targets a red or amber one can sit inside `+N`. "Left to the builder" (`spec:491`) also reopens the cap `spec:147` just fixed. Fix:
say what `+N` shows when a folded target is red/amber (or order the pills worst-first), and settle the cap in one place.

### I8. The Agent pill's words have no source, and decision 7 names a pill §1.2 cannot produce

`spec:148` — the live pill is `<state label> · <age>`; no function or table is named for the label, and the age's start (`startedAt` or `stateSince`) is
not said. Decision 7 (`spec:110`) calls it "the `Review live` pill in the strip"; `Review live` is not a session state, and the audit maps that mock text
to the Agent tab's card instead (`00-mock-audit.md`, row "B-Modal | Agent tab live card"). An implementer cannot tell whether the strip reads
`Review live · 4m` or `working · 4m`. Fix: name the label's source (and the `starting` reservation's word), and reword decision 7 to match.

### I9. §4.7 rests on a fact about a skill this repo does not hold

`spec:352-353` — the prompt "tells the session to post the review trigger the mr-review-loop skill uses — the skill owns its trigger". The skill is the
external `timify-gitlab` plugin's (`docs/subsystems/gitlab.md:19`); nothing in this repo shows that its trigger step names a comment. Today the prompt is
the only place the text exists (`server/src/jira/prompt.util.ts:168-169`: "post a comment `` `@coderabbitai review` ``"). If the skill's step does not
carry the text, a `request` session has no trigger to post. Not verifiable here; parked. Fix: cite the skill's step that defines the trigger, or keep a
fallback sentence in the prompt.

### I10. The key guard is a second, different definition of a Jira key

`spec:182` — `/^[A-Z][A-Z0-9_]*-\d+$/`. The repo's one definition is `JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/` (`shared/types.ts:1390`; `+`, not `*`),
and board.md's rule is one home per derivation. Fix: have the guard use `JIRA_KEY_RE`.

## Minor

- `spec:28-29` — "the `demo` MR is invisible unless it happens to lead": the `Also:` line does draw it, link, word, repo and age
  (`client/src/components/jira/DeliveryPane.tsx:117-133`); what is missing is its target, track and review row.
- `spec:30` — "only for a ticket the board's poll holds": a Sessions row opens tickets that are off the board
  (`client/src/components/jira/JiraSessionList.tsx:318`).
- `spec:148` — `Unassigned`; today's word is `unassigned` (`client/src/components/jira/JiraDetail.tsx:502`). Say which.
- `spec:160-161` — the Agent tab's "ended count" and the Children count have no stated wording (`N ended`? a bare number?).
- `spec:165-166` — the GitLab payload is `null` until it lands, so a remembered `delivery` draws Ticket and then jumps; one sentence either way (1-M, open).
- `spec:174-175` — `Resolved <date>` names no formatter; `Created · updated` uses `issueDatesLine` (`JiraDetail.tsx:524`).
- `spec:208-211` — "These surfaces are buttons": the card is a `div role="button"` (`client/src/components/jira/JiraCard.tsx:93`) and the list rows are
  `<tr onClick>` (`JiraIssueList.tsx:367`, `JiraSessionList.tsx:331`). The Children row is in the list of surfaces but not in test 23 (`spec:451`).
- `spec:216` — `Mentions` is a possible origin, yet nothing in scope opens the page from Mentions (`spec:53`).
- `spec:252-253` — the mocks' head line also reads `· newest per target shown · click a row for the full track`; the spec drops it and the audit has no row.
- `spec:299,315` — `reviewStepWord(review)` takes `now` too (`client/src/lib/review-copy.ts:46`). `spec:300` — "today's split, fix half preset": the row's
  button is a lone half with no menu (`client/src/components/jira/ReviewRow.tsx:14-15`); `Fix review` is the label.
- `spec:309` — "closed — (it is an older MR)": a closed MR is the representative of a group that holds only closed MRs (`leadOrder`).
- `spec:318` — `Open session` on a target row opens the newest live review link on the KEY, which may be reviewing another target's MR; and `SessionOpen`'s
  hand-over refusal has no stated place in the next row. `spec:375` — `last <date, time>` still names no formatter.
- `spec:443-462` — cases 24-29 sit under "Page (jsdom)", numbered 24, 25, 27, 28, 29, 26; test 12 (`spec:434`) says "the review row" where §4.2 now calls
  it the next row, and assumes `develop` leads without fixing `updatedAt`.
- `spec:474-482` — §10 misses `docs/overview.md:219` and `docs/subsystems/jira.md:324` (both say "four pages"), board.md's Escape rule naming
  `components/jira/JiraDetail.tsx` as the Move-to popover's home, `persistedStore.ts`'s header list of its users, and `← <origin>` / `Forget` among the
  threaded links. `spec:403` — "Server: no route, no type, no request" sits beside §4.7's prompt change; say "except §4.7".

## Checked and found true

`JIRA_PAGES` and the rail drawing it (`client/src/lib/jira-page.ts:15`, `client/src/components/SideRail.tsx:309`); `onOpenJiraPage` as `setJiraPage` then
`change` (`client/src/App.tsx:292-293`); `JiraView` hosting the launch sheet, `nudge` and the walk, and clearing both slots on a page change
(`client/src/components/jira/JiraView.tsx:83,85,90`); `persistedStore<V extends string>` (`client/src/hooks/persistedStore.ts:22`); `fetchJiraDetail`
rejecting with a sentence only (`client/src/lib/jira.ts:1253-1258`); the track order pushed, open, review, pipeline, merged and a draft's Pipeline `off`
(`client/src/lib/delivery.ts:176-181,227`); `GitlabPipeline` with `'none'` and `pipeline: … | null` (`shared/types.ts:3931,776`); `unknown` as rule 0
(`shared/review.ts:34`); `JiraLink.action` (`shared/types.ts:1129`); Stop offered only through `JiraSessionCard`, on `stopState` and agents on, Unlink on
`branch` only (`client/src/components/jira/JiraSessionCard.tsx:142-143`); `bandSub`, `nextLine` and both gate sentences (`JiraDetail.tsx:356,361`); the
comments sentence and the failure line (`JiraDetail.tsx:550,577`); `JiraRunMenu`'s `home="modal"` (`JiraRunMenu.tsx:84`); the one drawn bot name
(`client/src/lib/review-copy.ts:97`) and the prompt's trigger text (`server/src/jira/prompt.util.ts:169`); the `jira/` → `gitlab/remote.util.ts` rule
(`.claude/rules/jira.md:173`); the two invariants headings §10 renames (`docs/subsystems/invariants.md:3460,4384`); test arithmetic of cases 3, 6 and 12.

## Rulings

| id | outcome | evidence |
| -- | ------- | -------- |
| 2-C1 | FIX | `GitlabReview.landedAt: string \| null` (`shared/types.ts:752`), `none` = no landing (`shared/review.ts:41`); `null` is now a valid review stamp; test 29 adds the store round trip for an ignored `none` review |
| 2-I1 | FIX | `.claude/rules/gitlab.md`: an MR never read stays `null`; row 2 now offers Ignore, stored as `'unread'`, with a sentence |
| 2-I2 | FIX | `.chip` carries the iid (`client/src/lib/delivery.ts:203,232`); waiting/done pills read `deliveryLook(mr).word`; audit row added |
| 2-I3 | FIX | test 25 writes `{ pipeline: { status, updatedAt } }` |
| 2-I4 | FIX | prune drops only this ticket's groups' no-longer-open MRs; never other tickets'; never on a `null` payload or non-`mrs` delivery; test 30 |
| 2-I5 | FIX | page frame before an issue exists: crumbs `Jira / <KEY>`, `← <origin>`, no `Open in Jira`/`Run ▾`, Back chip + key, loading/failure; later failed re-read keeps the issue |
| 2-I6 | FIX | strip Delivery cell: `no MR`, `unknown`, not drawn when the tab is not |
| 2-I7 | FIX | pills ordered worst tone first, `+N` in the worst folded tone; "Left to the builder" cap line removed |
| 2-I8 | FIX | label `STATE_LABEL[state]` (`shared/jira-sessions.ts`), age `pollAge(stateSince | startedAt)` as `JiraSessionCard.tsx:110,197`; decision 7 reworded |
| 2-I9 | FIX | trigger is the skill's (external plugin, unverifiable here); prompt keeps a fallback: mention the repo's review bot with `review`, naming no account itself. Parked #1 answered by this |
| 2-I10 | FIX | guard uses `isJiraKey` / `JIRA_KEY_RE` (`shared/types.ts:1390`) |
| 2-M3 | FIX | `unassigned`, today's word (`JiraDetail.tsx:502`) |
| 2-M7 | FIX | surfaces described as clickable elements, not buttons |
| 2-M11 | FIX | row 14 covers a closed-only target's representative |
| 2-M13 | FIX | tests renumbered in order; test 12 says "next row" |
| 2-M14 | FIX | §10 adds overview.md, subsystems/jira.md, board.md Escape rule, persistedStore header; §8 "except §4.7" |
| 2-M (others) | DECLINE | wording/formatter choices left to the plan (formatters: `issueDatesLine` style for `Resolved`, `formatZonedClock` for History's `last`) |
