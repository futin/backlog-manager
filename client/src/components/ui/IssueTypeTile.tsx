import { typeTone } from '../../lib/jira';
import type { JiraIssueType } from '../../../../shared/types';
import { JiraTypeIcon } from './JiraTypeIcon';

/**
 * IssueTypeTile — a Jira issue's type as an 18 px tinted tile round its glyph (.claude/DESIGN.md §8.9.1, Card mock, parent-lanes spec §3.2).
 *
 * The card's head and a lane header both lead with it, which is why it lives here: the header is the issue's card laid out as a row, and a tile that drew
 * differently in the two would read as two kinds of thing. Bug and story are tinted marks (`typeTone`); every other type is the neutral tile. The type's
 * name is the tile's `title` rather than a word on the row: the key and the title need the width, and the type is the reading a person hovers for.
 *
 * `null` draws nothing — an off-board parent's stub carries a type only when Jira sent one, and a tile with a guessed glyph would state a fact nobody has.
 */
export function IssueTypeTile({ type }: { type: JiraIssueType | null }) {
  if (type === null) return null;
  return (
    <span className="ui-issue-type" data-tone={typeTone(type)} title={type.name}>
      <JiraTypeIcon type={type} />
    </span>
  );
}
