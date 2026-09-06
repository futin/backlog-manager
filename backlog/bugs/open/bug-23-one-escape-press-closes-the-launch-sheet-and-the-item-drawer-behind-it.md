---
id: bug-23
title: One Escape press closes the launch sheet and the item drawer behind it
created: 2026-09-06
tags: ui, audit-2026-09-06
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

Four independent copies of the same effect, none of which knows the others exist. The
copy-paste is documented and deliberate; the Escape interaction between two live copies is
not addressed anywhere in the comments that justify the coexistence.

## Fix

unknown — the shape is a single owner of the Escape key rather than four listeners. Options
worth weighing before picking: a small dialog-stack context where only the topmost
registered dialog reacts; or each dialog calling `stopImmediatePropagation` and relying on
mount order (fragile — order is a render detail, not a contract); or moving to a real
`<dialog>` element, which gets topmost-only Escape from the platform but changes focus and
styling behaviour across all four surfaces. Whichever is chosen needs a test that mounts
drawer + sheet together and asserts one Escape leaves the drawer open — the gap that let
this ship.
