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

/** `owner/name`, GitHub's own allowed character set on each side. */
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo(.git)` and
 * `ssh://git@github.com/owner/repo.git` — the three shapes a clone actually
 * produces. Deliberately not a general URL parser: anything else is `null`,
 * which is the honest answer for a remote this app cannot connect through.
 */
export function parseGithubRemote(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;

  // scp-like: [user@]host:path
  const scp = /^(?:[^@/]+@)?github\.com:(.+)$/.exec(trimmed);
  const path = scp !== null ? scp[1] : httpsPath(trimmed);
  if (path === null) return null;

  const cleaned = path.replace(/\.git$/, '').replace(/\/+$/, '');
  return REPO.test(cleaned) ? cleaned : null;
}

function httpsPath(url: string): string | null {
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/(.+)$/.exec(url);
  return m === null ? null : m[1];
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
