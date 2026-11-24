import type { MouseEvent, ReactNode } from 'react';

import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import type { LaneFoldState } from '../../hooks/useLaneFolds';
import type { OffBoardRead } from '../../hooks/useOffBoardParent';
import { STATE_LABEL } from '../../../../shared/jira-sessions';
import type { JiraAction, JiraIssue } from '../../../../shared/types';
import { deliveryLook, ticketDelivery, type DeliveryIndex } from '../../lib/delivery';
import { elapsedSince } from '../../lib/item-age';
import {
  LANE_INDENT_CAP,
  browseUrl,
  initialsOf,
  laneCountText,
  priorityTone,
  statusTone,
  typeTone,
  type JiraLaneView,
  type JiraLanes
} from '../../lib/jira';
import type { SessionCell } from '../../lib/jira-deck';
import { rowOpens } from '../../lib/jira-list';
import { browserPlatform, fullPageTitle, wantsPage } from '../../lib/open-intent';
import { sessionTone } from '../../lib/tones';
import { pollAge } from '../../lib/tracker';
import { DeliveryTrack } from '../ui/DeliveryTrack';
import { FoldMark } from '../ui/FoldMark';
import { Glyph } from '../ui/Glyphs';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { LaneChevron } from './JiraLaneHeader';
import { JiraMentionMarkFor } from './JiraMentionMarkFor';
import { JiraRunMenu } from './JiraRunMenu';
import { NotMergedChip } from './MrChip';

/**
 * DESIGN.md §8.9.1 — Jira › Board › List: the picked board's lanes as rows of one table (parent-lanes spec §4; mocks `List.dc.html`, `ListDeep.dc.html`).
 *
 * **The Board's lanes, as rows.** `views` is the page's `laneViews` answer — the same lanes, in the same order (§3.5), that `JiraLaneBoard` draws — so the two
 * views cannot group or order one board two ways. Each lane is a **header row**, then one row per card in the lane (`sortForBoard` order across every
 * status: the Status column says the status, so a lane is not split in three), then its nested lanes, walked depth first. There is no cut (§4.1): a row is
 * one line, and a list that hides rows cannot be scanned by eye. Header rows sit on a tinted ground so the eye finds the groups before it reads a cell.
 *
 * **The `@ N` mention mark** (DESIGN.md §8.9.7; Jira mentions <-> board link, Task 5): in a card row's and an on-board header row's Summary cell, after the
 * title and before the `FoldMark` and the count. It is a `JiraMentionMarkFor` that draws only while the ticket has open mentions and a `MentionOpenContext`
 * opener exists above; the `No parent` and off-board lane rows carry none (their key has no mentions entry of its own to open from here). Its press is
 * stopped inside `MentionMark`, so it never also opens Detail.
 *
 * **Folds are the Board's** (§3.6): `folds` is the page's one `useLaneFolds`, handed to both views, so a lane folded here is folded on the Board and the
 * other way round. A folded lane draws its header row and skips its cards and every lane under it. Every header row, of all three kinds, carries the
 * chevron (`LaneChevron`, the Board header's own button and words) and the lane's count in its Summary cell — settled lanes start folded, so a header row
 * without a chevron would be a lane nobody could open from the List. The count is `.jira-issues-under`, the class `N under it` wore, because a design guard
 * pins its `flex: none`; like the Board's tally it is drawn only when the lane holds a matching issue, so a header kept only by its own match does not say
 * `0 issues` beside itself.
 *
 * **Three kinds of header row** (§4.2), every one with the table's full cell count — an unknown value is an empty `td`, never a `colSpan`, because the table
 * is `table-layout: fixed` and sizes its trailing columns by position:
 * - **On the board** — the header issue's own row, every cell filled as a card row's and `Run ▾` drawn, plus `↳ <KEY>` (`FoldMark`, the parent's summary
 *   as its title) in Summary when the issue has a kept parent (`parentOf`, never the raw field). It opens Detail on a row click, as a card row does.
 * - **Off the board** — Key, Summary, Type and Status from the child's stub and nothing else: an empty cell says "not known", where a dash would read as
 *   "none". The key links to Jira by the Board header's rule (`browseUrl`, plain text while the site is unknown); the summary is a button that reads the
 *   parent once (`read`, the page's one `useOffBoardParent`, so the newest click across both views wins) and opens Detail on the answer, disabled while that
 *   read is out, with the failure sentence under it. Drawing requests nothing. The `not on this board` tag is the visible reason the row has no `Run ▾`.
 *   The row itself opens nothing: there is no issue behind it until the read lands.
 * - **`No parent`** — the label beside the chevron and the count; every other cell empty, and no row click.
 *
 * **Columns** run Type, Status, Key, Summary, Updated, [Delivery], Session, Assignee, Sprint, Priority, Run — the user's order (2026-11-20).
 *
 * **Indent** is padding inside the Summary cell, never a column: `data-depth` is `Math.min(depth, LANE_INDENT_CAP)` for a header row and one more for its
 * card rows, read by CSS — an attribute, because the CSP allows no inline style. It lived in the Key cell until the keys of a parent and its children read
 * staggered; in Summary a card's title lines up under its header's title, and every key starts at one edge.
 *
 * **Every row is its own issue** (§4.3). The Session cell is that key's `SessionCell` — a stripe dot, the state's word and an age, and `+N` when the key has
 * several live sessions; a session on a child marks the child's row and never its parent's, so no `FoldMark` is needed to say which ticket it runs on.
 * **Updated** is the row's own `updated`; the roll-up survives only as the lane's sort stamp. Type, Status, Priority and Assignee wear the board card's own
 * marks, so a row and its card cannot disagree on what a colour means. The last cell is the card's split Run, shown on row hover or focus only (it stays in
 * the DOM and tabbable — the stylesheet fades it, never removes it), on every row with an issue behind it.
 *
 * **Delivery** (GitLab connection spec §7.3, mock `List.dc.html`), after Updated and drawn only while GitLab is shown at all (`useDeliveryIndex`): the row's
 * lead MR as the compact `DeliveryTrack` (the same dots Detail draws, in the same marks), its `!iid` link out and `deliveryLook`'s List word in its tone, then
 * the amber `not merged` chip the card draws, and `+N MR` for the others. A known ticket with no MR reads `no MR` and an unknown one `—`, both `--ink3`, so a
 * list GitLab has not finished reading never claims a ticket has nothing; a ticket whose project maps no GitLab project gets an empty cell (spec §7, "Which
 * tickets draw delivery at all"), and so does an off-board or `No parent` header row, which has no read issue to ask about. The link goes out in a new tab
 * with no referrer, and `rowOpens` already leaves a click on it to the link. The column's presence moves no other column's width: everything after Delivery
 * is sized from the END of the row (`nth-last-child`), and the scroll box carries `data-delivery` for the wider minimum.
 *
 * The scroll box and header are `.jira-issues-*`, modelled on the session table's `.jira-list-*`: the box scrolls sideways, the page never does.
 */
export function JiraIssueList({
  views,
  folds,
  sessions,
  parentOf,
  site,
  read,
  now,
  filtered,
  onOpenIssue,
  onOpenPage,
  onRun
}: {
  views: readonly JiraLaneView[];
  folds: LaneFoldState;
  /** `sessionCells`' answer, keyed by each session's OWN issue key. */
  sessions: ReadonlyMap<string, SessionCell>;
  /** Every on-board key's KEPT parent — an on-board header row's `↳ <KEY>`. */
  parentOf: JiraLanes['parentOf'];
  /** The Jira site, `''` while the status has not said it — an off-board key is plain text then. */
  site: string;
  read: OffBoardRead;
  now: number;
  /** A filter or a search is applied — only the empty line's wording reads it. */
  filtered: boolean;
  onOpenIssue: (issue: JiraIssue) => void;
  /** A row's Cmd-, Ctrl- or middle-click: the ticket page on that issue (`IssueRow`). */
  onOpenPage?: (issue: JiraIssue) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const index = useDeliveryIndex();
  if (views.length === 0) return <div className="board-empty">{filtered ? 'No issues match' : 'No issues'}</div>;

  const row = (issue: JiraIssue, depth: number, head: HeadSlots | null = null): JSX.Element => (
    <IssueRow
      key={issue.key}
      issue={issue}
      depth={depth}
      head={head}
      cell={sessions.get(issue.key) ?? null}
      index={index}
      now={now}
      onOpenIssue={onOpenIssue}
      onOpenPage={onOpenPage}
      onRun={onRun}
    />
  );

  // One flat walk, as the Board's: a lane's header row, then (open) its cards and its nested lanes. `tbody` takes rows only, so nothing can be a wrapper.
  const drawLane = (view: JiraLaneView): JSX.Element[] => {
    const { lane } = view;
    const open = folds.isOpen(lane);
    const depth = Math.min(lane.depth, LANE_INDENT_CAP);
    const chevron = (
      <LaneChevron label={lane.kind === 'none' ? 'No parent' : lane.key} open={open} locked={folds.locked} onToggle={() => folds.toggle(lane)} />
    );
    const count = view.count > 0 ? <span className="jira-issues-under">{laneCountText(view.count)}</span> : null;
    const out: JSX.Element[] = [];
    if (lane.kind === 'board' && lane.header !== null) {
      const parent = parentOf.get(lane.header.key) ?? null;
      out.push(row(lane.header, depth, { chevron, chip: parent === null ? null : <FoldMark issueKey={parent.key} title={parent.summary} />, count }));
    } else {
      out.push(
        <StubRow key={`lane:${lane.key}`} view={view} depth={depth} chevron={chevron} count={count} hasDelivery={index !== null} site={site} read={read} />
      );
    }
    if (!open) return out;
    const cardDepth = Math.min(lane.depth + 1, LANE_INDENT_CAP);
    for (const card of view.cards) out.push(row(card, cardDepth));
    for (const child of view.lanes) out.push(...drawLane(child));
    return out;
  };

  return (
    <div className="jira-issues-frame">
      <div className="jira-issues-scroll" role="region" aria-label="Issues" data-delivery={index === null ? undefined : ''}>
        <table className="jira-issues-table">
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Key</th>
              <th scope="col">Summary</th>
              <th scope="col">Updated</th>
              {index !== null && (
                <th scope="col" className="jira-issues-dlv-h">
                  Delivery
                </th>
              )}
              <th scope="col">Session</th>
              <th scope="col">Assignee</th>
              <th scope="col">Sprint</th>
              <th scope="col">Priority</th>
              <th scope="col" aria-label="Run" />
            </tr>
          </thead>
          <tbody>{views.flatMap(drawLane)}</tbody>
        </table>
      </div>
    </div>
  );
}

/** What an on-board header row adds to its Summary cell, around the title every row draws: the chevron before it, the parent chip and the count after. */
interface HeadSlots {
  chevron: ReactNode;
  chip: ReactNode;
  count: ReactNode;
}

/**
 * An off-board or `No parent` header row (§4.2): no issue behind it, so no row click, no Session, Priority, Assignee, Sprint, Updated or Run — empty cells,
 * the full count of them. Only the off-board kind has a Key, a Summary button, a Type and a Status, all from the stub; a field the stub lacks is an empty cell.
 */
function StubRow({
  view,
  depth,
  chevron,
  count,
  hasDelivery,
  site,
  read
}: {
  view: JiraLaneView;
  depth: number;
  chevron: ReactNode;
  count: ReactNode;
  hasDelivery: boolean;
  site: string;
  read: OffBoardRead;
}) {
  const { lane } = view;
  // Updated, Delivery, Session, Assignee, Sprint, Priority and Run: everything after Summary is unknown on a stub row.
  const tail = (
    <>
      <td />
      {hasDelivery && <td />}
      <td />
      <td />
      <td />
      <td />
      <td className="jira-issues-act" />
    </>
  );
  if (lane.kind === 'none') {
    return (
      <tr className="jira-issues-row jira-issues-lane" data-lane={lane.key} data-kind="none">
        <td />
        <td />
        <td className="jira-issues-key" />
        <td className="jira-issues-summary" data-depth={depth}>
          <span className="jira-issues-flex">
            {chevron}
            <span className="jira-issues-label">No parent</span>
            {count}
          </span>
        </td>
        {tail}
      </tr>
    );
  }
  const stub = lane.stub;
  const url = browseUrl(site, lane.key);
  const summary = stub === null || stub.summary === '' ? lane.key : stub.summary;
  const failed = read.failed !== null && read.failed.key === lane.key ? read.failed.message : null;
  const line = (
    <span className="jira-issues-flex">
      {chevron}
      <button type="button" className="jira-issues-title" disabled={read.reading === lane.key} onClick={() => read.ask(lane.key)}>
        {summary}
      </button>
      <span className="jira-lane-tag">not on this board</span>
      {count}
    </span>
  );
  return (
    <tr className="jira-issues-row jira-issues-lane" data-key={lane.key} data-lane={lane.key} data-kind="off">
      <td>
        {stub?.type != null && (
          <span className="jira-issues-flex">
            <span className="jira-card-type" data-tone={typeTone(stub.type)} aria-hidden="true">
              <JiraTypeIcon type={stub.type} />
            </span>
            <span className="jira-issues-cut">{stub.type.name}</span>
          </span>
        )}
      </td>
      <td>
        {stub?.status != null && (
          <span className="jira-issues-flex">
            <span className="jira-status-dot" data-tone={statusTone(stub.status.category)} aria-hidden="true" />
            <span className="jira-issues-cut">{stub.status.name}</span>
          </span>
        )}
      </td>
      <td className="jira-issues-key">
        {url === null ? (
          lane.key
        ) : (
          <a href={url} target="_blank" rel="noreferrer" aria-label={`open ${lane.key} in Jira`}>
            {lane.key}
          </a>
        )}
      </td>
      <td className="jira-issues-summary" data-depth={depth} title={summary}>
        {failed === null ? (
          line
        ) : (
          <span className="jira-issues-stack">
            {line}
            <span className="jira-modal-error" role="alert">
              {failed}
            </span>
          </span>
        )}
      </td>
      {tail}
    </tr>
  );
}

/**
 * The Delivery cell (spec §7.3). Every word, tone and dot is `lib/delivery.ts`'s; the cell only arranges them. The word ellipsises before anything else, so
 * the link, the `not merged` chip and `+N MR` — the facts a person acts on — keep their width in a narrow column; the full word is still the cell's `title`.
 */
function DeliveryCell({ issue, index, now }: { issue: JiraIssue; index: DeliveryIndex; now: number }) {
  const d = ticketDelivery(issue, index);
  if (d.kind === 'hidden') return <td />;
  if (d.kind === 'unknown') return <td className="jira-issues-muted">—</td>;
  if (d.kind === 'none') return <td className="jira-issues-muted">no MR</td>;
  const look = deliveryLook(d.lead, now);
  return (
    <td className="jira-issues-dlv" title={d.via === null ? look.word : `${look.word} · via ${d.via}`}>
      <span className="jira-issues-flex">
        <DeliveryTrack track={look.track} compact />
        <a className="jira-issues-dlv-link" href={d.lead.webUrl} target="_blank" rel="noopener noreferrer">
          {`!${d.lead.iid}`}
        </a>
        <span className="jira-issues-dlv-word" data-tone={look.tone}>
          {look.word}
        </span>
        {d.notMerged && <NotMergedChip />}
        {d.also.length > 0 && <span className="jira-issues-dlv-more">{`+${d.also.length} MR`}</span>}
      </span>
    </td>
  );
}

/**
 * One issue's row — a card row, or an on-board lane's header row when `head` is given (`HeadSlots`: the chevron, the parent chip and the count, set around the
 * title in the Summary cell). Both open Detail on a row click; the header row also wears the tint and carries the lane's markers.
 *
 * Given `onOpenPage`, a Cmd-, Ctrl- or middle-click opens the full ticket page instead (Jira detail tabs spec §2.3, `wantsPage`), and the row names the
 * modifier in its title. The row's middle-click passes through `rowOpens` like its click, so a middle-click on the `!iid` link or inside `Run ▾` stays that
 * control's; the title button, which `rowOpens` excludes as a button, takes both clicks itself.
 */
function IssueRow({
  issue,
  depth,
  head,
  cell,
  index,
  now,
  onOpenIssue,
  onOpenPage,
  onRun
}: {
  issue: JiraIssue;
  depth: number;
  head: HeadSlots | null;
  cell: SessionCell | null;
  /** `null` while GitLab is not shown at all: then the row has no Delivery cell, as the head has no Delivery column. */
  index: DeliveryIndex | null;
  now: number;
  onOpenIssue: (issue: JiraIssue) => void;
  onOpenPage?: (issue: JiraIssue) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const open = (e: MouseEvent): void => (onOpenPage !== undefined && wantsPage(e) ? onOpenPage(issue) : onOpenIssue(issue));
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>): void => {
    if (rowOpens(e.currentTarget, e.target, window.getSelection()?.toString() ?? '')) open(e);
  };
  // A middle-click selects nothing, so the selection argument is empty: only the inner-control exclusion applies.
  const onRowAux = (e: MouseEvent<HTMLTableRowElement>): void => {
    if (onOpenPage !== undefined && e.button === 1 && rowOpens(e.currentTarget, e.target, '')) onOpenPage(issue);
  };
  const updated = elapsedSince(issue.updated, now);
  const age = cell === null ? null : pollAge(cell.since, now);
  const prio = priorityTone(issue.priority);
  const isHead = head !== null;
  const title = (
    <button
      type="button"
      className="jira-issues-title"
      onClick={open}
      onAuxClick={(e) => {
        if (onOpenPage !== undefined && e.button === 1) onOpenPage(issue);
      }}
    >
      {issue.summary}
    </button>
  );

  return (
    <tr
      className={isHead ? 'jira-issues-row jira-issues-lane' : 'jira-issues-row'}
      data-key={issue.key}
      data-lane={isHead ? issue.key : undefined}
      data-kind={isHead ? 'board' : undefined}
      data-state={cell?.state}
      title={onOpenPage === undefined ? undefined : fullPageTitle(browserPlatform())}
      onClick={onRowClick}
      onAuxClick={onRowAux}
    >
      <td>
        <span className="jira-issues-flex">
          <span className="jira-card-type" data-tone={typeTone(issue.type)} aria-hidden="true">
            <JiraTypeIcon type={issue.type} />
          </span>
          <span className="jira-issues-cut">{issue.type.name}</span>
        </span>
      </td>
      <td>
        <span className="jira-issues-flex">
          <span className="jira-status-dot" data-tone={statusTone(issue.status.category)} aria-hidden="true" />
          <span className="jira-issues-cut">{issue.status.name}</span>
        </span>
      </td>
      <td className="jira-issues-key">
        <a href={issue.url} target="_blank" rel="noreferrer" aria-label={`open ${issue.key} in Jira`}>
          {issue.key}
        </a>
      </td>
      <td className="jira-issues-summary" data-depth={depth} title={issue.summary}>
        <span className="jira-issues-flex">
          {head?.chevron}
          {title}
          <JiraMentionMarkFor issueKey={issue.key} />
          {head?.chip}
          {head?.count}
        </span>
      </td>
      <td className="jira-issues-updated">{updated ?? ''}</td>
      {index !== null && <DeliveryCell issue={issue} index={index} now={now} />}
      <td className="jira-issues-session">
        {cell === null ? (
          '—'
        ) : (
          <span className="jira-issues-flex">
            <span className="ui-stripe-dot" data-tone={sessionTone(cell.state)} aria-hidden="true" />
            <span className="jira-issues-sess">
              <span className="jira-issues-cut">{STATE_LABEL[cell.state]}</span>
              {age !== null && <span className="jira-issues-age"> · {age}</span>}
            </span>
            {cell.more > 0 && (
              <span className="jira-issues-more" title={`${cell.more} more live session${cell.more === 1 ? '' : 's'} on this ticket`}>{`+${cell.more}`}</span>
            )}
          </span>
        )}
      </td>
      <td className={issue.assignee === null ? 'jira-issues-muted' : undefined}>
        <span className="jira-issues-flex">
          <span className={issue.assignee === null ? 'jira-card-av none' : 'jira-card-av'} aria-hidden="true">
            {issue.assignee === null ? '' : initialsOf(issue.assignee.name)}
          </span>
          <span className="jira-issues-cut">{issue.assignee?.name ?? 'unassigned'}</span>
        </span>
      </td>
      <td className={issue.sprint === null ? 'jira-issues-muted' : undefined}>{issue.sprint ?? '—'}</td>
      <td>
        {/* The card's pill, with the grey `low` look and no glyph for an issue Jira left unprioritised: the cell is never blank, so the column reads as a column. */}
        <span className="jira-card-prio jira-issues-prio" data-tone={prio ?? 'low'} title={`priority ${issue.priority ?? 'none'}`}>
          {prio !== null && prio !== 'other' && <Glyph name={prio === 'high' ? 'up' : prio === 'med' ? 'equals' : 'down'} size={10} />}
          {issue.priority ?? 'Not prioritised'}
        </span>
      </td>
      <td className="jira-issues-act">
        <JiraRunMenu issue={issue} onPick={onRun} />
      </td>
    </tr>
  );
}
