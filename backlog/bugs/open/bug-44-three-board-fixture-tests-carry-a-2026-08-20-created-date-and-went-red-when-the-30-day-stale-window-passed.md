---
id: bug-44
title: Three board fixture tests carry a 2026-08-20 created date and went red when the 30-day stale window passed
created: 2026-09-21
tags: tests, fixtures, board, stale
runner-fix: true
updated: 2026-09-21T10:50:59Z
groom-elapsed: 356
groom-tokens: 69561
---

## Symptom

`pnpm test` is red on `main` with nothing changed: `Test Suites: 2 failed, 126 passed`, `Tests: 3 failed, 2108 passed` (2026-09-21, `cb02cc2`). The three
are `board-live-cards.test.tsx` ("gives a needs-answers card its own strip…") and `dispatch-button.test.tsx`'s two "board wiring" cases. Each renders a
fixture item created `2026-08-20` with no `updated`, so `lastTouched` is 2026-08-20 and `leavesBoard` moves it to the Archive once the real clock passes
2026-09-19; the card the case looks for is then not rendered. task-48's outcome noticed them expiring on 2026-09-20 and named them "a date-bomb in the
fixtures, worth its own bug"; nothing was filed. Every orchestrator run on this repo now parks at `verify`.

## Repro

`pnpm run test:jest -- board-live-cards dispatch-button` on any day after 2026-09-19.

## Affects

- `test/board-live-cards.test.tsx` — the needs-answers strip case's fixture.
- `test/dispatch-button.test.tsx` — the two board-wiring cases' fixtures.
- Ten other suites also use `2026-08-20` literals (`item-age`, `item-progress`, `board-column`, `item-modal`, `board-run-chip`, `orchestrator-start-ui`,
  `dialog-escape`, `agents-shared`, …) and are green only because they pass `runs`/`now` explicitly or never render through `leavesBoard`; whichever fix lands
  should say which of those are one refactor away from the same bomb.

## Cause

Two clocks that were never the same clock. A fixture's `created` is an absolute literal written the day the case was authored; the predicate that decides
whether the card renders at all reads the REAL clock, through `useNow` inside `BoardView`. Nothing in between injects an instant, so every such case has a
silent expiry date — `created + staleDays` — and passes only until the machine's date crosses it.

The chain is `BoardView` → `leavesBoard` → `isStale` → `lastTouched` (`client/src/lib/item-stale.ts`, `client/src/lib/item-touched.ts`). A fixture with
`updated: ''` and `lastCommit: ''` falls to rung 3, `created`, so `lastTouched` is `2026-08-20`; `isStale` compares that against `now` from
`useNow(...)` and returns true once the age passes the default `staleDays` of 30, i.e. from 2026-09-20 onward; `leavesBoard` then drops everything that is
not a task. The board's filter removes the card, and `getByText(...)` throws. This is the predicate working exactly as specified — the five rules in
[invariants.md](../../../docs/subsystems/invariants.md#board-versus-archive-is-derived-and-last-touched-has-three-rungs) are all doing their job. The defect
is entirely in the fixtures.

Which fixtures blew up is decided by the two escape hatches `isStale` already has, and that is why only three of the many `2026-08-20` literals went red:

- `leavesBoard` exempts `section: 'tasks'` outright, so every task fixture is immune no matter how old.
- `isStale` returns false for an item a FRESH run holds (`runHoldsItem`, over `RUN_HELD_STAGES`).

So in `board-live-cards.test.tsx`'s "gives a needs-answers card its own strip…" case, three non-task fixtures share one `created`: `task-21` is a task,
`bug-27` is at `pending` and held by the fixture run, and `bug-14` is at `merged` — terminal, therefore not held, therefore stale, therefore gone. That one
card is the whole failure; the assertion that throws is `screen.getByText('already merged')` at `test/board-live-cards.test.tsx:299`. In
`dispatch-button.test.tsx` the disappearing card is `idea-1` ("an idea", `test/dispatch-button.test.tsx:526`), which no run mentions at all — it is the
deliberate control in both failing cases ("leaving an unqueued sibling live"), so its removal takes the control out and both cases fail on the same
`getByText('an idea')`.

The idiom that avoids this already exists in the repo, hand-rolled three separate times and never named as the rule: `test/board.test.tsx:35`
(`daysAgoDate`, date-only), `test/archive.test.tsx:39` and `test/dialog-escape.test.tsx:51` (`daysAgo`, second-precision). Those three suites test staleness
head-on, so their authors reached for a relative date; the suites that merely needed *an* item did not, and had no reason to know they had to. There is no
guard anywhere that would have told them — and behaviour cannot be that guard, because a fixture with a fresh absolute date is green on the day it is
written and for thirty days afterwards.

## Fix

Make every fixture date in a jsdom suite relative to `Date.now()`, give the idiom one home, and add a source guard so the class cannot come back. Three
parts; the third is the one that matters in a year.

**1. One home for the helper.** Add `test/helpers/dates.ts` exporting two functions, both computed off `Date.now()` at call time (never at module load, so a
faked clock installed in `beforeEach` is honoured):

- `daysAgoDate(days)` → `YYYY-MM-DD`, the shape `created` carries.
- `daysAgoStamp(days)` → second-precision UTC (`YYYY-MM-DDTHH:MM:SSZ`), the shape `updated`/`lastCommit`/`started` carry.

Re-point the three existing hand-rolled copies at it (`board.test.tsx`, `archive.test.tsx`, `dialog-escape.test.tsx`) and delete their local definitions —
same "one implementation" rule `listenLoopback` follows in `test/helpers/app.ts`. The two exported names keep the two existing spellings' meanings apart:
today `board.test.tsx`'s `daysAgoDate` and `archive.test.tsx`'s `daysAgo` return different shapes under near-identical names, which is its own trap.

**2. Convert the fixtures.** In every `test/*.test.tsx`, replace an absolute `created`/`updated`/`lastCommit`/`started` literal with a `daysAgo*` call, unless
the case asserts that literal's rendered text (see the allowlist below). Two rules while converting:

- Pick a value well inside the window — `daysAgoDate(2)` for a default fixture — so the case says "recent" rather than accidentally sitting near a boundary.
- Where a case pins sort order by `created`, keep the ORDER and only make the values relative: `'2026-08-01'` vs `'2026-08-20'` becomes `daysAgoDate(5)` vs
  `daysAgoDate(2)`. `test/board-live-cards.test.tsx:439`, `:521` and `:545` are the three sites this applies to.
- Also convert `new Date().toISOString()` where it appears as a fixture stamp (`test/board-column.test.tsx:62`, `test/board-run-chip.test.tsx:238`) to
  `daysAgoStamp(0)`. Not cosmetic: those two expressions read the real clock directly, so they would survive the future-clock red-proof in part 4 by
  cheating — the whole fixture must read time through one function for that proof to mean anything.

The two red suites are `test/board-live-cards.test.tsx` (`:87`, plus the three ordering sites) and `test/dispatch-button.test.tsx` (`:41`). The rest are
green today and are converted so that they cannot become tomorrow's red — which is the question the `## Affects` section above asked this fix to answer, so
here is the survey it asked for, from reading each suite's render sites:

- **One edit away.** `board-column.test.tsx` and `board-run-chip.test.tsx` both render `BoardView` with non-task fixtures whose only protection is the
  `updated: new Date().toISOString()` line sitting two lines below the stale `created`; delete or override that one line and they go red the same day.
  `orchestrator-start-ui.test.tsx` carries `created: '2026-08-20'` with `updated: ''` and has non-task fixtures (`bug-1`, `bug-2`, `idea-9`), but hands them
  only to `OrchestrateSheet`, which does not filter by `leavesBoard`; its two `BoardView` renders pass no items. The day someone hands `THREE` to the board
  it is the same failure.
- **Not exposed, and not by luck.** `nav.test.tsx`'s item is `section: 'out-of-scope'` with `status: 'terminal'`, and `isStale` returns false at its first
  line for anything not `open`. `dialog-escape.test.tsx` is already relative, and its one stale fixture (`updated: daysAgo(90)`) is deliberately stale for an
  Archive case. `item-age`, `item-progress`, `item-modal`, `item-month`, `agents-shared`, `agents-prompt`, `launch-sheet` and `orchestrate-uncommitted` never
  render a surface that calls `leavesBoard`, and the ones that age anything pass `now` explicitly.
- **Out of scope, deliberately.** `test/helpers/store.ts:50` writes `created: 2026-08-20` into real item files for the server suites. Staleness is derived in
  the client and the server never evaluates it, so this is not a bomb; leave the literal, and note that the guard below scans `*.test.tsx` only, so it is not
  touched.

**3. The guard — `test/fixture-clock.test.ts`, a source guard that fails closed.** Read the SOURCE of every `test/*.test.tsx` and fail on any `YYYY-MM-DD`
literal appearing as the value of `created`, `updated`, `lastCommit` or `started`, unless the file is in a closed allowlist whose every entry carries the
reason its literal is load-bearing. Seeded with one entry: `item-modal.test.tsx`, which asserts `factValue('created')` is exactly `'2026-08-20'` and renders
`ItemModal` directly, never through `leavesBoard`. Note in the file's header comment that `test/*.test.ts` (no `x`) is deliberately out of scope — those are
node/unit suites that pass `now` explicitly, and `item-age.test.ts:122` and `item-month.test.ts:117` are exactly that shape.

Same idiom and the same justification as `test/supertest-bind.test.ts`: a behavioural test cannot catch this, because forgetting is green for thirty days. A
new absolute literal goes red immediately and the fix is either a `daysAgo*` call or an allowlist entry with its reason — which is the conversation this bug
exists to force.

**`runner-fix: true` is set on this item, and it is not one of the four paths that rule names.** The marker's four named paths
(`backlog-orchestrate`'s SKILL.md, `orchestrate.mjs`, `agents/backlog-reviewer.md`, `server/src/agents/`) are untouched by this fix — the change is entirely
under `test/`. It is set anyway because the rule is a judgement about whether the rest of a run would be executed by a broken runner, and it would be: with
`pnpm test` red on `main`, EVERY item in a run parks at `verify` regardless of what that item changed. Hoisting this one to the front is precisely the hoist's
purpose. If a later groom disagrees, the thing to re-check is whether `pnpm test` is still red on a clean `main`.

**How this is verified.**

- `pnpm run test:jest -- board-live-cards dispatch-button` is green. Today it is `2 failed suites, 3 failed tests`; the three are
  `BoardView: card live strips › gives a needs-answers card its own strip, and no strip at all to a pending one`,
  `the board wiring › re-seeds the sheet when a different item is dispatched after a launch` and
  `the board wiring › disables the tab of a card a fresh run has claimed, leaving an unqueued sibling live`. Capture that output as the red proof before
  changing anything.
- The three cases still assert what they always did: the needs-answers card carries a `.board-card-live` strip reading `needs-answers` with class `hatch`,
  the `pending` card carries none, the `merged` card carries none and keeps its `ui-marker-groomed`; and in `dispatch-button`, the idea card's `groom` button
  is `aria-disabled="false"` while the claimed task card's `execute` button is `aria-disabled="true"`. A "fix" that deletes the control fixture instead of
  dating it correctly passes the suite and destroys the case — do not take it.
- **The red-proof for the bomb itself, which is the point of the whole fix:** run the full jsdom suite set once with the clock moved a year forward, and it
  must still be green. Do it with a throwaway `--setupFilesAfterEnv` module (NOT committed) that shifts `Date.now` by +400 days before each test, and run
  `pnpm run test:jest -- board-live-cards dispatch-button board-column board-run-chip orchestrator-start-ui board archive dialog-escape` under it. Before the
  fix that run is red; after it, green. Record both outputs in `## Outcome`. This is the only check that proves the date-bomb is gone rather than reset.
- `test/fixture-clock.test.ts` passes on the converted tree, and is proved red: add a literal `created: '2026-08-20'` to a scanned file that is not
  allowlisted, watch it fail naming the file and the line, then remove it. A guard nobody has seen fail is a guard nobody knows works.
- `pnpm test` (both runners) is green, and `pnpm run typecheck` passes — `test/helpers/dates.ts` is new TypeScript that nothing type-checks except the
  suites importing it.

**Done when.** `pnpm test` is green on a clean `main` on any date, the two clocks are one clock in every jsdom suite, and
`test/fixture-clock.test.ts` stands as the reason the next person cannot reintroduce it without saying why.
