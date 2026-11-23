import { useRef, type ReactNode } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useTimeZone } from '../../hooks/TimeZoneContext';
import { useAction } from '../../hooks/useAction';
import { useAgents } from '../../hooks/useAgents';
import { useNarrow } from '../../hooks/useNarrow';
import { elapsedSince } from '../../lib/item-age';
import { openDesktopJira } from '../../lib/jira';
import {
  linkedHow,
  openButtons,
  runLabel,
  sessionDuration,
  shortSessionId,
  stripTitle,
  surfaceWord,
  type SessionLink
} from '../../lib/jira-sessions';
import { projectLabel } from '../../lib/project-label';
import { formatZonedClock } from '../../lib/time-zone';
import { pollAge } from '../../lib/tracker';
import { STATE_LABEL } from '../../../../shared/jira-sessions';
import type { JiraLiveSession } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { LiveStrip } from '../ui/LiveStrip';
import { Meter } from '../ui/Meter';
import { OpenChip, SessionOpen } from './SessionOpen';

/**
 * JiraSessionCard — one live Jira session as Detail draws it (Jira sessions spec §7.3, §7.5), and the history line under the cards. Exported on its own
 * because the deck's cards (the Board page) draw the same session and a second copy would be a second place to get C2 or the Stop rule wrong.
 *
 * **The card is the deck card's face, widened.** A state strip across the top (`ui/LiveStrip` — the same band a board card wears for "somebody is on this",
 * its label spec §6's words and its mark how long THIS server has seen the session in that state, `pollAge`'s ladder), then the session's facts, then its
 * buttons. The waiting question's TEXT is never drawn: the dashboard row does not carry it, and the mock that shows it is a mock (§7.3).
 *
 * **Buttons are `openButtons`' (§7.5), Detail's wide reading.** The primary and secondary come from the first-match table in `lib/jira-sessions.ts`; this
 * file only draws them. A Dashboard button is a link to `sessionUrl(linkBase, id)`. A Desktop one is whatever `desktopButton` says (C2): hidden on a phone,
 * disabled with C2's own title while opening it could fork a live transcript, a plain `claude://resume` link when the app owns the session or it is
 * resting locally, and — for a dashboard session at rest — a press that POSTs `jira-open-desktop`, so the dashboard's own guard stays the one that decides.
 * That one POST's refusal draws under the buttons in this card's own alert line; the card keeps its `useAction` for it because nothing above the card
 * has a reason to know a hand-over was refused.
 *
 * **One control, `SessionOpen`, holds every button.** Its split's main half is the primary Open; the secondary Open, Unlink and Stop are the `Session actions` menu's
 * rows, offered exactly where each used to be its own chip. With none of them it collapses to the single Open it always was.
 *
 * **Unlink and Stop are the parent's writes.** Detail owns the one write guard and the page's error line (a refusal of either is the dialog's to say), so
 * the card takes `onUnlink` / `onStop` and DECIDES ONLY WHETHER TO OFFER THEM:
 * - **Unlink** — only for a `branch` link (C9). A `run` link ends with its session (the server answers an unlink of one with a 409), and a `manual` link is
 *   the person's own act, which `/jira unlink` undoes from where it was made.
 * - **Stop** — only when the dashboard's row carries `stopState`, which is the dashboard's own rule for a session it can signal. A Desktop- or CLI-owned
 *   session, or a `processLive` one with no handle, gets none: Stop would end the link as `stopped` while the process kept running, and C5 would re-attach
 *   it at the next reconcile. `stopping` draws the chip disabled — the signal is already on its way. And, as before the sessions page, only while the
 *   dashboard has agents enabled (the card is handed `agentsOn` by `JiraSessionCards`, which asks `useAgents()` once per list and is mounted only while
 *   there is a live link; `Stop session` is a row of `SessionOpen`'s menu and its `Confirm` is `SessionOpen`'s), so a Stop the dashboard would refuse is
 *   not drawn. A `review` session gets none either (Jira detail tabs spec §5.1), whatever its row carries.
 */

function Row({ label, children, wide = false, title }: { label: string; children: ReactNode; wide?: boolean; title?: string }) {
  return (
    <div className={wide ? 'jira-sess-fact-wide' : undefined}>
      <dt>{label}</dt>
      <dd title={title}>{children}</dd>
    </div>
  );
}

export function JiraSessionCard({
  link,
  now,
  busy,
  onUnlink,
  onStop,
  agentsOn
}: {
  link: SessionLink;
  /** The page's one minute clock (`useNow`), so every age on the card ticks together. */
  now: number;
  /** Detail's write guard is out: Unlink and Stop draw disabled, as the page's own controls do. */
  busy: boolean;
  onUnlink: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  /** The dashboard has agents enabled — `JiraSessionCards`' one `useAgents()` answer, so N cards are one request, not N (#478). */
  agentsOn: boolean;
}) {
  const { data } = useJiraContext();
  const { zone } = useTimeZone();
  const phone = useNarrow();
  const handover = useAction();
  // The card takes the focus after an accepted Stop, when the control that held it is disabled (`SessionOpen`'s header, #475); `tabIndex={-1}` makes it
  // focusable from script without adding a tab stop.
  const cardRef = useRef<HTMLElement>(null);
  const { row, state } = link;
  const sessionId = link.sessionId;
  if (sessionId === null) return null;

  const buttons = openButtons(link, row, state, { phone, wide: true });
  const model = [row?.model ?? link.model, row?.effort ?? link.effort].filter((p) => p !== null && p !== undefined && p !== '').join(' · ');
  const where = surfaceWord(link, row);
  const started = Date.parse(link.startedAt);
  const startedLine = Number.isNaN(started)
    ? '—'
    : [formatZonedClock(started, zone), elapsedSince(link.startedAt, now)].filter((p) => p !== null).join(' · ');
  const pct = row?.contextPct;
  // A review session is never offered Stop (Jira detail tabs spec §5.1, decision 5) — on every surface that draws this card, whatever its row carries.
  const stoppable = row?.stopState !== undefined && link.action !== 'review';
  const stopping = row?.stopState === 'stopping';

  return (
    <article ref={cardRef} className="jira-sess" aria-label={`Session ${shortSessionId(sessionId)}`} data-state={state} tabIndex={-1}>
      <LiveStrip tone={state} label={STATE_LABEL[state]} mark={pollAge(link.stateSince, now)} title={stripTitle(state)} />
      <div className="jira-sess-face">
        <dl className="jira-sess-facts">
          {/* Two cells wide and titled: a review skill's label is `Review the MR · <name>`, and one 110 px cell ellipsised it to `Review the MR · Cla…`,
              the prefix eating the only part that says which reviewer runs (2026-11-20 ui-verify). */}
          <Row label="Run" wide title={runLabel(link, data?.skills ?? [])}>
            {runLabel(link, data?.skills ?? [])}
          </Row>
          {where !== null && <Row label="Where">{where}</Row>}
          {model !== '' && <Row label="Model">{model}</Row>}
          {pct !== undefined && (
            <Row label="Context">
              <Meter label="used" value={`${Math.round(pct)}%`} fraction={pct / 100} tone={pct >= 90 ? 'red' : pct >= 70 ? 'amber' : 'green'} width={104} />
            </Row>
          )}
          <Row label="Repo">{projectLabel(link.repo)}</Row>
          {link.branch !== null && <Row label="Branch"><span className="jira-sess-mono">{link.branch}</span></Row>}
          <Row label="Started">{startedLine}</Row>
          <Row label="Session">
            <span className="jira-sess-mono" title={sessionId}>
              {shortSessionId(sessionId)}
            </span>
          </Row>
          <Row label="Linked">{linkedHow(link.how)}</Row>
        </dl>
        <div className="jira-sess-acts">
          {/* One split Open: the secondary Open, Unlink and Stop are its menu's rows, offered exactly where each was a chip before. */}
          <SessionOpen
            issueKey={link.key}
            sessionId={sessionId}
            row={row}
            launch={link.surface}
            state={state}
            buttons={buttons}
            busy={busy || stopping}
            onHandover={(id) => handover.run(() => openDesktopJira(id))}
            onUnlink={link.how === 'branch' ? onUnlink : undefined}
            onStop={stoppable && agentsOn ? onStop : undefined}
            cardRef={cardRef}
          />
        </div>
        {handover.error !== null && (
          <p className="jira-modal-error" role="alert">
            {handover.error}
          </p>
        )}
      </div>
    </article>
  );
}

/**
 * Detail's live session cards, one `JiraSessionCard` per link, asking the dashboard's agents status ONCE for the lot (#478). Each card used to call
 * `useAgents()` itself, so a ticket with N live sessions mounted N of them and sent N `GET /api/agents/status` on open and on every window focus. The call
 * cannot move up into `JiraDetail`: a hook runs on every render, and Detail must not ask at all for a ticket with no confirmed session or only a starting one
 * (`test/jira/jira-detail.test.tsx` pins both). So it lives in this list, which Detail mounts only while it has a live link. A fragment, so the DOM is the
 * cards' alone, as it was.
 */
export function JiraSessionCards({
  links,
  now,
  busy,
  onUnlink,
  onStop
}: {
  links: SessionLink[];
  now: number;
  busy: boolean;
  onUnlink: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}) {
  const agents = useAgents();
  // The menu's Stop row is offered only while the dashboard has agents on, so a Stop it would refuse is not drawn.
  const agentsOn = agents.status !== null && agents.status.enabled;
  return (
    <>
      {links.map((link) => (
        <JiraSessionCard key={link.sessionId ?? link.startedAt} link={link} now={now} busy={busy} onUnlink={onUnlink} onStop={onStop} agentsOn={agentsOn} />
      ))}
    </>
  );
}

/**
 * The card for a Run whose session id is not known yet (`starting`, spec §6): built from the shell's `live[key]` reservation, because `GET /api/jira/sessions`
 * never carries one — a reservation has no link until the dashboard answers. A strip and the two facts the reservation knows; no buttons, since every one
 * of them needs the session's id.
 */
export function JiraStartingCard({ session, now }: { session: JiraLiveSession; now: number }) {
  return (
    <article className="jira-sess" aria-label="Session starting" data-state="starting">
      <LiveStrip tone="starting" label={STATE_LABEL.starting} mark={pollAge(session.startedAt, now)} />
      <div className="jira-sess-face">
        <dl className="jira-sess-facts">
          <Row label="Run">{session.name}</Row>
          <Row label="Repo">{projectLabel(session.repo)}</Row>
        </dl>
      </div>
    </article>
  );
}

/**
 * One line of the history timeline (spec §7.3): `<how> · ended <age> ago`, the surface it ran on, how long it ran, the session's own name, and Reopen — which
 * `openButtons` points at the surface it was started on (`endedTarget`). The age is `pollAge`'s, as every age on this page is.
 */
export function JiraHistoryLine({ link, now }: { link: SessionLink; now: number }) {
  const phone = useNarrow();
  const age = pollAge(link.endedAt, now);
  const buttons = openButtons(link, null, 'ended', { phone, wide: true });
  const meta = [surfaceWord(link, null), sessionDuration(link), link.name].filter((p) => p !== null && p !== '').join(' · ');
  return (
    <li className="jira-hist">
      <i className="jira-hist-node" aria-hidden="true" />
      <span className="jira-hist-head">{age === null ? `${link.how} · ended` : `${link.how} · ended ${age} ago`}</span>
      {link.sessionId !== null && <OpenChip button={buttons.primary} sessionId={link.sessionId} row={null} launch={link.surface} primary={false} onHandover={() => {}} />}
      <span className="jira-hist-meta">{meta}</span>
    </li>
  );
}
