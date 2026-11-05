import type { MouseEvent } from 'react';

import { STATE_LABEL, type JiraSessionState } from '../../../../shared/jira-sessions';
import type { JiraAction, JiraIssue } from '../../../../shared/types';
import { elapsedSince } from '../../lib/item-age';
import { initialsOf, priorityTone, rolledUpdated, statusTone, typeTone, type JiraChildrenIndex, type JiraFold } from '../../lib/jira';
import { rowOpens } from '../../lib/jira-list';
import { sessionTone } from '../../lib/tones';
import { pollAge } from '../../lib/tracker';
import { Glyph } from '../ui/Glyphs';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { JiraRunMenu } from './JiraRunMenu';

/**
 * DESIGN.md §8.9.1 — Jira › Board › List: the picked board's issues as a table (Jira › Sessions plan, Task 4; spec "Jira › Board", D2–D4; mock `Main.dc.html`).
 *
 * **One row per board card, never per issue.** `tops` is the filtered fold's top list in `sortTops` order, so the table lists exactly what the Board's shelves
 * would, only uncut: a folded sub-task is a `N under it` suffix on its top's summary and never a row of its own (the mock's indented children were a rejected
 * option). The modal's Children tree is still how you reach what folds — a row click hands it `fold.childrenOf`, as a card click does.
 *
 * **The Session cell is the deck's reading, not a second one.** `sessions` is `topSessionCell(...)`: a session live on a folded child marks its
 * top, and when a card carries two the cell names the one the deck leads with; a top with none live reads `Ended · <age>` for its newest ended session.
 * The cell is a stripe dot, the state's word and an age, and is not a link — opening a session is the Sessions page's and Detail's job. Type, Status,
 * Priority and Assignee wear the board card's own marks (plan 1's classes), so a row and its card cannot disagree on what a colour means. The last cell is
 * the card's split Run, shown on row hover or focus only (it stays in the DOM and tabbable — the stylesheet fades it, never removes it). **Updated** is `rolledUpdated`, the stamp the rows were sorted on.
 *
 * The scroll box and header are `.jira-issues-*`, modelled on the session table's `.jira-list-*`: the box scrolls sideways, the page never does.
 */
export function JiraIssueList({
  tops,
  fold,
  sessions,
  now,
  filtered,
  onOpenIssue,
  onRun
}: {
  tops: readonly JiraIssue[];
  fold: JiraFold;
  sessions: ReadonlyMap<string, { state: JiraSessionState; since: string }>;
  now: number;
  /** A filter or a search is applied — only the empty line's wording reads it. */
  filtered: boolean;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  if (tops.length === 0) return <div className="board-empty">{filtered ? 'No issues match' : 'No issues'}</div>;
  return (
    <div className="jira-issues-frame">
      <div className="jira-issues-scroll" role="region" aria-label="Issues">
        <table className="jira-issues-table">
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Key</th>
              <th scope="col">Summary</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Priority</th>
              <th scope="col">Assignee</th>
              <th scope="col">Sprint</th>
              <th scope="col">Updated</th>
              <th scope="col" aria-label="Run" />
            </tr>
          </thead>
          <tbody>
            {tops.map((top) => (
              <IssueRow key={top.key} top={top} fold={fold} cell={sessions.get(top.key) ?? null} now={now} onOpenIssue={onOpenIssue} onRun={onRun} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IssueRow({
  top,
  fold,
  cell,
  now,
  onOpenIssue,
  onRun
}: {
  top: JiraIssue;
  fold: JiraFold;
  cell: { state: JiraSessionState; since: string } | null;
  now: number;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const open = (): void => onOpenIssue(top, fold.childrenOf);
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>): void => {
    if (rowOpens(e.currentTarget, e.target, window.getSelection()?.toString() ?? '')) open();
  };
  const under = fold.under.get(top.key)?.length ?? 0;
  const rolled = rolledUpdated(top, fold.under);
  const updated = rolled === null ? null : elapsedSince(rolled, now);
  const age = cell === null ? null : pollAge(cell.since, now);
  const prio = priorityTone(top.priority);

  return (
    <tr className="jira-issues-row" data-key={top.key} data-state={cell?.state} onClick={onRowClick}>
      <td className="jira-issues-session">
        {cell === null ? (
          '—'
        ) : (
          <span className="jira-issues-flex">
            <span className="ui-stripe-dot" data-tone={sessionTone(cell.state)} aria-hidden="true" />
            <span className="jira-issues-cut">{age === null ? STATE_LABEL[cell.state] : `${STATE_LABEL[cell.state]} · ${age}`}</span>
          </span>
        )}
      </td>
      <td className="jira-issues-key">
        <a href={top.url} target="_blank" rel="noreferrer" aria-label={`open ${top.key} in Jira`}>
          {top.key}
        </a>
      </td>
      <td className="jira-issues-summary" title={top.summary}>
        <button type="button" className="jira-issues-title" onClick={open}>
          {top.summary}
        </button>
        {under > 0 && <span className="jira-issues-under"> {under} under it</span>}
      </td>
      <td>
        <span className="jira-issues-flex">
          <span className="jira-card-type" data-tone={typeTone(top.type)} aria-hidden="true">
            <JiraTypeIcon type={top.type} />
          </span>
          <span className="jira-issues-cut">{top.type.name}</span>
        </span>
      </td>
      <td>
        <span className="jira-issues-flex">
          <span className="jira-status-dot" data-tone={statusTone(top.status.category)} aria-hidden="true" />
          <span className="jira-issues-cut">{top.status.name}</span>
        </span>
      </td>
      <td>
        {/* The card's pill, with the grey `low` look and no glyph for an issue Jira left unprioritised: the cell is never blank, so the column reads as a column. */}
        <span className="jira-card-prio jira-issues-prio" data-tone={prio ?? 'low'} title={`priority ${top.priority ?? 'none'}`}>
          {prio !== null && prio !== 'other' && <Glyph name={prio === 'high' ? 'up' : prio === 'med' ? 'equals' : 'down'} size={10} />}
          {top.priority ?? 'Not prioritised'}
        </span>
      </td>
      <td className={top.assignee === null ? 'jira-issues-muted' : undefined}>
        <span className="jira-issues-flex">
          <span className={top.assignee === null ? 'jira-card-av none' : 'jira-card-av'} aria-hidden="true">
            {top.assignee === null ? '' : initialsOf(top.assignee.name)}
          </span>
          <span className="jira-issues-cut">{top.assignee?.name ?? 'unassigned'}</span>
        </span>
      </td>
      <td className={top.sprint === null ? 'jira-issues-muted' : undefined}>{top.sprint ?? '—'}</td>
      <td className="jira-issues-updated">{updated ?? ''}</td>
      <td className="jira-issues-act">
        <JiraRunMenu issue={top} onPick={(a) => onRun(top, a)} />
      </td>
    </tr>
  );
}
