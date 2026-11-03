import { useState, type ReactNode } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useTimeZone } from '../../hooks/TimeZoneContext';
import { useAction } from '../../hooks/useAction';
import { useAgents } from '../../hooks/useAgents';
import { useNarrow } from '../../hooks/useNarrow';
import { useSettings } from '../../hooks/useSettings';
import { sessionUrl } from '../../lib/agents';
import { elapsedSince } from '../../lib/item-age';
import { openDesktopJira, repoBasename } from '../../lib/jira';
import {
  desktopButton,
  desktopHref,
  linkedHow,
  openButtons,
  runLabel,
  sessionDuration,
  shortSessionId,
  stripTitle,
  surfaceWord,
  type OpenButton,
  type SessionLink
} from '../../lib/jira-sessions';
import { formatZonedClock } from '../../lib/time-zone';
import { pollAge } from '../../lib/tracker';
import { STATE_LABEL } from '../../../../shared/jira-sessions';
import type { JiraLiveSession } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { LiveStrip } from '../ui/LiveStrip';
import { Meter } from '../ui/Meter';

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
 * **Unlink and Stop are the parent's writes.** Detail owns the one write guard and the page's error line (a refusal of either is the dialog's to say), so
 * the card takes `onUnlink` / `onStop` and DECIDES ONLY WHETHER TO OFFER THEM:
 * - **Unlink** — only for a `branch` link (C9). A `run` link ends with its session (the server answers an unlink of one with a 409), and a `manual` link is
 *   the person's own act, which `/jira unlink` undoes from where it was made.
 * - **Stop** — only when the dashboard's row carries `stopState`, which is the dashboard's own rule for a session it can signal. A Desktop- or CLI-owned
 *   session, or a `processLive` one with no handle, gets none: Stop would end the link as `stopped` while the process kept running, and C5 would re-attach
 *   it at the next reconcile. `stopping` draws the chip disabled — the signal is already on its way. And, as before the sessions page, only while the
 *   dashboard has agents enabled (`StopSession` reads `useAgents()`), so a Stop the dashboard would refuse is not drawn.
 */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** One Dashboard or Desktop button, drawn from `openButtons`' answer and `desktopButton`'s verdict (see the header). */
export function OpenChip({
  button,
  sessionId,
  row,
  primary,
  onHandover
}: {
  button: OpenButton;
  sessionId: string;
  row: SessionLink['row'];
  primary: boolean;
  onHandover: (sessionId: string) => void;
}) {
  const { settings } = useSettings();
  const phone = useNarrow();
  const variant = primary ? 'ink' : 'outline';
  if (button.target === 'dashboard') {
    return (
      <Chip as="a" size={28} variant={variant} href={sessionUrl(settings.linkBase, sessionId)}>
        {button.label}
      </Chip>
    );
  }
  // A history line's Reopen has no row to judge by: an ended session has no process, so the app's own resume link is safe.
  if (row === null) {
    return (
      <Chip as="a" size={28} variant={variant} href={desktopHref(sessionId)}>
        {button.label}
      </Chip>
    );
  }
  const d = desktopButton(row, phone);
  if (!d.show) return null;
  if (!d.enabled) {
    return (
      <Chip size={28} variant={variant} disabled title={d.title ?? undefined}>
        {button.label}
      </Chip>
    );
  }
  if (d.via === 'href') {
    return (
      <Chip as="a" size={28} variant={variant} href={desktopHref(sessionId)}>
        {button.label}
      </Chip>
    );
  }
  return (
    <Chip size={28} variant={variant} onClick={() => onHandover(sessionId)}>
      {button.label}
    </Chip>
  );
}

export function JiraSessionCard({
  link,
  now,
  busy,
  onUnlink,
  onStop
}: {
  link: SessionLink;
  /** The page's one minute clock (`useNow`), so every age on the card ticks together. */
  now: number;
  /** Detail's write guard is out: Unlink and Stop draw disabled, as the page's own controls do. */
  busy: boolean;
  onUnlink: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}) {
  const { data } = useJiraContext();
  const { zone } = useTimeZone();
  const phone = useNarrow();
  const handover = useAction();
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
  const stoppable = row?.stopState !== undefined;

  return (
    <article className="jira-sess" aria-label={`Session ${shortSessionId(sessionId)}`} data-state={state}>
      <LiveStrip tone={state} label={STATE_LABEL[state]} mark={pollAge(link.stateSince, now)} title={stripTitle(state)} />
      <div className="jira-sess-face">
        <dl className="jira-sess-facts">
          <Row label="Run">{runLabel(link, data?.skills ?? [])}</Row>
          {where !== null && <Row label="Where">{where}</Row>}
          {model !== '' && <Row label="Model">{model}</Row>}
          {pct !== undefined && (
            <Row label="Context">
              <Meter label="used" value={`${Math.round(pct)}%`} fraction={pct / 100} tone={pct >= 90 ? 'red' : pct >= 70 ? 'amber' : 'green'} width={104} />
            </Row>
          )}
          <Row label="Repo">{repoBasename(link.repo)}</Row>
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
          <OpenChip
            button={buttons.primary}
            sessionId={sessionId}
            row={row}
            primary
            onHandover={(id) => handover.run(() => openDesktopJira(id))}
          />
          {buttons.secondary !== null && (
            <OpenChip button={buttons.secondary} sessionId={sessionId} row={row} primary={false} onHandover={(id) => handover.run(() => openDesktopJira(id))} />
          )}
          {link.how === 'branch' && (
            <Chip size={28} variant="flat" disabled={busy} title="drop this link — the session itself is not touched" onClick={() => onUnlink(sessionId)}>
              Unlink
            </Chip>
          )}
          {stoppable && <StopSession busy={busy || row?.stopState === 'stopping'} onStop={() => onStop(sessionId)} />}
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
          <Row label="Repo">{repoBasename(session.repo)}</Row>
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
      {link.sessionId !== null && <OpenChip button={buttons.primary} sessionId={link.sessionId} row={null} primary={false} onHandover={() => {}} />}
      <span className="jira-hist-meta">{meta}</span>
    </li>
  );
}

/**
 * `Stop session` and its confirmation (Jira phase 5, spec §7; DESIGN.md §8.9.2) — the modal's own control, moved here with the card that now owns it. Nothing
 * is drawn with agents off or before the answer lands: a Stop the dashboard would refuse is a promise it cannot keep. The question REPLACES the chip in
 * place (`ui/Confirm`, the claim release's precedent), and the safe answer holds the focus. The POST itself is Detail's, so its refusal draws in the one alert line.
 */
export function StopSession({ busy, onStop }: { busy: boolean; onStop: () => void }) {
  const { status } = useAgents();
  const [asking, setAsking] = useState(false);
  if (status === null || !status.enabled) return null;
  if (!asking)
    return (
      <Chip size={28} disabled={busy} title="end this session" onClick={() => setAsking(true)}>
        Stop session
      </Chip>
    );
  return (
    <Confirm
      label="confirm stop"
      testId="jira-stop-confirm"
      acceptLabel="Stop session"
      dismissLabel="Keep running"
      onDismiss={() => setAsking(false)}
      onAccept={() => {
        setAsking(false);
        onStop();
      }}
    >
      Stop this session? It ends mid-work; its edits stay where it left them.
    </Confirm>
  );
}
