/**
 * The GitLab credential pair, and the one place this process reads it (GitLab connection, spec §4).
 *
 * **The token never leaves the server.** No route returns it, no payload carries it, the client never sees it and the browser never talks to GitLab — every
 * call is board → this API → the configured site. The returned `detail` strings are written to be shown on the status payload, so none of them ever quotes
 * the token, and the malformed-site one does not quote the site either: a typo'd value is as likely to be a pasted URL with a credential in its userinfo as
 * a harmless hostname, and nothing here needs it echoed. This token is `read_api`; the `mr-review-loop` skill a session runs carries its OWN `api`-scoped
 * `GITLAB_TOKEN` from `~/.zshenv`, and the server's is never handed to a session.
 *
 * Read from the environment on every call, never cached — the rule `jiraEnv` and `githubToken` follow, for the same reason: a value read once at boot is a
 * value a test cannot change and an operator cannot fix without a restart, and the poller's "armed only while configured" question is asked repeatedly.
 *
 * Both variables or neither. One without the other reads as not configured and does NOT flag the site as malformed: a half-set pair is the ordinary
 * mid-setup state, and `malformedSite` is reserved for the one case where the operator has a site and it cannot be used (a scheme, a path or a port would
 * build a wrong URL, or a URL to another host — the same reasoning `isJiraHostname` documents, whose check this reuses rather than copies).
 */
import { isJiraHostname } from '../jira/env.util';

/** The one spelling of each variable. Named here so nothing else greps for them. */
export const GITLAB_ENV = { site: 'BM_GITLAB_SITE', token: 'BM_GITLAB_TOKEN' } as const;

export type GitlabEnv = { configured: true; site: string; token: string } | { configured: false; malformedSite: boolean; detail: string };

const NOT_SET_DETAIL = `set ${GITLAB_ENV.site} and ${GITLAB_ENV.token} in .env and restart`;
const MALFORMED_SITE_DETAIL = `${GITLAB_ENV.site} must be a hostname, like gitlab.example.com`;

export function gitlabEnv(env: NodeJS.ProcessEnv = process.env): GitlabEnv {
  const read = (key: string): string => {
    const raw = env[key];
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const site = read(GITLAB_ENV.site).toLowerCase();
  const token = read(GITLAB_ENV.token);
  if (site === '' || token === '') return { configured: false, malformedSite: false, detail: NOT_SET_DETAIL };
  if (!isJiraHostname(site)) return { configured: false, malformedSite: true, detail: MALFORMED_SITE_DETAIL };
  return { configured: true, site, token };
}
