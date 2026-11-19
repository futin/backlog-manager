import { useState, type ReactNode } from 'react';

import type { JiraChildrenIndex, modalTree } from '../../lib/jira';
import type { DeckEntry } from '../../lib/jira-deck';
import type { JiraIssue, JiraIssueDetail } from '../../../../shared/types';
import { Chevron } from '../ui/Chevron';
import { Fold } from '../ui/Fold';
import { ChildrenTree } from './ChildrenTree';

/**
 * JiraChildrenTab — the ticket body's Children & comments pane (Jira detail tabs spec §6; DESIGN.md §8.9.2's Children and comments note; mock `Main.html`'s
 * Children & comments tab): two folds, `Children` open by default and `Comments` closed.
 *
 * **Children** holds today's section — the `SpreadBar` and the tree, each row a button that swaps the ticket (`onOpenIssue`, a walk step: the modal pushes
 * it, the page swaps its key) — with the section's head row moved onto the fold's summary: `Children`, the direct-children count, and `N in all` when the
 * tree draws more rows than that. Its body follows the frame's read: `loading…` while it is out; NOTHING when it failed, because the Ticket tab already says
 * `could not read the ticket — …` and a second copy here would be the same failure twice; `No child tickets.` when the read has none (and the summary then
 * carries no count, as the tab carries none). Children come from the detail read, so a card's copy cannot draw them before it lands.
 *
 * **Comments** holds today's note, `Comments stay in Jira — v1 neither reads nor writes them.` with the issue's own link — the mock's comment list is a
 * mock (spec §6). Closed, because it is a pointer elsewhere and not a reading.
 *
 * Both folds' open state is this mount's; the body keys the tab by the ticket, so a walk step lands on the next ticket's Children open again.
 */
export function JiraChildrenTab({
  src,
  detail,
  failure,
  tree,
  underway,
  childrenOf,
  onOpenIssue
}: {
  /** The detail read when it has landed, else the frame's issue: the key and the link the comments note names. */
  src: JiraIssue;
  /** The frame's detail read, `null` while out or failed. */
  detail: JiraIssueDetail | null;
  /** The read's failure sentence, or `null`. */
  failure: string | null;
  /** `modalTree` over the detail's direct children; `null` when there are none, or no detail. */
  tree: ReturnType<typeof modalTree> | null;
  /** The tree's rows a session is live on (`childSessions`), one per row. */
  underway: readonly DeckEntry[];
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
}) {
  const [childrenOpen, setChildrenOpen] = useState(true);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const direct = detail === null ? 0 : detail.children.length;

  let childrenBody: ReactNode = null;
  if (detail !== null && tree !== null) {
    childrenBody = (
      <div className="jira-detail-pane">
        <ChildrenTree direct={direct} tree={tree} underway={underway} childrenOf={childrenOf} onOpenIssue={onOpenIssue} head={false} />
      </div>
    );
  } else if (detail !== null) {
    childrenBody = <p className="jira-modal-none">No child tickets.</p>;
  } else if (failure === null) {
    childrenBody = <p className="jira-modal-none">loading…</p>;
  }

  return (
    <div className="jira-detail-ticket">
      <Fold
        className="jira-fold"
        open={childrenOpen}
        onToggle={() => setChildrenOpen((o) => !o)}
        head={
          <>
            <Chevron dir={childrenOpen ? 'down' : 'right'} />
            <span className="jira-fold-label">Children</span>
            {direct > 0 && <span className="jira-tab-count">{direct}</span>}
            {tree !== null && tree.rows.length > direct && <span className="jira-fold-meta">{`${tree.rows.length} in all`}</span>}
          </>
        }
      >
        {childrenBody !== null && <div className="jira-fold-body">{childrenBody}</div>}
      </Fold>
      <Fold
        className="jira-fold"
        open={commentsOpen}
        onToggle={() => setCommentsOpen((o) => !o)}
        head={
          <>
            <Chevron dir={commentsOpen ? 'down' : 'right'} />
            <span className="jira-fold-label">Comments</span>
          </>
        }
      >
        <p className="jira-modal-comments jira-fold-body">
          Comments stay in Jira — v1 neither reads nor writes them.{' '}
          <a href={src.url} target="_blank" rel="noreferrer">
            {`${src.key} in Jira ↗`}
          </a>
        </p>
      </Fold>
    </div>
  );
}
