import { actionLabel, deriveAction, dispatchBlock } from '../../../../shared/agent';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';

/**
 * DispatchButton — the click that hands this item to a Claude session.
 *
 * Three states, and the absent one matters most: an item with no next step
 * (archived, or out of scope) gets no control at all rather than a disabled
 * one, because there is nothing here to enable. A status that has not arrived
 * yet is also nothing — otherwise every board load flashes a dead button.
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
  const action = deriveAction(item);
  if (action === null || status === null) return null;

  const blocked = dispatchBlock(item, status);

  return (
    <button
      className="board-card-dispatch"
      // The reason, not a generic tooltip: "no Claude session in that repo
      // inside LOOKBACK_HOURS" is a fixable thing, and nowhere else says it.
      title={blocked ?? `dispatch ${action} to a Claude session`}
      disabled={blocked !== null}
      onClick={(e) => {
        // The whole card is a role="button" that opens the drawer. Without
        // this, one click opens both.
        e.stopPropagation();
        onDispatch();
      }}
      onKeyDown={(e) => {
        // Same reasoning as onClick's stopPropagation, for the keyboard path
        // specifically: the card's own onKeyDown bubbles up from ANY
        // descendant and unconditionally calls preventDefault()+onOpen(). Left
        // unstopped, Enter on this button would have that handler fire first
        // (preventDefault there cancels this button's own Enter-activates-click
        // behaviour, so the drawer opens and the sheet does not), and Space
        // would open the drawer on keydown while the button's own keyup click
        // still fires — both open, the exact double-open onClick's
        // stopPropagation exists to prevent, back again through the keyboard.
        // Stopping it here means the card never sees the keydown at all, so
        // its handler never runs and the button's normal activation proceeds.
        e.stopPropagation();
      }}
    >
      {actionLabel(item, action)}
    </button>
  );
}
