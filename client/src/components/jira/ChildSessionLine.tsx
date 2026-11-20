import type { DeckEntry } from '../../lib/jira-deck';
import { sessionTone } from '../../lib/tones';
import { STATE_LABEL } from '../../../../shared/jira-sessions';

/* The agent band's child-live line. Moved out of `JiraDetail.tsx` unchanged (Jira detail tabs plan, Task 4) so the Detail body and its tabs can
   draw it; DESIGN.md §8.9.2. */

/**
 * The empty agent band's third line when a child has a live session (`underway[0]`, the deck's lead among the tree's rows): `<state> on <key>`, `+N more`
 * when others are live too. It opens that child the way its Children row does — the same `onOpenIssue` and the same snapshot — so a reader who came here from a
 * `Working` epic reaches the session in one press.
 */
export function ChildSessionLine({ first, more, onOpen }: { first: DeckEntry; more: number; onOpen: () => void }) {
  return (
    <button type="button" className="jira-detail-agent-child" onClick={onOpen}>
      <i className="ui-stripe-dot" data-tone={sessionTone(first.state)} aria-hidden="true" />
      <span className="jira-detail-agent-child-text">{`${STATE_LABEL[first.state]} on ${first.issue.key} →`}</span>
      {more > 0 && <span className="jira-detail-agent-child-more">{`+${more} more`}</span>}
    </button>
  );
}
