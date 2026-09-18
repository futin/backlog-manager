/**
 * The GitHub credential, and the one place this process reads it (task-45,
 * spec §5.6 and §11).
 *
 * **The token never leaves the server.** No route returns it, no payload
 * carries it, the client never sees it and the browser never talks to GitHub
 * at all — every call is board → this API → api.github.com. That is the exact
 * shape of CLAUDE.md's "The browser never talks to the dashboard", stated
 * again for the credential rather than assumed to be covered by it: the
 * dashboard rule is about an ORIGIN the browser must not reach, and this one
 * is about a SECRET that must not reach the browser. Neither implies the
 * other, and this app now has both.
 *
 * Read from the environment on every call, never cached, for the same reason
 * `isAllowedHost` re-reads `BM_ALLOWED_HOSTS` per request: a value read once at
 * boot is a value a test cannot change and an operator cannot fix without a
 * restart — and the poller's whole "armed only while a token is present" rule
 * is a question asked repeatedly, not once.
 */

/** The one spelling of the variable. Named here so nothing else greps for it. */
export const GITHUB_TOKEN_ENV = 'BM_GITHUB_TOKEN';

/**
 * The token, or `null` when there is none. Whitespace-only counts as none: a
 * `BM_GITHUB_TOKEN=` line in a `.env` is how a variable is unset in practice,
 * and an empty Authorization header is a 401 rather than the honest
 * `access: 'no-token'` the Trackers card exists to show.
 */
export function githubToken(): string | null {
  const raw = process.env[GITHUB_TOKEN_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}
