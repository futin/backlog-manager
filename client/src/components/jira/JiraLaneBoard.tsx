import { useState } from 'react';

import type { LaneFoldState } from '../../hooks/useLaneFolds';
import type { OffBoardRead } from '../../hooks/useOffBoardParent';
import {
  JIRA_COLUMNS,
  LANE_INDENT_CAP,
  columnOf,
  laneCell,
  type JiraLaneView,
  type JiraLanes
} from '../../lib/jira';
import type { SessionCell } from '../../lib/jira-deck';
import type { SessionLink } from '../../lib/jira-sessions';
import type { JiraAction, JiraBoard, JiraIssue, JiraWorktree } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { JiraCard } from './JiraCard';
import { JiraLaneHeader } from './JiraLaneHeader';

const NO_ENDED: readonly SessionLink[] = [];

/**
 * JiraLaneBoard — the Board as one lane per parent (parent-lanes spec §3; .claude/DESIGN.md §8.9.1; mocks `Board.dc.html`, `BoardDeep.dc.html`).
 *
 * **No page-wide column header; each cell is a labelled tile** (user pick, 2026-11-19, mock option D over the live board — the page header was dropped as
 * redundant once every tile names itself). `To Do`, `In Progress`, `Done` in `JIRA_COLUMNS`' order and tones, each tile headed by its category dot, name and
 * the count of this lane's matching cards in it — before the cut, so `+ N more` never makes the count lie. Header issues are in no column and add nothing.
 * A status Jira files under a category (TIMIFY's `In Review` and `In Testing` are `new`) lands in that category's tile; the card's own status word says which.
 *
 * **A lane is its header, then three cells, then its nested lanes** (§3.2, §3.3). The lanes are drawn FLAT, each nested lane a sibling after its parent's
 * cells rather than a child element, so indentation is one `data-depth` read by CSS — `Math.min(depth, LANE_INDENT_CAP)`, the model's depth uncapped — and
 * never an indent that compounds through wrappers; a folded lane draws its header and skips its cells and every lane under it. Depth reaches CSS as an
 * attribute because the CSP allows no inline style.
 *
 * **A cell's cut is `laneCell`'s** — five cards, plus any card past them with a live session, never reordered — with `+ N more` / `show fewer` as the
 * flat chip with `aria-expanded`. Which cells are open is this component's state, keyed `<lane key>:<column>`, lost on reload as the shelves' was; a key
 * whose lane has left the board is simply never read again.
 *
 * **Folds are `useLaneFolds`'** (§3.6) and **the off-board read is `useOffBoardParent`'s**, both owned by the page (`JiraBoardView`) and handed in, because
 * the List draws the same lanes with the same folds (§4.1): a fold made in either view is the other's, and the newest click on any off-board header, in
 * either view, is the only one that may open Detail.
 *
 * Empty: one line — the List's words, `No issues` for an empty loaded list and `No issues match` when the filters hide everything.
 */
export function JiraLaneBoard({
  views,
  lanes,
  folds,
  read,
  total,
  cells,
  ended,
  treesOf,
  board,
  me,
  now,
  site,
  onOpenIssue,
  onOpenPage,
  onRun
}: {
  views: readonly JiraLaneView[];
  /** The UNFILTERED lanes of the loaded list — the kept parents (`parentOf`). */
  lanes: JiraLanes;
  folds: LaneFoldState;
  read: OffBoardRead;
  /** How many issues the loaded list holds — `No issues` at 0, `No issues match` otherwise. */
  total: number;
  cells: ReadonlyMap<string, SessionCell>;
  ended: ReadonlyMap<string, readonly SessionLink[]>;
  treesOf: (key: string) => readonly JiraWorktree[];
  board: JiraBoard;
  me: { accountId: string } | null;
  now: number;
  site: string;
  onOpenIssue: (issue: JiraIssue) => void;
  /** A card's Cmd-, Ctrl- or middle-click: the ticket page (`JiraCard`). */
  onOpenPage?: (issue: JiraIssue) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const [openCells, setOpenCells] = useState<ReadonlySet<string>>(() => new Set());
  const isLive = (key: string): boolean => (cells.get(key)?.lead ?? null) !== null;
  const toggleCell = (id: string): void =>
    setOpenCells((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const drawLane = (view: JiraLaneView): JSX.Element[] => {
    const { lane } = view;
    const open = folds.isOpen(lane);
    const header = lane.header;
    const out: JSX.Element[] = [
      <section key={lane.key} className="jira-lane" data-depth={Math.min(lane.depth, LANE_INDENT_CAP)} data-lane={lane.key} data-open={open}>
        <JiraLaneHeader
          view={view}
          open={open}
          locked={folds.locked}
          onToggle={() => folds.toggle(lane)}
          board={board}
          me={me}
          now={now}
          parent={header === null ? null : (lanes.parentOf.get(header.key) ?? null)}
          session={header === null ? null : (cells.get(header.key) ?? null)}
          ended={header === null ? NO_ENDED : (ended.get(header.key) ?? NO_ENDED)}
          trees={header === null ? [] : treesOf(header.key)}
          site={site}
          read={read}
          onOpenIssue={onOpenIssue}
          onRun={onRun}
        />
        {open && (
          <div className="jira-lane-cells">
            {JIRA_COLUMNS.map((col) => {
              const id = `${lane.key}:${col.slug}`;
              const cellOpen = openCells.has(id);
              const all = view.cards.filter((c) => columnOf(c) === col.slug);
              const { shown, hidden } = laneCell(all, isLive, cellOpen);
              return (
                <div key={col.slug} className="jira-lane-cell" data-col={col.slug} data-testid={`cell-${lane.key}-${col.slug}`}>
                  <div className="jira-cell-head" data-tone={col.slug}>
                    <span className="jira-cell-dot" aria-hidden="true" />
                    <span className="jira-cell-name">{col.label}</span>
                    <span className="jira-cell-count">{all.length}</span>
                  </div>
                  {shown.map((issue) => (
                    <JiraCard
                      key={issue.key}
                      issue={issue}
                      board={board}
                      me={me}
                      now={now}
                      parent={lanes.parentOf.get(issue.key) ?? null}
                      session={cells.get(issue.key) ?? null}
                      ended={ended.get(issue.key) ?? NO_ENDED}
                      trees={treesOf(issue.key)}
                      onOpen={onOpenIssue}
                      onOpenPage={onOpenPage}
                      onRun={onRun}
                    />
                  ))}
                  {(hidden > 0 || (cellOpen && laneCell(all, isLive, false).hidden > 0)) && (
                    <div className="jira-lane-more">
                      <Chip variant="flat" size={28} aria-expanded={cellOpen} onClick={() => toggleCell(id)}>
                        {cellOpen ? 'show fewer' : `+ ${hidden} more`}
                      </Chip>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    ];
    if (open) for (const child of view.lanes) out.push(...drawLane(child));
    return out;
  };

  return (
    <div className="jira-lanes">
      {views.length === 0 ? <div className="board-empty">{total === 0 ? 'No issues' : 'No issues match'}</div> : views.flatMap(drawLane)}
    </div>
  );
}
