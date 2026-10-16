import { useId } from 'react';
import type { ReactNode } from 'react';

import type { AgentsStatus } from '../../../../shared/types';
import { useReverify } from '../../hooks/useReverify';
import { gateView } from '../../lib/gate-view';
import { Chip } from './Chip';
import type { ChipSize, ChipVariant } from './Chip';

/**
 * GatedChip — a `Chip` (DESIGN.md §7) with the dispatch gate's disabled behaviour built in: the band's ink Orchestrate chip and the card's 28 px dispatch
 * chip, both defined in DESIGN.md §8.3, are its two callers (#272).
 *
 * What it owns is the MECHANICS those two used to hand-keep each: which block is shown (`gateView`, `lib/gate-view.ts`, whose comments carry the
 * precedence and the three re-ask conditions), `aria-disabled` plus the `aria-describedby` reason, `aria-busy` while a re-ask is in flight, and bug-13 /
 * bug-16's click that re-asks the dashboard status for a stale project-visibility block and acts only on the fresh answer. What stays with each caller is
 * its POLICY: which gate it runs (handed in as `gateBlock` and again, over the fresh status, as `recheck`), what its other blocks are, when it hides (it
 * renders nothing rather than this), its label and what activating it does.
 *
 * Keeps `Chip`'s narrow pass-through philosophy and narrows it further: no `className`, no `onClick`, no `aria-*` — the attributes this component sets are
 * the whole point of it, and a caller that could hand over its own `aria-disabled` could quietly put the two copies back.
 */
export function GatedChip({
  gateBlock,
  otherBlock,
  idleTitle,
  reverify,
  recheck,
  onActivate,
  variant,
  size,
  children
}: {
  /** The project-visibility block from the caller's gate, or null — the one block a click may re-ask. */
  gateBlock: string | null;
  /** Every other block the caller has, folded in its own precedence, or null. Never re-asked: no status refetch can move one. */
  otherBlock: string | null;
  /** The `title` when nothing blocks. When something does, the title is the blocked reason instead. */
  idleTitle: string;
  /** Re-ask the dashboard status and resolve to the fresh answer (the board's `useAgents().reload`). Optional: without it a blocked click is inert. */
  reverify?: () => Promise<AgentsStatus>;
  /** The caller's own gate, run over the FRESH status a re-ask resolved to; `onActivate` runs only when this says yes. */
  recheck: (fresh: AgentsStatus) => boolean;
  /** The unblocked click, and the re-ask that came back clear. */
  onActivate: () => void;
  variant?: ChipVariant;
  size?: ChipSize;
  /** The label — or a function of whether the chip is blocked, for a label whose look changes with it (DispatchButton's dimmed action word), so the
   *  caller never has to call `gateView` a second time to learn what this already knows. */
  children: ReactNode | ((blocked: boolean) => ReactNode);
}) {
  // Stable per mounted chip and unique across the forty a board can hold — an item id is not, since two projects can both own `task-1` and the modal
  // renders a second chip for an item its card already rendered one for. A duplicated id would point aria-describedby at the wrong card's span.
  const reasonId = useId();
  /* `verifying` is only ever true between a re-asking click and the status answering it; `ask` carries the in-flight guard that keeps an impatient reader
     from queueing one status fetch per click on a control that stays disabled while the first is still out. Both are `useReverify`'s — see its comment
     for why the gate check stays out of it, here with `recheck`. */
  const { verifying, ask } = useReverify(reverify);
  const { blocked, reverifiable } = gateView(gateBlock, otherBlock, reverify !== undefined);

  return (
    <>
      <Chip
        variant={variant}
        size={size}
        // The reason, not a generic tooltip: "the dashboard does not list <path>" is a fixable thing, and nowhere else says it. Deliberately NOT swapped
        // out while `verifying` — the reason has to still be readable when the re-ask comes back with the same answer.
        title={blocked ?? idleTitle}
        // aria-disabled, NOT `Chip`'s own `disabled` prop, and the guard in onClick is what actually makes it inert. A `disabled` button is removed from
        // the tab order and from the accessibility tree's interactive surface, so a keyboard user cannot reach it — and every disabled state here names
        // something specific and actionable (which project the dashboard cannot see; which session holds the item and since when; which run stage owns
        // it; which repo's sync is off). `title` on an unreachable element is announced unreliably at best; the aria-describedby span below is what makes
        // it dependable, and it is only readable if the control can be focused at all.
        aria-disabled={blocked !== null}
        aria-describedby={blocked === null ? undefined : reasonId}
        // The one signal that a swallowed-looking click was actually answered (bug-13). An attribute rather than a spinner or a second label: the re-ask
        // is one request long, and styles.css keys a `progress` cursor and a lighter label off this same attribute on `.ui-chip`, so the feedback is not
        // screen-reader-only either.
        aria-busy={verifying}
        onClick={() => {
          if (blocked === null) {
            onActivate();
            return;
          }
          // The other half of aria-disabled: the browser does not stop a click on a control that is only *labelled* disabled, so this does — except for
          // the one block a click may re-ask (see `gateView` for the three conditions).
          if (!reverifiable) return;
          // `ask` no-ops while an ask is already in flight, and `reverify` never rejects (useAgents.ts explains why it resolves to a flatly-off status
          // instead), so there is no failure branch: an off status fails every gate and opens nothing. `recheck` and `onActivate` are this render's —
          // the closure captures them — which is what keeps the Orchestrate chip opening the sheet for the project the reader clicked for even if the
          // filter moved while the answer was out. Do not read them from a ref.
          ask((fresh) => {
            if (recheck(fresh)) onActivate();
          });
        }}
      >
        {typeof children === 'function' ? children(blocked !== null) : children}
      </Chip>
      {/* Visually hidden, deliberately not `aria-label`: the label is the control's word, and folding a sentence into it would make every screen reader
          announce the whole explanation as the control's name. A description is the right slot for "why this cannot be used right now", and for the
          project-visibility reason it is the only place in the UI that states the condition at all — Settings reports a project *count*, not which
          projects are missing. Rendered as a sibling rather than a child so its text stays out of the button's accessible name. */}
      {blocked !== null && (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
    </>
  );
}
