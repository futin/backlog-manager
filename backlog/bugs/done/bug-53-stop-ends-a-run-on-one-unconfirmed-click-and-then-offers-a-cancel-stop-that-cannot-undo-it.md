---
id: bug-53
title: Stop ends a run on one unconfirmed click and then offers a Cancel stop that cannot undo it
created: 2026-09-22
updated: 2026-09-22T19:42:09Z
started: 2026-09-22T19:17:45Z
execute-elapsed: 1464
execute-tokens: 143519
---

## Symptom

Two halves of one mistake, and they point opposite ways.

**The Stop chip ends a run on the first click, with no confirmation.** It sits beside Pause, at the same size, one pixel-miss away from it. Its own
doc comment states the stakes — "this one IS destructive — it abandons whatever worktree the run is mid-way through" — and then the click goes
straight through to `POST /api/agents/stop`. There is no confirmation anywhere in `client/src`: no `window.confirm`, no dialog component, nothing.
A multi-hour unattended operation is one misclick from over.

**The `Cancel stop` chip then promises an undo that does not exist.** By the time it is drawn, the same request that recorded the stop has already
awaited `spawnAbort(project)`, so an `--abort` session is running; the tool side has already refused every `stage` transition with exit `10` and
`watch` has already SIGTERMed the child. `Cancel stop` deletes the control file and spawns nothing. It restores no child, no worktree, no branch, and
no run. It is drawn in `flat`, the variant reserved for controls that destroy nothing, beside a note reading "Stopping — this run is being ended" —
so it reads as a withdrawal that is still available, when the thing it would withdraw has already happened.

Confirmed live on run-20260922-144041 (guide-manager issue #5, stopped from the board): the stop landed at ~14:42:01 with `stage_exit=10`, the abort
session ran at 14:42:19, and by 14:42:28 the worktree and branch `backlog/5` were gone. Nothing in that sequence has a withdrawal point.

## Repro

1. Start an orchestrator run from the board and let an item reach `dispatched`.
2. Open the run detail and click `Stop` once. Nothing asks for confirmation; the run begins ending immediately.
3. The controls redraw as "Stopping — this run is being ended" with a `Cancel stop` chip. Click it.
4. The chip succeeds and the note clears — and the run is still over. The child was signalled, the `--abort` session already ran, the worktree and
   branch are gone. Nothing came back.

Step 2 alone is the first defect; steps 3–4 are the second.

## Affects

- `client/src/components/RunControls.tsx:271` — `stopControl`, the Stop chip: `onClick` calls `stopOrchestrate` directly, no confirmation step
- `client/src/components/RunControls.tsx:303` — the `run.stopRequested` branch, which draws the note and the `Cancel stop` chip
- `client/src/components/RunControls.tsx:311` — the `Cancel stop` chip itself, `variant="flat"`, calling `cancelStopOrchestrate`
- `client/src/lib/agents.ts:433` — `cancelStopOrchestrate`, whose own comment already concedes "It spawns nothing"
- `server/src/agents/agents.service.ts:1148` — `stop(project, cancel)`; the non-cancel path awaits `spawnAbort` in the same request, which is why
  there is no window in which a withdrawal could mean anything
- `server/src/agents/agents.service.ts:1161` — the `cancel` branch, `clearPauseRequest(project)` and nothing else
- `server/src/agents/agents.controller.ts:328` — `POST /api/agents/stop`, which accepts `cancel: true`
- `server/src/orchestrator/pause-control.util.ts:249` — `clearPauseRequest`, shared with pause's genuine withdrawal and NOT to be broken by this fix

## Cause

The stop control was built by copying the pause control's shape, and the two actions are not the same kind of thing.

A pause is a REQUEST the run honours at the next item boundary. Nothing is destroyed while it is outstanding, the run keeps working, and withdrawing it
before that boundary genuinely returns the run to where it was — so a `Cancel` with no confirmation on either side is exactly right, and the `flat`
variant is honest. Both properties came along with the copy. Neither survives the change of verb.

A stop is an ACT, and it completes inside the request that records it: `stop()` writes the control file and then awaits `spawnAbort(project)` before
returning. The control file is only the marker; the abort session, the SIGTERM and the worktree teardown are the actual event. So the component is
offering to withdraw a marker for something already done, and doing it in the visual language of a reversible choice.

The missing confirmation has the same root: pause needed none, so none was written, and `client/src` never grew a confirmation primitive at all.

## Fix

Two changes, and the first is the one that matters — a confirmation on the destructive action is worth more than any amount of cleanup on the
withdrawal.

**Stop asks first.** The click opens a confirmation naming the consequences in the run's own terms: the item in flight is abandoned, its worktree and
branch are removed, the run ends and cannot be resumed. Confirming performs today's `POST /api/agents/stop`; dismissing makes no request at all. This
is the client's first confirmation, so it also decides where that primitive lives — `components/ui/`, per the one-home rule, not inline in
RunControls. Escape closes it and only it (the Escape-has-one-owner invariant), and it must not become a second dialog layer fighting the run detail
sheet.

**`Cancel stop` goes away.** The `stopRequested` branch keeps its note and offers no control. Remove `cancelStopOrchestrate` with it — its only caller
is the chip.

Server side, decide and state it in the item rather than leaving it to the implementer: whether `POST /api/agents/stop` keeps accepting `cancel: true`.
Removing it is cleaner and matches "nothing resumes a stopped run"; keeping it as a 409 refusal is more honest to anyone holding an old client. Either
way `clearPauseRequest` itself is untouched — pause's withdrawal and the resume path's speculative clear both depend on it, and neither is in scope.

Do NOT add a "resume a stopped run" path as compensation. A stopped run is over; starting the work again is a new run, which the board already offers.

## Done when

- clicking Stop makes no API request until the confirmation is accepted; dismissing it leaves the run untouched and makes no request
- accepting the confirmation issues exactly one `POST /api/agents/stop`
- a run with `stopRequested` renders the "Stopping" note and no withdrawal control
- pause's own `Cancel` still renders and still calls `cancelPauseOrchestrate` — the shared shape must not be removed collaterally
- the decided behaviour of `POST /api/agents/stop` with `cancel: true` is asserted, whichever was chosen
- test cases live in `test/run-controls.test.tsx` for the four client cases and `test/agents-stop.test.ts` for the route, both flat in `test/` per the
  jest convention

## Outcome

2026-09-22 — fixed. Cause confirmed live against the code: `stopControl`'s `onClick` called `stopOrchestrate` directly, and the `stopRequested` branch drew a
`flat` `Cancel stop` over a stop whose `--abort` spawn `stop()` had already awaited.

**Stop asks first.** New primitive `client/src/components/ui/Confirm.tsx`: the clicked chip is replaced IN PLACE by the question and two answers — not a
modal, because DESIGN.md §8.7 keeps `Modal` to one composer and nothing else floating, and a box over the Runs page would cover the run it asks about. The
question names the item in flight, says its worktree and branch are removed and that the run cannot be resumed; `Stop run` (`danger`) sends the one POST
through `act` (bug-19's guard unchanged), `Keep running` (`flat`) holds the focus, and it and Escape send nothing. Escape goes through `useDialogEscape`, so
the confirmation is topmost while drawn and closes alone; it is documented as a stack entry that is NOT one of the three dialogs, which keeps the
`dialog-count-docs` count true.

**`Cancel stop` is gone**, with `cancelStopOrchestrate` and the `'cancel-stop'` member of `RunControlsChange`. A stop-requested run shows the `Stopping` note
(and the refused-abort sentence, when there is one) and no control at all.

**Server decision: `POST /api/agents/stop` with `cancel: true` is a 409**, uncoded, `a stop cannot be withdrawn — …`, refused in the controller before the
run lookup. Chosen over dropping the flag because an old client still sends it, and a route that ignored it would read that click as a SECOND stop — a second
`--abort` spawn. `AgentsService.stop(project)` lost its `cancel` parameter. A string `'true'` is still a stop, as before. `clearPauseRequest` is untouched;
pause's own cancel still deletes the control file of either kind. The resume refusal no longer says "Cancel the stop first" — it says to start a new run.

Verification (`pnpm test`, then `pnpm run typecheck`):

```
Test Suites: 129 passed, 129 total
Tests:       2194 passed, 2194 total
Snapshots:   0 total
# tests 784
# suites 0
# pass 784
# fail 0
typecheck exit 0
```

Not checked in a browser: no live run was available to click Stop on, so the look of the inline confirmation is covered by the tests and the CSS alone.

Contract sweep: 12 files updated (.claude/DESIGN.md §8.4.1 and §8.7, .claude/rules/board.md, .claude/rules/orchestrator.md, docs/subsystems/invariants.md stop and Escape entries, docs/subsystems/board.md ×2, docs/subsystems/api.md, shared/types.ts `StopResult`, client/src/lib/agents.ts, client/src/hooks/useDialogEscape.ts, client/src/components/ui/Modal.tsx, server/src/orchestrator/watchdog-state.service.ts, and the resume refusal in server/src/agents/agents.service.ts). Left standing on purpose: `backlog/bugs/open/bug-54-…md` still says "`stop(cancel: true)` is untouched … clears the control file and spawns nothing" in its Done-when — another item's plan, which is groom's to edit, not execute's; bug-54 needs a re-groom line saying `cancel: true` is now a 409. `docs/superpowers/` plans that mention `Cancel stop` are historical records and were not rewritten.
Red proof: 23 tests went red with the change reverted (10 stop cases in test/run-controls.test.tsx and 10 stop-leg rows in test/watchdog-coupling.test.tsx with both client halves reverted; 2 cases in test/agents-stop.test.ts with the controller refusal disabled; 1 case in test/dialog-escape.test.tsx with Confirm on its own `window` listener instead of `useDialogEscape`). Pause's own `Cancel` case (`cancels a pending pause`) was already present and stays green.
