/**
 * Parse a git remote URL into the parts the GitLab connection compares: host, port, scheme and namespace path.
 *
 * Modelled on `parseGithubRemote` (`tracker/origin.util.ts`) but differs in three deliberate ways: the port is KEPT (an https remote on `:8443` is a
 * different server than the one `BM_GITLAB_SITE` names), nested namespaces are KEPT (`development/backend/microservice` is a legal GitLab path, GitHub's
 * two segments are not), and `www.` is never stripped (`www.gitlab.timify.io` and `gitlab.timify.io` are different hosts, the latter answers a 301).
 *
 * A remote's host is only ever compared against the configured site, never dialled (spec §6.1).
 */
export type ParsedRemote = { host: string; port: number | null; scheme: 'https' | 'http' | 'ssh' | 'scp'; path: string };

// Userinfo is matched but never captured: a remote on this machine can be `https://oauth2:<PAT>@…` (spec §4), and what is never stored cannot leak.
const URL_LIKE = /^(https|http|ssh):\/\/(?:[^@/]*@)?([^/:@]+)(?::(\d+))?\/(.+)$/i;
const SCP_LIKE = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/;

function cleanPath(raw: string): string {
  // Leading slashes first (an `ssh://` path carries one), then trailing slashes, then `.git` — that order, because `…/repo.git/` only reduces when the
  // slash goes first.
  return raw.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
}

export function parseGitRemote(url: string): ParsedRemote | null {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (trimmed === '') return null;

  const urlMatch = URL_LIKE.exec(trimmed);
  if (urlMatch !== null) {
    const path = cleanPath(urlMatch[4]);
    if (path === '') return null;
    return {
      host: urlMatch[2].toLowerCase(),
      port: urlMatch[3] === undefined ? null : Number(urlMatch[3]),
      scheme: urlMatch[1].toLowerCase() as 'https' | 'http' | 'ssh',
      path
    };
  }

  const scp = SCP_LIKE.exec(trimmed);
  if (scp === null) return null;
  const path = cleanPath(scp[2]);
  if (path === '') return null;
  return { host: scp[1].toLowerCase(), port: null, scheme: 'scp', path };
}

/**
 * Whether a remote lives on the configured GitLab site. ssh/scp remotes on any port qualify (an ssh port is not the https port), https qualifies with no
 * port or 443, and `http://` never does: the server only speaks https to the site, so a plain-http remote names a different service (spec §6.1).
 */
export function remoteOnSite(remote: ParsedRemote, site: string): boolean {
  if (remote.host !== site.trim().toLowerCase()) return false;
  if (remote.scheme === 'ssh' || remote.scheme === 'scp') return true;
  if (remote.scheme === 'https') return remote.port === null || remote.port === 443;
  return false;
}

/** The `:id` GitLab's REST API accepts for a project addressed by its namespace path: the whole path, slashes percent-encoded. */
export function gitlabProjectId(path: string): string {
  return encodeURIComponent(path);
}
