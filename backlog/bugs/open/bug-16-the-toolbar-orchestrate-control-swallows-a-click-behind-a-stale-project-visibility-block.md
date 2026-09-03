---
id: bug-16
title: The toolbar Orchestrate control swallows a click behind a stale project-visibility block
created: 2026-09-03
tags: board, dispatch, agents, orchestrate
---

## Symptom

The board toolbar's **Orchestrate** button sits disabled reading "the dashboard
does not list /Users/… — most likely no Claude session there inside its
LOOKBACK_HOURS" long after that stopped being true, and nothing in the UI
clears it. Clicking does nothing. Only a reload, or blurring and refocusing the
window, fixes it.

This is bug-13 one control over. bug-13 fixed exactly this failure for the
per-item dispatch button — a click on a project-visibility block now re-asks
the status (`DispatchButton`'s `reverify`) and opens the sheet if the block has
cleared — and deliberately did not touch this one, because its own Fix and
Affects named the per-item control only. Same gate
(`projectDispatchGate`), same reason string, same unrecoverable shape.

Arguably worse here than there, because a project-scoped control is the entry
point to an unattended queue drain: the reader who cannot start a run has no
per-card fallback for the whole queue, and the message tells them to go fix
something that is already fine.

## Repro

1. Filter the board to one project while that project is absent from
   `status.projectPaths`.
2. Make it present (start a session in that repo, start the dashboard, or fix
   whatever hid it).
3. Keep the browser window focused the whole time.
4. The Orchestrate button stays disabled with the stale reason indefinitely.

`GET /api/agents/status` answers correctly throughout.

## Affects

- `client/src/components/board/BoardView.tsx:417-422` — `orchestrateGate`,
  `showOrchestrate`, `orchestrateBlockedReason`
- `client/src/components/board/BoardView.tsx:599-605` — `onClick`'s
  `if (orchestrateBlockedReason !== null) return;`, whose own comment cites
  "DispatchButton's identical guard" — the guard that no longer is
- `client/src/hooks/useAgents.ts` — `reload` already resolves to the fetched
  status (bug-13), and `BoardView` already holds it as `reverifyAgents`

## Cause

unknown — bug-13's cause is the obvious candidate and reads across verbatim
(`useAgents` refetches on mount and window focus only, so a window that never
loses focus is never asked again; the sheet that would re-derive the block
server-side is behind the control the stale answer disabled), but it has not
been confirmed for this control. Two things need checking before it can be
called the same bug: whether `OrchestrateSheet` re-derives the gate on open at
all — `LaunchSheet` does, via `plan()`, and that asymmetry is what made bug-13
"unrecoverable" rather than merely late — and whether the fourth rule in
`orchestrateGate`'s ladder (a fresh run hides the control outright) interacts,
since that one is fed by `useOrchestratorRuns` and is not stale by
construction.

## Fix

unknown. The shape bug-13 landed is the starting point and most of the
machinery is already in place — `BoardView` destructures
`useAgents().reload` as `reverifyAgents` and threads it to every card, so the
toolbar's `onClick` has it in scope with nothing new to plumb. What still has
to be decided is where the "re-ask once, guard the in-flight ask, mark it busy"
logic lives: `DispatchButton` owns its copy internally, and this control is
hand-restated markup in `BoardView` (deliberately — its signature is fixed
around one `BacklogItem`, which a project-level control does not have), so
either the toolbar grows its own small copy or the pair gets a shared hook. A
copy is three lines of state and a promise; a hook is the drift-proof answer to
a rule this repo has now written twice. Whichever lands, the scope line from
bug-13 applies unchanged: re-ask ONLY for the project-visibility block, never
for the environment ladder above it (which hides the control anyway) and never
for the fresh-run rule below it.
