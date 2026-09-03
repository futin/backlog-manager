import { useId } from 'react';

import { actionLabel, deriveAction, dispatchGate } from '../../../../shared/agent';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';
import { progressBlock } from '../../lib/item-progress';

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
 *    while the per-item ones disable it. The short version is that a control
 *    disabled on every single card, for a reason that is not about any of
 *    them, is noise; "BM_AGENTS is off" belongs in Settings, which reports it.
 *
 * There are THREE per-item blocks, not one: the dashboard cannot see this
 * item's project (derived here, from `status`), a local skill session already
 * holds this item (derived here too, by `progressBlock` — the only one of the
 * three the item file itself can answer, since `started:` is right there in
 * its frontmatter), and an orchestrator run has already claimed this item
 * (handed in as `runBlock`, because nothing in the item file or the status
 * payload can know it). All three disable with their reason; see the `blocked`
 * line below for why they read in that order.
 *
 * `status` is trusted here exactly as typed: making it honest at runtime is
 * `fetchAgentsStatus`'s job (`lib/agents.ts`), the one place a JSON body
 * actually becomes this type, not every leaf that consumes it — a guard here
 * would not follow `useAgents` to whatever consumes it next.
 *
 * The derivation is `shared/agent.ts`, the same module the server validates
 * with, so the label can never promise an action the API would refuse.
 *
 * Two shapes, one component: `tab` is the card's tear-off right edge and
 * `chip` is the drawer head's inline control. A shape prop rather than two
 * components because everything above this line — the gate, the derivation,
 * the aria-describedby reason, the two event-stopping handlers below — is the
 * hard part and is identical in both places; only the markup inside the button
 * differs. The tone class, though, is the action itself, so both shapes are
 * coloured by the same rules in styles.css.
 */
export function DispatchButton(
  { item, status, onDispatch, variant = 'chip', runBlock = null }: {
    item: BacklogItem;
    status: AgentsStatus | null;
    onDispatch: () => void;
    /** Which shape to render — see the two blocks in styles.css. `tab` is the
     *  card's tear-off edge and needs the card to be a flex row around it;
     *  `chip` stands on its own anywhere, which is why it is the default. */
    variant?: 'tab' | 'chip';
    /**
     * Why an orchestrator run forbids dispatching this item right now, or null.
     *
     * A prop rather than a derivation, unlike every other state this component
     * decides for itself: the answer lives in the run payload alone
     * (`GET /api/orchestrator/runs`), which this leaf has no access to and no
     * business fetching forty times per board. `runClaimBlock`
     * (shared/agent.ts) is what produces the string, once, from the run list
     * the board already holds — see its doc comment for why the item file
     * cannot carry this fact at all.
     *
     * Optional and defaulted so every caller that has no run data to give
     * (the older tests, any future read-only view) behaves exactly as before.
     */
    runBlock?: string | null;
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

  /*
   * Order is the invariant, not a preference: ENVIRONMENT-level → per-item
   * project visibility → in progress → run claim. The first still returns
   * `null` above (no control at all — see the file comment and `dispatchGate`
   * for why), and the other three disable with a reason. The run claim reads
   * LAST of the four because it is the most volatile and the least
   * fundamental: with dispatch off or the project invisible there is nothing
   * to say about a run, and a reason naming a stage would send the reader to
   * watch a queue when what needs fixing is the dashboard.
   *
   * The in-progress block slots in just ahead of it by that same logic: the
   * `started:` stamp is on the file this very board is rendering, while a run
   * claim is a fact about another worktree that the next poll can change. The
   * two coexist only pathologically — a run stamps `started:` on its own
   * worktree's copy, so the registry's copy of a claimed item normally carries
   * no stamp at all — and when they do, the file wins.
   */
  const blocked = (gate.control === 'disabled' ? gate.reason : null)
    ?? progressBlock(item)
    ?? runBlock;

  // The action IS the tone class: `groom` and `execute` are the two
  // AgentAction values, so the palette can never drift from the derivation.
  return (
    <>
      <button
        className={`dispatch-${variant} ${action}`}
        // The reason, not a generic tooltip: "no Claude session in that repo
        // inside LOOKBACK_HOURS" is a fixable thing, and nowhere else says it.
        title={blocked ?? `dispatch ${action} to a Claude session`}
        // aria-disabled, NOT the `disabled` attribute, and the guard in
        // onClick is what actually makes it inert. A `disabled` button is
        // removed from the tab order and from the accessibility tree's
        // interactive surface, so a keyboard user cannot reach it — and all
        // three disabled states there are name something specific and
        // actionable (which project the dashboard cannot see; which session
        // holds this item and since when; which run stage owns it). `title`
        // on an unreachable element is announced unreliably at
        // best; the aria-describedby span below is what makes it dependable,
        // and it is only readable if the control can be focused at all.
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
        {variant === 'tab' ? (
          <span className="dispatch-tab-in">
            <span className="dispatch-word">{actionLabel(item, action)}</span>
            {/* aria-hidden: the accessible name is the action word alone. */}
            <span className="dispatch-mark" aria-hidden="true">▸</span>
          </span>
        ) : (
          <>
            {actionLabel(item, action)}
            <span className="dispatch-mark" aria-hidden="true">▸</span>
          </>
        )}
      </button>
      {/* Visually hidden, deliberately not `aria-label`: the label is the
          action word, and folding a two-line explanation into it would make
          every screen reader announce the whole sentence as the control's
          name. A description is the right slot for "why this cannot be used
          right now", and for the project-visibility reason it is the only
          place in the UI that states the condition at all — Settings reports
          a project *count*, not which projects are missing. (The other two each have
          a second telling: the run strip above the columns for a run claim,
          though the strip names a queue and not this card, and this card's own
          amber bar for a session already holding the item, though the bar
          prints an elapsed rather than a reason not to dispatch.) Rendered as a sibling rather
          than a child so its text stays out of the button's accessible
          name. */}
      {blocked !== null && <span id={reasonId} className="sr-only">{blocked}</span>}
    </>
  );
}
