# Plan review 1 recheck — Runs and GitHub restyle (plan 3 of 4)

Plan: `docs/superpowers/plans/2026-11-05-runs-github-restyle.md` (working tree, after the round-1 fixes). Spec: `docs/superpowers/specs/2026-11-05-app-restyle-design.md`.
Round 1: `docs/superpowers/reviews/2026-11-05-runs-github-restyle-review-1.md`. Scope: only the lines the recheck diff touches (`p3-recheck.diff`, 141 lines,
hunks at plan :37, :69, :83, :112, :130, :145, :206, :220, :242). Plan 2 (`2026-11-05-jira-rest-restyle.md`) Tasks 1–2 read for the names the new block
cites. Every code claim was grepped on the working tree.

## Verdict: APPROVE WITH FIXES

All six round-1 Important findings are resolved in substance. Four Important findings remain, all in the new text: one line cite is off by one, one new test
case contradicts the behaviour paragraph it sits under, and the Matrix mechanism names an element that does not exist and invalidates an existing test the plan
does not name.

## (a) Does each change resolve its round-1 finding?

| Round 1 | Change | Resolved? |
| --- | --- | --- |
| I1 (plan-2 names unpinned) | `## Required from plan 2` block, :40-52 | Yes. `StateTone`, `runTone` map, `.ui-stripe[data-tone]` / `tr.ui-stripe > :first-child` / `.ui-stripe-dot[data-tone]`, `GlyphTile` signature and markup, `Segmented` `count?: number` / `.ui-seg-count` / `Needs you 1` are spelled identically to plan 2 :59-66 and :82-86. "No other option field — an option carries no `Dot`" matches plan 2 (nothing else is added to the option type). |
| I2 (Matrix menu escape) | :173-177, :184 | Yes in mechanism (panel as a sibling after `.prs-matrix-scroll`, `Popover` unchanged) and in test (`closest('.prs-matrix-scroll')` null). See I3/I4 below for the element it names. |
| I3 (`.prs-card*`) | :165 | Yes. `.prs-repo*`, `.prs-list`, `.prs-row*`, `.prs-chips`, `.prs-outcome` are the families `styles.css` has (`.prs-repo-inner`, `.prs-repo-sub`, `.prs-list`, `.prs-row`, `.prs-row-main`, `.prs-row-title`, `.prs-chips`, `.prs-outcome`, `.prs-outcome-error`) and `PrCards.tsx:40-126` draws them. `.prs-card` is still 0 hits. |
| I4 (failing check names) | :176-177 | Yes. `PullRequestRow.checks` is the five-value enum at `shared/types.ts:630`; `checksDetail: string \| null` at :666; spec :38 reads "No new data on any page except what §5 adds" — the plan's "no new data on any page" is a fair short quote. |
| I5 (armed + syncOff test) | :130-132 | Added, and the three menu rows' reason is right (`mergeBlock`, `autoMergeBlock`, `updateBlock` all answer `sync off` first, `prs.ts:94,131,113`). But the main half's text contradicts :115-116 — I2 below. |
| I6 (countdown twice, `18 s` vs `42s`) | :248-250, :255-256 | Yes. One countdown, in `watchdog-state-line`, in the code's form (`run-watchdog.ts:182` renders `next check in ${seconds}s`; `watchdog-monitor.test.tsx:600` pins `next check in 42s`); the band row carries `watchdog-state` so `runs-view` :1841/:1883 (`getByTestId('watchdog-state')` after `findByTestId('watchdog-phase')`) stay green. |
| Minor :72-73 | :86-87 | Yes. `pending` + `autoMergeAllowed: false` with non-empty `methods` → `mergeBlock` null (`prs.ts:93-100`); draft + pending → `'draft'` (:95). |
| Minor :74 | :88-89 | Yes. `blocked && facts.length === 0 && pr.checks !== 'pending'` is `pr-layouts.ts:86-88`. |
| Minor :86 | :101 | No — the new cite is also off (I1 below). |
| Minor :138 | :52 | Yes, via the Required block. |
| Minor :209, :210 | :232-234 | Yes. Fixtures at `run-detail.test.tsx:139-141,180-182,363-365` have `prUrl: null`, `base: 'main'`; `Pill` renders `ui-pill-${tone}` and no `data-tone` (`Pill.tsx:27`); `done` is a `PillTone` (:3). |
| Minor :217 | :249 | Yes (see I6 row). |
| Minor :244-245 | :271 | Yes. |
| Minor :82, :193, :256-258 | not in the diff | Unaddressed, still Minor; :283 still says §8.4.2 for the stage chip rather than §8.4.1 item 5 (`DESIGN.md:338`). Not re-raised beyond this line. |

## (b) Truth of the changed lines — checked

- :45-52 vs plan 2 :59-66, :82-86: identical spellings, including `size?: 18 \| 28 \| 32` and `tone = 'neutral'` default.
- :86-89 vs `prs.ts:93-100`, `pr-layouts.ts:86-88`: true.
- :101 vs `.claude/rules/board.md`: the Popover-composer sentence STARTS on :20 ("The second is `ui/Popover.tsx`, with seven composers — …") and runs to :22. I1.
- :130-132 vs `prs.ts:94,113,131`: `sync off` on all three. True; the main-half wording is I2.
- :150-151 vs spec :164 ("triage tabs as `Segmented` with counts"): true, no dot.
- :165 vs `styles.css` / `PrCards.tsx`: true.
- :173-177: `Popover.tsx:24` "measures nothing and portals nothing" — true (cite :24-25 is one line early but lands). `.prs-matrix-scroll { overflow-x: auto; container-type: inline-size }` (`styles.css:3212`) — true, and a non-`visible` `overflow-x` does compute `overflow-y` to `auto`. Note the box is also a `container-type` ancestor, which `Popover.tsx:26-27` forbids for its phone shape — one more reason the sibling placement is right; worth one clause. "the row's disclosure button" — false, I3. "no expansion `tr`" — invalidates `prs-matrix` :224-230, I4.
- :176-177 vs `shared/types.ts:630,666`: true.
- :184: `closest` case is structural and would fail today (the expansion `tr` at `PrMatrix.tsx:147` is inside the scroll box). Good.
- :232-234 vs `run-detail.test.tsx`, `Pill.tsx`: true.
- :248-250, :255-256 vs `run-watchdog.ts:182`, `watchdog-monitor.test.tsx:600-604`, `WatchdogMonitor.tsx:168,225`, `runs-view.test.tsx:1834-1841`: true. `watchdog-state` is also the could-not-reach notice's testid (:168); moving the loaded one to the band row keeps both states covered, as the `runs-view` comment wants.
- :271: `last N ticks` with N = cells drawn — consistent with Task 8's 15 → 12 and 3 → 3 cases.

## (c) Contradictions

- :130 vs :115-116 and :128 (same task): I2.
- :249 "the code wins over the spec's `18 s`" vs :21 "Where the plan and the spec differ, the spec wins; report the difference": the deviation is deliberate and right (the spec's `18 s` is copy, the code's `42s` is pinned), but the sentence should say it is REPORTED as a §4.7 deviation, as :177 does for §4.8. Minor.
- Nothing in the changed lines contradicts plan 2's names or an unchanged part of this plan beyond the two above.

## Important

- **I1 — plan :101 — `board.md:21-22` is wrong by one line.** The Popover-composer sentence, including the count phrase to change (`with seven composers`,
  which plans 1–2 raise to nine), begins on `.claude/rules/board.md:20`, after the Confirm sentence ends on that same line; it continues to :22. An
  implementer editing :21-22 misses the count. → Cite `:20-22` ("the Popover-composer sentence, which starts after the Confirm sentence ends on :20").
- **I2 — plan :130-131 — the armed + `syncOff` case contradicts the blocked-main rule at :115-116.** :115-116 says a blocked main half is "`dashed`, visible
  `Blocked` (or the reason with `blockedText`)" and :128 tests exactly that for failing checks ("main reads `Blocked`"), yet :130 says the armed + `syncOff`
  main "reads `Auto-merge on #12`". Both cases are blocked (`mergeMain` → `{disarm, 'sync off'}`, :87). An implementer must guess whether an armed blocked
  half keeps its state word or reads `Blocked`. → Either write the test as "main NAMED `Auto-merge on #12` (its `label`), reading `Blocked`, `aria-disabled`,
  `title` `sync off`" or, if an armed PR should keep showing it is armed, add that exception to :115-116 and to the mock check in Task 10.
- **I3 — plan :174-175, :184 — "the row's disclosure button" does not exist.** The Matrix row IS the disclosure: `PrMatrix.tsx:110` puts `tabIndex={0}`,
  `aria-expanded` and the click/key handlers on the `tr`, and `prs-matrix` :114 (`row()` → `pr-mrow-<key>`), :208 and :255 read `aria-expanded` on that
  `tr`. The plan neither adds a button nor says the attributes stay on the `tr`. → Say "the row (`tr`, `pr-mrow-<key>`) keeps `aria-expanded` and gains
  `aria-controls` = the panel's `id`" (and :184 reads them off `row()`), or state that a real button is added inside the PR cell and what :208/:255 then query.
- **I4 — plan :175 — "no expansion `tr`" silently invalidates `prs-matrix` :224-230.** That case ("pins the expansion block to the visible width") asserts
  `getByTestId('pr-expand-…').querySelector('td').firstElementChild` has `.prs-matrix-pinned`. With the panel outside the table there is no `td` and no
  pinned block to measure — the panel is full width by construction. Task 4 Step 1 does not name it and Task 2's :210-212 list predates the move. → Add to
  Task 4 Step 1: "drop :224-230 (the panel sits outside the scroll box, so `cqw` pinning no longer applies) — or rewrite it to assert the panel is the
  scroll box's next sibling".

## Minor

- :88, :151, :165, :174-177, :184, :234, :236, :249, :258, :271 exceed 160 columns (up to 272). The file already had long lines before the recheck (:6, :15,
  :57, :60), so this is the author's convention drifting, not a new rule; reflow the new ones only.
- :174 "a sibling inside the Matrix wrapper": the next sibling of `.prs-matrix-scroll` is inside `Sheet` (`PrMatrix.tsx:197-199`), two levels under
  `.prs-matrix`. "inside the `Sheet`" is the precise word.
- :173 could add: `.prs-matrix-scroll` is also a `container-type` box, which `Popover.tsx:26-27` forbids as an ancestor of its phone shape — the second
  reason the panel must be a sibling.
- :249: say the `42s`-over-`18 s` choice is reported as a §4.7 deviation (the plan's own :21 rule), as :177 does for §4.8.
- :87 `pending` + `autoMergeAllowed` → `{arm, null}`: this reads `autoMergeBlock` (:130-137), which checks `pr.draft`, `mergeable`, `checks === 'failure'`
  before `autoMergeAllowed`; the fixture must have `checks: 'pending'` (not `failure`), `draft: false`, `mergeable` not `conflicting` — worth the same
  "(fixture: …)" clause :88 now carries.
- Unaddressed round-1 minors (:82 tenth-composer clause, :193 `runDotTone` is a `Dot` tone, :283 §8.4.2 → §8.4.1 item 5 for the stage chip) stand.

## Parked (autopilot)

- Whether an armed PR on a `syncOff` repo should visibly read `Blocked` or keep `Auto-merge on` (I2) — recommended: `Blocked` with the name `Auto-merge on #12`,
  matching :115-116 and the failing-checks case.
