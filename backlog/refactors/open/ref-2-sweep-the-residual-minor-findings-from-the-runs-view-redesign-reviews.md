---
id: ref-2
title: Sweep the residual minor findings from the runs-view redesign reviews
created: 2026-09-02
kind: chore
---

## What exists today

The runs-view redesign (merged 2026-09-02, `7a91779`) was executed task by
task, each with its own review. Every Critical and Important finding was fixed;
the final whole-branch review triaged the Minor ones and promoted five into the
last fix wave. These are the ones judged not to block merge — none can produce
a wrong number, a wrong DOM, or a wrong belief in a reader — collected here so
they are not simply lost.

The full reports are preserved at
`.superpowers/sdd/2026-09-02-runs-view-redesign/` (git-ignored scratch in the
repo root): `task-N-review.md` per task, plus `final-review.md` and
`DEFERRED.md`.

Correctness-adjacent:

- `client/src/lib/run-stats.ts` — `sumStageTotals` materialises a `0` entry for
  a key present with an explicitly `undefined` value (`Object.keys` picks it
  up, `?? 0` writes it), which is exactly the zero-value noise the `Partial`
  return type exists to avoid. Nothing produces such an input today.
- `client/src/components/runs/StageTrack.tsx` — the `×N` badge carries
  `aria-label` on a roleless `<span>`, which maps to `generic`, where ARIA 1.2
  prohibits an accessible name. `role="img"` alongside it makes the label
  reliable and changes nothing visually.
- `client/src/components/runs/StageTrack.tsx` — an unparseable `stageAt.merged`
  prints `—` in the `run-track-val-when` register (`--ink2`, "a real fact, a
  different one") where every other `—` on the track uses `--ink3` ("nothing
  was recorded"). Plan-mandated precedence; worth deciding whether rung 2
  should fall through to rung 4 when `formatClock` returns `null`.

Dead or misleading CSS:

- `client/src/styles.css` — `.run-detail-heading:first-of-type { margin-top: 0 }`
  has never matched anything: `:first-of-type` selects the first `div` among
  siblings, and the pane's first two children are `.run-detail-head` and
  `.run-drawer-chips`. Drop it or express the intent as a sibling rule.

Comment accuracy:

- `client/src/lib/run-stats.ts` — `runStageTotals`' doc overstates a structural
  guarantee ("a span labelled by a TERMINAL stage cannot occur from
  `itemStageSpans` in the first place"); the real guarantee is the
  `MACHINE_STAGES.includes(...)` filter. A reader trusting the comment could
  delete the filter as redundant.
- `client/src/styles.css` / `StageTrack.tsx` — the prose describing the
  reduced-motion degraded appearance still says the ring freezes "at its first
  frame"; the blanket rule lands an animation on its **last** keyframe, and
  with no resting `box-shadow` the ring simply disappears. Fine visually, wrong
  in the sentence.

Test coverage:

- `test/run-range.test.ts` — no DST-transition case (a `week` or `month`
  boundary crossing spring-forward / fall-back).
- `test/run-time.test.ts` — `itemQueueWaitMs`' `Math.max(0, …)` clamp is
  unexercised; all five cases stamp `pending` before the first work stamp.
- `test/stage-track.test.tsx` — three one-line contract gaps: the root's
  `run-track` class is never asserted (a typo would silently drop the whole
  grid), `aria-hidden="true"` on the dots is asserted nowhere though it is why
  no dot needs a label, and `data-out` is never checked on a *current* node.

Consistency:

- `client/src/components/runs/StageBars.tsx` — imports a value and a type from
  the same module on two lines; everywhere else in this codebase combines them
  with an inline `type` specifier.

## Why it should change

Each item is individually trivial, which is exactly why they will never be
fixed one at a time. Two of them are the kind that decay into real defects: a
comment that credits the wrong mechanism invites someone to delete the
mechanism that actually works, and an assertion gap on a class name means a
typo takes out a whole grid silently. The rest is drift that makes the next
reader trust the file less.

The reviews that found these were thorough and are preserved; re-deriving them
later costs far more than acting on the list now.

## Rough shape

One pass, one commit per cluster (correctness-adjacent, dead CSS, comments,
tests, consistency) so a bisect can tell them apart. Nothing here should change
rendered output except the `role="img"` addition and the possible `—` register
change, both of which want a glance in both themes.

Deliberately **not** in scope, filed separately: bug-14 (`runWallMs` grows
forever for a crashed run) and bug-15 (an aborted run's stalled item reads as
live). Both are behaviour, not tidying.
