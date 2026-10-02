# Band filter track and shared Popover — execution rulings

Spec: [2026-10-01-band-filter-popover-design.md](../specs/2026-10-01-band-filter-popover-design.md). Plan:
[2026-10-02-band-filter-popover.md](../plans/2026-10-02-band-filter-popover.md). Final whole-branch review (Fable, `cb98630..7fca6c0`, ready to merge, 0
Critical / 0 Important / 13 Minor): [2026-10-02-band-filter-popover-final-review.md](../reviews/2026-10-02-band-filter-popover-final-review.md).

Rulings made during subagent-driven execution, each as what was decided, why, and what it costs if wrong. The per-task ledger, reports and reviews lived
under the git-ignored `.superpowers/` and are not kept.

## Baseline

- **Proceed with one red case on the base commit.** `test/tracker-write.test.ts` › "body › patches after a claim, a heartbeat, its late stamp bump and a
  poll, on the stamp read after the claim" fails deterministically on `cb98630` (expected `2026-09-30T12:00:00Z`, received wall-clock time). It is a
  server tracker-write test no task touches, so every task was judged on "no NEW red". Cost if wrong: a real regression could have hidden behind that
  one case name. Filed as a separate task.

## Plan corrections and deviations accepted

- **`resolveSortKey` instead of `?? COMPARATORS.created` in `sortItems` (Task 4).** The stored sort key is checked once, and the sort, the track label,
  the ticked row and the default direction all read the checked key. The plan's form keeps the order right but prints `Sort: newest ()` for a stale key,
  `Sort: 42 ()` for a number, and throws on render for a stored object. Tests in `test/board.test.tsx` were proven red against the plan's form. The spec's
  pointer (the status-unvalidated comment) was retargeted to `resolveSortKey`. Cost if wrong: one helper to fold back into `sortItems`.
- **`white-space: nowrap` on the Status switch buttons (Task 3).** Measured on the real stylesheet: the panel's content box is 266 px, and "In progress"
  wrapped inside the 28 px pill without it. Pinned by a stylesheet test; the browser check found no overflow at 320 px either. Cost if wrong: one
  declaration.
- **Small additions beyond the plan (Task 3, Task 5).** Picks get `max-width: 100%; overflow: hidden` so a long project name clips instead of widening
  the panel; icon buttons get `title`s, as the dashboard has; the run chip's CSS comment ("beside two stroked chips") was corrected because this change
  made it false. Cost if wrong: a few declarations and one comment.

## Scope and sequencing

- **R1 — Task 2's Escape docs name the band's two popovers before Task 4 built them.** The branch merges as one unit; writing the docs twice is churn on
  four pinned files. Cost if wrong: a branch abandoned between Task 2 and Task 4 would over-claim by two popovers.
- **Stale "nothing else floats" comments swept in Task 2, not Task 1.** `ui/Modal.tsx`, `ui/Confirm.tsx`, the Modal and `.ui-confirm` CSS comments,
  DESIGN §8.0's "the dialogs' shadow" — one sweep beside the Escape docs Task 2 rewrote anyway. `docs/subsystems/board.md`'s stack sentence (naming only
  `ui/Confirm` as a non-dialog joiner) was swept in Task 5. Cost if wrong: a few comment lines in a different commit.
- **Kept a review Minor rejected:** `ui/Popover.tsx`'s header mention of `.tracker-pop` is past-tense history ("kept it there before this component
  replaced it"), accurate after the deletion.

## Process

- **Commit trailers name the model that wrote them** (`Claude Sonnet 5.5` on the Sonnet-implemented commits) rather than the contract's line, and were not
  amended. Cost if wrong: trailers differ from the house line.
- **Browser check via headless Playwright, not the in-app pane.** The pane crops an emulated 1440 px view. Same build, same CSS; a worktree Vite on 5187
  proxied to the docker stack's API (the branch is client-only), started and killed by recorded pid. Daylight theme, 1440×900 / 375×812 / 320×568: panel
  right edge flush with the track on desktop, full width below its button on phone, sort label hidden on phone, Status switch one row at every size, badge
  legible at 11 px, no horizontal page overflow, nothing clipped under the Archive month kickers.

## Final review: declined-to-judge lines, all upheld

Keyboard-opened popover under the item modal's scrim (pre-existing; the Escape rule's "whichever mounted last"); panel Tab order after the sort button
(spec §2 mandates its DOM position); phone popover fixed while the page scrolls (any outside touch closes it); a stale sort string left in localStorage
after re-picking Created (every reader goes through `resolveSortKey`); no two-digit badge test (count is at most 2); the Runs page's own project select
(spec out of scope); `Chip`/`Segmented` skins (untouched primitives); the Task 3 additions (accepted above); commit trailers (accepted above).

## Verification on head `7fca6c0`

jest 2605 passed / 1 failed (the baseline case above) / 1 skipped; node 852 passed / 0 failed / 1 skipped; `pnpm run typecheck` and `pnpm run build`
exit 0.
