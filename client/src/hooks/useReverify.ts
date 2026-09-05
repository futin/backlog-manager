import { useCallback, useRef, useState } from 'react';

import type { AgentsStatus } from '../../../shared/types';

/**
 * The one-question click: ask the dashboard status once, then act on the
 * answer that came back rather than on the render that provoked the click.
 *
 * `useAgents` refetches on mount and window focus alone, and that cadence is
 * deliberate (see its own comment — what changes the answer happens outside
 * this tab). It is also, for one particular kind of block, unrecoverable: a
 * board whose window never loses focus keeps whatever `projectPaths` it last
 * fetched, so a control disabled with "the dashboard does not list <path>"
 * stays disabled forever while the thing it names is already fixed. bug-13
 * gave the card's dispatch button a click that re-asks; bug-16 gave the
 * toolbar's Orchestrate button the same click. This is the half they share.
 *
 * What is shared is the MECHANICS, not the policy — the caller still runs its
 * own gate over the fresh status inside `act`. The two callers derive
 * genuinely different answers (`dispatchGate(item, fresh)` versus
 * `projectDispatchGate(fresh, path)`) and have different sibling blocks, so
 * folding the gate in here would mean a config object per caller; the
 * drift-prone part is "ask once, mark busy, act on the fresh answer", which is
 * what lives here. Extracted rather than copied a second time because, unlike
 * the small idioms this repo does repeat on purpose (the three copies of the
 * Escape effect), this one is stateful and correctness-bearing: a copy that
 * acts on the stale render, or that drops the in-flight guard, looks right and
 * is wrong.
 *
 * No failure branch, deliberately. The board's `reverify` is
 * `useAgents().reload`, which resolves to a flatly-off status rather than
 * rejecting (its own comment says why: an awaiting caller is inside a click
 * handler, where a rejection would surface as an uncaught error), and an off
 * status fails every gate — so a failed ask opens nothing, which is exactly
 * the behaviour a failure branch would have to hand-write.
 */
export function useReverify(
  /** Re-ask the status and resolve to the fresh answer. Optional: a caller
   *  with nothing to ask (older tests, any future read-only view) leaves the
   *  click inert exactly as it was before this existed. */
  reverify?: () => Promise<AgentsStatus>
): {
  /** True between the click and the answer. Callers put it on `aria-busy`, so
   *  a click that looks swallowed is legible as "asked, same answer". */
  verifying: boolean;
  /** Ask once, then run `act` with the fresh status. A no-op when there is no
   *  `reverify` to call, or when an ask is already in flight. */
  ask: (act: (fresh: AgentsStatus) => void) => void;
} {
  const [verifying, setVerifying] = useState(false);
  /* The in-flight guard is a ref, not the state above, even though the two
     always agree by the time a render lands. `verifying` exists to be
     rendered; this exists to be read synchronously inside the handler, and
     two clicks dispatched before React has re-rendered would both see a
     stale `false`. One redundant-looking line is cheaper than an impatient
     reader queueing a status fetch per click on a control that stays
     disabled for the whole first one. */
  const inFlight = useRef(false);

  const ask = useCallback((act: (fresh: AgentsStatus) => void): void => {
    if (reverify === undefined || inFlight.current) return;
    inFlight.current = true;
    setVerifying(true);
    void reverify().then((fresh) => {
      inFlight.current = false;
      setVerifying(false);
      act(fresh);
    });
  }, [reverify]);

  return { verifying, ask };
}
