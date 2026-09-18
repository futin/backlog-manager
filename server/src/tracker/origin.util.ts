import { execFileSync } from 'node:child_process';

/**
 * The GitHub repo a files project's `origin` points at, read from git PER
 * REQUEST (task-45, spec §5.6) — the Trackers card's "here is the exact
 * command to connect this project" row.
 *
 * Per request and memoised nowhere, the way `uncommitted.util.ts` reads git
 * per request, and explicitly NOT joining `git-dates.util.ts`'s memo one file
 * over: that memo is keyed on the mtimes of `index` and `logs/HEAD`, and
 * neither of them moves when somebody adds or re-points a remote. A remote is
 * exactly the kind of fact those keys do not cover, so a value cached against
 * them would be stale in the one case that matters.
 *
 * Every failure degrades to `null` — no git, not a repo, no `origin`, a remote
 * that is not GitHub. This feeds a suggestion, not a fact about the project,
 * and a card that showed a wrong connect command would be worse than one that
 * shows none.
 */

/** `owner/name`, GitHub's own allowed character set on each side — the same
 *  `REPO_SHAPE` the skill validates with, and the same shape the server
 *  re-checks before interpolating a repo into an `api.github.com` path. */
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The two shapes git writes for a remote, in the SAME grammar
 * `parseOriginRepo` in `skills/backlog/tools/backlog.mjs` uses, character for
 * character:
 *
 *   git@github.com:owner/repo.git        the scp-like shape `git clone git@…` produces
 *   https://github.com/owner/repo.git    the shape `git clone https://…` produces, `.git` and trailing slash optional
 *
 * Two implementations of one rule, and deliberately so: a skill's `tools/` is
 * installed as a standalone copy with no path back into `server/`, exactly as
 * `labels.ts` describes for the label set. The agreement is enforced the same
 * way it is there — mechanically, from the outside. `test/tracker-origin.test.ts`
 * runs the SKILL's own parser (in a node child, over a file URL) against this
 * one on a shared table of remotes and asserts every answer matches, so the
 * two cannot drift without a red test. Before that guard existed they already
 * had: the skill accepted `www.github.com` and any URL scheme and this file
 * accepted neither, so the Trackers card stayed silent about a project
 * `connect` would have connected.
 */
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/;
const SCP_LIKE = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/;

export function parseGithubRemote(url: string): string | null {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (trimmed === '') return null;

  const match = URL_LIKE.exec(trimmed) ?? SCP_LIKE.exec(trimmed);
  if (match === null) return null;

  // `www.` is the one host alias, because a hand-typed clone URL occasionally
  // carries it and it names the same repository. Anything else — GitLab, an
  // enterprise host — is `null`: guessing `owner/repo` off a different host
  // would name a repository that does not exist.
  const host = match[1].toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') return null;

  // Leading slash (an `ssh://` path carries one), then trailing slashes, then
  // `.git` — that ORDER, because `…/owner/repo.git/` only reduces correctly
  // when the slash goes first. A path with more than two segments fails the
  // shape check rather than being truncated to its first two: truncating would
  // invent a repository name out of a URL that never named one.
  const repo = match[2]
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  return REPO.test(repo) ? repo : null;
}

/** The project's `origin` as `owner/name`, or `null`. Synchronous and bounded,
 *  like every other git read in a request path here. */
export function originRepo(projectPath: string): string | null {
  let out: string;
  try {
    out = execFileSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
  return parseGithubRemote(out);
}
