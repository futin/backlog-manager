---
id: bug-15
title: An aborted run's stalled item still reads as live in the Runs pane
created: 2026-09-02
---

## Symptom

Open an aborted run in the Runs detail pane. Its in-flight item — the one the
run died on, frozen at a non-terminal stage — presents as if work were still
happening on it, in two places at once:

- **`RowTime`** prints `<work> elapsed` measured to `now`, so a run aborted a
  day ago shows something like `30h 05m elapsed` for that row.
- **`StageTrack`** renders that item's current stage as a `run-track-dot-current`
  — the cyan dot with the pulsing ring, the app's "this is happening right now"
  signal.

Observed live on `run-20260901-112035` (`aborted`, `bug-2` frozen at
`dispatched`).

## Repro

1. Runs tab → pick any run whose status chip reads `aborted` (or `failed`) and
   whose queue still holds an item at a non-terminal stage.
2. The item's right-margin time keeps counting up; its current node pulses.

## Affects

- `client/src/lib/run-time.ts` — `itemDurationMs` (falls back to `now` while an
  item has not reached a terminal stage) and `stepperDots` (derives dot state
  from the item alone, with no notion of run status).
- `client/src/components/board/RunRowTime.tsx` — `RowTime`, shared by the
  drawer and the pane.
- `client/src/components/runs/StageTrack.tsx` — renders `stepperDots`' output.

## Cause

Both functions take an **item** and know nothing about the **run**. That is not
an oversight: `itemDurationMs` is the single implementation the "queue wait is
not work" invariant rests on (see `docs/invariants.md`), and `stepperDots` and
`RowTime` are shared with `RunDrawer`, whose rendered output is frozen by a
Global Constraint — so neither can grow a run-status parameter without either
widening a shared contract or re-forking an implementation this codebase
deliberately unified.

Both were raised during the runs-view-redesign review (2026-09-02) and parked
with that reasoning. The criterion applied then: unlike the sibling defects
that *were* fixed (`runStageTotals`, see bug-14), these corrupt no aggregate —
they are per-row readings sitting under a header that already says the run
aborted. The reading is arguably even honest for `RowTime` ("open since then"),
but the pulsing dot is not: nothing is happening.

Worth deciding whether the honest fix is a run-status prop threaded into the
pane's own wrappers (leaving the shared lib functions untouched), or accepting
the current behaviour and dropping only the pulse.

## Fix

unknown
