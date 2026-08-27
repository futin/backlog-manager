import { useId } from 'react';

import { actionLabel, deriveAction, dispatchGate } from '../../../../shared/agent';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';

/**
 * DispatchButton — the click that hands this item to a Claude session.
 *
 * Three states, and the two absent ones matter most:
 *  - An item with no next step (archived, or out of scope) gets no control at
 *    all rather than a disabled one, because there is nothing here to enable.
 *  - A status that has not arrived yet is also nothing — otherwise every board
 *    load flashes a dead button.
 *  - And an ENVIRONMENT-level block (dispatch off, dashboard unreachable, no
 *    CLAUDE_BIN, remote answers off) renders nothing either: see
 *    `dispatchGate` in shared/agent.ts for why those four hide the control
 *    while the per-item one disables it. The short version is that a control
 *    disabled on every single card, for a reason that is not about any of
 *    them, is noise; "BM_AGENTS is off" belongs in Settings, which reports it.
 *
 * `status` is trusted here exactly as typed: making it honest at runtime is
 * `fetchAgentsStatus`'s job (`lib/agents.ts`), the one place a JSON body
 * actually becomes this type, not every leaf that consumes it — a guard here
 * would not follow `useAgents` to whatever consumes it next.
 *
 * The derivation is `shared/agent.ts`, the same module the server validates
 * with, so the label can never promise an action the API would refuse.
 */
export function DispatchButton(
  { item, status, onDispatch }: {
    item: BacklogItem;
    status: AgentsStatus | null;
    onDispatch: () => void;
  }
) {
  // Stable per mounted button, and unique across the forty of them a board can
  // hold — `item.id` is not, since two projects can both own `task-1`, and the
  // drawer renders a second button for an item the card already rendered one
  // for. A duplicated id would point aria-describedby at the wrong card's span.
  const reasonId = useId();
  const action = deriveAction(item);
  if (action === null || status === null) return null;

  const gate = dispatchGate(item, status);
  if (gate.control === 'hidden') return null;

  const blocked = gate.control === 'disabled' ? gate.reason : null;

  return (
    <>
      <button
        className="board-card-dispatch"
        // The reason, not a generic tooltip: "no Claude session in that repo
        // inside LOOKBACK_HOURS" is a fixable thing, and nowhere else says it.
        title={blocked ?? `dispatch ${action} to a Claude session`}
        // aria-disabled, NOT the `disabled` attribute, and the guard in
        // onClick is what actually makes it inert. A `disabled` button is
        // removed from the tab order and from the accessibility tree's
        // interactive surface, so a keyboard user cannot reach it — and this
        // is now the ONLY disabled state there is, the one case where the
        // reason names a specific project and a specific fix. `title` on an
        // unreachable element is announced unreliably at best; the
        // aria-describedby span below is what makes it dependable, and it is
        // only readable if the control can be focused at all.
        aria-disabled={blocked !== null}
        aria-describedby={blocked === null ? undefined : reasonId}
        onClick={(e) => {
          // The whole card is a role="button" that opens the drawer. Without
          // this, one click opens both.
          e.stopPropagation();
          // The other half of aria-disabled: the browser will not stop a
          // click on a control that is only *labelled* disabled, so this does.
          if (blocked !== null) return;
          onDispatch();
        }}
        onKeyDown={(e) => {
          // Bounded to the two keys the card's own handler actually acts on,
          // and no further. Same reasoning as onClick's stopPropagation, for
          // the keyboard path specifically: the card's onKeyDown bubbles up
          // from ANY descendant and unconditionally calls
          // preventDefault()+onOpen(). Left unstopped, Enter on this button
          // would have that handler fire first (preventDefault there cancels
          // this button's own Enter-activates-click behaviour, so the drawer
          // opens and the sheet does not), and Space would open the drawer on
          // keydown while the button's own keyup click still fires — both
          // open, the exact double-open onClick's stopPropagation exists to
          // prevent, back again through the keyboard.
          //
          // Stopping EVERY key instead was a real bug, not a harmless
          // over-reach: React 18 delegates keydown at the root, and a
          // synthetic stopPropagation also stops the native event, so nothing
          // at `window` ever saw it. With focus still on this button after the
          // sheet opened — which is where focus is, since nothing in the sheet
          // takes it — Escape never reached the sheet's own window listener
          // and the sheet would not close. Same for the drawer's Escape while
          // its head button held focus.
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
      >
        {actionLabel(item, action)}
      </button>
      {/* Visually hidden, deliberately not `aria-label`: the label is the
          action word, and folding a two-line explanation into it would make
          every screen reader announce the whole sentence as the control's
          name. A description is the right slot for "why this cannot be used
          right now", and it is the only place in the UI that states this
          condition at all — Settings reports a project *count*, not which
          projects are missing. Rendered as a sibling rather than a child so
          its text stays out of the button's accessible name. */}
      {blocked !== null && <span id={reasonId} className="sr-only">{blocked}</span>}
    </>
  );
}
