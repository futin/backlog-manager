import { priorityTone } from '../../lib/jira';
import { Glyph } from './Glyphs';

/**
 * PriorityPill — a Jira priority as an 18 px pill (.claude/DESIGN.md §8.9.1, Card mock, spec §4.2), drawn by the card's head and by an on-board lane header.
 *
 * Jira's five names fold to three tones through `priorityTone`, each with its arrow glyph; a custom name like `P1` is the quiet pill with no glyph, because
 * an arrow would claim a weight the name does not say. A null or empty priority draws nothing — the row keeps its other parts and no `none` pill stands in.
 */
export function PriorityPill({ priority }: { priority: string | null }) {
  const tone = priorityTone(priority === '' ? null : priority);
  if (priority === null || tone === null) return null;
  return (
    <span className="ui-prio" data-tone={tone} title={`priority ${priority}`}>
      {tone !== 'other' && <Glyph name={tone === 'high' ? 'up' : tone === 'med' ? 'equals' : 'down'} size={10} />}
      {priority}
    </span>
  );
}
