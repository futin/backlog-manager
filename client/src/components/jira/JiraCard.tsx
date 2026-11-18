import type { ReactNode } from 'react';

import { useAction } from '../../hooks/useAction';
import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import { useJiraContext } from '../../hooks/JiraContext';
import { useNarrow } from '../../hooks/useNarrow';
import { ticketDelivery } from '../../lib/delivery';
import { cardAgeStamp, crumbOf, crumbText, openDesktopJira } from '../../lib/jira';
import { endedLine, type SessionCell } from '../../lib/jira-deck';
import { openButtons, stripTitle, type SessionLink } from '../../lib/jira-sessions';
import { sessionTone } from '../../lib/tones';
import { pollAge } from '../../lib/tracker';
import { STATE_LABEL } from '../../../../shared/jira-sessions';
import type { JiraAction, JiraBoard, JiraIssue, JiraParentRef, JiraWorktree } from '../../../../shared/types';
import { IssueStatus } from '../ui/IssueStatus';
import { IssueTypeTile } from '../ui/IssueTypeTile';
import { PersonMark } from '../ui/PersonMark';
import { PriorityPill } from '../ui/PriorityPill';
import { RepoMark } from '../ui/RepoMark';
import { TreeMark } from '../ui/TreeMark';
import { JiraRunMenu } from './JiraRunMenu';
import { MrChip } from './MrChip';
import { OpenChip, SessionOpen } from './SessionOpen';

/**
 * JiraCard — one issue in a lane cell of the Jira board (parent-lanes spec §3.4; Jira phase 2, spec §6.2; DESIGN.md §8.9.1, which applies §8.3's card to a
 * Jira issue).
 *
 * **It is the Board's card, not a second one.** The ground, the radius, the face's padding and gap, the title's 14/500 and the marker row are `.board-card`,
 * `.board-card-face`, `.board-card-title`, `.board-card-foot`, `.board-card-meta` and `.board-card-markers` — composed, never restated — so a density or
 * theme change to the Board's card moves this one with it. What a Jira issue has that a backlog item does not — the type tile, the priority pill, the
 * initials disc, the raw status, the mapped repo and the worktree chip — are `components/ui/` primitives (`IssueTypeTile`, `PriorityPill`, `PersonMark`,
 * `IssueStatus`, `RepoMark`, `TreeMark`), because an on-board lane header draws the same issue as a row (`JiraLaneHeader`) and the two must not drift.
 *
 * **Everything the card prints comes from `lib/`.** The crumb's words are `crumbText`'s, the age `cardAgeStamp`'s (aged against the page's `now` so every
 * card shares one clock), the ended line `endedLine`'s — this file holds no copy of any of them (spec §6.1's one-home rule).
 *
 * **The crumb never names the parent** (parent-lanes spec §3.4). The lane the card sits in already says it, so `crumbOf`'s `parent` kind draws nothing here;
 * the precedence — root, then parent, then mine — is unchanged, so a followed root still reads `root` and a parentless issue assigned to me reads
 * `Assigned to me`, while a card under a parent draws no crumb even when it is mine. Dropping the rung instead would print `Assigned to me` on every card of
 * a "my tasks" board. `parent` is the parent the lane model KEPT (`JiraLanes.parentOf`), not the raw field, so a link dropped to break a cycle is no parent.
 *
 * **No fold block and no match ring any more.** A card has no children on the board by definition — an issue with one is a lane header — and filters match
 * per issue, so nothing is folded under a card for a ring to explain.
 *
 * **A card with a live session stays in its cell** (D7, §3.4). `session` is `sessionCells`' answer for this card's OWN key: with a `lead`, the card wears
 * the `ui-stripe` leading edge in the state's tone (`data-tone`, plus `data-state` for the reading), a state line — the deck card's `STATE_LABEL · age`,
 * `+N` for the key's other live sessions — and `SessionOpen` as the deck card mounts it, with the hand-over error under it. An ended cell (`lead` null)
 * draws none of that: the ended line says it. `Run ▾` stays on a live card and draws what `runChipState` says, untouched.
 *
 * **The browser never talks to Jira.** The person is initials on a disc, never Jira's `avatarUrls`. The one link out is the issue's `url` exactly as the
 * SERVER built it, in a new tab with no referrer; the card never composes a Jira URL of its own.
 *
 * The whole card is a `role="button"` that opens the issue (`onOpen`), Enter and Space included, exactly as `ItemCard`; the link out, `Run ▾`, the session's
 * open control and Reopen each stop both the click and those two keys — without that one press opens Jira AND the modal, and the card's `preventDefault()`
 * on Enter would cancel the inner control's own activation.
 */
export function JiraCard({
  issue,
  board,
  me,
  now,
  parent,
  session,
  ended,
  trees,
  onOpen,
  onRun
}: {
  issue: JiraIssue;
  board: JiraBoard;
  me: { accountId: string } | null;
  now: number;
  parent: JiraParentRef | null;
  session: SessionCell | null;
  ended: readonly SessionLink[];
  trees: readonly JiraWorktree[];
  onOpen: (issue: JiraIssue) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const kind = crumbOf(issue, board, me, parent);
  const crumb = kind?.kind === 'parent' ? null : crumbText(kind);
  const open = (): void => onOpen(issue);
  const lead = session?.lead ?? null;
  const tone = lead === null ? undefined : sessionTone(lead.state);

  return (
    <div
      className={lead === null ? 'board-card' : 'board-card ui-stripe'}
      data-tone={tone}
      data-state={lead?.state}
      data-key={issue.key}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="board-card-face">
        {session !== null && lead !== null && <SessionStateLine cell={session} now={now} />}
        <div className="jira-card-head">
          <IssueTypeTile type={issue.type} />
          <span className="jira-card-key">{issue.key}</span>
          {crumb !== null && <span className="jira-card-crumb">{crumb}</span>}
          <PriorityPill priority={issue.priority} />
        </div>
        <div className="board-card-title">{issue.summary}</div>
        <div className="board-card-foot">
          <PersonMark name={issue.assignee?.name ?? null} />
          <IssueStatus status={issue.status} />
          <span className="board-card-meta">{cardAgeStamp(issue, now)}</span>
          <IssueLinkOut issueKey={issue.key} url={issue.url} />
        </div>
        <div className="board-card-markers" data-testid="marker-row">
          <IssueMarks issue={issue} trees={trees} now={now} onRun={onRun} />
        </div>
        {lead !== null && <SessionControl cell={session as SessionCell} />}
        <EndedLine ended={ended} now={now} />
      </div>
    </div>
  );
}

/** Stops a press from reaching the card (or header) round it, so an inner control never also opens Detail. */
function Contained({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={className}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >
      {children}
    </span>
  );
}

/** The `↗` link out — the server's `url` for an on-board issue, or the one an off-board header composes from the site. */
export function IssueLinkOut({ issueKey, url }: { issueKey: string; url: string }) {
  return (
    <a
      className="board-card-link"
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`open ${issueKey} in Jira`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >
      ↗
    </a>
  );
}

/**
 * The issue's marks and its one action, in the order the card's marker row draws them: the mapped repo (the status' own mapping for the project, which
 * `runChipState` reads too — a non-array is unmapped there and here), the worktree chip, the lead MR (`ticketDelivery`, read from the shell's GitLab
 * answer, `null` while GitLab is not shown), and `Run ▾` last. The card and an on-board lane header both mount this, so the two cannot disagree about
 * what an issue carries; `Run ▾` is never hidden on either.
 */
export function IssueMarks({
  issue,
  trees,
  now,
  onRun
}: {
  issue: JiraIssue;
  trees: readonly JiraWorktree[];
  now: number;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const { data } = useJiraContext();
  const mapped: unknown = data?.repos[issue.project.key];
  const paths = Array.isArray(mapped) ? (mapped as string[]) : [];
  const index = useDeliveryIndex();
  const delivery = index === null ? null : ticketDelivery(issue, index);
  return (
    <>
      <RepoMark paths={paths} />
      <TreeMark trees={trees} />
      {delivery !== null && <MrChip delivery={delivery} now={now} />}
      <JiraRunMenu issue={issue} onPick={onRun} />
    </>
  );
}

/** A live session's state line — the deck card's words (`STATE_LABEL · age`) with its dot, plus `+N` for the key's other live sessions. */
export function SessionStateLine({ cell, now }: { cell: SessionCell; now: number }) {
  const age = pollAge(cell.since, now);
  const words = age === null ? STATE_LABEL[cell.state] : `${STATE_LABEL[cell.state]} · ${age}`;
  return (
    <div className="jira-card-live" data-testid="session-line" title={stripTitle(cell.state)}>
      <i className="ui-stripe-dot" data-tone={sessionTone(cell.state)} aria-hidden="true" />
      <span>{words}</span>
      {cell.more > 0 && <span className="jira-card-live-more">{`+${cell.more}`}</span>}
    </div>
  );
}

/**
 * The lead session's open control, mounted exactly as the deck card mounts it (`openButtons`' narrow reading, the hand-over through `useAction` with its
 * error under it). A reservation (`starting`) has no link yet and so no control — the state line still says it.
 */
export function SessionControl({ cell }: { cell: SessionCell }) {
  const phone = useNarrow();
  const handover = useAction();
  const lead = cell.lead;
  const link = lead?.link ?? null;
  const sessionId = link?.sessionId ?? null;
  if (lead === null || link === null || sessionId === null) return null;
  const row = link.row ?? null;
  return (
    <>
      <Contained className="jira-card-open">
        <SessionOpen
          issueKey={lead.issue.key}
          sessionId={sessionId}
          row={row}
          launch={link.surface ?? null}
          state={lead.state}
          buttons={openButtons(link, row, lead.state, { phone, wide: false })}
          onHandover={(id) => handover.run(() => openDesktopJira(id))}
        />
      </Contained>
      {handover.error !== null && (
        <p className="jira-modal-error" role="alert">
          {handover.error}
        </p>
      )}
    </>
  );
}

/**
 * The extra line (Jira sessions spec §7.1): the ticket's OWN ended sessions, newest first — `run ended 2h ago` with a Reopen for one, `N sessions` for
 * several, nothing for a ticket never run. Reopen stops the click and the two keys for the reason the link out does.
 */
export function EndedLine({ ended, now }: { ended: readonly SessionLink[]; now: number }) {
  const phone = useNarrow();
  const last = endedLine(ended, now);
  if (last === null) return null;
  return (
    <div className="jira-card-ended" data-testid="ended-line">
      <span>{last.text}</span>
      {last.reopen !== null && last.reopen.sessionId !== null && (
        <Contained>
          <OpenChip
            button={openButtons(last.reopen, null, 'ended', { phone, wide: false }).primary}
            sessionId={last.reopen.sessionId}
            row={null}
            launch={last.reopen.surface}
            primary={false}
            onHandover={() => {}}
          />
        </Contained>
      )}
    </div>
  );
}
