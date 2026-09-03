---
id: bug-13
title: A stale agents status leaves a false 'cannot see project' block with no way to clear it
created: 2026-09-02
tags: board, dispatch, agents
updated: 2026-09-03T12:39:28Z
started: 2026-09-03T12:11:04Z
execute-elapsed: 1704
---

## Symptom

A card's dispatch button sits disabled reading "the dashboard cannot see
/Users/… — no Claude session there inside its LOOKBACK_HOURS" long after that
stopped being true, and nothing in the UI clears it. The message names a fix
(open a session there, raise `LOOKBACK_HOURS`) that is wrong: the project is
visible, the tab's copy of the status is simply old.

Worse than an out-of-date label, because the message is confidently actionable.
Observed 2026-09-02 while diagnosing claude-agents-dashboard's bug-14, which is
what made the status wrong in the first place — but that bug is only one way to
get here, not the cause of this one.

## Repro

1. Load the board while a project is absent from `status.projectPaths`.
2. Make it present (start a session in that repo, start the dashboard, or fix
   the upstream condition that hid it).
3. Keep the browser window focused the whole time — a board on a second
   monitor, or the only window in use.
4. The button stays disabled with the stale reason indefinitely. Clicking it
   does nothing. Only a reload, or blurring and refocusing the window, fixes it.

`GET /api/agents/status` answers correctly throughout, so the server and the
tab disagree with no way for the reader to tell.

## Affects

- `client/src/hooks/useAgents.ts:31-38` — mount + `window` focus, no interval,
  no `visibilitychange`
- `client/src/components/board/DispatchButton.tsx:107-115` — `if (blocked !== null) return;`
- `server/src/agents/agents.service.ts:31-36` — `PROJECT_TTL_MS`, and the
  comment asserting the sheet corrects this
- `shared/agent.ts:287` — the reason string being shown

## Cause

Two things that are each defensible alone and wrong together.

`useAgents` refetches on mount and `window` focus only, deliberately: "what
changes it happens outside this tab, and you come back to the tab afterwards."
That reasoning holds for a tab you leave and return to, and fails for one that
never loses focus — the state it changed to is never re-asked.

The second half is what makes it unrecoverable rather than merely slow.
`AgentsService`'s `PROJECT_TTL_MS` comment argues the cost is bounded: "a minute
of staleness costs a disabled button that would have worked, which the sheet's
own re-check then corrects." That is true in exactly one direction. A stale
*enable* is corrected by the sheet, because clicking opens it and `plan()`
re-derives `blocked` server-side. A stale *disable* is not: `DispatchButton`'s
`onClick` returns early on `blocked !== null`, so the sheet never opens and the
re-check that would fix the status is behind the control the bad status
disabled. The self-correcting path is unreachable from the state that needs it.

Note this is only true of the project-visibility block. The run-claim block
(`runClaimBlock`) is fed by `useOrchestratorRuns`, which polls every 5s while
any run is fresh, so it is never stale in this way.

## Fix

Make a click on a button blocked *by project visibility* re-verify instead of
doing nothing: refetch the status (`reload` is already returned by `useAgents`
and already threaded to the board) and, if the block has cleared, proceed to
open the sheet. The server is authoritative and `plan()` re-checks anyway, so
the worst case is one wasted request and the button staying disabled — with the
reader now knowing it was actually asked.

Scope it to that one block. The run-claim block must keep swallowing the click:
it is fresh by construction, and a claimed item genuinely must not be
hand-dispatched.

Two alternatives, both rejected. A polling interval on `useAgents` asks the
same question on a timer for every reader whether or not anyone is looking at a
blocked button, which is what the mount+focus cadence was chosen over. Adding a
`visibilitychange` listener narrows the window but does not close it — the
failing case has the tab visible and the window focused the entire time.

Whichever lands, the reason string should stop asserting a cause it cannot
know. `shared/agent.ts:287` states "no Claude session there inside its
LOOKBACK_HOURS" as fact when all the client actually knows is that the path is
absent from the list it last fetched.

Cases the fix must satisfy:

- A `dispatch-chip` blocked by project visibility, clicked once: triggers a
  status refetch. With the refetched status containing the path, the sheet
  opens. With it still absent, no sheet and the reason unchanged.
- A chip blocked by `runBlock` only, clicked: no refetch, no sheet.
- A chip blocked by both: behaves as the run-claim case.
- An unblocked chip: dispatches with no extra status fetch (unchanged).

## Outcome

2026-09-03 — fixed as the Fix section describes: a click on a dispatch button
blocked *only* by project visibility now re-asks the status and opens the
launch sheet if the block has cleared. The diagnosis held against the code
unchanged; `useAgents` still refetched on mount and `window` focus alone, and
`DispatchButton`'s `onClick` still returned early on `blocked !== null` with
the third (in-progress) block from bug-12 now folded into that same string.

What changed:

- `client/src/hooks/useAgents.ts` — `reload` now RESOLVES to the status it
  fetched instead of returning void, and still never rejects (a failed fetch
  resolves to the flatly-off status it already set). The setState it also
  performs lands a render too late for the handler that provoked it, which is
  why the answer is handed back directly.
- `client/src/components/board/DispatchButton.tsx` — the one block string is
  now derived in two halves, `gateBlock` (project visibility) and `itemBlock`
  (`progressBlock ?? runBlock`), in the same precedence as before. A click on a
  blocked button re-asks only when `gateBlock` is the *only* block and a
  `reverify` prop was supplied; it guards against a second in-flight ask, marks
  itself `aria-busy` while it waits, and dispatches only if `dispatchGate`
  reads `enabled` against the fresh answer.
- `reverify` threaded from `BoardView` and `ArchiveView` (`useAgents().reload`)
  through `ItemCard` and `ItemDrawer`, optional exactly like `runBlock`, so a
  caller with no status to re-ask leaves the click inert as before.
- `client/src/styles.css` — a `[aria-busy='true']` rule for both shapes,
  declared after the `[aria-disabled='true']` rules so it wins on equal
  specificity. Without it the only signal was in the accessibility tree.
- `shared/agent.ts` — the reason string now states what the caller knows and
  hedges what it cannot: `the dashboard does not list <path> — most likely no
  Claude session there inside its LOOKBACK_HOURS`. Three test assertions on the
  old wording (`agents-dispatch`, `orchestrator-start`, `orchestrator-start-ui`)
  moved with it.
- `server/src/agents/agents.service.ts` — `PROJECT_TTL_MS`'s comment no longer
  claims the sheet corrects this; it records that the claim held in one
  direction only, and that a re-ask inside the same minute can still be
  answered from that cache. The bound is deliberate and unchanged: the fix
  removes the *unrecoverable* state, not the cache.
- `CLAUDE.md` and `docs/invariants.md` — the dispatch-block invariant now says
  which one of the three lets a click through, and why the other two must not.

Tests, all written before the code and watched fail:

- `test/dispatch-button.test.tsx` — the four cases the Fix names plus three
  more: busy-while-in-flight, one ask per burst of clicks, and the in-progress
  block (bug-12's, which the Fix predates) refused like the run claim. Plus the
  repro end to end through `BoardView`, with a status that changes between
  mount and click and no focus event in between — the case a component-level
  test with a hand-written `reverify` could not catch, since it is the
  threading that was missing.
- `test/agents-hook.test.tsx` (new) — `reload` resolves to the fetched status,
  and resolves to an off status rather than rejecting when the fetch fails.
- `test/dispatch-busy-style.test.ts` (new) — the busy rule exists for both
  shapes and is declared after the disabled rule it has to beat.
- `test/agents-shared.test.ts` — the reason states the path as fact and the
  lookback as a likelihood.

Verification:

```
$ pnpm run typecheck
> tsc --noEmit

$ pnpm test
Test Suites: 55 passed, 55 total
Tests:       845 passed, 845 total
Snapshots:   0 total
Time:        32.772 s

$ pnpm run test:skills
ℹ pass 277
ℹ fail 0

$ pnpm run build
✓ built in 1.10s
```

Two things this deliberately did not do. The toolbar **Orchestrate** control
(`BoardView`, `orchestrateGate`) swallows a click behind the identical
project-visibility gate and has the identical unrecoverable-stale shape; it is
out of this item's scope (the Fix and the Affects list name the per-item
control only) and wants its own capture. And the re-ask does not bypass the
server's `PROJECT_TTL_MS` project map, so a re-ask within a minute of a truly
stale server cache can legitimately answer the same — one more click a moment
later is the remaining cost, and it is now a cost the reader can see being
paid.

One unexplained observation, recorded rather than hidden: across nine full
suite runs during this work, `test/agents-origin-guard.test.ts` failed once,
and passed on the other eight plus four isolated runs of that file and three
runs of it paired after the new hook suite. The failure message was not
captured before the run scrolled, and this fix touches nothing that suite
asserts (its only change in that module is a comment). Treated as a
pre-existing flake, not as evidence about this change.
