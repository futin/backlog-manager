---
id: bug-16
title: The toolbar Orchestrate control swallows a click behind a stale project-visibility block
created: 2026-09-03
tags: board, dispatch, agents, orchestrate
updated: 2026-09-04T21:01:02Z
groom-elapsed: 244
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

Confirmed: bug-13's cause reads across verbatim, and both of the checks this
section asked for came back the way the guess expected — with one difference in
degree that makes this control *worse*, not merely equal.

The mechanism, end to end. `BoardView` holds `agents` from `useAgents()`, which
refetches on mount and window focus alone (`useAgents.ts`; the cadence is
deliberate — what changes the answer happens outside the tab). Line 417 derives
`orchestrateGate = projectDispatchGate(agents, projectValue)`, whose second rung
returns `{ control: 'disabled', reason: 'the dashboard does not list <path> …' }`
straight from the `projectPaths` array in whatever status the tab last fetched.
`orchestrateBlockedReason` (line 421) is that reason, and the button's own
`onClick` (line 604) returns early on it. A window that never loses focus has no
trigger that could re-fetch, so the array — and the reason derived from it —
never moves. `reverifyAgents` is already destructured three lines from the gate
(`BoardView.tsx:176`) and threaded to every card; the toolbar simply never calls
it, because bug-13's Fix and Affects named the per-item control only.

**Question 1 — does `OrchestrateSheet` re-derive the gate on open?** No, and it
says so on purpose. It takes `spawnMaxPermission` alone rather than the whole
`AgentsStatus`, and that prop's own comment argues explicitly against re-running
`dispatchGate`'s checks a second time client-side; it calls `fetchMergeCheck` on
open and nothing else. `LaunchSheet` by contrast calls `fetchAgentPlan` on mount
(`LaunchSheet.tsx:46`), which is exactly the server-side re-derivation
docs/invariants.md leans on when it says a stale *enable* self-corrects. So the
asymmetry that made bug-13 "unrecoverable" is one step sharper here: this sheet's
only server re-check is at **Start**, where the same `projectDispatchGate` runs
server-side and comes back as an *uncoded* 409 the sheet renders as an error and
stays open on (`orchestrator-start-ui.test.tsx:558`). A stale disable is
unrecoverable for bug-13's reason — the sheet sits behind the inert control —
and a stale *enable* on this control is not corrected on open either, only on
submit. Nothing about that second half is a defect to fix here; it is the reason
the fix cannot be "let the sheet sort it out."

**Question 2 — does the fresh-run rule interact?** No, and the way it fails to
interact removes work rather than adding it. `showOrchestrate` (line 420) is
`gate !== null && gate.control !== 'hidden' && !orchestrateHasFreshRun`: a fresh
run **hides** the control outright rather than disabling it, and the unfiltered
case (`projectValue === ALL`) leaves the gate `null`, which hides it too. So a
non-null `orchestrateBlockedReason` already proves the other three rules are
inactive — project-visibility is necessarily the *only* block on a rendered
toolbar button. `DispatchButton`'s `reverifiable` needs three conditions because
two sibling blocks (`progressBlock`, `runBlock`) can coexist with the gate's;
this control has no such sibling, so the same rule reduces to "the reason is
non-null and no ask is already in flight." `freshRuns` comes from
`useOrchestratorRuns` (5s poll while any run is fresh), so it is not stale in
this way and must not be re-derived from a status refetch that cannot see runs
at all.

## Fix

Give the toolbar the same one-question click bug-13 gave the card, and make the
mechanism shared so the third control that needs it cannot get it subtly wrong.

**1. Extract the mechanism, not the policy** — new
`client/src/hooks/useReverify.ts`:

    useReverify(reverify?: () => Promise<AgentsStatus>):
      { verifying: boolean; ask: (act: (fresh: AgentsStatus) => void) => void }

`ask` no-ops when `reverify` is undefined or an ask is already in flight;
otherwise it sets `verifying`, calls `reverify()` once, clears `verifying`, then
calls `act` with the fresh status. No failure branch — `useAgents().reload`
resolves to a flatly-off status rather than rejecting, and an off status is not
`enabled`, so it opens nothing.

What the hook must NOT own is the gate check. The two callers derive genuinely
different answers (`dispatchGate(item, fresh)` versus
`projectDispatchGate(fresh, path)`) and have different sibling blocks, so folding
the policy in would mean a config object per caller — the drift-prone half is the
mechanics (ask once, mark busy, act on the *fresh* answer and not on the render
that provoked the click), which is what is being shared. Rejected alternative: a
three-line copy inside `BoardView`. The repo does repeat small idioms on purpose
(three copies of the Escape effect), but those are stateless and have no wrong
answer; this one is stateful and correctness-bearing, the item file itself notes
the rule is now being written twice, and the *next* status-gated control would be
the third copy.

**2. Convert `DispatchButton` to the hook** — behaviour-preserving, and the four
existing bug-13 tests in `test/dispatch-button.test.tsx` (re-asks and dispatches,
opens nothing when still blocked, marks itself busy, asks once while in flight)
are the proof: they must pass **unchanged**, with no edits to that file. Its
`reverifiable` predicate stays exactly as written — the hook replaces the
`useState` + in-flight guard + `.then` only.

**3. The toolbar** (`BoardView.tsx`, the `board-orchestrate` button):
- take `{ verifying, ask }` from `useReverify(reverifyAgents)`;
- add `aria-busy={verifying}` alongside the existing `aria-disabled`, for the
  reason `DispatchButton` has it: a click that looks swallowed has to be legible
  as "asked, same answer";
- in `onClick`, when `orchestrateBlockedReason !== null`, capture
  `projectValue` into a local first, then `ask((fresh) => …)` and open the sheet
  for that **captured** path only if `projectDispatchGate(fresh, path).control
  === 'enabled'`. Captured, not re-read: the filter is a live `<select>` and the
  closure's value is the one the reader actually clicked for. Deliberately no
  "the filter moved, discard the answer" guard — `orchestrating` is already keyed
  on identity precisely so a sheet outlives a filter change (see its declaration
  comment), the window is one request wide, and a discard would need a ref to
  read the current filter at resolve time;
- replace the `onClick` comment's claim that this mirrors "DispatchButton's
  identical guard" — after this change the guard is genuinely identical again,
  but for the opposite reason, and the comment should say which block the click
  may re-ask and which it may not.

**Scope, unchanged from bug-13**: re-ask for the project-visibility block and
nothing else. The environment ladder hides the control (nothing to click) and
the fresh-run rule is fed by a 5s poll, so neither is reachable from a rendered
disabled button — per Cause question 2, `orchestrateBlockedReason !== null` is
already the whole condition, and no "only block" clause is needed here.

**4. `client/src/styles.css`** — add
`.board-orchestrate[aria-busy='true'] { color: var(--ink2); cursor: progress }`
**after** the existing `[aria-disabled='true']` rule, same specificity, so the
busy look wins over the disabled colour. That is the identical rule and identical
ordering constraint `.dispatch-tab`/`.dispatch-chip` already carry at line 1270.

**5. Documentation.** Two places assert the current, now-wrong scope and must
move with the code:
- `CLAUDE.md` (~line 442): "Exactly one of the three lets the click through"
  describes `DispatchButton`; extend the paragraph to say the toolbar Orchestrate
  control re-asks on the same block, by the same hook.
- `docs/invariants.md` (~line 755): the "One of the three lets the click through
  anyway" section. Add the toolbar, and correct the sentence claiming a stale
  *enable* is corrected by the sheet's `plan()` — true of `LaunchSheet`, false of
  `OrchestrateSheet`, which re-checks only at Start and only as an uncoded 409.

**Test cases** (`test/orchestrator-start-ui.test.tsx`, in the existing
`toolbar Orchestrate button` block). Its `stub()` freezes the status in a closure
at stub time, so it first needs the mutable shape `dispatch-button.test.tsx`
already uses — a reassignable variable the `/api/agents/status` branch reads per
call, or an `agents` argument accepting a thunk:
- a board narrowed to `/abs/alpha` with `projectPaths: []`, window never
  focused: the button is `aria-disabled="true"`; the status then changes to
  `READY` and a single click opens the `orchestrate alpha` dialog;
- same setup, status still `projectPaths: []` on the re-ask: no dialog appears,
  the button stays `aria-disabled="true"` and settles back to
  `aria-busy="false"`;
- `aria-busy="true"` while the status request is in flight (resolve it by hand),
  `"false"` after;
- two clicks while the first ask is in flight issue exactly one extra
  `/api/agents/status` request;
- an *unblocked* toolbar button (the existing open-the-sheet cases) issues no
  extra status request at all — the re-ask is for the blocked path only;
- a fresh run for the project still renders no button (existing case) — proof
  the new path did not resurrect a control rule 4 removes.

Plus `test/dispatch-button.test.tsx` unchanged and green, which is what makes the
hook extraction a refactor rather than a rewrite.

In the browser (playwright MCP tools): with the stack up and `BM_AGENTS` on and
the dashboard reachable (if it is off the control is hidden and this check
cannot run — say so and fall back to the jest suite above), open
http://localhost:5177, pick this project in the Board toolbar's Project filter,
then `browser_evaluate` a patch over `window.fetch` that answers any
`/api/agents/status` URL with the real payload but `projectPaths: []` and
dispatches `new Event('focus')` on `window` to force one refetch through it; the
Orchestrate button now reads `aria-disabled="true"` with the "does not list …"
reason. Restore the original `window.fetch` in a second `browser_evaluate` — no
reload, no focus event — then click Orchestrate: the `orchestrate <project>`
dialog must open, and before this fix nothing happens at all.
