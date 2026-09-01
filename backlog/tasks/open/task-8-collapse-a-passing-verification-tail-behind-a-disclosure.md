---
id: task-8
title: Collapse a passing verification tail behind a disclosure
created: 2026-09-01
from: ref-1
---

## Goal

`RunDrawer.tsx:225` renders a verification row's `tail` unconditionally, so a
green three-command baseline prints three walls of passing output and the one
red row, when there is one, sits buried between them. Worse, `pnpm run build`
ends its *successful* output with `The CJS build of Vite's Node API is
deprecated`, which currently renders directly beneath a green `ok` and reads as
a problem on a check that passed.

Gate the tail on `verify.ok`: collapsed behind a disclosure when the row
passed, open when it failed. Collapsed, not dropped — a green tail is still
proof the command really ran, and the same reasoning that keeps the tool
storing it keeps it reachable in one click.

The tool, `run.json`'s shape and `shared/types.ts` are all untouched.
`client/src/styles.css` is untouched too: it belongs to the companion task
(`from: ref-1`, bounding the tail's box), and keeping this change inside
`RunDrawer.tsx` plus its test file is what lets the two merge in either order
without conflicting. That constraint is a real design input here, not
paperwork — see the markup note below.

## Plan

In `RunDrawer.tsx`, inside the `verify !== null` block (around line 218), turn
the row into a `<details>` and move the tail inside it:

- The `<details>` takes `className="run-drawer-item-verify"` — the class the
  wrapper `<div>` carries today, so the existing flex-row rule at
  `styles.css:747` applies unchanged and no new selector is needed.
- `open={!verify.ok}` and no state. A failed row is open on arrival; a passed
  one is closed until someone clicks it. React only writes the `open`
  attribute when the prop's value changes, so a tail the user expanded by hand
  stays expanded across the 5s poll re-render that `useOrchestratorRuns` fires
  while a run is fresh — the reason this is a `<details>` and not a
  `useState` toggle.
- `<summary>` holds the two spans the head already shows: the
  `run-drawer-item-verify-cmd` span and the `ok`/`failed` span with its
  existing conditional class. Both survive collapsing, which is the point —
  what ran, and whether it passed, must be legible without expanding
  anything. Give the summary a class of its own for a later stylesheet to
  hook, but do not add a rule for it here.
- The tail keeps `className="run-drawer-item-verify-tail"` and becomes the
  `<details>`'s non-summary child.

Two things to confirm in the browser before calling this done, because neither
is decidable from the source alone:

1. **`display: flex` on a `<details>`.** The inherited rule makes the element a
   flex container, and a summary that is a flex item has historically rendered
   its disclosure marker inconsistently across engines. If the marker or the
   open/closed toggle misbehaves, the fallback needs no stylesheet either:
   keep the existing `<div className="run-drawer-item-verify">` exactly as it
   is and nest a bare `<details>` around the tail alone, inside it.
2. **Row placement before the companion task lands.** Until that task gives the
   tail `flex-basis: 100%`, an expanded tail may wrap onto the summary's own
   line instead of below it. Cosmetic, and it resolves itself when the other
   half of `ref-1` merges — do not fix it here by editing the stylesheet.

## Test cases

All in `test/orchestrator-drawer.test.tsx`, alongside the existing verification
test. The shared fixture (`test/fixtures/orchestrator-run.json`) carries **no**
failing verification row — every one of its four rows is `ok: true` — so the
failed cases build their queue inline through the existing `runPayload({...})`
override rather than editing the fixture, which `orchestrator-strip.test.tsx`
also reads.

1. **A passing row's tail is collapsed.** bug-14's last verification row is
   `pnpm run typecheck`, `ok: true`. Its `<details>` exists and its `open`
   property is `false`.
2. **A failing row's tail is open.** Override one queue item with a
   verification row carrying `ok: false` and a recognisable tail; that row's
   `<details>` has `open` true, and the tail text is present.
3. **Collapsing hides output, never identity.** For both rows above, the
   `<summary>`'s own text contains the command string and the pass word — `ok`
   for the passing row, `failed` for the failing one.
4. **No verification, no disclosure.** task-21 has `verification: []`; its row
   contains no `<details>` element at all. Guards the existing
   `verify !== null` gate against being folded into the new conditional.
5. **The existing test at line 79 keeps passing, unedited.** It asserts
   bug-14's tail text via `toHaveTextContent`, and a collapsed `<details>`
   still holds its content in the DOM. That it needs no change is the
   assertion that this task collapsed the tail rather than dropping it — if
   it goes red, the implementation drifted to the rejected option.

## Done when

- `pnpm test` green, with case 5 unedited.
- `pnpm run typecheck` and `pnpm run build` green.
- The drawer was actually opened in a browser and shows a closed green row and
  an open failed one, per the two confirmations in the Plan.
- `client/src/styles.css` shows no diff.
