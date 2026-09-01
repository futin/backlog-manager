---
id: task-7
title: Bound the run drawer's verification tail box
created: 2026-09-01
from: ref-1
updated: 2026-09-01T07:42:03Z
started: 2026-09-01T07:34:21Z
execute-elapsed: 462
---

## Goal

The verification tail in the run drawer has no height bound of any kind:
`client/src/styles.css:754` is its only rule (`color: var(--ink3)`), so twenty
captured lines set the drawer's height and push the ATTENTION section — the
reason a human opens this drawer after an unattended run — below the fold.

Give the tail its own bounded, scrollable box. Markup is untouched: this task
is `client/src/styles.css` and one new test file, nothing else. The companion
task (`from: ref-1`, the disclosure gate) changes `RunDrawer.tsx` and inherits
this rule wherever it moves the span to, so the two do not overlap on a single
file and can merge in either order.

A second, smaller defect gets fixed by the same rule. `runVerifyCommand`
(`skills/backlog-orchestrate/tools/orchestrate.mjs`) joins the last 20 lines
with `\n`, but the tail renders inside a plain `<span>` with no `white-space`
declaration, so HTML collapses every newline into a space. What the drawer
shows today is not twenty lines — it is one long wrapped paragraph of run-on
output. Bounding the box without restoring the line breaks would just bound an
unreadable blob.

## Plan

One rule to edit, `.run-drawer-item-verify-tail` (`client/src/styles.css:754`).
Keep `color: var(--ink3)` and add:

- `flex-basis: 100%` — the parent `.run-drawer-item-verify` (line 747) is
  `display: flex; flex-wrap: wrap`, so the tail is a flex sibling of the `cmd`
  span and the `ok`/`failed` chip. Today it wraps onto the same line as them
  whenever it is short, and onto its own when it is long. A scroll container
  whose row placement changes with its content length is not a box anyone can
  read; give it its own full-width row unconditionally.
- `min-width: 0` — a flex item's default `min-width: auto` refuses to shrink
  below its content's intrinsic width. Without this, the two properties below
  are silently overridden by a single long line.
- `white-space: pre-wrap` — restores the captured line breaks (see Goal) while
  still wrapping lines too long for the drawer. Not `pre`: that would trade the
  vertical overflow this task is fixing for a horizontal one.
- `overflow-wrap: anywhere` — `pre-wrap` alone will not break a single
  unbroken token, and the tail's 8 KiB cap is a character cap, not a line one;
  one long path or base64 blob would otherwise widen the whole drawer.
- `max-height: 10em` — `em`, so it tracks the parent's 10px mono `font-size`
  rather than pinning a pixel height that goes wrong under the `--font-scale`
  the rest of this stylesheet respects (lines 87, 798). Ten lines is enough to
  read a failure without any single row owning the drawer.
- `overflow-y: auto` — the actual bound. `auto`, not `scroll`: a two-line tail
  should not carry a permanent scrollbar gutter.
- `overscroll-behavior: contain` — the tail sits inside `.drawer-body`, which
  is itself `overflow-y: auto` (line 690). Without this, a wheel gesture that
  reaches the tail's end chains straight into scrolling the drawer behind it,
  which reads as the drawer randomly jumping while you read output.

Nothing else moves. No component file, no markup, no data shape — the tool
still stores a tail for every row, pass or fail, exactly as designed.

## Test cases

jsdom performs no layout, so no rendering test can observe a `max-height`;
`getComputedStyle` in the existing component suites would return the declared
value only if the stylesheet were loaded, and it is not. The honest guard is
the stylesheet's own text, in the same spirit as `test/csp.test.ts` pinning the
theme script's hash by reading the file it hashes.

New flat test file under `test/` (plain `.test.ts`, no jsdom docblock — it
reads a file, it does not render):

1. **The tail rule bounds its height.** Read `client/src/styles.css`, isolate
   the `.run-drawer-item-verify-tail` block, and assert it declares both a
   `max-height` and `overflow-y: auto`. Assert on the properties being present
   in that block, not on an exact pixel string — the point being guarded is
   "this box cannot grow without limit", and a future 12em is not a
   regression.
2. **The tail rule preserves captured newlines.** Same block declares
   `white-space: pre-wrap`. This is the assertion that would have caught the
   collapsed-newline bug, and the one most likely to be lost by a later
   well-meaning cleanup of "redundant" whitespace properties.
3. **The block is found at all.** The isolation step must fail loudly if the
   selector is missing or renamed rather than passing vacuously on an empty
   match — a renamed class with no rule behind it is exactly the regression
   this file exists to catch.

Existing suites are expected to stay green untouched:
`test/orchestrator-drawer.test.tsx:79` asserts the tail's text content and is
indifferent to the stylesheet.

## Done when

- `pnpm test` green, including the new file.
- `pnpm run typecheck` and `pnpm run build` green.
- `client/src/components/board/RunDrawer.tsx` shows no diff — the whole change
  is `client/src/styles.css` plus one new `test/` file.

## Outcome

2026-09-01 — done as planned, on branch `backlog/task-7`. All seven declarations
went onto the existing `.run-drawer-item-verify-tail` rule
(`client/src/styles.css`), keeping `color: var(--ink3)`; a new
`test/run-drawer-tail-style.test.ts` reads the stylesheet's text and pins the
three properties a later cleanup could silently drop. `RunDrawer.tsx` shows no
diff, as the plan required — `git diff --stat -- client/src/components/board/RunDrawer.tsx`
prints nothing.

The new file was verified red before the CSS edit and green after, so the guard
is known to actually guard something:

```
$ pnpm test -- test/run-drawer-tail-style.test.ts     # before the CSS edit
  ● run drawer verification tail stylesheet rule › bounds its height and scrolls instead of growing
    Expected pattern: /(^|[\s;])max-height\s*:/
    Received string:  " color: var(--ink3) "
  ● run drawer verification tail stylesheet rule › preserves the captured newlines
    Expected pattern: /(^|[\s;])white-space\s*:\s*pre-wrap\b/
    Received string:  " color: var(--ink3) "
Test Suites: 1 failed, 1 total
Tests:       2 failed, 1 passed, 3 total
```

```
$ pnpm test -- test/run-drawer-tail-style.test.ts     # after
PASS test/run-drawer-tail-style.test.ts
  run drawer verification tail stylesheet rule
    ✓ has a rule in client/src/styles.css (2 ms)
    ✓ bounds its height and scrolls instead of growing
    ✓ preserves the captured newlines (1 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
```

Full gate, all three exit 0:

```
$ pnpm test ; echo "test exit=$?"
Test Suites: 33 passed, 33 total
Tests:       441 passed, 441 total
Snapshots:   0 total
Time:        29.546 s, estimated 31 s
test exit=0
$ pnpm run typecheck ; echo "typecheck exit=$?"
typecheck exit=0
$ pnpm run build ; echo "build exit=$?"
build exit=0
```

One thing worth recording rather than hiding: of four full-suite runs after the
change, one failed a single test in `test/orchestrator-start.test.ts` and the
other three were green, including the two consecutive runs above. That suite
passes 11/11 in isolation, and this item's diff is one CSS rule plus a test that
only reads a file — it touches no server code and no supertest path at all. It
is `bug-1` (full-suite supertest teardown flake), already filed, reproducing
again; not a regression from this task.
