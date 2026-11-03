import type { JiraSessionState } from '../../../shared/jira-sessions';
import type { DashboardRow, JiraLink, JiraSessionsPayload } from '../../../shared/types';
import { elapsedSince } from './item-age';

/**
 * jira-sessions.ts — which "open" buttons a linked Jira session shows, and whether the Desktop one may be pressed (Jira sessions spec C2, C3, §7.5).
 *
 * Pure, and the one home of these rules: the deck card, Detail's live card and the List row all draw the same buttons, so a rule held by each of them would
 * drift. Nothing here touches React or `fetch`; the Dashboard button's URL is `sessionUrl(linkBase, id)` (`lib/agents.ts`, per device) and the Desktop one
 * is `desktopHref` or the guarded `jira-open-desktop` route, as `desktopButton`'s `via` says.
 *
 * The dashboard row's `surface` is `'local' | 'dashboard' | 'cloud'`; a `JiraLink`'s is this repo's own launch surface, `'desktop' | 'dashboard' | null`. They are
 * different vocabularies that happen to share a word, and only `endedTarget` reads the second.
 */

/** C2's two disabled titles, verbatim: they say where to go instead, which is the only thing a person with a greyed button needs to know. */
export const DESKTOP_BUSY_DASHBOARD_TITLE = 'Still running — open it in the Dashboard';
export const DESKTOP_BUSY_LOCAL_TITLE = 'Still running in a terminal or the app';

/** `claude://resume?session=<id>` — the app's own resume link. The id is encoded, though a dashboard session id never needs it. */
export function desktopHref(sessionId: string): string {
  return 'claude://resume?session=' + encodeURIComponent(sessionId);
}

export interface DesktopButton {
  /** `false` on a phone only: it has no desktop app to hand a session to, so the button is not drawn at all. */
  show: boolean;
  enabled: boolean;
  /** `href` — a plain `claude://resume` link; `handover` — `POST /api/agents/jira-open-desktop`, so the dashboard's own guard decides. `null` while disabled. */
  via: 'href' | 'handover' | null;
  /** Why the button is disabled; `null` while enabled or hidden. */
  title: string | null;
}

/** The two statuses a session rests in once its turn is over; the dashboard's own hand-over (`handOverState` → `offer`) accepts exactly these. */
const RESTING = new Set(['idle', 'incomplete']);

/**
 * C2 — Open in Desktop is enabled only when opening it cannot put a second process on the transcript.
 *
 * - `local` (a terminal or the app, the row cannot say which): enabled only while resting, as the plain href. A working or waiting one may be a terminal
 *   mid-turn, and the app opening it would fork a transcript that terminal is writing.
 * - Anything else is read as a dashboard session, `cloud` and a row that sent no surface included (a cloud row never reaches this server, and treating the
 *   unknown as the stricter case can only disable a button, never fork a transcript): `desktopOwned` is enabled as the href, since the app already owns it;
 *   otherwise it is enabled exactly when the dashboard's own hand-over would accept it — no `stopState`, no `processLive`, none of the three held waits, and a
 *   resting status — and goes through the guarded route, never a raw link, so the guard stays the dashboard's. A held wait is a running process mid-turn.
 *
 * `desktopOwned` is read only on the dashboard branch, as the spec words it: a `local` row is judged by its status alone.
 */
export function desktopButton(row: DashboardRow, phone: boolean): DesktopButton {
  if (phone) return { show: false, enabled: false, via: null, title: null };
  const resting = RESTING.has(row.status);
  if (row.surface === 'local') {
    return resting
      ? { show: true, enabled: true, via: 'href', title: null }
      : { show: true, enabled: false, via: null, title: DESKTOP_BUSY_LOCAL_TITLE };
  }
  if (row.desktopOwned === true) return { show: true, enabled: true, via: 'href', title: null };
  const held = row.remoteQuestion === true || row.remotePlan === true || row.remoteReply === true;
  const offered = resting && row.stopState === undefined && row.processLive !== true && !held;
  return offered
    ? { show: true, enabled: true, via: 'handover', title: null }
    : { show: true, enabled: false, via: null, title: DESKTOP_BUSY_DASHBOARD_TITLE };
}

/**
 * C3 — the primary button follows the session's surface: Desktop for a `local` or `desktopOwned` session, Dashboard otherwise, and Dashboard is promoted when
 * C2 disables the Desktop the surface picked. Phone-blind on purpose (a phone hides Desktop; `openButtons` applies that), so the answer is about the row.
 */
export function primaryIsDesktop(row: DashboardRow): boolean {
  const surfacePicksDesktop = row.surface === 'local' || row.desktopOwned === true;
  return surfacePicksDesktop && desktopButton(row, false).enabled;
}

export type OpenTarget = 'desktop' | 'dashboard';
export interface OpenButton {
  label: string;
  target: OpenTarget;
}
export interface OpenButtons {
  primary: OpenButton;
  secondary: OpenButton | null;
}

/**
 * The verb a Dashboard primary carries (spec §7.5, rows 1–3): only a `dashboard`-surface session that is not `desktopOwned` can be answered from there. A
 * permission wait gets none — nothing can answer that dialog remotely — and a `local` session's wait can be answered only where it runs.
 */
function dashboardLabel(row: DashboardRow, state: JiraSessionState): string {
  if (row.surface !== 'dashboard' || row.desktopOwned === true) return 'Open in Dashboard';
  switch (state) {
    case 'answer':
      return 'Answer in Dashboard';
    case 'plan':
      return 'Review plan in Dashboard';
    case 'reply':
      return 'Reply in Dashboard';
    default:
      return 'Open in Dashboard';
  }
}

/**
 * An ended session's Reopen goes to the surface it was started on (`link.surface`), with no row to ask: Dashboard for a dashboard launch, Desktop for the rest
 * (a desktop launch, and a detected or manual link, which carry no surface). A phone has no Desktop, so it falls to Dashboard.
 */
function endedTarget(link: JiraLink, phone: boolean): OpenTarget {
  return link.surface === 'dashboard' || phone ? 'dashboard' : 'desktop';
}

/**
 * §7.5's first-match table, for one link. `wide` is Detail's live card, which has the width to spell the secondary out (`Open in Desktop`) where the deck card
 * and List row say `Desktop`. The buttons' ENABLED state is `desktopButton`'s, not this function's: a disabled Desktop keeps its label.
 *
 * - Ended (a history line, List's ended row): `Reopen` alone.
 * - A live link with no row (`starting`, or the dashboard has nothing for it): `Open in Dashboard` alone — with no row nothing says Desktop is safe.
 * - Primary is Desktop (C3): `Open in Desktop`, secondary Dashboard. A phone never gets here, so a phone's primary is always Dashboard and it has no secondary.
 * - Otherwise Dashboard, with its verb for an answer, a plan or a reply, and Desktop as the secondary.
 */
export function openButtons(link: JiraLink, row: DashboardRow | null, state: JiraSessionState, opts: { phone: boolean; wide: boolean }): OpenButtons {
  if (state === 'ended' || link.endedAt !== null) {
    return { primary: { label: 'Reopen', target: endedTarget(link, opts.phone) }, secondary: null };
  }
  if (row === null) return { primary: { label: 'Open in Dashboard', target: 'dashboard' }, secondary: null };
  if (!opts.phone && primaryIsDesktop(row)) {
    return {
      primary: { label: 'Open in Desktop', target: 'desktop' },
      secondary: { label: opts.wide ? 'Open in Dashboard' : 'Dashboard', target: 'dashboard' }
    };
  }
  return {
    primary: { label: dashboardLabel(row, state), target: 'dashboard' },
    secondary: opts.phone ? null : { label: opts.wide ? 'Open in Desktop' : 'Desktop', target: 'desktop' }
  };
}

/** One link as `GET /api/jira/sessions` carries it: the link, its derived state, the dashboard's row for it, and when this server first saw it in that state. */
export type SessionLink = JiraSessionsPayload['links'][number];

/**
 * A ticket's sessions for Detail (spec §7.3), split into the two lists it draws and each ordered newest first: the live ones by `startedAt`, the ended ones by
 * `endedAt` (a history reads from the most recent end backwards). A re-attached session (C5) keeps its original `startedAt`, so it stays where it began rather
 * than jumping to the top on every resume. Ties keep the payload's order, which is the store's, so two equal instants do not swap between polls.
 */
export function ticketSessions(key: string, payload: JiraSessionsPayload | null): { live: SessionLink[]; ended: SessionLink[] } {
  const mine = (payload?.links ?? []).filter((l) => l.key === key);
  const at = (iso: string | null): number => {
    const ms = iso === null ? NaN : Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
  };
  const newest = (field: 'startedAt' | 'endedAt') => (a: SessionLink, b: SessionLink) => at(b[field]) - at(a[field]);
  return {
    live: mine.filter((l) => l.endedAt === null).sort(newest('startedAt')),
    ended: mine.filter((l) => l.endedAt !== null).sort(newest('endedAt'))
  };
}

/** `7f3c…a91e` — the first and last four of a session id, which is what a person matches against the dashboard's own list. A short id is returned whole. */
export function shortSessionId(id: string): string {
  return id.length <= 9 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** How long a session ran, `startedAt` → `endedAt`: `elapsedSince`'s ladder, with its `now` (under a minute) spelled `<1m` because a duration is not "now". */
export function sessionDuration(link: Pick<JiraLink, 'startedAt' | 'endedAt'>): string | null {
  if (link.endedAt === null) return null;
  const end = Date.parse(link.endedAt);
  if (Number.isNaN(end)) return null;
  const span = elapsedSince(link.startedAt, end);
  return span === 'now' ? '<1m' : span;
}

/** The "linked how" tag on a card (spec §7.3): Run ▾ made it, a branch name matched it, or somebody linked it by hand. */
export function linkedHow(how: JiraLink['how']): string {
  return how === 'run' ? 'started by Run' : how === 'branch' ? 'found by its branch' : 'linked by hand';
}

/** Where a link was started or runs, for the card's `Where` line and a history line's surface; `null` when nothing says. */
export function surfaceWord(link: JiraLink, row: DashboardRow | null): string | null {
  if (row !== null) {
    if (row.desktopOwned === true) return 'Desktop';
    if (row.surface === 'local') return 'Terminal or app';
    if (row.surface === 'dashboard') return 'Dashboard';
    if (row.surface === 'cloud') return 'Cloud';
  }
  return link.surface === 'desktop' ? 'Desktop' : link.surface === 'dashboard' ? 'Dashboard' : null;
}
