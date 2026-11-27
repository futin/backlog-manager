import type { DashboardRow, JiraLink } from './types';

/**
 * The session state a Jira page shows for one linked session (spec §6), derived — never stored — from the link and the dashboard's row for it. Pure, so the
 * server (which stamps `stateSince` on a change) and the client (which paints the badge and the Needs-you count) cannot disagree on what a row means.
 */
export type JiraSessionState = 'starting' | 'plan' | 'permission' | 'reply' | 'answer' | 'working' | 'quiet' | 'lost' | 'ended';

/**
 * Spec §6's table, read top to bottom, first match wins. Two deliberate readings of it:
 *
 * - **Lost contact sits above the row's own state.** §6 says the dashboard "did not answer this tick" and a live entry then keeps nothing but its place: the
 *   rows kept from the last good read are old, so a `working` row from then is not evidence of anything now, and a wait that has since been answered would
 *   keep shouting "needs you". `starting` and `ended` still win over it — neither depends on the dashboard.
 * - **Total.** The reconciler ends a link whose row has been `idle`/`incomplete` for 120 s, so a LIVE link whose row is either (with or without `quietSince`
 *   yet), or has no row while the dashboard answers, or carries a status this code has never heard of, is still on its clock or unknown: it reads Quiet, and
 *   Quiet is the one state that never counts toward the badge, so an unknown status cannot raise a false alarm.
 *
 * The three wait flags are read whatever `status` says — they are the row's own statement that a person is wanted, and the dashboard sets them on a session
 * it also reports as `question`.
 */
export function sessionState(link: JiraLink, row: DashboardRow | null, reachable: boolean): JiraSessionState {
  if (link.sessionId === null) return 'starting';
  if (link.endedAt !== null) return 'ended';
  if (!reachable) return 'lost';
  if (row === null) return 'quiet';
  if (row.remotePlan === true) return 'plan';
  if (row.permissionWait === true) return 'permission';
  if (row.remoteReply === true) return 'reply';
  if (row.status === 'question') return 'answer';
  if (row.status === 'working') return 'working';
  return 'quiet';
}

/**
 * Why a live Run still holds its key against the next Run, in the words both the dispatch's 409 (`<KEY> has a Run <phrase>`) and the disabled chip's title
 * (`a Run on <KEY> is <phrase>`) end with — one list, so the server and the client cannot word one state two ways.
 */
export type RunBlockPhrase = 'not seen by the dashboard' | 'waiting on you' | 'still working' | 'not quiet yet';

/**
 * The quiet-only Run gate (spec 2026-11-17-jira-quiet-run-gate-design.md, Design → One predicate): `null` when this link would let the next Run on its key
 * start, else the reason it will not, first match wins.
 *
 * A link yields only when ALL of: the reconciler has marked it quiet (`quietSince` — set on the first tick that reads a row neither `working` nor
 * `question`, at any age; only an ABSENT row waits out the 2-minute grace), the dashboard's latest good read carries a row for it, and `sessionState` reads that row as Quiet. The row requirement is what makes "every
 * unknown blocks" true. `quietSince` is persisted while the rows are memory only, so straight after a restart a link can carry `quietSince` with no row at all;
 * `sessionState` reads a null row as `quiet` (its totality rule, above) because for a BADGE "unknown" must never raise an alarm — but for a GATE it is the
 * opposite: a link the server knows nothing current about may be mid-turn, so it blocks. The same holds for a row that fell off a full 50-row list, which
 * leaves `quietSince` standing (the reconciler proves nothing from an absent row in a full list). An unreachable dashboard is `lost`, which blocks too.
 *
 * The states that want a person (`plan`, `permission`, `reply`, `answer`) block as `waiting on you`: a second Run there would start beside a session that is
 * only paused for an answer. `quiet` without `quietSince` yet — idle for less than one reconcile tick, or no row inside the grace — is `not quiet yet`.
 */
export function runBlockPhrase(link: JiraLink, row: DashboardRow | null, reachable: boolean): RunBlockPhrase | null {
  if (!reachable || row === null) return 'not seen by the dashboard';
  const state = sessionState(link, row, reachable);
  if (needsYou(state)) return 'waiting on you';
  if (state === 'working') return 'still working';
  if (state === 'quiet' && link.quietSince !== null) return null;
  return 'not quiet yet';
}

/** True when this is a LIVE `run` link that would let the next Run on its key start — `runBlockPhrase` is `null` for it. Other links never gate a Run. */
export function runYields(link: JiraLink, row: DashboardRow | null, reachable: boolean): boolean {
  return link.how === 'run' && link.endedAt === null && runBlockPhrase(link, row, reachable) === null;
}

/** The states that want a person — the Needs-you list and the rail badge count exactly these. */
export function needsYou(state: JiraSessionState): boolean {
  return state === 'plan' || state === 'permission' || state === 'reply' || state === 'answer';
}

/** The words the page shows for each state — spec §6 verbatim. */
export const STATE_LABEL: Record<JiraSessionState, string> = {
  starting: 'Starting…',
  plan: 'Waiting for plan approval',
  permission: 'Waiting for permission',
  reply: 'Waiting for a reply',
  answer: 'Waiting on your answer',
  working: 'Working',
  quiet: 'Quiet',
  lost: 'Lost contact',
  ended: 'Ended'
};

/** The `title` on a Quiet badge: `incomplete` is "your turn, recent and done" or "stalled" in the dashboard and the two cannot be told apart (spec §6). */
export const QUIET_TITLE = 'Turn finished or stalled — the dashboard cannot tell which';
