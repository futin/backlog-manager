---
id: task-15
title: Sweep the eight residual minor findings from the runs-view redesign reviews
created: 2026-09-04
from: ref-2
updated: 2026-09-05T17:56:39Z
started: 2026-09-05T17:22:19Z
execute-elapsed: 2060
execute-tokens: 156229
---

## Goal

Clear the eight Minor findings the runs-view redesign reviews left behind
(ref-2), in one pass, four commits. Two of them decay into real defects if left:
a doc comment that credits a mechanism that isn't the one doing the work invites
someone to delete the mechanism that is, and it happens twice — once in
`run-stats.ts`, once in `StageTrack.tsx`. The rest is drift.

Nothing here is a behaviour change except one: an unparseable terminal stamp
moves from the `-when` colour register to `-none`. That was ref-2's one open
question and it is settled below.

**ref-2 listed nine findings; this task carries eight.** The ninth — the
"Consistency" item asking `StageBars.tsx` to combine its value and type imports
with an inline `type` specifier — was checked during grooming and its premise is
false. See "Dropped from ref-2" at the end.

## Plan

Four commits, one per cluster, so a bisect can tell them apart. Work them in
order; nothing in a later cluster depends on an earlier one, so a cluster that
turns out wrong can be dropped without unpicking the others.

### Commit 1 — correctness-adjacent (3 findings)

**1a. `client/src/lib/run-stats.ts`, `sumStageTotals` (~line 481).**
The loop reads `Object.keys(t)` and writes `sum[stage] = (sum[stage] ?? 0) + (t[stage] ?? 0)`.
A key present with an explicitly `undefined` value — `{ merging: undefined }`,
which `Partial<Record<RunStage, number>>` admits — is enumerated by
`Object.keys`, and `?? 0` then materialises a `0` entry for it. That is exactly
the zero-value noise the `Partial` return type exists to avoid: an absent key
means "this stage was never recorded", a `0` means "measured, and it took no
time". Nothing produces such an input today, which is why this is a Minor.

Skip the key when its value is `undefined`, before it can contribute. Keep the
existing `?? 0` on the accumulator side (`sum[stage]`) — that one is reading a
key this function itself may not have written yet, which is a different
question. Add a short comment saying which of the two `??`s is load-bearing and
why, since the fix makes them visibly asymmetric.

**1b. `client/src/components/runs/StageTrack.tsx`, the `×N` fix-loop badge (~line 223).**
The badge is a `<span>` with no `role`, carrying both `title` and `aria-label`.
A roleless `<span>` maps to `generic`, and ARIA 1.2 prohibits an accessible name
on `generic` — so the `aria-label` is not reliably announced. Add
`role="img"` to that span. `role="img"` accepts an accessible name, makes the
existing `aria-label` authoritative, and changes nothing visually or in layout.
Leave `title` alone — it is the sighted-hover affordance and is unaffected.

**1c. `client/src/components/runs/StageTrack.tsx`, `trackValue` rung 2 (~line 175).**
Rung 2 currently reads `formatClock(item.stageAt[terminal]) ?? '—'` and returns
modifier `'when'`. When `formatClock` returns `null` — a visited terminal stage
whose stamp will not parse — the node prints `—` in the `run-track-val-when`
register (`--ink2`, whose documented meaning is "a real fact, a different one":
a clock time rather than a duration) where every other `—` on the track uses
`run-track-val-none` (`--ink3`, "nothing was recorded"). The node is claiming a
register it has no value for.

**Decision (settled during grooming): rung 2 falls through to rung 4 when
`formatClock` returns `null`.** Restructure so that a `null` clock does not
return from rung 2 at all — it continues to the span lookup (rung 3) and then to
the plain `{ text: '—', modifier: 'none' }` of rung 4. The result is one `--ink3`
register for "nothing was recorded" across the whole track, and `--ink2` is only
ever used when a real clock time is being printed.

Update `trackValue`'s own doc comment (the numbered 1–4 precedence list above the
function, ~line 150–162) to state the new rung-2 condition: rung 2 fires for the
terminal node **only when its stamp actually parses**. The current comment
describes precedence that this change alters, so leaving it is the same
wrong-mechanism failure as cluster 3.

Note for the implementer: rung 2 is already guarded by `dot.state !== 'hollow'`,
and the existing test at `test/stage-track.test.tsx:258` ("fills through the
last-visited stage on a parked item... reads the merged value as — rather than a
clock") covers the *hollow* path and already expects `-none`. That test must
keep passing unchanged — it is not the case this change is about.

### Commit 2 — dead CSS (1 finding)

**`client/src/styles.css:1660` — `.run-detail-heading:first-of-type { margin-top: 0 }`.**
This has never matched anything. `:first-of-type` selects the first element of
its *type* (tag name) among its siblings — the first `div` — and the detail
pane's first `div` children are `.run-detail-head` and `.run-drawer-chips`
(and, conditionally, `.run-detail-error`). The first `.run-detail-heading`
("Machine time by stage", `RunDetail.tsx:446`) is never the first `div`, so the
compound selector never matches.

**Delete the rule.** Do not reconstruct the intent as a sibling rule: the
heading it was aimed at now sits below the chips row, where the 14px top margin
from `.run-detail-heading` is the spacing that is actually wanted. Deleting a
selector that matches nothing is a provable no-op on rendered output — that is
the whole reason this cluster is separable from the others.

Leave the `.run-detail-heading` block itself (`styles.css:1655–1659`) untouched.

### Commit 3 — comment accuracy (2 findings)

Both are the same failure: a comment credits a mechanism that is not the one
doing the work, so a reader could delete the mechanism that is.

**3a. `client/src/lib/run-stats.ts:295–299`, `runStageTotals`' doc, second bullet.**
It reads: "A span labeled by a TERMINAL stage (`merged`, `parked`, ...) cannot
occur from `itemStageSpans` in the first place — a terminal arrival is always the
LAST recorded stamp, and `itemStageSpans` never opens a span from the last
stamp". That structural claim is stronger than what actually holds. A terminal
arrival is the last stamp in a well-formed run file, but this module's whole
stated posture (see `parsedArrivals`' own comment) is that a hand-edited or
corrupt file is exactly the input it exists to survive — and `parsedArrivals`
sorts by *time*, so a terminal stamp that is not chronologically last will open
a span. The guarantee that actually holds is the
`MACHINE_STAGES.includes(span.stage)` filter in the function body, which excludes
every terminal stage because `MACHINE_STAGES` lists only the seven working
stages.

Rewrite the bullet to name the filter as the guarantee and demote the
last-stamp ordering to what it is — true of every file the orchestrator itself
writes, not a structural invariant. Say explicitly that the filter is therefore
not redundant, since "a reader trusting the comment could delete it" is the
concrete harm this finding names.

**3b. `client/src/components/runs/StageTrack.tsx:79–83`, the reduced-motion sentence.**
It reads: "`prefers-reduced-motion` (styles.css) already zeroes every animation
in the app, these two included, landing both on a plain solid cyan instead."

Two things wrong. First, it credits the file's blanket
`* { animation-duration: .01ms !important }` rule, which **cannot** reach either
of these two: `*` matches real elements and never the generated content a
`::before` paints, so the sweep is untouched by it; and the current dot is a real
element but the blanket rule only floors the *timing* properties, which parks the
ring on its last keyframe rather than stopping it. What actually degrades both is
this section's own carve-out at `styles.css:2004–2007` — and `styles.css`'s
comment at 1974–2003 already explains all of this correctly and at length. The
`.tsx` sentence is the one that drifted, not the CSS one.

Second, it omits what the dot actually looks like afterwards: `animation: none`
drops `.run-track-dot-current` to its resting rule (`styles.css:1908–1911`),
which sets `background`/`border-color` but no `box-shadow` — so the *ring*
disappears entirely and a plain solid cyan dot remains. "Landing both on a plain
solid cyan" is right about the fill and silent about the ring, which is the part
a reader would want to know.

Rewrite the sentence to point at the carve-out rather than the blanket rule, and
to say the ring is dropped rather than frozen. Do **not** edit
`styles.css:1974–2007` — that prose is already correct, and this task must not
"fix" it into agreement with the sentence that was wrong.

(ref-2 quotes this finding as the prose saying the ring freezes "at its first
frame". That literal phrase is no longer in the tree — a later fix wave corrected
the CSS side. The inaccuracy that remains is the `.tsx` sentence described above,
which is the same finding one revision on.)

### Commit 4 — test coverage (3 findings)

**4a. `test/run-range.test.ts` — DST transitions.**
`rangeStart` builds its window with `setHours(0,0,0,0)` and `setDate(...)`, both
local-time operations, and there is no case anywhere in the suite that crosses a
DST boundary. Add a `describe` block that pins the timezone rather than
inheriting the runner's: `jest.config.ts` sets no `TZ`, so today these tests
happen to pass under whatever zone the machine is in.

Pin `America/New_York` and use dates whose transitions are rule-derived and
therefore stable in any tzdata (US rules have been "second Sunday in March,
first Sunday in November" since 2007): spring-forward 2026-03-08, fall-back
2026-11-01. Set `process.env.TZ` in `beforeAll` and restore the previous value
in `afterAll` — the whole suite runs `--runInBand` in one process, so a leaked
`TZ` would silently reinterpret every other date-sensitive test in the run.
Verify the pin actually takes effect before trusting the assertions (assert a
known instant's local hour inside the block); if it does not, a `globalSetup`
that sets `TZ` before the runtime boots is the fallback.

The three cases are listed under Test cases below with their exact expected
values.

Explicitly **not** in scope: the sharper "local midnight does not exist on this
day" case (zones like `America/Santiago` that transition at midnight, where
`setHours(0,0,0,0)` yields 01:00). Those zones' transition dates are politically
volatile and change between tzdata releases, which would make the test flaky for
a reason that has nothing to do with this code. Note the omission in a comment
so the next reader does not think it was overlooked.

**4b. `test/run-time.test.ts` — `itemQueueWaitMs`' clamp.**
`itemQueueWaitMs` ends in `Math.max(0, started - pending)`. All five existing
cases stamp `pending` at or before the first work stamp, so the clamp has never
been exercised — it could be deleted today with the suite still green. Add a
sixth case whose earliest non-`pending` arrival precedes its `pending` stamp
(a hand-edited or corrupt run file, the same input class cases 4 and 5 already
cover). Follow the existing numbered-comment style: each case in that block
carries a `// Case N:` comment saying what fact it pins, and the new one should
say that a negative wait is not a real fact about the world, so it reads as
zero rather than as a negative duration.

**4c. `test/stage-track.test.tsx` — three one-line contract gaps.**
All three are assertions to add to *existing* tests, not new tests:

- The root's `run-track` class is asserted nowhere. It is the grid container —
  a typo in that string silently drops the whole track layout while every
  per-node assertion in the file keeps passing, because they all resolve
  through `data-testid`. Assert it on the root element in the first test
  ("renders seven nodes...", line 73).
- `aria-hidden="true"` on the dots is asserted nowhere, though it is the reason
  no dot needs an accessible name of its own (the sibling `.run-track-name`
  span carries the text). Assert it in the same first test.
- `data-out` is never checked on a **current** node. The test at line 196
  ("rings the current node...") asserts `data-in` on the current `fixing` node
  but not `data-out`. Add the `data-out` assertion there, alongside the
  existing `data-in` one.

If commit 1b lands first, this file is also the natural home for a `role="img"`
assertion on the `×N` badge — add it to the badge test at line 221.

## Test cases

Every check below is one a headless session can run itself.

**Unit — `test/run-stats.test.ts` (`sumStageTotals`, commit 1a):**

1. `sumStageTotals([{ merging: undefined }])` returns `{}` — specifically,
   `Object.keys(result)` has length `0`. Today it returns `{ merging: 0 }`.
2. `sumStageTotals([{ preflight: 1000, merging: undefined }])` returns exactly
   `{ preflight: 1000 }`; `'merging' in result` is `false`.
3. Regression guard — an explicit zero is NOT the same input and must survive:
   `sumStageTotals([{ merging: 0 }])` returns `{ merging: 0 }`, and
   `'merging' in result` is `true`. This is the case that distinguishes "never
   recorded" from "measured at zero", and it is the reason the fix keys on
   `undefined` rather than on falsiness.
4. Every existing case in the suite still passes unchanged.

**Unit — `test/run-time.test.ts` (`itemQueueWaitMs`, commit 4b):**

5. `{ stageAt: { pending: at(40_000), dispatched: at(10_000) } }` returns `0`,
   not `-30_000`. (`at()` is the existing offset helper at line 22, relative to
   `T0 = 2026-08-31T09:20:45Z`.)

**Unit — `test/run-range.test.ts` (DST, commit 4a), `TZ=America/New_York`:**

6. Sanity check that the pin took: `new Date(Date.parse('2026-03-11T12:00:00Z')).getHours()`
   is `8` (EDT, UTC−4). If this fails, the `TZ` assignment did not reach the
   Date implementation and the rest of the block is meaningless.
7. `week` across spring-forward: with `now = Date.parse('2026-03-11T16:00:00Z')`
   (Wednesday 2026-03-11, 12:00 EDT), `rangeStart('week', now)` equals
   `Date.parse('2026-03-09T05:00:00Z')` — Monday 2026-03-09 at 00:00 EDT. The
   window therefore spans 6 days and 23 hours of real time, not 7×24h, and that
   is correct: the range is calendar-aligned, not duration-aligned.
8. `inRange` either side of that boundary: a run stamped
   `'2026-03-08T17:00:00Z'` (Sunday 12:00 EST, the day the clocks moved) is
   **out** of `week`; one stamped `'2026-03-09T05:00:00Z'` is **in**.
9. `month` across fall-back: with `now = Date.parse('2026-11-15T17:00:00Z')`
   (Sunday 2026-11-15, 12:00 EST), `rangeStart('month', now)` equals
   `Date.parse('2026-11-01T04:00:00Z')` — 2026-11-01 at 00:00 EDT, the first of
   the two 1:00 AMs that day being irrelevant because midnight precedes both.
10. `TZ` is restored after the block: assert in a test placed after it, or
    confirm the full suite is green, which cases 6–9 would not be if the pin
    leaked.

**Component — `test/stage-track.test.tsx` (commits 1b, 1c, 4c):**

11. The terminal node with a visited-but-unparseable stamp reads `—` with class
    `run-track-val-none` and NOT `run-track-val-when`. Build an item whose
    `stage` is `merged` and whose `stageAt.merged` is a string that will not
    parse (`'garbage'`), with at least one earlier parseable stamp so the node
    is `filled` rather than `hollow`. Pass `mergeModeEffective="merge"` so
    `stepperTerminal` resolves the seventh node to `merged` — `StageTrack`
    takes that prop since the branch-mode work landed, and every existing
    test in the file already passes it. This is the one case commit 1c
    changes; today it produces `run-track-val-when`.
12. The terminal node with a *parseable* stamp still reads its clock in the
    `run-track-val-when` register — the existing test at line 142/165 covers
    this and must pass unchanged. Rung 2 is narrowed, not removed.
13. The existing parked-item test (line 258) still passes unchanged: a *hollow*
    merged node reads `—` with `-none`. It went through rung 4 before this
    change and still does.
14. The `×N` badge element has `role="img"` and keeps its existing `aria-label`
    (`'2 fix loops'` for `fixLoops: 2`) and `title`.
15. The root element rendered by `StageTrack` has class `run-track`.
16. Every `.run-track-dot` has `aria-hidden="true"`.
17. On the current (`fixing`) node in the live-run test at line 196,
    `data-out` is asserted to its actual value alongside the existing
    `data-in="live"` assertion.

**Whole suite:**

18. `pnpm test` is green — all suites, not just the four touched.
19. `pnpm run typecheck` is clean.

**Browser:**

20. In the browser (playwright MCP tools): start the stack
    (`pnpm run docker:up`), open `http://localhost:5177`, click **Runs** in the
    side rail, set the range control to **All**, and click any run in the
    day-grouped list. In the detail pane that opens, confirm the
    "MACHINE TIME BY STAGE" heading and the "ITEMS" heading below it both
    render with their normal spacing — a visible gap above each, not flush
    against the element above — and that the seven-node stage track under each
    item still renders as one horizontal row of seven labelled nodes rather
    than collapsing or stacking. This is the check for commit 2: the deleted
    CSS rule never matched, so the correct result is that the pane looks
    exactly as it did before, and the point of looking is to prove the
    deletion took nothing else with it. Take a screenshot for the record.

## Done when

- All eight findings are addressed: three in commit 1, one in commit 2, two in
  commit 3, three assertion groups in commit 4. (Eight findings, ten edits —
  4c is three assertions inside one finding.)
- Test cases 1–19 all pass, and case 20's browser check has been run with a
  screenshot showing the detail pane's headings and stage track intact.
- Four commits exist, one per cluster, each independently revertible.
- The two comment rewrites (3a, 3b) name the mechanism that actually does the
  work — the `MACHINE_STAGES.includes` filter, and the `@media` carve-out at
  `styles.css:2004–2007` — and neither reads as if the old claim were merely
  softened.
- `styles.css:1974–2007` is **unchanged**. It was already correct.
- No behaviour changed anywhere except the one settled register change (1c):
  an unparseable terminal stamp now reads `--ink3` instead of `--ink2`.

## Dropped from ref-2

ref-2's ninth finding, under "Consistency", asked that
`client/src/components/runs/StageBars.tsx` stop splitting its value and type
imports from `../../lib/run-stats` across two lines, on the grounds that
"everywhere else in this codebase combines them with an inline `type`
specifier".

That premise is false, and it was measured during grooming rather than argued:

- Eleven sites import a value and a type from the same module on two separate
  lines — including `StageTrack.tsx` (twice) and `RunsView.tsx`, which are
  `StageBars.tsx`'s own neighbours in `components/runs/`, written in the same
  redesign, plus `BoardView.tsx`, `ItemCard.tsx`, `OrchestrateSheet.tsx`,
  `run-time.ts`, `app.module.ts` and `origin.guard.ts`.
- Eight sites use the inline `type` specifier.

So the two-line split is if anything the *dominant* idiom, and `StageBars.tsx`
matches its immediate neighbours exactly. Changing it alone would create the
inconsistency the finding was trying to remove.

Recorded here rather than silently dropped because the review reports it came
from are preserved at `.superpowers/sdd/2026-09-02-runs-view-redesign/`, and
without this note the same wrong claim would be re-derived from them.

## Outcome

2026-09-05. All eight findings addressed — ten edits across four clusters, plus
one mechanism change the plan itself authorised as a fallback and one plan value
that turned out to be wrong. `pnpm run typecheck` clean, `pnpm test` green
(1179/1179, 69 suites), browser check run against the worktree's own client with
the detail pane measured in the live DOM. **Nothing is committed** —
`backlog-execute` never commits, so the four-commit split the plan asked for is
left for whoever stages this.

### What landed

- **1a** `sumStageTotals` now skips a key whose value is `undefined` before it
  can contribute, with a comment saying which of the two `??`s is load-bearing
  and why (the accumulator side reads a key this function may not have written
  yet; the operand side was materialising zero-value noise).
- **1b** `role="img"` on the `×N` fix-loop badge, `title` and `aria-label`
  untouched.
- **1c** rung 2 no longer returns on a `null` clock — it falls through to the
  span lookup and then to rung 4's `{ text: '—', modifier: 'none' }`. The 1–4
  precedence comment above `trackValue` was rewritten to state the new
  condition.
- **2** `.run-detail-heading:first-of-type { margin-top: 0 }` deleted;
  `.run-detail-heading` itself untouched.
- **3a** the `runStageTotals` bullet now names `MACHINE_STAGES.includes(span.stage)`
  as the guarantee, says explicitly that it is therefore not redundant, and
  demotes the last-stamp ordering to a convention of orchestrator-written files
  rather than a structural invariant.
- **3b** the reduced-motion sentence in `StageTrack.tsx` now points at the
  run-track section's own `@media` carve-out instead of the blanket rule,
  explains why the blanket rule cannot reach either animation, and says the ring
  is *dropped* (no `box-shadow` in the resting rule) rather than frozen.
  `styles.css`'s own prose was left byte-for-byte alone, as required.
- **4a** a DST `describe` in `test/run-range.test.ts` (spring-forward week,
  `inRange` either side of that boundary, fall-back month), with the
  `America/Santiago`-class omission noted in a comment.
- **4b** a sixth `itemQueueWaitMs` case pinning the `Math.max(0, ...)` clamp.
- **4c** the root's `run-track` class, `aria-hidden="true"` on all seven dots,
  `data-out` on the current node, and `role="img"` on the badge — all added to
  existing tests.
- **11** a new `stage-track` case: a *filled* terminal node with an unparseable
  stamp reads `—` with `run-track-val-none` and not `-when`.

### Two deviations from the plan

**The `TZ` pin had to move to `globalSetup`.** The plan's `beforeAll` approach
does not work, and this was measured rather than reasoned: jest hands each test
file a COPY of `process.env`, so `process.env.TZ = 'America/New_York'` lands on
the copy and never reaches the setter Node uses to invalidate its timezone
cache. A probe test read the variable back as `America/New_York` while
`new Date(Date.parse('2026-03-11T12:00:00Z')).getHours()` still answered `13`
(CET, the host's zone) instead of `8`. The plan named `globalSetup` as the
fallback for exactly this, so `test/helpers/global-setup.ts` now sets `TZ`,
wired in from `jest.config.ts`. Consequence, stated plainly because it is wider
than the plan's own framing: the WHOLE suite now runs in one pinned zone rather
than the developer's. That removes a class of machine-dependent failure rather
than adding one. Case 10 ("TZ is restored after the block") is therefore moot
and was dropped — there is no per-block pin left to leak.

The pin is **unconditional**, and this is the one thing about it a later reader
must not "improve". It shipped in review as `if (process.env.TZ === undefined)`,
on the reasoning that a developer running `TZ=UTC pnpm test` deliberately should
get UTC. That is wrong here: the DST cases assert absolute instants that are
correct only in `America/New_York` (`2026-03-02T05:00:00Z` is Monday local
midnight there and nowhere else), so a conditional pin does not let an explicit
`TZ` win — it lets an explicit `TZ` turn four passing tests red in a suite that
was green in every zone before the block existed. Caught in review, reproduced
as `TZ=UTC npx jest test/run-range.test.ts` → 4 failures, and fixed by dropping
the condition. The accepted cost, recorded in the file's own header: a
`TZ=<anything> pnpm test` run can no longer be used to check that the rest of
the suite is zone-agnostic. That property is maintained by reading now — every
other date-sensitive suite builds its instants with the local `Date`
constructor — rather than by being executable.

**Test case 7's expected value was wrong in the plan, twice over.** It named
`now = 2026-03-11T16:00:00Z` with `rangeStart('week', now)` equal to
`Date.parse('2026-03-09T05:00:00Z')`. Two problems: 9 March is inside EDT
(UTC−4), so Monday local midnight is `04:00Z`, not `05:00Z`; and more
importantly the week Mon 9 – Sun 15 March contains no transition at all — 8
March is a *Sunday*, which belongs to the preceding week. The case as written
would have passed after the arithmetic fix while testing nothing about DST. It
was rewritten onto `now = 2026-03-08T17:00:00Z` (Sunday, on the transition day
itself), whose week start is Mon 2 March 00:00 EST = `2026-03-02T05:00:00Z` —
a walk back across the seam, which is the thing the case exists to pin. Case 8
was rebuilt on the same `now`, asserting the boundary instant in, one second
earlier out, and the preceding Saturday out.

### Red-green

The new guards were verified to actually fail against the pre-fix code, not
merely to pass against the fixed code: reverting 1a, 1b and 1c and re-running
the two suites turned exactly four assertions red.

```
$ npx jest test/run-stats.test.ts test/stage-track.test.tsx --runInBand   # with 1a/1b/1c reverted
Tests:       4 failed, 48 passed, 52 total
```

Restored, both suites are green again.

### Verification

```
$ pnpm run typecheck
$ tsc --noEmit
(no output — clean)

$ pnpm test
$ jest --runInBand
Test Suites: 69 passed, 69 total
Tests:       1179 passed, 1179 total
Snapshots:   0 total
Time:        59.27 s
Ran all test suites.
```

The worktree had no `node_modules` of its own (`pnpm test` failed with
`sh: jest: command not found`), so `pnpm install` was run in it first.

The timezone pin was proved both ways rather than asserted. With the pin
unconditional, `test/run-range.test.ts` is green under an unset `TZ` and under
three explicit ones, two of them on the far side of the date line from the
pinned zone:

```
TZ=UNSET             exit=0 :: Tests: 17 passed, 17 total
TZ=UTC               exit=0 :: Tests: 17 passed, 17 total
TZ=Australia/Sydney  exit=0 :: Tests: 17 passed, 17 total
TZ=Pacific/Kiritimati exit=0 :: Tests: 17 passed, 17 total
```

and with the condition temporarily put back, the reviewer's failure reproduces
exactly:

```
$ TZ=UTC npx jest test/run-range.test.ts --runInBand   # with `if (process.env.TZ === undefined)` restored
Tests:       4 failed, 13 passed, 17 total
```

Case 6 (the zone sanity assertion) is one of those four, so the guard against
someone reintroducing the condition is the block's own first test rather than a
comment asking them not to. The whole suite is green under an explicit `TZ` too
— `TZ=Australia/Sydney pnpm test` → 1179/1179 — which is what confirms the pin
reaches every suite and not just this one.

### Browser check (case 20)

The docker stack on 5177 mounts the MAIN checkout, so it cannot see this
worktree's client. A Vite dev server was started from this worktree on port
5188 instead, proxying `/api` to the already-running API on 4322 — the change
is client-only, so the data source is irrelevant to what is being checked.
Runs → range **All** → clicked `run-20260904-204912` (done, backlog-manager,
2/2). Measured in the live DOM rather than eyeballed:

```
headings: [
  { text: "Machine time by stage…", marginTop: "14px" },
  { text: "Items",                  marginTop: "14px" },
  { text: "Attention",              marginTop: "14px" }
]
tracks: [
  { nodes: 7, rows: 1, vals: [":24m 24s", ":46s", ":8m 50s",
      "run-track-val-none:—", ":1m 44s", ":26s", "run-track-val-when:23:26"] },
  { nodes: 7, rows: 1, vals: ["run-track-val-none:—", …,
      "run-track-val-when:23:38"] }
]
```

All three headings keep their 14px top margin — which is itself the proof the
deleted rule never matched, since the first heading would have read `0px` if it
had. Each track is seven nodes on a single row (`grid-template-columns:
140px ×7`, one distinct `getBoundingClientRect().top`). Both merged items still
read their finish clock in `run-track-val-when`, so rung 2 was narrowed and not
removed. Screenshot taken and reviewed; kept out of the repo at
`/tmp/task-15-run-detail-pane.png` rather than committed as a binary.

### One thing left open, deliberately not hidden

Two full-suite runs early in this session each reported `1 failed` — one test,
one suite — and in both cases the output was piped to `tail` and the identity of
the failure was lost. It has not reproduced since: **15 consecutive full-suite
runs, 1179/1179 each**, including 8 run back-to-back specifically to catch it.
Both failures occurred while the Vite dev server, a Playwright Chromium and the
docker stack were competing for the machine, which points at a load-sensitive
timeout in one of the jsdom suites rather than at anything in this diff — but
that is a hypothesis, not a finding, and it is recorded here rather than
dropped. Nothing in this change touches timers or async behaviour.
