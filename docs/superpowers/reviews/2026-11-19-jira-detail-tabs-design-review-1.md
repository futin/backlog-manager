## Verdict: REVISE

Review 1 of `docs/superpowers/specs/2026-11-19-jira-detail-tabs-design.md` (referred to as `spec` below), read against the code at `6bf059c1`, the four
mocks, `00-mock-audit.md`, `CLAUDE.md`, `.claude/rules/board.md`, `jira.md`, `gitlab.md` and `.claude/DESIGN.md`.

One Critical, twenty Important, eleven Minor. The shape of the design (strip + four tabs, one body in two frames, a fifth page, per-target rows) is sound and
most of its statements about the code check out. What blocks it is concentrated in two places: §4.5 / §4.5.1 (the next-step rule, which several sections
describe differently and which leaves real states uncovered) and §4.7 (a server change that runs into a `jira.md` import rule).

## What this proposes

Jira Detail stops being a two-column dialog and becomes one body component: a heading, a summary strip (status, assignee, sprint, parent, one delivery pill
per target branch, the agent's state) and four tabs — Ticket, Delivery, Agent, Children & comments — with the last tab used remembered across tickets. The
same body is framed twice: by the existing modal and by a new fifth Jira page, `ticket`, held by key in localStorage, reached from the modal's
`Open full page`, a Cmd/Ctrl/middle click on any surface that opens Detail, or a conditional rail row. The Delivery tab groups every MR of the ticket by
(project, target branch), shows each group's newest MR as a fold row that expands into today's Delivery pane, folds the group's older MRs under it, and
replaces "skipped" with a "next step" marker plus one row button and a browser-local `Ignore`. History folds, Stop disappears from review sessions, and the
review bot's product name leaves every drawn string and the review prompt.

## How the existing system works, per this document

Detail today is `JiraDetail`, a composer of `ui/Modal`'s split shape: an Agent column (session cards, `DeliveryPane`, History, `Run ▾`) and a Ticket column
(facts with `Move to` and `Assign to me`, description, children, worktrees, a comments note). It opens from a card's `JiraIssue` and then reads
`GET /api/jira/issue/:key` for description, children, transitions and boards; a walk through children and the parent is held by `JiraView` as `OpenSlot`s.
Delivery comes from `lib/delivery.ts`: `ticketDelivery` sorts a ticket's MRs with `leadOrder`, and Detail draws only the lead plus an `Also:` line, with
`ReviewRow` under the lead's track opening the launch sheet in review mode. The Jira section has four pages in `JIRA_PAGES`, held by a `persistedStore` and
switched only by the rail's tree or a link threaded down from `App` as `onOpenJiraPage`; the client has no router.

## Critical

### C1. §4.7's prompt change needs an import `jira.md` forbids, and names a function that does not exist

`spec:325-326` — "The review session's prompt (`server/src/jira/prompt.util.ts`, `request` half) stops hard-coding `@coderabbitai` and names the account
`BM_GITLAB_REVIEW_BOT` resolves to (`reviewBot` in `server/src/gitlab/env.util.ts`, default unchanged)."

- The reader is `gitlabReviewBot` (`server/src/gitlab/env.util.ts:47`), not `reviewBot`.
- `.claude/rules/jira.md:173` is explicit: "`jira/` imports `gitlab/remote.util.ts` for `isGitlabProjectPath` and for nothing else". `prompt.util.ts`
  today has exactly that one edge (`server/src/jira/prompt.util.ts:41`). Built as written, `prompt.util.ts` imports `gitlab/env.util.ts` and breaks the rule.
- `reviewText(key, half, mr)` (`server/src/jira/prompt.util.ts:162`) takes no bot name, and the same text is composed for `GET /api/jira/prompt` (the
  preview, in `jira/`) and for dispatch (in `agents/`). The spec does not say who reads the env or how the name reaches both callers so that the preview
  still equals the spawn.
- `.claude/rules/jira.md:176` states the mechanism in words ("posts the `@coderabbitai review` trigger"). §10 (`spec:433-438`) does not list `jira.md`, so
  the rule file would be left contradicting the code.
- `test/jira/jira-prompt.test.ts:542,556` pin `@coderabbitai review`; they stay green only because the default is unchanged, which the spec should say.

Suggested fix: state the route for the bot name (a parameter threaded from each caller, or the reader moved somewhere `jira/` may import, or an explicit
amendment of the `jira.md` rule), use the real function name, and add `.claude/rules/jira.md` to §10.

## Important

### I1. `persistedStore` cannot hold either new value as specified

`spec:310` stores the ignored steps "in a `persistedStore`" as a map `<project>!<iid>` → `{ review?, pipeline? }`; `spec:176-177` makes the ticket key
"a second `persistedStore` … a string or `null`". `persistedStore` is `persistedStore<V extends string>` and its header says "one closed string value"
(`client/src/hooks/persistedStore.ts:4,22`). An object does not fit, and neither does `null`. The builder must either widen the shared store (five existing
callers, a documented contract) or use something else. Fix: name the storage for each (e.g. `''` for no key; a different hook or a widened store for the map)
and, for the map, the guard that validates what localStorage hands back.

### I2. Three sections disagree on whether the next-step rule reaches the card, List and deck

`spec:55` (Non-goals): "Only the shared Review-step rule (§4.5) reaches them." `spec:371` (§8): "The board card, the List, the agent deck (except §4.5's
shared rule)." Against `spec:106` (decision 4, "Detail only, the card and List unchanged") and `spec:270-271` (§4.5, "Detail only: the card, the List, the
band and the filters keep `deliveryLook` as it is, and `deliveryLook` itself does not change"). Fix: delete the two exceptions, and name in §8 what does
reach other surfaces — §4.7's `reviewRowText` prefix and nothing else.

### I3. The Goals remove Stop from the Detail card; the decision removes it from review sessions only

`spec:45` lists "Stop on the Detail card, §5.1" among what is removed. `spec:107-108` and `spec:339-340` hide it only where the link's `action` is
`'review'` and keep it "exactly as today" otherwise (`client/src/components/jira/JiraSessionCard.tsx:143`). Fix: reword line 45 to "Stop on a review
session's card".

### I4. "No field carries `Resolved`" is false

`spec:169-170` — "The mock's `Resolved` row is not drawn — no field carries it today, and this spec adds no Jira request." `JiraIssue.resolved: string |
null` exists (`shared/types.ts:951`) and `JiraIssueDetail extends JiraIssue` (`shared/types.ts:1172`), so the detail read already carries it. Fix: either
draw it or give the real reason it is left out; correct the audit row (`00-mock-audit.md:11`) to match.

### I5. §4.5's table omits a real pipeline value, and row 10's word contradicts "unchanged"

`spec:276-291` covers pipeline `running`, `failed`, `success`, `canceled` and `null`. `GitlabPipeline` is `'success' | 'failed' | 'running' | 'canceled' |
'none'` (`shared/types.ts:3931`) and `GitlabMr.pipeline` is that or `null` (`shared/types.ts:776`); `'none'` (read, no pipeline, or a status with no word —
`skipped`, `manual`) has no row, and test 7 (`spec:387`) pins "exactly" fourteen rows. Row 10 (`spec:287`) also says the Pipeline step "reads `none`", while
today's word for that step is `open, no pipeline` (`client/src/lib/delivery.ts:250`, drawn at `client/src/components/jira/DeliveryPane.tsx:50`) and §4.5
says `deliveryLook` does not change. Fix: add `'none'` to row 10 and state the step's word.

### I6. `deliveryNext(mr, now)` cannot answer what the spec and its tests ask of it

`spec:270` fixes the signature as `deliveryNext(mr, now)`, "pure", answering "which track step is next and what the row's one button does". Test 7
(`spec:387-389`) requires it to honour ignores, and row 5's button (`spec:282`, `spec:299-300`) depends on whether a live `review` link is on the key.
Neither is derivable from an MR and a clock. Fix: give the real inputs (the ignore entry for that MR, and either the live-review fact or a button kind the
caller resolves).

### I7. The compact pill and the ringed step's word are not determinable from the text

- `spec:246-247` and `spec:273-274` say the pill is "`deliveryLook`'s chip word". `DeliveryLook` has `chip` (`!482 · ✓ pipeline`, with the iid) and `word`
  (`pipeline passed`) (`client/src/lib/delivery.ts:153-154`); "chip word" is neither. `States.dc.html` draws `pipeline running` (the `word`) for row 7,
  `open` (the `chip` tail) for row 2, and `reviewing… 4m` for row 4 — which is `reviewStepWord`, not `deliveryLook` at all.
- `spec:273` says the pill reads `next: <step word>`, but rows 1, 3 and 11 (`spec:278,280,288`) give no word. The mocks draw `next: review`.
- `spec:272` says the track shows "the word `next` under the step label, replacing the step's own word". Both mocks draw `next · review` /
  `next · fix 3` / `next · merge` — the word kept after `next`. Test 14 (`spec:403`) follows the spec's reading; the audit names no difference.
- `fix <n>` (`spec:282`) does not say whether a capped count reads `fix 3+`, as every other count does (`client/src/lib/review-copy.ts:19`).

Fix: one table column for the pill text of all fourteen rows (waiting rows included), one sentence for the track word, and name the `DeliveryLook` field.

### I8. Where the row button and `Ignore` are drawn is not specified, and three buttons have no home

§4.2's compact line (`spec:245-247`) lists its contents and no button; the expanded row is "today's `DeliveryPane` … unchanged in content"
(`spec:248-249`). §4.5 then gives every row "one button" (`spec:270`) and §4.5.1 an `Ignore` "after the row button" (`spec:304`). `States.dc.html` draws
both on the compact line; `Main.dc.html` draws them in the expanded pane's review row. For Review steps the expanded home is `ReviewRow`; for `Merge in
GitLab ↗`, `GitLab ↗` and `Run ▾` (`spec:285-289`) there is none — the mock invents a sentence row (`Reviewed and green — merge happens in GitLab`) the
spec never mentions. If the button sits on the compact line it is an interactive control inside a `details` summary, which needs saying. Row 8
(`spec:285`) is also ambiguous on its own: "`Run ▾` (the frame's, scrolled to; no new action)" does not say whether the row draws a button that focuses the
head's chip or opens its menu, nor what it does while that chip is disabled (`live`) or dashed (`no-repo`); the mock draws a full `▶ Run ▾` split in the row.
Fix: state the home(s), the non-review rows' sentence if one is drawn, and row 8's exact behaviour.

### I9. Two waiting states never end and cannot be ignored — the case decision 12 exists to prevent

Decision 12 (`spec:115-116`) adds Ignore so Review does not "read `next` forever". But `review: null` (row 2, `spec:279`) and `unknown` (`spec:296-297`,
"treated as `reviewing`: waiting, no button") are waiting rows with no button and no `Ignore` (`spec:304` lists rows 1, 3, 5, 6, 8, 11, 12). `unknown` is
permanent while the MR has more threads than the page budget (`shared/review.ts:33`), and `null` persists for as long as the review read never succeeds
(`.claude/rules/gitlab.md:38`). Such an MR can never reach `merge`. Fix: say what those two rows offer (Ignore, or Merge straight away), or say the dead end
is accepted.

### I10. An ignore keyed on the state alone does not make "a fresh failure judged fresh"

`spec:311-312` — the ignore "holds only while the step still reads that state … so a fresh failure is judged fresh. The pipeline carries no id". The drop
happens "on the next read", and reads happen only while Detail is open on that ticket in this browser. `failed` → re-run → `failed` between two looks (or
`open` → re-review → `open` with new findings) reads the same state, so the ignore stands over a new failure. Fix: either state this as the accepted
limit and drop the "judged fresh" claim, or key on something that moves (the MR's `updatedAt`, the review's `landedAt`).

### I11. The crumbs are drawn by the body in §1.1 and by the frame in §2.1 and §7.1

`spec:127-128` — the body "draws the heading, strip, tab row and four panes … neither [frame] draws any of its parts". `spec:132-133` puts the crumbs
(type glyph, key, type, parent link, sprint, the Back chip) in that heading. `spec:358` then says the modal's "head holds the crumbs on the left", and
`spec:185` gives the page's top bar its own crumbs (`Jira / <board name> / <parent key> <parent summary> / <KEY>`). Read literally the page shows the key
three times and the parent twice; the mocks show frame crumbs plus a heading of type, key and label tags only. Fix: say once which crumbs each frame draws
and what the body's heading holds, including where the walk's `← <key>` chip sits in each frame.

### I12. The strip's Agent cell does not say which session it shows when several are live

`spec:146` — "live: a pill `<state label> · <age>` led by the state's dot". A key can hold several live links and a `starting` reservation
(`client/src/components/jira/JiraDetail.tsx:252-256,350`). The anti-goal (`spec:61-62`) is that a session waiting on an answer always shows; with the
newest session working and an older one waiting, "the newest" hides it. Fix: name the lead rule (the deck's, `lib/jira-deck.ts`, already orders by
urgency) and the `+N` and `starting` cases.

### I13. §5.1 calls the band "unchanged" while changing its copy and dropping two lines without a home

`spec:334-335` quotes the empty state as `No live session on this ticket.`; today it is `No session on this ticket`
(`client/src/components/jira/JiraDetail.tsx:401`) — the spec's string is the mock's. With `Run ▾` moved to the frame's head, two things that sit beside it
today lose their place and §3's table (`spec:213-226`) lists neither: the gate lines `Next Run can start once this one is quiet.` / `Quiet — a new Run can
start now.` (`JiraDetail.tsx:361,375`) and the empty band's `default: <action> · last run <age>` sub-line (`JiraDetail.tsx:356,402`). The Goals promise
nothing is lost except what is removed by name (`spec:45`). Fix: fix the string and place or remove the two lines by name.

### I14. The Children & comments tab has no empty, loading or failed state

`spec:350-352` makes `Children <count>` a fold "open by default holding today's Children section". Today that section is drawn only when the detail landed
and has children (`JiraDetail.tsx:271,560`). The tab is always drawn, so a ticket with none, a detail still loading and a failed read all need words.
`Main.dc.html` draws `Children none` / `No child tickets.` and `Comments are read in Jira ↗`; the spec keeps today's comments sentence and is silent on
the children case, and the audit names neither difference. Fix: specify the three states and add the two audit rows.

### I15. `ticket` with no key is resolved by a mechanism that does not do that

`spec:177-178` — "the hold-and-fall resolves it to `board` (the same shape as an unknown stored page today)". An unknown stored page is turned into `board`
by the store's guard on read (`client/src/hooks/useJiraPage.ts:11`). `App`'s hold-and-fall moves the SECTION "on `configured === false` and on nothing
else" (`.claude/rules/board.md:66`, `client/src/App.tsx:264`). The guard cannot see a second store. Fix: say where the check lives (`JiraView`'s page
switch, or the store's read) and whether it writes `board` back or only renders it.

### I16. The page's 404 branch cannot be told from any other failure, and its copy is not given

`spec:183` — "A 404 (no such ticket, or not visible) says so and offers `← Board`." `fetchJiraDetail` rejects with a sentence only
(`client/src/lib/jira.ts:1253-1255`); no status reaches the caller. "Says so" is not copy. The failed-read line also changes wording from today's
`could not read the ticket — …` (`JiraDetail.tsx:550`) to `could not read <KEY> — …` without saying whether the modal follows. Fix: name the change to the
helper (or drop the separate branch), give the exact sentence, and state which frame uses which failure line.

### I17. A dead key is a permanent rail row

`spec:191-193` — the row is "drawn only while a key is held" and the key "is never cleared by leaving". Nothing ever clears it: a ticket that 404s
(deleted, moved, another site after a config change) leaves a rail row that opens an error page until some other ticket is opened on the page. Fix: say
whether a 404 clears the key, or that the row stays by design.

### I18. Counts have no singular or zero rule

`spec:255` — `<N> earlier MRs into <target> · <x merged>, <y closed>`; `spec:241` — `<N> targets · <M> MRs`; `spec:247` — `+N earlier`. One older MR reads
`1 earlier MRs`; a group with no closed MRs reads `…, 0 closed` or drops the part — not said. §1.3 does give `1 target` (`spec:155`), and the repo's rule
is singular at 1 and zero parts omitted (`client/src/lib/review-copy.ts:9`, `client/src/lib/delivery.ts:264`). Fix: state both rules for these three strings.

### I19. The audit does not list "every such place"

`spec:15-16` and `00-mock-audit.md:4` claim every mock/spec difference is listed. Not listed:

- `Main.dc.html` and `B-Modal.dc.html` draw `CR: not reviewed` on the compact row; the spec draws `reviewStepWord` alone (`spec:247`). `CR:` is the product's
  initials, against decision 14 (`spec:119-120`) and the audit's own last row (`00-mock-audit.md:19`).
- The Delivery head reads `2 targets · 6 MRs · newest per target shown · click a row for the full track`; the spec stops at `<N> targets · <M> MRs`
  (`spec:241`).
- The track word `next · <word>` versus the spec's `next` (I7).
- `Main.dc.html`'s Agent tab draws no count with five ended sessions; the spec draws the ended count (`spec:155-156`).
- The strip's `Review live · 4m` (`B-Modal.dc.html`, and decision 7 at `spec:110`) versus `<state label> · <age>` (`spec:146`) — `Review live` is not a
  `STATE_LABEL`.
- The Children and Comments copy (I14) and `No live session on this ticket.` (I13).
- `States.dc.html` numbers a row 15 (clean draft) the spec's table does not have (`spec:12` says fourteen plus two ignored).

Fix: add the rows, or change the spec where the mock was the intent.

### I20. §10 leaves rule text contradicting the code

`spec:433-438` renames one `board.md` title. Left stale by this spec:

- `.claude/rules/board.md:133` — "`ReviewRow` … draws … for the LEAD MR only (`Also:` MRs get none)"; §4.4 (`spec:261`) puts it on every open target and
  §4.2 removes `Also:`.
- `.claude/rules/board.md:126` — `JiraRunMenu` is "the card's marker row and the Detail dialog's agent column"; §3 moves it to the frame's head.
- `.claude/rules/jira.md:176` (C1).
- `.claude/DESIGN.md:738` (§8.9.5, "opened by the CodeRabbit row's button") — decision 14 says no doc of this change names the bot.
- `docs/subsystems/invariants.md`: the anchors `board.md:76` and `board.md:142` link to are titled "four pages" and "the CodeRabbit button"; retitling
  the bullets without the headings (or the reverse) breaks the links `test/guards/claude-rules.test.ts` reads.

Fix: list each in §10.

## Minor

- `spec:145` — the Delivery pill's tone is cited as "§4.3", which is Older MRs; it is `deliveryLook`'s (§4.2).
- `spec:145` vs `spec:446` — the strip caps "at most three then `+N`" in §1.2 and leaves "cap at three or fit-then-`+N`" to the builder; what a `+N` click
  does is unsaid.
- `spec:144` — `Unassigned`; today's drawn word is `unassigned` (`JiraDetail.tsx:502`). Say if the capital is intended.
- `spec:122-123` — the list of marked calls names §3, which carries no "my call".
- `spec:205` — `Mentions` is listed as a possible origin, but nothing in scope opens the page from Mentions (`spec:53`).
- `spec:201` — the title gains `⌘-click: full page` on every platform, though the gesture is Ctrl-click off macOS (`spec:198`).
- `spec:158-161` — the GitLab payload is `null` until it lands (`DeliveryPane.tsx:85-86`), so a remembered `delivery` opens on Ticket and jumps to Delivery a
  moment later. Worth one sentence either way.
- `spec:344` — `last <date, time>` names no formatter (`formatZonedClock` is the card's).
- `spec:352` — "the tree's tree is".
- `spec:399-400` — test 12 assumes `develop` leads and that the lead's review state has a `reviewRowText` sentence; the fixture of case 3 fixes neither.
- `spec:419-423` — tests 24-26 are body and server cases listed under "Page (jsdom)".
- `spec:185` — the board crumb needs the picked board without `usePickedJiraBoard`, which mounts the board load (`client/src/hooks/usePickedJiraBoard.ts:43`)
  that §6 says the page does not mount.

## Checked and found true

`JIRA_PAGES`, `useJiraPage` and its stale header (`client/src/lib/jira-page.ts:15`, `client/src/hooks/useJiraPage.ts:5`); `OpenSlot` and the launch shape
(`client/src/components/jira/JiraView.tsx:68,90`); dispatch accepting any open MR carrying the key or its parent's
(`server/src/agents/jira-dispatch.service.ts:301`); `leadMr` / `leadOrder` and the claim that the first group's representative is the overall lead
(`client/src/lib/delivery.ts:76-93`); the Delivery tab's draw condition (`DeliveryPane.tsx:85-88`); a draft's Pipeline step staying `off`
(`delivery.ts:227`); Stop's two conditions and Unlink on `branch` only (`JiraSessionCard.tsx:142-143`); the one drawn bot name (`review-copy.ts:97`);
`Modal`'s required `facts` slot (`client/src/components/ui/Modal.tsx:82`); the test arithmetic of cases 3, 6 and 12.

## Rulings

| id | outcome | evidence |
| -- | ------- | -------- |
| 1-C1 | FIX | `.claude/rules/jira.md` allows `jira/` → `gitlab/remote.util.ts` only; §4.7 now has the prompt post the mr-review-loop skill's own trigger, naming no account; jira.md bullet added to §10 |
| 1-I1 | FIX | `persistedStore<V extends string>` (`client/src/hooks/persistedStore.ts:22`); key → `persistedStore<string>` with `''` = none + key-regex guard; ignore map → JSON module store, guard drops malformed entries |
| 1-I2 | FIX | Non-goals and §8 no longer say §4.5 reaches card/List/deck |
| 1-I3 | FIX | Goals: "Stop on a review session's card" |
| 1-I4 | FIX | `JiraIssue.resolved` exists (`shared/types.ts:951`); `Resolved <date>` drawn when non-null; audit row 11 updated |
| 1-I5 | FIX | `GitlabPipeline` includes `'none'`; row 10 covers `null` or `'none'`, Pipeline step keeps `pipelineWord`, not ringed |
| 1-I6 | FIX | `deliveryNext(mr, now, ignored)` returns step, word, pill, sentence, button kind and Ignore flag; caller maps `fix` → `Open session` |
| 1-I7 | FIX | Pill column added for all 14 rows; ringed label is `next · <word>` or `next`; `fix <n>+` when capped |
| 1-I8 | FIX | Next row replaces ReviewRow in the expanded pane; Sentence column for rows 8/9/10/12 and clean draft; row 8 is a second `JiraRunMenu`; compact line has no button |
| 1-I9 | FIX | `unknown` is permanent (`shared/review.ts` rule 0) → waits but offers Ignore; `null` is the first poll's gap, stated |
| 1-I10 | FIX | Ignore entry carries a stamp (`review.landedAt`, MR `updatedAt`); same-commit manual retry limit stated and accepted |
| 1-I11 | FIX | Crumbs are each frame's; body heading holds Back chip, key/tags, title |
| 1-I12 | FIX | Agent pill lead by attention order question → working → starting → other, newest first, then `+N` |
| 1-I13 | FIX | §5.1 keeps `No session on this ticket` + `bandSub`; gate line moves to the Agent tab top; §3 table row added |
| 1-I14 | FIX | Children: `loading…`, nothing on failure (Ticket tab carries it), `No child tickets.`; comments keep today's copy, audit row |
| 1-I15 | FIX | Empty key → `JiraView` draws Board and writes `board` back; App hold-and-fall named as uninvolved |
| 1-I16 | FIX | 404 branch dropped (`fetchJiraDetail` rejects with a sentence only, `client/src/lib/jira.ts:1253`); today's failure line in both frames; page adds `Retry` |
| 1-I17 | FIX | `Forget <KEY>` on a failed read clears the key and returns to the origin, so no permanent dead row |
| 1-I18 | FIX | Singular `1 target`/`1 MR`/`1 earlier MR`; zero parts omitted |
| 1-I19 | FIX | Audit rows added: compact review word, head-line hint, `next · <word>`, Agent count, `Review live · 4m`, comments copy, row 15; Main/B-Modal mock `CR:` text removed |
| 1-I20 | FIX | §10 adds board.md (ReviewRow lead-only and Run ▾ home), jira.md review bullet, DESIGN.md §8.9.5, invariants.md heading renames + anchor grep |
| 1-M1 | FIX | §1.2 Delivery tone cites §4.2 |
| 1-M6 | FIX | `Ctrl-click: full page` off macOS |
| 1-M9 | FIX | "the tree's tree" → "the tree" |
