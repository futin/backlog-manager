import type { MouseEvent } from 'react';

import type { JiraSessionState } from '../../../../shared/jira-sessions';
import type { JiraIssue } from '../../../../shared/types';
import { elapsedSince } from '../../lib/item-age';
import { rolledUpdated, type JiraChildrenIndex, type JiraFold } from '../../lib/jira';
import { issueCellWord } from '../../lib/jira-deck';
import { listDotTone, rowOpens } from '../../lib/jira-list';
import { Dot } from '../ui/Dot';
import { Pill } from '../ui/Pill';

/**
 * DESIGN.md §8.9.1 — Jira › Board › List: the picked board's issues as a table (Jira › Sessions plan, Task 4; spec "Jira › Board", D2–D4; mock `Main.dc.html`).
 *
 * **One row per board card, never per issue.** `tops` is the filtered fold's top list in `sortTops` order, so the table lists exactly what the Board's shelves
 * would, only uncut: a folded sub-task is a `N under it` suffix on its top's summary and never a row of its own (the mock's indented children were a rejected
 * option). The modal's Children tree is still how you reach what folds — a row click hands it `fold.childrenOf`, as a card click does.
 *
 * **The Session cell is the deck's reading, not a second one.** `sessions` is `topSessionState(boardAgents(...))`: a session live on a folded child marks its
 * top, and when a card carries two the cell names the one the deck leads with. The cell is a dot and a word and is not a link — opening a session is the
 * Sessions page's and Detail's job. **Updated** is `rolledUpdated`, the stamp the rows were sorted on.
 *
 * The scroll box and header are `.jira-issues-*`, modelled on the session table's `.jira-list-*`: the box scrolls sideways, the page never does.
 */
export function JiraIssueList({
  tops,
  fold,
  sessions,
  now,
  filtered,
  onOpenIssue
}: {
  tops: readonly JiraIssue[];
  fold: JiraFold;
  sessions: ReadonlyMap<string, JiraSessionState>;
  now: number;
  /** A filter or a search is applied — only the empty line's wording reads it. */
  filtered: boolean;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
}) {
  if (tops.length === 0) return <div className="board-empty">{filtered ? 'No issues match' : 'No issues'}</div>;
  return (
    <div className="jira-issues-scroll" role="region" aria-label="Issues">
      <table className="jira-issues-table">
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Key</th>
            <th scope="col">Summary</th>
            <th scope="col">Type</th>
            <th scope="col">Status</th>
            <th scope="col">Assignee</th>
            <th scope="col">Sprint</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {tops.map((top) => (
            <IssueRow key={top.key} top={top} fold={fold} state={sessions.get(top.key) ?? null} now={now} onOpenIssue={onOpenIssue} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IssueRow({
  top,
  fold,
  state,
  now,
  onOpenIssue
}: {
  top: JiraIssue;
  fold: JiraFold;
  state: JiraSessionState | null;
  now: number;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
}) {
  const open = (): void => onOpenIssue(top, fold.childrenOf);
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>): void => {
    if (rowOpens(e.currentTarget, e.target, window.getSelection()?.toString() ?? '')) open();
  };
  const under = fold.under.get(top.key)?.length ?? 0;
  const tone = state === null ? null : listDotTone(state);
  const rolled = rolledUpdated(top, fold.under);
  const updated = rolled === null ? null : elapsedSince(rolled, now);

  return (
    <tr className="jira-issues-row" data-key={top.key} data-state={state ?? undefined} onClick={onRowClick}>
      <td className="jira-issues-session">
        {state !== null && (
          <span className="jira-issues-flex">
            {tone !== null && <Dot tone={tone} breathe={tone === 'live'} />}
            <span>{issueCellWord(state)}</span>
          </span>
        )}
      </td>
      <td className="jira-issues-key">
        <a href={top.url} target="_blank" rel="noreferrer" aria-label={`open ${top.key} in Jira`}>
          {top.key}
        </a>
      </td>
      <td className="jira-issues-summary">
        <button type="button" className="jira-issues-title" onClick={open}>
          {top.summary}
        </button>
        {under > 0 && <span className="jira-issues-under"> {under} under it</span>}
      </td>
      <td>{top.type.name}</td>
      <td>
        <Pill tone="neutral">{top.status.name}</Pill>
      </td>
      <td className={top.assignee === null ? 'jira-issues-muted' : undefined}>{top.assignee?.name ?? 'unassigned'}</td>
      <td className={top.sprint === null ? 'jira-issues-muted' : undefined}>{top.sprint ?? '—'}</td>
      <td className="jira-issues-updated">{updated ?? ''}</td>
    </tr>
  );
}
