## Verdict: APPROVE WITH FIXES

Narrow re-check of commit `228fa0c6` ("docs: address plan review 1") against `docs/superpowers/plans/2026-11-19-jira-detail-tabs.md`. Only the changed
lines were reviewed; surrounding lines were read as context. `plan:<n>` is a line in the plan, `spec:<n>` a line in
`docs/superpowers/specs/2026-11-19-jira-detail-tabs-design.md`.

No Critical findings. Four Important findings, all in what the changed lines leave for the implementer to guess or state incorrectly.

## Important

### I1 — plan:303-305 vs plan:427 — two owners for the one `useAction` guard

The new Ownership sentence gives the write guard to the body ("the body owns the one `useAction` write guard (`JiraDetail.tsx:217`)"). Task 7 Step 3
(plan:427, unchanged) still says of `JiraDetail`: "Keep the one `useAction` guard, the `shownKey` reset, `useParentRead`". Built as written, the modal
frame and the body each hold a `useAction`, which contradicts spec:79 ("One write guard (`useAction`) per Detail") and spec:411.

What the guard covers today is wider than the sentence says: `JiraDetail.tsx:311-322` (`write`, Assign and Move), `JiraDetail.tsx:329-339`
(`sessionWrite`, Stop and Unlink, whose `busy` is handed to the session cards at `JiraDetail.tsx:384`), and `clearError()` in the `shownKey` reset at
`JiraDetail.tsx:232-238`. The same paragraph also leaves two things unassigned:

- `write`'s success does three things (`JiraDetail.tsx:314-318`): `reload()`, `onWrote()` (the board nudge, a `JiraDetail` prop) and `setRev` (the
  re-read). The plan folds the last two into one body prop, "`onWrote` (re-read)", without saying the frame's handler must do both.
- The parent read's own `role="alert"` line (`JiraDetail.tsx:541-545`) and `useParentRead`: the Parent link moves into the body's strip, but plan:427
  keeps `useParentRead` in the frame.

The cite "today 311–339" for the write-error line is also wrong: 311–339 are the two write functions; the `role="alert"` line is
`JiraDetail.tsx:535-539`.

Suggested fix: change plan:427 to say the guard, the `shownKey` reset of the error and the write-error line are the body's since Task 4 and
`JiraDetail` holds none; say the frame's `onWrote` handler nudges the board and bumps its re-read; name the owner of `useParentRead` and its failure
line; correct the cite to 535–539.

### I2 — plan:375 — the interim modal's `JiraDeliveryTab` has no stated inputs

"Until Task 7, the old modal's delivery region (`JiraDetail.tsx:414`) renders `JiraDeliveryTab` in place of `DeliveryPane`". The line cited is correct
(`JiraDetail.tsx:414`), but `JiraDeliveryTab`'s props (plan:347-349) include `openRows`, `onToggleRow`, `onOpenRow`, `liveReviewLink` and `worktrees`,
and the old modal has none of them. In particular the old modal already draws its own Worktrees list (`JiraDetail.tsx:571-575`), so passing the trees
draws Worktrees twice in one dialog between Tasks 5 and 7, and not passing them is a choice the plan does not make. The implementer must also guess
where the interim `openRows` state lives.

Suggested fix: one sentence — the interim modal holds a local `openRows` (first group open), passes an empty `worktrees` (its own list at 571–575 stays
until Task 7), and derives `liveReviewLink` from `liveLinks` (`JiraDetail.tsx:252`).

### I3 — plan:344-346 with plan:378-379 — the `DeliveryPane` props change breaks more of the existing suite than Step 4 allows for

`DeliveryPane` now takes `{ issue, mr, now, next, via, onUnignore, children }` and "no longer resolves the ticket's delivery itself". Every case in
`test/jira/jira-delivery-pane.test.tsx` mounts it as `<DeliveryPane issue={of} now={now} />` under a `GitlabContext`
(`test/jira/jira-delivery-pane.test.tsx:103-109`) and relies on the pane resolving the lead, the no-MR sentence and the unknown lines
(`DeliveryPane.tsx:83-101`). Step 4 says only "update the `Also:` and lead-only ReviewRow cases". With the new props every case stops compiling,
and the `none` / `unknown` / `hidden` / unshown cases no longer belong to this component at all.

Suggested fix: say in Step 4 that the suite's `draw` helper is re-pointed (the head and track cases mount the pane with one target's lead; the
`none` / `unknown` / `hidden` / not-shown cases move to `test/jira/jira-delivery-tab.test.tsx` with their assertions unchanged), and that this is the
task, not a regression. Same note for the delivery assertions in `test/jira/jira-detail.test.tsx`, which Step 4 now runs but does not license changing.

### I4 — plan:429-431 — the shared case table covers five of the spec's nine body cases

spec:439 heads cases 8–16 "Detail body (jsdom, rendered in the modal and on the page with the same fixtures)". The new Shared cases step moves T8, T9,
T11, T15 and T16 only. T10 (arrow keys), T12 (two rows and the nested fold), T13 (strip pill opens its row) and T14 (next-row button launches the
review) run through one mount only, and the plan gives no reason. T13 and T14 are the ones a frame can actually break: the open-row state is the
body's and `onReview` is threaded through each frame separately (`JiraDetail.tsx:414` today).

Suggested fix: add T10 and T12–T14 to the table, or state per case why it is frame-independent and where its single run lives.

## Minor

- plan:239 — Task 3's Files line still reads "`client/src/hooks/persistedStore.ts` (header list)"; plan:98 and plan:248 now make it a real change
  (`persistedJsonStore`). Align the three.
- plan:248-251 — `persistedJsonStore`'s `useValue(): T` differs from `persistedStore`'s `[V, set]` tuple (`persistedStore.ts:47-56`, pinned by
  `test/ui/persisted-store.test.tsx:27`); say the wrapper keeps the tuple. Also say what `read` receives when storage is absent or not JSON (`null`, as
  `persistedStore.ts:29` does today), since the signature has no fallback and plan:267 expects "a stored non-JSON string reads `{}`".
- plan:286-288 — the move list omits `RowSession` (`JiraDetail.tsx:705`), which `ChildrenTree` renders at `JiraDetail.tsx:694`; "the function at 615"
  is `Description` (`JiraDetail.tsx:615`) — name it. All six line numbers were checked and are right (592, 615, 656, 721, 735, 752).
- plan:288 vs plan:342 and plan:392-393 — "Tasks 5 and 6 consume them from those files", but those tasks' Consumes lines still cite
  `JiraDetail.tsx:592` / `562/656` / `721/735`. Likewise plan:375's `JiraDetail.tsx:414` and plan:414's ranges are pre-Task-4 numbers; mark them
  "today".
- plan:362-363 — the `unknown` case pins no value for its second half: "the pill moves on to the pipeline rows" names neither the fixture's pipeline
  nor the expected pill. Give it one (for example pipeline `success` → `next: merge`) and a non-null `landedAt` distinct from the MR's `updatedAt`, per
  the plan's own "fixtures discriminate" constraint (plan:55-56).
- plan:367 — "today's two sentences (`DeliveryPane.tsx:90-100`, copied unchanged)": the strings are `UNKNOWN_LINE` at `DeliveryPane.tsx:76-80` and the
  template at `DeliveryPane.tsx:92`, and there are four of them, not two. "Moved" rather than "copied" keeps one home
  (`.claude/rules/board.md`, "Every derivation has one home").
- plan:429-432 — the Shared cases step is unnumbered and sits after "Run, expect FAIL"; Step 4's run list omits `test/jira/jira-ticket-body.test.tsx`,
  which the step edits. The `(mount: (fixture) => void) => void` signature has no rerender handle, which T9 and T16 need (a ticket swap).
- plan:204-206 — the new next-row rule ("a sentence, a button OR `ignore !== null`") is right for `unknown` (`review-copy.ts:94-95` returns `null`),
  but it overrides spec:270-271 ("A row with no button and no sentence draws no next row") in favour of spec:333. Worth one line in the spec so the two
  agree.
- plan:85-87 and plan:318 — `+2 in green's tone` reads spec:149's "worst tone among the folded ones" as "first folded in strip order". The fixture
  does discriminate that reading from a severity ranking of grey over green, and the tones are reachable (`delivery.ts:239-252`); recorded only because
  the spec never ranks green against grey.
- plan:263 — the case at `test/jira/jira-lib.test.ts:781` is titled "names the four pages"; rename it with the value.
- plan:442 — the Children row becomes a modifier-click surface "in the modal"; the same component draws on the page, where the plan does not say what
  a modifier-click does (a plain swap is the obvious answer).

## Checked and correct

- plan:152-153 — `older` order case: `STATE_RANK` (`delivery.ts:69`) puts merged before closed, so `leadMr`'s `also` would be `[11, 13, 12]` and
  newest-first is `[11, 12, 13]`. The fixture discriminates.
- plan:219-220 — both new stamp cases follow spec:346 and exercise the `landedAt` half and the state half separately.
- plan:242, plan:263 — `test/jira/jira-lib.test.ts:782` does pin the four-page array.
- plan:248-251 — `persistedStore.ts:14-17` and the source guard at `test/ui/persisted-store.test.tsx:130-136` are as described; listeners receive the
  value (`persistedStore.ts:44`), so a throwing `setItem` still reaches mounted readers (already pinned at `test/ui/persisted-store.test.tsx:89-100`).
- plan:369, plan:373 — `2 targets · 8 MRs` (3 + 5) and `5 earlier MRs into demo · 4 merged, 1 closed` are arithmetically right for T3's fixture.
- plan:474-475 — `JiraCard.tsx:139` and `JiraCard.tsx:158` are the two `stopPropagation` click handlers.
- plan:490-491 — `test/jira/agents-dispatch-jira.test.ts:963` and `test/jira/jira-delivery-pane.test.tsx:344,347` pin the strings named; the three
  `test/gitlab/` suites named at plan:501 exist.
- plan:429 — `test/helpers/` holds shared tables already (`watchdog-coupling.ts`), and a helper there is outside the jest feature-directory rule
  (`.claude/rules/tests.md`, the "one level down" bullet).

## Rulings

Narrow re-check of review 1's diff. No further round: the plan limit (1 round + re-check) is reached.

| Id | Outcome | Evidence / change |
| -- | ------- | ----------------- |
| 2-1 | FIX | `JiraDetail.tsx:314-318`, `:535-539`, `:541-545` confirmed; body owns guard, error reset, write-error line and `useParentRead` from Task 4; frame's `onWrote` re-reads and nudges; Task 7 Step 3 says no second guard; cite fixed |
| 2-2 | FIX | `JiraDetail.tsx:571-575` confirmed; interim modal: local fold state, empty `worktrees`, `liveReviewLink` from `liveLinks` |
| 2-3 | FIX | `jira-delivery-pane.test.tsx:103-109` confirmed; `draw` re-pointed, none/unknown/hidden/not-shown cases move to the tab suite unchanged; same licence for `jira-detail.test.tsx` |
| 2-4 | FIX | shared table now carries T8–T16, per spec:439 |
