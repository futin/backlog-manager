import type { DispatchGate } from '../../../shared/agent';

/**
 * `gateView` — the disabled half of the board's two re-asking gated controls, the card/modal `DispatchButton` and the band's Orchestrate chip, as one
 * pure function (#272, from the 2026-10-15 composability audit's gap 7). `components/ui/GatedChip.tsx` is the one component that renders it.
 *
 * CLAUDE.md's "an environment-level block hides the dispatch control; the per-item ones disable it" used to have two hand-kept implementations of its
 * disabled half, and they had already drifted: DispatchButton re-asked only when the visibility block was the only block, while the Orchestrate chip
 * re-asked whenever the visibility block spoke — including alongside a sync-off block (#17), where the fresh answer could never open the sheet. This is
 * the one home of that rule now, and it is DispatchButton's.
 *
 * Hidden is NOT modelled here. Each caller still decides hide before rendering anything, because the hide rules genuinely differ: both hide for the
 * environment ladder in `shared/agent.ts`, and the Orchestrate chip also hides for an unfiltered board and for a project with a fresh run. Nor is the
 * policy — which gate each caller runs, and what its other blocks are — which stays with the callers; only the mechanics they shared live here.
 *
 * Imports nothing from React and nothing from `components/`, so `test/gate-view.test.ts` pins it under jest's default `node` environment with no render.
 */

/** A gate's block reason when it disables, or null — the `control === 'disabled' ? reason : null` both callers wrote. A `hidden` gate is null here
 *  too: hidden is the caller's early return, decided before this is read, and never a reason a rendered control shows. A null gate (no status yet,
 *  or the Orchestrate chip's unfiltered board) has no block to give. */
export function disabledReason(gate: DispatchGate | null): string | null {
  return gate !== null && gate.control === 'disabled' ? gate.reason : null;
}

export function gateView(
  /** The project-visibility block from the caller's gate (`disabledReason` of `dispatchGate` or `projectDispatchGate`), or null. */
  gateBlock: string | null,
  /** Every other block the caller has, already folded into one value in the caller's own precedence — DispatchButton's in-progress then run claim
   *  then sync-off, the Orchestrate chip's sync-off. One value because the answer it feeds is the same for all of them: refuse, ask nothing. */
  otherBlock: string | null,
  /** Whether the caller handed over a way to re-ask the dashboard status at all. */
  canAsk: boolean
): { blocked: string | null; reverifiable: boolean } {
  return {
    /* The gate's reason outranks every other block — the existing precedence in both callers. With the project invisible to the dashboard there is
       nothing useful to say about a session holding the item, a run claiming it or a sync interval: what needs fixing is the dashboard. */
    blocked: gateBlock ?? otherBlock,
    /*
     * bug-13 / bug-16: whether a click on the (blocked) control may re-ask the status instead of being swallowed. All three conditions are load-bearing.
     *
     * `gateBlock !== null` — the project-visibility block is the one that can be stale, because it is derived from a payload this tab fetched at some
     * earlier moment, and `useAgents` has no trigger to re-fetch it while the window keeps focus. A stale *enable* self-corrects (the sheet's own
     * server check refuses), but a stale *disable* cannot: the sheet that would correct it sits behind the control the stale answer made inert.
     *
     * `otherBlock === null` — and it must be the ONLY block. Clearing the visibility half of "invisible project AND claimed by a run" (or AND sync off)
     * would still leave the click refused, so there is nothing worth asking. None of the other blocks can be moved by a status refetch either: a run
     * claim and a fresh run come from `useOrchestratorRuns`, which polls every 5s while any run is fresh; `started:` is on the item file this board is
     * rendering; and sync-off is read off the project list. A doubly-blocked control therefore behaves exactly as the non-reaskable block alone does,
     * which is what it looks like to the reader anyway once the more fundamental reason is the one on screen.
     *
     * `canAsk` — a caller that handed over no way to ask.
     */
    reverifiable: gateBlock !== null && otherBlock === null && canAsk
  };
}
