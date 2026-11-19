import { useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { useSettings } from '../../hooks/useSettings';
import { useTimeZone } from '../../hooks/TimeZoneContext';
import { resolveJiraAction, runChipState } from '../../lib/jira';
import type { DeckEntry } from '../../lib/jira-deck';
import { parentLiveLine } from '../../lib/jira-parent';
import { historySummary, type SessionLink } from '../../lib/jira-sessions';
import { pollAge } from '../../lib/tracker';
import { JIRA_BUILTIN_LABELS } from '../../../../shared/types';
import type { JiraIssue, JiraLiveSession } from '../../../../shared/types';
import { Chevron } from '../ui/Chevron';
import { Fold } from '../ui/Fold';
import { Glyph } from '../ui/Glyphs';
import { ChildSessionLine } from './ChildSessionLine';
import { JiraHistoryLine, JiraSessionCards, JiraStartingCard } from './JiraSessionCard';
import { ParentSessionLine } from './ParentSessionLine';

/**
 * JiraAgentTab — the ticket body's Agent pane (Jira detail tabs spec §5; DESIGN.md §8.9.2, the Agent column's band, now a tab; mock `B-Modal.html`'s Agent
 * tab). It is the old Detail agent band moved as it was, less the two things the frame and the tab row took over: `Run ▾` (the frame's head, spec §2.1, §7.1)
 * and the band's `Agent · N live · M ended` label (the tab's count and the strip's Agent cell).
 *
 * **Top to bottom.** The gate line first — `Next Run can start once this one is quiet.` / `Quiet — a new Run can start now.` — because it explains the frame's
 * `Run ▾` chip and this tab is where the sessions it speaks of are; it reads `runChipState`, the chip's own reading, so the line and a disabled chip can
 * never disagree. Then, with something live, the parent-live line, a `starting` reservation's card and one card per live session, newest first; with
 * nothing live, the dashed robot tile, `No session on this ticket`, its `default: <action> · last run <age>` sub-line and the parent- and child-live lines
 * (an epic whose sub-task is working must not read as idle). Then History.
 *
 * **History is a fold, closed by default** (spec §5.2): `History` with `<N> ended · last <date, time>` on its summary, today's `JiraHistoryLine` rows
 * (each with `Reopen`) once open. Its open state is per ticket — reset when the key changes — so a walk step opens the next ticket's History closed.
 * No fold at all on a ticket that never ended a session — an empty fold is a control that opens onto nothing.
 *
 * **Writes are the body's.** Stop and Unlink arrive as `onStop` / `onUnlink`, already behind the body's one `useAction` guard, so the card's refusal lands
 * on the body's error line under the strip; this pane sends nothing itself.
 */
export function JiraAgentTab({
  issue,
  src,
  live,
  ended,
  starting,
  underway,
  now,
  busy,
  onOpenParent,
  onOpenChild,
  onUnlink,
  onStop
}: {
  /** The issue the frame shows — the key `runChipState` asks about. */
  issue: JiraIssue;
  /** The detail read when it has landed, else `issue`: the parent the parent-live line names. */
  src: JiraIssue;
  /** This ticket's live session links, newest first (`ticketSessions`). */
  live: SessionLink[];
  /** Its ended ones, newest end first (`ticketSessions`). */
  ended: SessionLink[];
  /** The shell's `starting` reservation on the key, or `null`. */
  starting: JiraLiveSession | null;
  /** The Children tree's rows a session is live on (`childSessions`), the deck's lead first. */
  underway: readonly DeckEntry[];
  now: number;
  /** The body's write guard is out: the cards' Unlink and Stop draw disabled. */
  busy: boolean;
  /** The parent-live line's press: the body's parent read, then a push onto the walk. */
  onOpenParent: () => void;
  /** The child-live line's press: opens `underway[0]`'s issue as its Children row would. */
  onOpenChild: () => void;
  onUnlink: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}) {
  const { data } = useJiraContext();
  const { data: sessions } = useJiraSessionsContext();
  const { settings } = useSettings();
  const { zone } = useTimeZone();
  // History's open state, reset DURING render on a key change (the body's own pattern) rather than by keying this tab: a remount would remount
  // `JiraSessionCards` too, and with it a second agents-status read on every walk step (#478 made that one read per list).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState(issue.key);
  if (historyKey !== issue.key) {
    setHistoryKey(issue.key);
    setHistoryOpen(false);
  }

  const parent = src.parent;
  const parentLine = parentLiveLine(src, sessions);
  const parentLineEl =
    parentLine === null || parent === null ? null : (
      <ParentSessionLine parentKey={parent.key} lead={parentLine.lead} more={parentLine.more} onOpen={onOpenParent} />
    );
  const defaultAction = resolveJiraAction(settings.jiraDefaultAction, data?.skills ?? []);
  const defaultLabel =
    typeof defaultAction === 'string' ? JIRA_BUILTIN_LABELS[defaultAction] : (data?.skills.find((k) => k.id === defaultAction.skill)?.name ?? '');
  const lastRun = ended.length > 0 ? pollAge(ended[0].endedAt, now) : null;
  const bandSub = `default: ${defaultLabel}${lastRun === null ? '' : ` · last run ${lastRun}`}`;
  const gate = data === null ? null : runChipState(issue, data, sessions);
  const runLive = live.some((l) => l.how === 'run');
  const nextLine = gate === 'live' ? 'Next Run can start once this one is quiet.' : gate === 'ready' && runLive ? 'Quiet — a new Run can start now.' : null;
  const anyLive = live.length > 0 || starting !== null;

  return (
    <div className="jira-detail-agent">
      <div className="jira-detail-agent-band">
        {nextLine !== null && <span className="jira-detail-next">{nextLine}</span>}
        {anyLive ? (
          <>
            {parentLineEl}
            {starting !== null && <JiraStartingCard session={starting} now={now} />}
            {live.length > 0 && <JiraSessionCards links={live} now={now} busy={busy} onUnlink={onUnlink} onStop={onStop} />}
          </>
        ) : (
          <div className="jira-detail-agent-row">
            <span className="jira-detail-agent-tile" aria-hidden="true">
              <Glyph name="robot" size={16} />
            </span>
            <div className="jira-detail-agent-text">
              <span className="jira-detail-agent-none">No session on this ticket</span>
              <span className="jira-detail-agent-sub">{bandSub}</span>
              {parentLineEl}
              {underway.length > 0 && <ChildSessionLine first={underway[0]} more={underway.length - 1} onOpen={onOpenChild} />}
            </div>
          </div>
        )}
      </div>
      {ended.length > 0 && (
        <Fold
          className="jira-fold"
          open={historyOpen}
          onToggle={() => setHistoryOpen((o) => !o)}
          head={
            <>
              <Chevron dir={historyOpen ? 'down' : 'right'} />
              <span className="jira-fold-label">History</span>
              <span className="jira-fold-meta">{historySummary(ended, zone)}</span>
            </>
          }
        >
          <ol className="jira-hist-list jira-fold-body">
            {ended.map((link) => (
              <JiraHistoryLine key={`${link.sessionId ?? ''}\u0000${link.startedAt}`} link={link} now={now} />
            ))}
          </ol>
        </Fold>
      )}
    </div>
  );
}
