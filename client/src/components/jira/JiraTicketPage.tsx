import { useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { setJiraTicketKey, useJiraTicketKey } from '../../hooks/useJiraTicketKey';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useTicketDetail } from '../../hooks/useTicketDetail';
import { JIRA_BOARD_KEY, pickBoard } from '../../lib/jira';
import type { GitlabMr, JiraAction, JiraIssue, ReviewHalf } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { JiraRunMenu } from './JiraRunMenu';
import { JiraTicketBody } from './JiraTicketBody';

/**
 * JiraTicketPage — the Jira section's fifth page, one ticket read by key at the main area's width (Jira detail tabs spec §2; DESIGN.md §8.9.2; mock
 * `Main.html`, `.topbar` and the page body). Mounted by `JiraView` only while the page is `ticket` AND the key store holds a key — `ticket` with an empty key
 * is not a page (§2.1), and `JiraView` draws the Board for it.
 *
 * **Two components.** `JiraTicketPage` owns the page's state — the key store and the walk — and `JiraTicketFrame` draws one key: it reads the detail
 * (`useTicketDetail`, the hook the modal reads through, so the held-copy rule is one implementation), draws the top bar and hands the body its issue. The
 * frame is what the shared ticket-body case table mounts on the page side (`test/helpers/ticket-body-cases.ts`), with the page's own walk around it.
 *
 * **No board poll.** The page reads `fetchJiraDetail` and nothing else: it mounts no `useJiraBoard`, so a ticket off every board, or a board that is not
 * picked, reads the same. The board's name for the crumb comes from the status and the stored pick (`pickBoard`, the pages' own resolution), never from a
 * list read; it draws only when the detail's `boards` holds the picked board's id. With no board's lane index, the Children tab shows the detail's direct
 * children only (`childrenOf` `null`).
 *
 * **The issue the page draws** is the detail's own (`JiraIssueDetail extends JiraIssue`): the landed read, or the held copy across a re-read and across a
 * failed one (`kept`) — so a write's re-read never blinks the page back to its pre-issue frame, and a later failure draws its line under the strip over the
 * ticket already shown (§2.1), as the modal does. With no copy at all (first open, a reload, every walk step) the PRE-ISSUE frame draws: crumbs
 * `Jira / <KEY>` and `← <origin>`, no `Open in Jira ↗` or `Run ▾` (both need the issue), the walk's Back chip and `<KEY>` in mono, then `loading…` — or the
 * failure line with `Retry` (reads again) and `Forget <KEY>` (empties the key store and goes back to the origin, so a ticket that no longer reads does not
 * leave a rail row that opens an error forever, §2.2).
 *
 * **The walk is the page's own** (§2.3): a Children row or the parent link pushes the ticket on screen and writes the child's key; Back pops and writes the
 * popped key. Every step goes through the key store, so a reload lands on the ticket on screen — and the walk itself is component state, gone when the page
 * unmounts (the reader left it) or the section remounts, which is why a reload opens on the last child with no Back chip (Review Focus 3).
 *
 * **Origin** is `JiraView`'s, held in memory and handed in: the page that opened this one, `Board` after a reload or a rail-row entry (§2.3).
 */

/** The pages a ticket page can be entered from, and the word its `←` chip names each by. */
export type TicketOrigin = 'board' | 'sessions' | 'mentions';
const ORIGIN_LABEL: Record<TicketOrigin, string> = { board: 'Board', sessions: 'Sessions', mentions: 'Mentions' };

export function JiraTicketPage({
  origin,
  onLeave,
  onWrote,
  onRun,
  onReview
}: {
  origin: TicketOrigin;
  /** Back to the origin page (`← <origin>`, and after `Forget`): `onOpenJiraPage(origin)`. */
  onLeave: () => void;
  /** A landed write: the section's nudge, which the board pages re-read on. The page's own re-read is the frame's. */
  onWrote: () => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  onReview?: (issue: JiraIssue, half: ReviewHalf, mr: GitlabMr, repos: string[]) => void;
}) {
  const key = useJiraTicketKey();
  // The tickets before the one on screen, oldest first; the last is the Back chip's.
  const [walk, setWalk] = useState<readonly JiraIssue[]>([]);
  const back = walk.length === 0 ? null : walk[walk.length - 1];

  return (
    <JiraTicketFrame
      ticketKey={key}
      origin={origin}
      back={back}
      onOpenIssue={(from, child) => {
        setWalk((w) => [...w, from]);
        setJiraTicketKey(child.key);
      }}
      onBack={() => {
        if (back === null) return;
        setWalk((w) => w.slice(0, -1));
        setJiraTicketKey(back.key);
      }}
      onLeave={onLeave}
      onForget={() => {
        setJiraTicketKey('');
        onLeave();
      }}
      onWrote={onWrote}
      onRun={onRun}
      onReview={onReview}
    />
  );
}

export function JiraTicketFrame({
  ticketKey,
  origin,
  back,
  onOpenIssue,
  onBack,
  onLeave,
  onForget,
  onWrote,
  onRun,
  onReview
}: {
  ticketKey: string;
  origin: TicketOrigin;
  /** One step up the page's walk, or `null` at its start. */
  back: JiraIssue | null;
  /** A walk step: `from` is the ticket on screen (the Back chip's next target), `child` the one to show. */
  onOpenIssue: (from: JiraIssue, child: JiraIssue) => void;
  onBack: () => void;
  onLeave: () => void;
  onForget: () => void;
  onWrote: () => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  onReview?: (issue: JiraIssue, half: ReviewHalf, mr: GitlabMr, repos: string[]) => void;
}) {
  const { data } = useJiraContext();
  const { detail, kept, failure, reread } = useTicketDetail(ticketKey);
  const [storedBoard] = usePersistedState<unknown>(JIRA_BOARD_KEY, null);
  const picked = data === null || data.configUnreadable !== null ? null : pickBoard(storedBoard, data.boards);
  const issue: JiraIssue | null = kept;

  const leave = (
    <Chip size={28} variant="flat" onClick={onLeave}>
      <span aria-hidden="true">←</span> {ORIGIN_LABEL[origin]}
    </Chip>
  );

  if (issue === null) {
    return (
      <div className="jira-page">
        <div className="jira-page-top">
          <nav className="jira-page-crumbs" aria-label="Ticket path">
            <span>Jira</span>
            <span aria-hidden="true">/</span>
            <b>{ticketKey}</b>
          </nav>
          <div className="jira-page-acts">{leave}</div>
        </div>
        <div className="jira-page-pre">
          <div className="jira-body-tags">
            {back !== null && (
              <Chip size={28} aria-label={`Back to ${back.key}`} title={`Back to ${back.key} ${back.summary}`} onClick={onBack}>
                <span aria-hidden="true">←</span> {back.key}
              </Chip>
            )}
            <span className="jira-body-key">{ticketKey}</span>
          </div>
          {failure === null ? (
            <p className="jira-modal-none">loading…</p>
          ) : (
            <div className="jira-page-failed">
              <p role="alert">{`could not read the ticket — ${failure}`}</p>
              <Chip size={28} onClick={reread}>
                Retry
              </Chip>
              <Chip size={28} variant="flat" onClick={onForget}>
                {`Forget ${ticketKey}`}
              </Chip>
            </div>
          )}
        </div>
      </div>
    );
  }

  const parent = issue.parent;
  const onPicked = picked !== null && kept !== null && kept.boards.includes(picked.id) ? picked : null;
  return (
    <div className="jira-page">
      <div className="jira-page-top">
        <nav className="jira-page-crumbs" aria-label="Ticket path">
          <span>Jira</span>
          {onPicked !== null && (
            <>
              <span aria-hidden="true">/</span>
              <span>{onPicked.name}</span>
            </>
          )}
          {parent !== null && (
            <>
              <span aria-hidden="true">/</span>
              <span className="jira-page-crumb-parent">{[parent.key, parent.summary].filter((p) => p !== '').join(' ')}</span>
            </>
          )}
          <span aria-hidden="true">/</span>
          <b>{issue.key}</b>
        </nav>
        {/* `Run ▾` is its own popover's positioning parent, so the row carries it as the modal's head does. */}
        <div className="jira-page-acts">
          {leave}
          <a className="jira-detail-out" href={issue.url} target="_blank" rel="noreferrer">
            Open in Jira ↗
          </a>
          <JiraRunMenu issue={issue} home="modal" onPick={onRun} />
        </div>
      </div>
      <div className="jira-page-body">
        <JiraTicketBody
          issue={issue}
          detail={detail}
          failure={failure}
          childrenOf={null}
          back={back}
          onBack={onBack}
          onOpenIssue={(child) => onOpenIssue(issue, child)}
          onWrote={(again) => {
            if (again) reread();
            onWrote();
          }}
          onRun={onRun}
          onReview={onReview}
        />
      </div>
    </div>
  );
}
