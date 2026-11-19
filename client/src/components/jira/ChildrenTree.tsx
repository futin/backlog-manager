import { initialsOf, progressLine, type JiraChildrenIndex, type modalTree } from '../../lib/jira';
import type { DeckEntry } from '../../lib/jira-deck';
import { sessionTone } from '../../lib/tones';
import { STATE_LABEL, type JiraSessionState } from '../../../../shared/jira-sessions';
import type { JiraIssue } from '../../../../shared/types';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Pill } from '../ui/Pill';
import { SpreadBar } from '../ui/SpreadBar';

/* The Children tree and its rows' session pill. Moved out of `JiraDetail.tsx` unchanged (Jira detail tabs plan, Task 4) so the Detail body and its tabs can
   draw it; DESIGN.md §8.9.2. */

/**
 * The Children section — head row, spread bar, tree — over `modalTree` (see the header). Drawn only when the detail has direct children. A row a session is
 * live on wears that session's state as a neutral `Pill` led by the state's dot (`underway`, one per row), before the ticket's own status pill: an epic's
 * List row can read `Working` for a sub-task's session, and this is where the reader finds which one. `head={false}` drops the head row, for the Children
 * & comments tab, whose fold summary already carries the `Children` label, the count and `N in all` (Jira detail tabs spec §6).
 */
export function ChildrenTree({
  direct,
  tree,
  underway,
  childrenOf,
  onOpenIssue,
  head = true
}: {
  direct: number;
  tree: ReturnType<typeof modalTree>;
  underway: readonly DeckEntry[];
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  /** Draw the `Children` head row (the old Detail column); the tab's fold passes `false` because its summary is that head. */
  head?: boolean;
}) {
  const { rows, progress } = tree;
  const live = new Map(underway.map((e) => [e.issue.key, e.state] as const));
  return (
    <>
      {head && (
        <div className="jira-tree-head">
          <h3>Children</h3>
          <Pill tone="neutral">{direct}</Pill>
          {rows.length > direct && <span className="jira-tree-all">{`${rows.length} in all`}</span>}
        </div>
      )}
      {/* Wrapped, because the spacing is this surface's and the primitive's own selectors stay in the ui block (design-guard 7). */}
      <div className="jira-tree-spread">
        <SpreadBar done={progress.done} doing={progress.doing} todo={progress.todo} caption={progressLine(progress)} />
      </div>
      <ul className="jira-tree">
        {rows.map(({ issue: row, depth }) => (
          // The indent is the one inline style: a depth is data, and a class per depth would cap how deep a tree may go.
          <li key={row.key} data-depth={depth} style={{ paddingLeft: depth * 22 }}>
            <button type="button" className="jira-tree-row" onClick={() => onOpenIssue(row, childrenOf)}>
              <JiraTypeIcon type={row.type} />
              {/* The spaces between the spans are what the button's accessible name reads as word breaks: `PAY-162 Ledger rounding fix`. */}
              <span className="jira-tree-key">{row.key}</span> <span className="jira-tree-summary">{row.summary}</span>{' '}
              {/* The card's own disc: initials or the empty one, never an image, so every row's status pill lines up. */}
              <span className={row.assignee === null ? 'jira-card-av none' : 'jira-card-av'} aria-hidden="true">
                {row.assignee === null ? '' : initialsOf(row.assignee.name)}
              </span>
              {live.has(row.key) && <RowSession state={live.get(row.key) as JiraSessionState} />}
              <Pill tone="neutral">{row.status.name}</Pill>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A Children row's session: the state's dot and word in a neutral pill, wrapped so the tree places it (`.jira-tree-session`) without restyling `Pill`. */
function RowSession({ state }: { state: JiraSessionState }) {
  return (
    <span className="jira-tree-session">
      <Pill tone="neutral" title={`a session is ${STATE_LABEL[state].toLowerCase()} on this ticket`}>
        <i className="ui-stripe-dot" data-tone={sessionTone(state)} aria-hidden="true" />
        {STATE_LABEL[state]}
      </Pill>
    </span>
  );
}
