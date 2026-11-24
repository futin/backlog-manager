import { mentionMarkText } from '../../lib/jira-mentions';
import { Chip } from './Chip';

/**
 * MentionMark — the amber `@ N` chip that says "this ticket has mentions waiting for your answer" and opens the Mentions page on it (.claude/DESIGN.md §7's
 * chip, §8.9.7's Mentions page).
 *
 * It is a `Chip variant="warn"` at 28 px rather than a new shape, so its radius and label weight cannot drift from the board's other controls. `count <= 0`
 * renders nothing: a ticket with no open mention carries no mark, and the callers need not guard it. The words come from `mentionMarkText`, and the title is
 * also the `aria-label`, because the visible `@ 2` alone says nothing to a screen reader.
 *
 * The wrapper stops `click`, `auxclick` and Enter/Space `keydown` the way `JiraCard`'s `Contained` does: the mark sits inside a card, a lane header and a list row,
 * each of which opens Detail on a press, and a press on the mark must open the Mentions page and nothing else.
 */
export function MentionMark({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  const { label, title } = mentionMarkText(count);
  return (
    <span
      className="mention-mark"
      onClick={(e) => e.stopPropagation()}
      onAuxClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >
      <Chip variant="warn" size={28} title={title} aria-label={title} onClick={onOpen}>
        {label}
      </Chip>
    </span>
  );
}
