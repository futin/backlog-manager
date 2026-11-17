/**
 * A session id as the Jira routes accept it. The repo has no validator of its own for a dashboard session id (they are minted by the dashboard and compared,
 * never parsed here), and a UUID-only check would refuse the short ids the suites seed, so this is the shape that makes the id safe to compare, name in a
 * sentence and put into the dashboard's stop URL: 1–128 characters of `[A-Za-z0-9._-]` whose FIRST is alphanumeric, so `.` and `..` can never become a path
 * segment there (`encodeURIComponent` leaves dots alone) and no separator gets in. Whether the id is LIVE on the key is the service's 409, not this check's.
 *
 * Lives in `jira/` (task 4 moved it from `agents/jira-agents.controller.ts`, which re-exports it) because the draft route and the draft store need it and the
 * edge between the modules runs agents → jira only.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}
