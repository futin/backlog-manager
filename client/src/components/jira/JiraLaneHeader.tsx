import { browseUrl, cardAgeStamp, crumbOf, crumbText, laneCountText, type JiraLaneView } from '../../lib/jira';
import type { SessionCell } from '../../lib/jira-deck';
import type { SessionLink } from '../../lib/jira-sessions';
import type { OffBoardRead } from '../../hooks/useOffBoardParent';
import type { JiraAction, JiraBoard, JiraIssue, JiraParentRef, JiraWorktree } from '../../../../shared/types';
import { Chevron } from '../ui/Chevron';
import { FoldMark } from '../ui/FoldMark';
import { IssueStatus } from '../ui/IssueStatus';
import { IssueTypeTile } from '../ui/IssueTypeTile';
import { PersonMark } from '../ui/PersonMark';
import { PriorityPill } from '../ui/PriorityPill';
import { SpreadBar } from '../ui/SpreadBar';
import { JiraMentionMarkFor } from './JiraMentionMarkFor';
import { EndedLine, IssueLinkOut, IssueMarks, SessionControl, SessionStateLine } from './JiraCard';

/**
 * LaneChevron — the button that folds a lane (parent-lanes spec §3.2, §3.6; .claude/DESIGN.md §8.9.1). `label` is the lane's key, or `No parent`; the
 * `aria-label` says what a press does (`Collapse PAY-7` / `Expand PAY-7`) and `aria-expanded` what is true now. `locked` — a search is typed, so every lane
 * draws open — disables it rather than hiding it, so the header does not shift by a chevron's width while someone types. Exported because the List's header
 * rows (Task 5) draw the same button with the same words.
 */
export function LaneChevron({ label, open, locked, onToggle }: { label: string; open: boolean; locked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="jira-lane-chev"
      aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
      aria-expanded={open}
      disabled={locked}
      onClick={onToggle}
    >
      <Chevron dir={open ? 'down' : 'right'} />
    </button>
  );
}

/**
 * JiraLaneHeader — the row above a lane's three cells (parent-lanes spec §3.2; .claude/DESIGN.md §8.9.1; mocks `Board.dc.html`, `BoardDeep.dc.html`). Three
 * kinds, one per `JiraLane['kind']`:
 *
 * **On the board.** The header issue's card laid out as a row — it was a full card before lanes and loses nothing by becoming a header, which is why the mock's
 * reduced header is not the rule (`00-mock-audit.md`). Type tile, key, title (a button that opens Detail, as the card's face does), `↳ <parent>` when the issue
 * has a kept parent (`FoldMark`, the parent's summary as its title — a lane above, or a parent off the board), the crumb by the card's rule (root or mine;
 * never the parent kind, which the chip already says), status, priority, assignee disc (name in its title), age, `↗`, then the right-hand cluster: spread
 * bar and count, the card's own marks (`IssueMarks` — repo, worktree, MR, `Run ▾`, never hidden), and under them the live state line and open control when
 * a session runs on THIS key, and the ended line. The parts are the card's own primitives and sub-components, so the two cannot drift.
 *
 * **Off the board.** Only what the child's stub knows: type tile and status pill when Jira sent them (each omitted otherwise — never guessed), key, summary,
 * the tag `not on this board` — the visible reason this header has no `Run ▾`, assignee or priority — spread and count, and `↗` composed from the site
 * (`browseUrl`, none while the site is unknown). The summary is a button that reads the parent once on a click (`useOffBoardParent`, owned by the page so the
 * newest click across every header wins) and opens Detail on the answer; it is disabled while that read is out, reads the key when Jira sent no summary, and
 * the failure sentence sits under it on this header alone. Drawing requests nothing.
 *
 * **No parent.** The label, the spread bar and the count.
 *
 * **The `@ N` mention mark** (DESIGN.md §8.9.7; Jira mentions <-> board link, Task 5): on the on-board header only, beside its key (an off-board or
 * `No parent` header has no entry of its own to open). It is a `JiraMentionMarkFor` that draws only while the ticket has open mentions and a
 * `MentionOpenContext` opener exists above; its press is stopped inside `MentionMark`, so it never also opens Detail.
 *
 * The count and the bar are the view's — the matching issues of the lane's subtree (§3.2, §6.2) — so a folded lane still says what it holds. A header drawn
 * only because its own issue matches a filter has a count of 0 and draws neither: an empty bar and `0 issues` beside a header that plainly matched would
 * contradict it.
 */
export function JiraLaneHeader({
  view,
  open,
  locked,
  onToggle,
  board,
  me,
  now,
  parent,
  session,
  ended,
  trees,
  site,
  read,
  onOpenIssue,
  onRun
}: {
  view: JiraLaneView;
  open: boolean;
  locked: boolean;
  onToggle: () => void;
  board: JiraBoard;
  me: { accountId: string } | null;
  now: number;
  /** The header issue's KEPT parent (`JiraLanes.parentOf`); `null` for the other two kinds. */
  parent: JiraParentRef | null;
  session: SessionCell | null;
  ended: readonly SessionLink[];
  trees: readonly JiraWorktree[];
  site: string;
  read: OffBoardRead;
  onOpenIssue: (issue: JiraIssue) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const { lane } = view;
  const label = lane.kind === 'none' ? 'No parent' : lane.key;
  const tally =
    view.count > 0 ? (
      <span className="jira-lane-tally">
        <span className="jira-lane-bar">
          <SpreadBar done={view.progress.done} doing={view.progress.doing} todo={view.progress.todo} />
        </span>
        <span className="jira-lane-count">{laneCountText(view.count)}</span>
      </span>
    ) : null;
  const chevron = <LaneChevron label={label} open={open} locked={locked} onToggle={onToggle} />;

  if (lane.kind === 'none') {
    return (
      <div className="jira-lane-head" data-kind="none">
        {chevron}
        <span className="jira-lane-label">No parent</span>
        {tally}
      </div>
    );
  }

  if (lane.kind === 'off') {
    const stub = lane.stub;
    const url = browseUrl(site, lane.key);
    const failed = read.failed !== null && read.failed.key === lane.key ? read.failed.message : null;
    return (
      <div className="jira-lane-head" data-kind="off">
        {chevron}
        <div className="jira-lane-main">
          <div className="jira-lane-line">
            <IssueTypeTile type={stub?.type ?? null} />
            <span className="jira-card-key">{lane.key}</span>
            <button type="button" className="jira-lane-title" disabled={read.reading === lane.key} onClick={() => read.ask(lane.key)}>
              {stub === null || stub.summary === '' ? lane.key : stub.summary}
            </button>
            <IssueStatus status={stub?.status ?? null} />
            <span className="jira-lane-tag">not on this board</span>
            {url !== null && <IssueLinkOut issueKey={lane.key} url={url} />}
          </div>
          {failed !== null && (
            <p className="jira-modal-error" role="alert">
              {failed}
            </p>
          )}
        </div>
        {tally}
      </div>
    );
  }

  const issue = lane.header as JiraIssue;
  const kind = crumbOf(issue, board, me, parent);
  const crumb = kind?.kind === 'parent' ? null : crumbText(kind);
  const lead = session?.lead ?? null;
  return (
    <div className="jira-lane-head" data-kind="board" data-key={issue.key}>
      {chevron}
      <div className="jira-lane-main">
        {session !== null && lead !== null && <SessionStateLine cell={session} now={now} />}
        <div className="jira-lane-line">
          <IssueTypeTile type={issue.type} />
          <span className="jira-card-key">{issue.key}</span>
          <JiraMentionMarkFor issueKey={issue.key} />
          <button type="button" className="jira-lane-title" onClick={() => onOpenIssue(issue)}>
            {issue.summary}
          </button>
          {parent !== null && <FoldMark issueKey={parent.key} title={parent.summary} />}
          {crumb !== null && <span className="jira-card-crumb">{crumb}</span>}
          <IssueStatus status={issue.status} />
          <PriorityPill priority={issue.priority} />
          <PersonMark name={issue.assignee?.name ?? null} compact />
          <span className="board-card-meta">{cardAgeStamp(issue, now)}</span>
          <IssueLinkOut issueKey={issue.key} url={issue.url} />
        </div>
        {lead !== null && session !== null && <SessionControl cell={session} />}
        <EndedLine ended={ended} now={now} />
      </div>
      <div className="jira-lane-side">
        {tally}
        <span className="jira-lane-marks">
          <IssueMarks issue={issue} trees={trees} now={now} onRun={onRun} />
        </span>
      </div>
    </div>
  );
}
