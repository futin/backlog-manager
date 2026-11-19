import { parentLineText } from '../../lib/jira-parent';
import type { SessionLink } from '../../lib/jira-sessions';
import { sessionTone } from '../../lib/tones';

/* The sub-task band's parent-live line. Moved out of `JiraDetail.tsx` unchanged (Jira detail tabs plan, Task 4) so the Detail body and its tabs can
   draw it; DESIGN.md §8.9.2. */

/**
 * The sub-task band's parent-live line (spec §4.3; DESIGN.md §8.9.2): `ChildSessionLine`'s skin — the lead session's tone dot, the words, `+N more` — pointed
 * UP at the parent, whose newest live session leads. A click opens the parent's Detail, as the head's parent link does.
 */
export function ParentSessionLine({ parentKey, lead, more, onOpen }: { parentKey: string; lead: SessionLink; more: number; onOpen: () => void }) {
  return (
    <button type="button" className="jira-detail-agent-child jira-detail-parent-line" onClick={onOpen}>
      <i className="ui-stripe-dot" data-tone={sessionTone(lead.state)} aria-hidden="true" />
      <span className="jira-detail-agent-child-text">{parentLineText(parentKey, lead)}</span>
      {more > 0 && <span className="jira-detail-agent-child-more">{`+${more} more`}</span>}
    </button>
  );
}
