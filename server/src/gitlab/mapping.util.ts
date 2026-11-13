import { keysInBranch } from '../../../shared/jira-branch';
import type { GitlabPipeline } from '../../../shared/types';
import { runGit } from '../git-run.util';
import { parseGitRemote, remoteOnSite } from './remote.util';

/**
 * One GitLab project the poller reads. `repo` is the basename of the first `jira.json` path that resolved to it, for messages only. `repos` is the full
 * list: per Jira project key, EVERY `jira.json` path under that key whose origin resolved here, in the file's own (already normalised) spelling — the one
 * review dispatch compares (spec §5.2 "Review candidates"). Per key and not flat, because `PAY`'s checkout of a project is not a candidate for `OPS`.
 */
export type GitlabProjectTarget = { path: string; repo: string; jiraKeys: string[]; repos: Record<string, string[]> };

/**
 * What mapping the configured Jira repos found. `foundHosts` are the hosts of remotes that parsed but are not on the site (so Settings can say "your repos
 * are on github.com, not here"); `originFailures` are basenames whose `origin` could not be read or parsed. Only basenames and hosts: a remote can carry a
 * PAT in its userinfo, and `parseGitRemote` has already dropped it, so nothing here can leak one.
 */
export type GitlabMapping = { projects: GitlabProjectTarget[]; foundHosts: string[]; originFailures: string[] };

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p;

const gitReadOrigin = (repoPath: string): Promise<string | null> => runGit(['-C', repoPath, 'remote', 'get-url', 'origin']);

/**
 * Resolve `{ JIRA_KEY: [repo paths] }` to the GitLab projects those repos' `origin` remotes name on `site`. Origins are read concurrently. Two Jira keys
 * pointing at one repo, or two checkouts of one project, collapse to one target carrying both keys — one project is polled once.
 */
export async function resolveGitlabProjects(
  repos: Record<string, string[]>,
  site: string,
  readOrigin: (repoPath: string) => Promise<string | null> = gitReadOrigin
): Promise<GitlabMapping> {
  const reads: { jiraKey: string; repoPath: string }[] = [];
  for (const [jiraKey, paths] of Object.entries(repos)) for (const repoPath of paths) reads.push({ jiraKey, repoPath });

  const origins = await Promise.all(reads.map((r) => readOrigin(r.repoPath)));

  const byPath = new Map<string, { repo: string; keys: Set<string>; repos: Record<string, string[]> }>();
  const hosts = new Set<string>();
  const failures = new Set<string>();
  reads.forEach((r, i) => {
    const raw = origins[i];
    const remote = raw === null ? null : parseGitRemote(raw);
    if (remote === null) {
      failures.add(baseName(r.repoPath));
      return;
    }
    if (!remoteOnSite(remote, site)) {
      hosts.add(remote.host);
      return;
    }
    const entry = byPath.get(remote.path) ?? { repo: baseName(r.repoPath), keys: new Set<string>(), repos: {} };
    entry.keys.add(r.jiraKey);
    const listed = (entry.repos[r.jiraKey] ??= []);
    if (!listed.includes(r.repoPath)) listed.push(r.repoPath);
    byPath.set(remote.path, entry);
  });

  const projects = [...byPath.entries()]
    .map(([path, e]) => ({ path, repo: e.repo, jiraKeys: [...e.keys].sort(), repos: e.repos }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { projects, foundHosts: [...hosts].sort(), originFailures: [...failures].sort() };
}

/**
 * The ticket keys an MR carries, from its source branch and its title. It reuses `keysInBranch` rather than a pattern of its own because an MR and a Jira
 * session must agree on which ticket a branch belongs to (spec §6.2): `timify-1234-x` is never `TIMIFY-123`, `hotfix/timify-123` always is.
 */
export function mrKeys(sourceBranch: string, title: string, jiraKeys: readonly string[]): string[] {
  return [...new Set([...keysInBranch(sourceBranch, jiraKeys), ...keysInBranch(title, jiraKeys)])].sort();
}

/** Fold GitLab's pipeline status to the board's five (spec §6.3). Anything unrecognised is `none`: unknown must never read as green. */
export function foldPipeline(status: string | null | undefined): GitlabPipeline {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'running':
    case 'pending':
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'canceling':
      return 'running';
    case 'canceled':
      return 'canceled';
    default:
      return 'none';
  }
}

/** Fold an MR state: `locked` (mid-merge) is still open; anything GitLab adds later is `null` and its row is dropped rather than guessed at. */
export function foldMrState(state: string): 'opened' | 'merged' | 'closed' | null {
  if (state === 'opened' || state === 'locked') return 'opened';
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  return null;
}
