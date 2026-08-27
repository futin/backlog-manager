import { actionLabel, deriveAction, dispatchBlock } from '../../../../shared/agent';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';

/**
 * `unwrap` in `lib/agents.ts` hands back whatever JSON the fetch resolved to,
 * cast to `AgentsStatus` with a bare `as` — a compile-time-only promise that
 * erases the moment the bytes actually arrive. Every real answer carries
 * `enabled` and `projectPaths`; a caller that resolved this hook with
 * something else (an old value, unrelated JSON) handed this component a
 * status it has never actually seen, and `dispatchBlock` would either read
 * `undefined` as false-y (announcing a wrong reason) or throw on
 * `.projectPaths.includes`. Treating that the same as "not answered yet"
 * costs nothing real: a genuine answer always has both.
 */
function isAgentsStatus(status: AgentsStatus | null): status is AgentsStatus {
  return status !== null && typeof status.enabled === 'boolean' && Array.isArray(status.projectPaths);
}

/**
 * DispatchButton — the click that hands this item to a Claude session.
 *
 * Three states, and the absent one matters most: an item with no next step
 * (archived, or out of scope) gets no control at all rather than a disabled
 * one, because there is nothing here to enable. A status that has not arrived
 * yet is also nothing — otherwise every board load flashes a dead button.
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
  if (action === null || !isAgentsStatus(status)) return null;

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
    >
      {actionLabel(item, action)}
    </button>
  );
}
