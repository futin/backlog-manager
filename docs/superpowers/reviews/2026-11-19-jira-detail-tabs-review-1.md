## Verdict: REVISE

Plan: `docs/superpowers/plans/2026-11-19-jira-detail-tabs.md` (cited below as `plan:<line>`).
Spec: `docs/superpowers/specs/2026-11-19-jira-detail-tabs-design.md` (cited as `spec:<line>`).

## What this proposes

Jira Detail stops being a two-column dialog and becomes one body component (heading, summary strip, four tabs: Ticket, Delivery, Agent, Children &
comments) that two frames draw: the existing modal and a new fifth Jira page, `ticket`, opened by key from the modal, the rail or a modifier-click.
The Delivery tab groups the ticket's MRs per (project, target branch), shows one fold row per group with older MRs nested under it, and marks each
open MR's next step (review, pipeline, merge) with a ring, a `next:` pill and one button, plus a per-browser `Ignore`. Session history folds, Stop
disappears from review sessions, and the review bot's product name leaves the drawn copy and the review prompt. The work is eleven tasks: two pure
helper tasks, a stores task, three body tasks, the two frames, the copy change, docs and `/ui-verify`.

## How the existing system works, per this document

`JiraDetail.tsx` (779 lines) is a `ui/Modal` composer in the split shape: the facts slot is the agent column (sessions band with `Run ▾`,
`DeliveryPane`, History) and the body is the ticket column (facts with `Move to` and `Assign to me`, description, children, worktrees, comments
note). `lib/delivery.ts` owns every delivery word and tone; `leadMr` / `leadOrder` pick one lead MR and `DeliveryPane` draws it with an `Also:`
line, with `ReviewRow` acting on the lead only. The Jira section's page is `JIRA_PAGES` held by `useJiraPage`, a `persistedStore`, switched by the
rail's tree or `onOpenJiraPage` threaded from `App`; `JiraView` holds the modal's walk and the one launch sheet. `reviewRowText` prefixes
`CodeRabbit · ` and `reviewText` in `server/src/jira/prompt.util.ts` writes `@coderabbitai review` into the request half.

All of this checked out against the code: the line references in the plan (delivery.ts 76/89, DeliveryPane 117/118, ReviewRow 45, JiraDetail
356/361/401/417/430/460/562/592/656/721/735/752, JiraSessionCard 105, jira-page.ts 15, SideRail 220/309, JiraView 103-113, App 292, jira.ts 1253,
types.ts 1393, prompt.util.ts 158/162/169, the DESIGN.md and docs lines) are right, every Modify file exists and no Create file does.

## Checklist summary

| # | Item | Result |
| - | ---- | ------ |
| 1 | Coverage | Gaps: T29's render half, T8-T16 "in both frames", the modal's Children row as a modifier-click surface, `none`/`unknown` in the tab, the write line on the page |
| 2 | Values | One wrong value (`7 MRs`); all copy strings match the spec |
| 3 | Reality | Paths and lines correct; three existing suites that pin changed values are not named |
| 4 | Interfaces | `openRow` contradicts "keyed by row id"; `DeliveryPane`'s new props not stated; module-private helpers consumed |
| 5 | Order | Task 5 asserts something only Task 9 makes true; Task 5 changes a component the live modal still mounts |
| 6 | Tests | Several fixtures do not discriminate (older order, strip `+N` tone, review stamp); Review Focus 2 misses middle-click |
| 7 | Conventions | Followed, bar a few lines over 160 columns |

## Critical

### C1. Task 9 leaves two existing suites red that it neither edits nor runs

`plan:456-458` and `plan:468` name `test/gitlab/review-copy.test.ts`, `test/jira/jira-prompt.test.ts` and `test/jira/jira-launch.test.tsx`. Two more
suites pin the strings Task 9 changes:

- `test/jira/agents-dispatch-jira.test.ts:963` — `expect(sent.spawns[0].prompt).toContain('`@coderabbitai review`')`.
- `test/jira/jira-delivery-pane.test.tsx:344` and `:347` — `'CodeRabbit · 2 open findings · 1 major, 1 minor · reviewed 4m ago'`.

No grep in the Global Constraints (`plan:32-37`) finds them: Task 9 adds no caller of a listed symbol. The executor ends Task 9 green locally and CI
goes red. Fix: add both suites to Task 9's Test list and Step 4, and have Step 3's grep cover `test/` for `CodeRabbit ·` and `@coderabbitai`.

## Important

### I1. Task 5 asserts "no `CodeRabbit` in the tab" four tasks before the copy changes

`plan:350` asserts no rendered text in the Delivery tab contains `CodeRabbit`, in the same fixture where `demo` is open with review `none`
(`plan:336`). At Task 5 `reviewRowText` still returns `CodeRabbit · not reviewed yet` (`client/src/lib/review-copy.ts:97`), and the next row draws
that sentence (`plan:202`). Step 4's "expect PASS" (`plan:354`) cannot hold. Fix: move Task 9 before Task 5, or move this assertion into Task 9.

### I2. `2 targets · 7 MRs` is wrong for the stated fixture

`plan:345` expects `2 targets · 7 MRs` on "the fixture of T3" (`plan:332`): `develop` 1 open + 2 merged, `demo` 1 open + 3 merged + 1 closed
(`plan:146`). That is 3 + 5 = 8 MRs. Fix: `2 targets · 8 MRs`.

### I3. Task 3 changes `JIRA_PAGES` without touching the test that pins it

`test/jira/jira-lib.test.ts:782` is `expect(JIRA_PAGES).toEqual(['board', 'sessions', 'mentions', 'setup'])`. Task 3's Test list (`plan:236`), T17
(`plan:254`) and Step 4 (`plan:265`) do not name that suite; it appears only in the Global Constraints' "known hits" (`plan:35`). Fix: name
`test/jira/jira-lib.test.ts` in Task 3's Test list as the home of T17 and in Step 4.

### I4. `jsonStore.ts` trips the persisted-store source guard, and the plan describes a cached value the store deliberately lacks

`test/ui/persisted-store.test.tsx:130-136` fails when any file under `client/src/hooks` other than `persistedStore.ts` and `useJiraListFilters.ts`
contains `new Set<Listener>`. `plan:96` and `plan:241-242` create `hooks/jsonStore.ts` as "the same listener-set shape", and say nothing about the
guard's list. Separately `plan:87-88` and `plan:242` speak of the store's "in-memory value"; `client/src/hooks/persistedStore.ts:14-17` says it
holds none on purpose (a cache leaks one test's value into the next and hides another tab's write), and `persisted-store.test.tsx:80-87` pins that.
Fix: say which of the two it is (generalise `persistedStore`, or add `jsonStore.ts` to the guard's list with its reason), and say "mounted readers
update" in place of "in-memory value".

### I5. Who owns the write guard, the detail read and the write-error line is not decided

`plan:288-291` gives the body `detail`, `failure` and `onWrote` and leaves the rest to the builder; `plan:403` keeps "the one `useAction` guard,
the `shownKey` reset, `useParentRead`" in `JiraDetail`. Today all of these sit in one place: `useAction` at `JiraDetail.tsx:217`, the keyed read
and `rev` re-read at `:243-249`, `write` at `:311-322`, `sessionWrite` at `:329-339`, the worktrees read at `:257`. The strip's `Move to` and
`Assign to me` are the body's, so either the body owns the guard (and `plan:403` is wrong) or each frame does (and Task 8 must build a second copy,
which the spec's anti-goal "a second Detail" names, `spec:61`). No task says, and no test covers a write on the page or the `role="alert"` line
under the strip (`spec:156`). Fix: state the owner in Task 4's Produces, and add a page test: `Assign to me` posts, the detail is read again, a
refusal draws the alert line under the strip.

### I6. Task 5 changes `DeliveryPane` while the live modal still mounts it, and never states its new props

`plan:319-321` removes the `Also:` block and replaces the `ReviewRow` slot, but lists no new signature for `DeliveryPane` (today
`{ issue, now, onReview }`, resolving the lead itself, `DeliveryPane.tsx:82-103`). `JiraDetail.tsx:414` still renders it until Task 7, and
`JiraDetail.tsx` is not in Task 5's Files nor `test/jira/jira-detail.test.tsx` in its Step 4 (`plan:354`). The executor must guess whether the old
modal keeps a working pane for two tasks, and what the per-MR pane takes. Fix: give the new props (`mr`, `via`, `polledAt`, the next node, ...),
say what `JiraDetail` renders between Tasks 5 and 7, and add `jira-detail.test.tsx` to Task 5's run.

### I7. Tasks 4-6 consume functions that are private to `JiraDetail.tsx`

`plan:281-282` (`JiraMoveRows`, the description clamp), `plan:326` (`WorktreesList`) and `plan:368-369` (`ChildrenTree`, `ChildSessionLine`,
`ParentSessionLine`) are un-exported functions at `JiraDetail.tsx:752`, `:615`, `:592`, `:656`, `:721`, `:735`. `JiraDetail.tsx` is a Modify file
only in Tasks 7 and 8 (`plan:390`, `plan:416`), and the old modal uses all of them until Task 7. Fix: say in each task whether the function moves
to its own file and `JiraDetail` imports it (list `JiraDetail.tsx` under Modify), so nothing is copied.

### I8. `openRow: string | null` contradicts "fold state keyed by row id"

`plan:328-329` gives the Delivery tab one `openRow` id held by the body; `plan:352` says "fold state lives in the body, keyed by row id". The first
is an accordion (opening `demo` closes `develop`), the second lets both stand open. T12 (`plan:333-334`) opens `demo` after `develop` and does not
say whether `develop` stays open; the spec describes independent fold rows (`spec:263`, `spec:272`). Fix: pick one shape, type it, and assert in
T12 what happens to `develop`.

### I9. The `unknown` review row has `Ignore` but no place to draw it

`plan:192` gives `unknown` `ignore: 'review'` with no button, and `plan:202` gives Review rows a `null` sentence; `reviewRowText` returns `null`
for `unknown` (`client/src/lib/review-copy.ts:94-95`). The spec says a row with no button and no sentence draws no next row (`spec:270-271`) and
also that `unknown` offers `Ignore` (`spec:323-325`). Task 5 has no test for it. Fix: state that a next row draws whenever `ignore !== null`, say
what sentence it carries for `unknown`, and add the render test (an `unknown` lead shows `Ignore`; clicking it moves the pill on).

### I10. T29's render half has no task

`spec:475-477` requires that `Ignore` on a `none` review (row 3) "still reads `ignored` after a remount (the store round trip, not `deliveryNext`
alone)". `plan:204` takes T29's "pure half" and `plan:257-258` its "store half"; Task 5's only rendered ignore is the pipeline one (T25,
`plan:340-342`). Fix: add to Task 5: click `Ignore` on `demo` (review `none`), unmount, remount, the Review step reads `ignored`.

### I11. Ignore tests never move the review stamp or the review state

`plan:210-214` covers a pipeline ignore whose status changed and one whose `updatedAt` changed, and review ignores only where they hold. No case
has a stored `{ review: { state: 'open', landedAt: A } }` against a review still `open` with `landedAt` B, nor a stored `none` against a review now
`open`. An `ignoreHolds` that never reads `landedAt` passes every test, against `spec:346`. Fix: add both cases, expecting row 5 with
`ignored.review` false.

### I12. The older-MRs order is not pinned by a discriminating fixture

`plan:137` says `older` is newest `updatedAt` first and T12 (`plan:334`) says "four rows newest first", but no fixture gives the closed MR a stamp
between two merged ones. `leadMr(...).also` is ordered by state rank first (`client/src/lib/delivery.ts:69`, `:76-83`, `:91`), so an implementation
that reuses it passes with merged-then-closed. Fix: in T3's fixture make `demo`'s closed MR newer than at least one merged MR and assert the iid
order in Task 1.

### I13. Review Focus 4's expected `+2` tone depends on a fixture the plan does not give

`plan:85-86` and `plan:303` expect `+2` "in grey's tone" for folded grey and green. By the rule the plan cites, the rest after red and amber are in
`leadOrder`, which reads state and `updatedAt`, not tone (`client/src/lib/delivery.ts:76-83`); a green group updated more recently than the grey
one leads, and `+2` is green. Fix: state each group's state and stamp (for example both open, grey updated last), and make `leadOrder` over all
five differ from the worst-first order so the sort itself is tested.

### I14. The modal's Children row is a modifier-click surface in the spec and in no task

`spec:216-218` lists "a Children row inside the modal" among the surfaces where Cmd/Ctrl-click or middle-click opens the page. `plan:119`,
`plan:415-417` and T23 (`plan:436-437`) cover the Board card, List row, deck card and Sessions row only; the row is the button at
`JiraDetail.tsx:686`. Fix: add it to Task 8's Files and to T23, with the origin it reports.

### I15. Review Focus 2 does not cover a middle-click on an inner control

`plan:81-82` and `plan:443` test Cmd-click on the card's `!iid` link and `Run ▾`. Those wrappers stop `click` only
(`client/src/components/jira/JiraCard.tsx:139`, `:158`), so that case is already green before Task 8. The new `onAuxClick` (`plan:436`) is what
adds a risk: a middle-click on the link bubbles `auxclick` to the card, which then opens the ticket page while the browser opens the link. Fix: add
the middle-click case for both inner controls on the card, and for an inner control of a List and Sessions row (they filter by `rowOpens`,
`JiraIssueList.tsx:347`, `JiraSessionList.tsx:319`).

### I16. T8-T16 run once on the bare body, not "in the modal and on the page"

`spec:439` has the body cases "rendered in the modal and on the page with the same fixtures". Task 4 (`plan:293`) renders `JiraTicketBody` alone;
Task 7 re-points old modal cases and Task 8 adds page-only cases. A frame that fails to thread a prop (`onReview`, the tab store, the strip's pill
click) passes. Fix: one shared case table run through both frames in Tasks 7 and 8, or state the deviation and name which of T8-T16 each frame
repeats.

### I17. `none` and `unknown` in the Delivery tab have no test and no owner

`spec:261` keeps today's sentences in place of rows for `kind: 'none'` and `'unknown'`. Today `DeliveryPane` draws them
(`DeliveryPane.tsx:90-100`); Task 5 rewrites that pane per MR and its tests (`plan:333-350`) cover `mrs` only. Fix: say whether `JiraDeliveryTab`
draws the two sentences, and add both cases plus the tab's count for each (`spec:163`: a count with nothing to say is not drawn).

## Minor

- `plan:79` says the merged MR sits "under `1 earlier MR`" while the test at `plan:349` expects `5 earlier MRs`; the first describes a different
  fixture. Reword one.
- `plan:42` forbids any inline style object; `ChildrenTree`, which Task 6 moves as it is, has one for depth (`JiraDetail.tsx:685`), and the rule in
  `.claude/rules/board.md:98-100` forbids `style=` in markup and `<style>`, not CSSOM writes. Say whether the indent changes.
- `plan:38-39` lists three rule files to read; `server/src/jira/prompt.util.ts` is also under `.claude/rules/dispatch-watchdog.md` (CLAUDE.md's
  rule table), whose prompt rule (preview equals spawn, `JIRA_PROMPT_MAX`) governs Task 9.
- `plan:234-235` filters `ticket` out of the rail tree in Task 3 but does not mention that `RAIL_JIRA_LABEL` is a `Record<JiraPage, string>`
  (`client/src/components/SideRail.tsx:564`), so the type change needs a label in the same task for typecheck.
- `plan:153`: with ts-jest a missing export fails as a type diagnostic, not `deliveryTargets is not a function`.
- `plan:241`: `jsonStore.useValue(): T` differs from `persistedStore`'s tuple (`persistedStore.ts:47-56`) while claiming the same shape.
- `plan:243-246`: "drops the other half only if it is the one named" is hard to parse; say `ignore` sets the named half, `unignore` deletes it.
- `plan:332-334`: T12 needs `develop`'s open MR to be the newest for `develop` to be the first (open) row; say so in the fixture.
- `plan:40-41` limits invented data to two branches and two projects; Review Focus 4 needs five groups. Name a third branch.
- `plan:58`: the Agent tab's "ended count" format is not given (`5` or `5 ended`), and no test asserts it; the spec leaves it open too
  (`spec:162-163`).
- `plan:284-285`: no test asserts the strip pill's label (`<target> · <word>`) or the repo-basename lead when groups span two projects
  (`spec:149`).
- `plan:382`: Task 6's run omits `test/jira/jira-detail.test.tsx` and `test/jira/jira-board.test.tsx`, which both press `Stop session` on a
  session card (`jira-detail.test.tsx:669-803`, `jira-board.test.tsx:1762`).
- `plan:439-442`: no page test that `Run ▾` or a review button on the page opens the launch sheet, nor that `deliveryShown` false hides the tab.
- `plan:319`, `plan:449`: over 160 columns.

## Rulings

| Id | Outcome | Evidence / change |
| -- | ------- | ----------------- |
| 1-1 (C) | FIX | `agents-dispatch-jira.test.ts:963`, `jira-delivery-pane.test.tsx:344,347` confirmed; Task 9 lists both, greps `test/` for both strings first, runs every hit |
| 1-2 | FIX | `review-copy.ts:97` confirmed; the no-`CodeRabbit` render assertion moved from Task 5 to Task 9 |
| 1-3 | FIX | 3 + 5 = 8 → `2 targets · 8 MRs` |
| 1-4 | FIX | `jira-lib.test.ts:782` confirmed; T17 lives there, suite in Task 3's run |
| 1-5 | FIX | guard at `persisted-store.test.tsx:130-136` and `persistedStore.ts:14-17` confirmed; chose generalising `persistedStore` (`persistedJsonStore`), one listener holder, no cached value, "mounted readers update" |
| 1-6 | FIX | frames own the read/re-read, the body owns `useAction` and the alert line; alert-line test (Task 4) and page write test (Task 8) added |
| 1-7 | FIX | `DeliveryPane`'s new props stated; old modal renders `JiraDeliveryTab` at `JiraDetail.tsx:414` until Task 7; `jira-detail.test.tsx` in Task 5's run |
| 1-8 | FIX | Task 4 moves the six private helpers to their own files, exported unchanged, `JiraDetail` imports them |
| 1-9 | FIX | independent folds: `openRows: ReadonlySet<string>`; T12 asserts `develop` stays open |
| 1-10 | FIX | next row draws on sentence, button or `ignore !== null`; `unknown` draws `Ignore` alone, no invented copy; render test added |
| 1-11 | FIX | T29 render half (remount still `ignored`) added to Task 5 |
| 1-12 | FIX | `landedAt` moved and state moved cases added, both row 5 with `ignored.review` false |
| 1-13 | FIX | closed `!12` between merged `!11`/`!13`; expected `[11, 12, 13]` |
| 1-14 | FIX | fixture stamps given so `leadOrder` ≠ worst-first; `+2` now in green's tone (first folded pill in the strip's order) |
| 1-15 | FIX | modal Children row (`JiraDetail.tsx:686`) added to Task 8's files and T23 |
| 1-16 | FIX | `JiraCard.tsx:139,158` stop `click` only; middle-click cases on inner controls added; inner controls also stop `auxclick` |
| 1-17 | FIX | shared case table `test/helpers/ticket-body-cases.ts`, run through the modal (Task 7) and the page (Task 8) |
| 1-18 | FIX | `JiraDeliveryTab` draws today's two sentences (`DeliveryPane.tsx:90-100`) for `none`/`unknown`, no tab count; tests added |
