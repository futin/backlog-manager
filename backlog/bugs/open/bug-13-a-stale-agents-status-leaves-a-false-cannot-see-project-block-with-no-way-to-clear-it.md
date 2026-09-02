---
id: bug-13
title: A stale agents status leaves a false 'cannot see project' block with no way to clear it
created: 2026-09-02
tags: board, dispatch, agents
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
