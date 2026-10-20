/**
 * The Jira credentials, and the one place this process reads them (spec §6 Connection and §10; the shape of `server/src/tracker/token.util.ts`, restated for
 * three variables rather than one).
 *
 * **The token and the email never leave the server.** No route returns either, no payload carries them, no log line or URL contains them, and the browser
 * never talks to Jira — every call is board → this API → Jira. The status payload says `site`, `me.name` and `me.accountId` and nothing more. This is
 * `githubToken()`'s rule stated again for a second credential, not assumed to be covered by it: a secret that reaches the browser is a different failure from
 * an origin the browser must not reach, and this app now holds secrets for two services.
 *
 * Read from `process.env` on every call, never cached, for the reason `githubToken()` and `isAllowedHost` give: a value read once at boot is one a test
 * cannot change and an operator cannot fix without a restart, and the poller's "armed only while all three are present" rule is a question asked
 * repeatedly, not once. `jiraEnv` takes the environment as a parameter (defaulting to `process.env`) so a test can hand it an object and never touch the real
 * one; the default is still read at CALL time, which is what keeps the per-call property.
 *
 * Trimmed, and whitespace-only counts as absent: `BM_JIRA_TOKEN=` is how a variable is unset in practice (it is also how `test/helpers/env.ts` blanks the
 * three), and an empty basic-auth credential is a 401 rather than the honest `access: 'unconfigured'` the Connection card exists to show. When something is
 * missing the detail names the FIRST missing key in `site, email, token` order — one problem at a time, in the order an operator would set them.
 */

/** The one spelling of each variable. Named here so nothing else greps for them. */
export const JIRA_ENV = { site: 'BM_JIRA_SITE', email: 'BM_JIRA_EMAIL', token: 'BM_JIRA_TOKEN' } as const;

export type JiraEnv = { configured: true; site: string; email: string; token: string } | { configured: false; detail: string };

/**
 * A bare hostname: lower-cased dot-separated labels of letters, digits and `-`, at least two of them. The server always speaks `https://` and builds every
 * URL itself, so a scheme, a path, a port, a query or a space in the site would either build a wrong URL or — worse — a URL to another host. The check runs
 * on the lower-cased value, so the pattern needs no `i` flag.
 */
export function isJiraHostname(value: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value.toLowerCase());
}

export function jiraEnv(env: NodeJS.ProcessEnv = process.env): JiraEnv {
  const read = (key: string): string => {
    const raw = env[key];
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const site = read(JIRA_ENV.site).toLowerCase();
  const email = read(JIRA_ENV.email);
  const token = read(JIRA_ENV.token);
  if (site === '') return { configured: false, detail: `${JIRA_ENV.site} is not set` };
  if (email === '') return { configured: false, detail: `${JIRA_ENV.email} is not set` };
  if (token === '') return { configured: false, detail: `${JIRA_ENV.token} is not set` };
  if (!isJiraHostname(site)) {
    // Quote the value as given (trimmed, not lower-cased) so the operator sees the typo they made rather than our normalisation of it.
    return {
      configured: false,
      detail: `${JIRA_ENV.site} must be a hostname such as acme.atlassian.net (no scheme, path or port): ${read(JIRA_ENV.site)}`
    };
  }
  return { configured: true, site, email, token };
}

/** The one spelling of the variable that names the roots compose mounts into the container (spec §4). Exported, like `JIRA_ENV`, so `compose-env.test.ts` pins it. */
export const REPO_ROOTS_ENV = 'BM_REPO_ROOTS';

/**
 * The directories this server can see repositories under: `BM_REPO_ROOTS`, `:`-separated absolute paths, read per call and never cached (the rule `jiraEnv`
 * states). Compose sets it to its two read-only mounts, so Setup can say "not mounted into the board" for a mapped path outside both instead of the vaguer
 * "does not exist". Empty segments are dropped (`/a::` is `['/a']`) and unset or empty is `null` — a host-run API, where every path is visible and the
 * "not mounted" check does not apply.
 */
export function repoRoots(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env[REPO_ROOTS_ENV];
  const roots = (typeof raw === 'string' ? raw : '')
    .split(':')
    .map((root) => root.trim())
    .filter((root) => root !== '');
  return roots.length === 0 ? null : roots;
}
