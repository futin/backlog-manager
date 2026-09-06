---
id: bug-23
title: One Escape press closes the launch sheet and the item drawer behind it
created: 2026-09-06
tags: ui, audit-2026-09-06
updated: 2026-09-06T22:52:08Z
groom-elapsed: 57
groom-tokens: 9497
started: 2026-09-06T22:39:31Z
execute-elapsed: 757
execute-tokens: 87331
---

## Symptom

Four dialogs each register their own unguarded `window` keydown listener that calls
`onClose` on Escape. Two of them are mounted simultaneously **by design** — the board
deliberately keeps `ItemDrawer` open behind `LaunchSheet` — so one Escape press runs both
callbacks and closes the drawer the user expected to return to.

None of the four does `stopImmediatePropagation`, checks whether it is the topmost dialog,
or reads `defaultPrevented`.

## Repro

1. Open an item's drawer on the board.
2. Click Dispatch — the launch sheet opens and the drawer stays open behind it, which is
   what `BoardView.tsx:194-196` says it is supposed to do.
3. Press Escape once.

Both close. `test/dispatch-button.test.tsx:676-692` already proves that both-mounted state
is reachable; every Escape case in `test/` mounts a single dialog, so none of them asserts
the drawer survives.

## Affects

- `client/src/components/board/LaunchSheet.tsx:62-68`
- `client/src/components/board/ItemDrawer.tsx:247-253`
- `client/src/components/board/RunDrawer.tsx:240-246`
- `client/src/components/board/OrchestrateSheet.tsx:262-269`
- `client/src/components/board/BoardView.tsx:868-878` and `:913-916` — `ItemDrawer` and
  `LaunchSheet` rendered from independent state
- `client/src/components/board/BoardView.tsx:594-597` — `openLaunchSheet` clears only
  `orchestrating`, never `open`, so both listeners are live together

## Cause

Four independent copies of the same four-line effect — `LaunchSheet.tsx:61-67`,
`ItemDrawer.tsx:246-252`, `RunDrawer.tsx:239-245`, `OrchestrateSheet.tsx:262-268` — each
binding its own `keydown` on `window` and calling its own `onClose` unconditionally. They
are all `window` listeners rather than element handlers on purpose (RunDrawer's comment
says why: Escape must work no matter where focus sits, since none of the four traps focus),
so DOM nesting cannot rank them and a bubbling `stopPropagation` cannot reach them. Every
listener that is registered when the key is pressed fires, in registration order, and none
of the four asks whether it is the dialog the user is actually looking at.

That only becomes a defect because one pair is deliberately allowed to coexist.
`BoardView.tsx`'s `openLaunchSheet` clears `orchestrating` and nothing else, and the
comment above it states outright that `dispatching` is excluded from the three-way overlay
exclusion `orchestrating`/`open`/`openRunProject` participate in — LaunchSheet layering
over a still-open ItemDrawer is the tested, intended behaviour
(`test/dispatch-button.test.tsx:675-691`). So the two listeners are live together by
design, and one Escape runs both.

Confirmed by repro rather than by reading: a scratch jsdom test that renders `BoardView`,
opens the drawer, opens the sheet from inside it, and presses Escape once fails on
`expect(screen.getByRole('dialog', { name: 'a task' })).toBeInTheDocument()` — the sheet
closes and the drawer is gone with it.

`ArchiveView.tsx:317-332` renders the same two components from the same two independent
pieces of state, with its own comment pointing back at BoardView's, so the defect is
reachable on Archive identically. Nothing is wrong in either host: both are correct about
overlay state, and neither can see that the two components fight over one key.

## Fix

Give Escape a single owner: one module-level LIFO stack of open dialogs and one `window`
listener, with only the top entry's `onClose` invoked. Replace all four copied effects with
one call to a new hook.

**1. `client/src/hooks/useDialogEscape.ts` (new).** A module-scoped array of entries and a
module-scoped `onKey` that, on `Escape`, calls `stack[stack.length - 1]` and nothing else.
The listener is added when the stack goes from empty to one and removed when it returns to
empty — not installed permanently — so `test/launch-sheet.test.tsx:157`'s "removes its
Escape listener when it unmounts" keeps testing something real.

Two details the implementation must get right, both of them the reason a naive version
fails:

- **The registration effect takes an empty dependency array, and `onClose` is read through
  a ref updated on every render.** All four call sites are passed an inline arrow
  (`onClose={() => setOpen(null)}`), so `onClose` has a new identity on every render of the
  host. An effect keyed on `[onClose]` would pop and re-push its entry each time — and
  BoardView re-renders on a 5s runs poll and on `useNow`, so the drawer would silently
  climb back above the sheet while the user was reading it. Stack position must be fixed
  for the dialog's mounted lifetime; only the callback behind it may change.
- **Remove by identity (`indexOf` the entry object), never `pop()`,** since dialogs can
  unmount out of order.

Module-level state rather than a React context: four suites mount these components
standalone (`test/launch-sheet.test.tsx`, `test/drawer.test.tsx`,
`test/orchestrator-drawer.test.tsx`, `test/orchestrator-start-ui.test.tsx`), and Board and
Archive are separate lazy chunks, so a provider would have to sit in `App.tsx` and every
isolated mount would need wrapping. A shared module both chunks import is the shape
`lib/view-keys.ts` already uses for exactly this reason.

**2. The four components** each drop their `useEffect` and call `useDialogEscape(onClose)`.
No `stopImmediatePropagation` anywhere — there is only one listener left to stop. The
`<dialog>` element was considered and rejected: it would get topmost-only Escape from the
platform but changes focus, scroll-locking and backdrop styling across all four surfaces,
which is a redesign, not this fix.

**Ranking is by mount order — "the most recently opened dialog owns Escape."** Stated
because it is a contract now, not an accident: the sheet mounts after the drawer it layers
over, so it wins, and when it unmounts the drawer is top again. One case is knowingly left
alone: `openItemDrawer` does not clear `dispatching`, so a keyboard user who tabs into a
card behind the sheet (none of these overlays traps focus) can open the drawer *after* the
sheet, making it topmost in the stack while the sheet is still painted above it. Escape
would then close the drawer. That is a pre-existing untrapped-focus problem, ranking by
paint order would mean a z-index registry, and this bug is about one press closing two
dialogs — so it stays out, deliberately, rather than being fixed silently.

### Test cases

`test/dialog-escape.test.tsx` (new), plus the four existing single-dialog Escape cases
staying green:

1. `BoardView`: open the drawer, open the sheet from inside it, press Escape once — the
   sheet is gone and `getByRole('dialog', { name: 'a task' })` still resolves. This is the
   scratch repro above; it must fail against `main` before the hook lands.
2. Same setup, a second Escape — the drawer closes too.
3. Same setup, force a host re-render between opening the sheet and the press (advance the
   runs poll, or a state change on BoardView), then one Escape — still the sheet that
   closes. This is the case that catches an effect keyed on `[onClose]`.
4. `ArchiveView`: the same drawer-then-sheet sequence and the same single-Escape assertion,
   since it is the second host of the same pair.
5. Hook-level, two throwaway components mounting in order: Escape calls only the second's
   `onClose`; unmount it; Escape then calls the first's. Then unmount that one and assert
   `window` has no listener left (spy on `removeEventListener`, mirroring
   `test/launch-sheet.test.tsx:157`).

In the browser (playwright MCP tools): open `http://localhost:5177`, click a groomed task
card on the Board to open its drawer, click the drawer's dispatch button so the launch
sheet opens over it, press Escape once, and confirm the launch sheet is gone while the item
drawer is still on screen; press Escape again and confirm the drawer closes.

## Outcome

2026-09-06 — Fixed as planned. `client/src/hooks/useDialogEscape.ts` is new: a
module-level LIFO stack of open dialogs and one `window` keydown listener,
installed when the stack goes empty → one and removed when it returns to empty,
calling only `stack[stack.length - 1]`'s `onClose`. The registration effect takes
an empty dependency array and reads `onClose` through a ref rewritten on every
render, and entries are removed by `indexOf` rather than `pop()` — both details
the Fix called out. `ItemDrawer`, `LaunchSheet`, `RunDrawer` and
`OrchestrateSheet` each dropped their own copy of the four-line effect and call
`useDialogEscape(onClose)`; no `stopImmediatePropagation` anywhere, since there
is one listener left to stop. `RunDrawer`'s and `OrchestrateSheet`'s header
comments described the duplication as a deliberate choice and were rewritten to
describe the hook instead. A CLAUDE.md invariant records the mount-order contract
and the untrapped-focus case left deliberately out.

`test/dialog-escape.test.tsx` is new: the four host cases (board single press,
board second press, board with a host re-render forced in between via its own
search box, and the same drawer-then-sheet sequence on Archive) and four
hook-level cases (LIFO ranking, listener teardown proved by a press reaching
nobody, removal by identity when a dialog below the top unmounts, and the latest
`onClose` an entry rendered with being the one called).

Red first, against the unfixed code — three of the four host cases failed on
exactly the defect, the fourth passes either way because it only asserts the
drawer eventually closes:

```
✕ closes only the sheet on the board, leaving the drawer behind it open (225 ms)
✓ closes the drawer on the second press (54 ms)
✕ still closes only the sheet after the host re-renders underneath it (203 ms)
✕ closes only the sheet on Archive too (142 ms)

● closes only the sheet on the board, leaving the drawer behind it open
  TestingLibraryElementError: Unable to find an accessible element with the
  role "dialog" and name "a task"
Tests: 3 failed, 1 passed, 4 total
```

Green after the hook, and the whole suite with it:

```
$ npx jest test/dialog-escape.test.tsx --runInBand
✓ closes only the sheet on the board, leaving the drawer behind it open (110 ms)
✓ closes the drawer on the second press (59 ms)
✓ still closes only the sheet after the host re-renders underneath it (71 ms)
✓ closes only the sheet on Archive too (49 ms)
✓ gives Escape to the last dialog mounted, then back to the one below it (8 ms)
✓ leaves no window listener behind once the stack empties (2 ms)
✓ removes the right entry when a dialog below the top unmounts (5 ms)
✓ calls the latest onClose an entry was rendered with (14 ms)
Tests: 8 passed, 8 total

$ pnpm test
# tests 411
# pass 411
# fail 0
────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)
pnpm test: both runners passed.

$ pnpm run test:jest
Test Suites: 77 passed, 77 total
Tests:       1477 passed, 1477 total

$ pnpm run typecheck
$ tsc --noEmit
(no output, exit 0)

$ pnpm run build
✓ built in 1.63s
```

The four pre-existing single-dialog Escape cases stayed green, including
`test/launch-sheet.test.tsx`'s "removes its Escape listener when it unmounts" —
which still tests something real, since the listener is torn down with the last
entry rather than installed permanently.

Not done: the Fix's browser check (playwright against `http://localhost:5177`).
This ran unattended in a worktree with no stack up, and a server already on 5177
would be serving the main tree's code, so that check could only have proved
something about code this branch does not contain. The two jsdom host cases
drive the same click-click-Escape sequence through the real `BoardView`,
`ArchiveView`, `ItemDrawer` and `LaunchSheet`.
