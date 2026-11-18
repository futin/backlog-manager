import { statusTone } from '../../lib/jira';
import type { JiraIssueStatus } from '../../../../shared/types';

/**
 * IssueStatus — a Jira issue's RAW status name beside a 6 px dot in its column's tone (.claude/DESIGN.md §8.9.1), drawn by the card's foot and by both lane
 * header kinds that have a status (on-board, and off-board when the stub carries one).
 *
 * The column says the status CATEGORY; this says the name, because `In Review` and `In Progress` are one column and two very different facts to the person
 * reading it, and the dot ties the two readings together. `null` — an off-board stub Jira sent no status for — draws nothing rather than a guessed state.
 */
export function IssueStatus({ status }: { status: JiraIssueStatus | null }) {
  if (status === null) return null;
  return (
    <span className="ui-issue-status">
      <span className="ui-issue-status-dot" data-tone={statusTone(status.category)} aria-hidden="true" />
      {status.name}
    </span>
  );
}
