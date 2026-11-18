import { initialsOf } from '../../lib/jira';

/**
 * PersonMark — an assignee as a 22 px initials disc and the name (.claude/DESIGN.md §8.9.1), drawn by the card's foot and by an on-board lane header.
 *
 * Initials only, never Jira's `avatarUrls`: an `<img>` would be a request to Atlassian from every reader's browser, with their cookies. Nobody draws the empty
 * dashed disc and `unassigned`, so a row does not shift by a disc's width between one issue and the next. `compact` drops the name and puts it in the
 * `title` — the lane header is one line and its title needs the width more than a second copy of who holds it.
 */
export function PersonMark({ name, compact = false }: { name: string | null; compact?: boolean }) {
  const word = name ?? 'unassigned';
  return (
    <span className="ui-person" title={compact ? word : undefined}>
      <span className={name === null ? 'ui-person-av none' : 'ui-person-av'} aria-hidden="true">
        {name === null ? '' : initialsOf(name)}
      </span>
      {!compact && <span className="ui-person-name">{word}</span>}
    </span>
  );
}
