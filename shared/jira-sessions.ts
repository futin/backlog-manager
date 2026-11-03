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
 * - **Total.** The reconciler ends a link whose row is `idle`/`incomplete` past the 120 s grace, so a LIVE link whose row is either (with or without `quietSince`
 *   yet), or has no row while the dashboard answers, or carries a status this code has never heard of, is inside the grace or unknown: it reads Quiet, and
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
