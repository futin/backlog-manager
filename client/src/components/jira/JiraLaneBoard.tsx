import { useMemo, useState } from 'react';

import type { LaneFoldState } from '../../hooks/useLaneFolds';
import type { OffBoardRead } from '../../hooks/useOffBoardParent';
import {
  JIRA_COLUMNS,
  LANE_INDENT_CAP,
  columnOf,
  laneCell,
  laneColumnCounts,
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
 * **One column header for every lane** (§3.1). `To Do`, `In Progress`, `Done` in `JIRA_COLUMNS`' order and tones, each with `laneColumnCounts`' number — the
 * cards that pass the filters across every drawn lane, folded or cut or not, so a page whose settled lanes start folded still says how much is Done. Header
 * issues are in no column and add nothing. The row is sticky, so it stays above the lanes while they scroll under it.
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
 * Empty: the column header stays with its zeros and one line under it — the List's words, `No issues` for an empty loaded list and `No issues match`
 * when the filters hide everything.
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
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const counts = useMemo(() => laneColumnCounts(views), [views]);
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
      <div className="jira-lanes-head">
        {JIRA_COLUMNS.map((col) => (
          <div key={col.slug} className="jira-lanes-col" data-tone={col.slug} data-testid={`lanes-col-${col.slug}`}>
            <span className="jira-lanes-dot" aria-hidden="true" />
            <span className="jira-lanes-name">{col.label}</span>
            <span className="jira-lanes-count">{counts[col.slug]}</span>
          </div>
        ))}
      </div>
      {views.length === 0 ? <div className="board-empty">{total === 0 ? 'No issues' : 'No issues match'}</div> : views.flatMap(drawLane)}
    </div>
  );
}
