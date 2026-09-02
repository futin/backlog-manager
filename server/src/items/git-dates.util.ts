import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * When each item file was last committed — the middle rung of "last touched".
 *
 * `updated:` has one writer (`backlog.mjs start`/`stop`) but the file has
 * several editors: a groom session that writes Cause/Fix without running
 * `start --as groom` leaves the frontmatter silent, and staleness then falls
 * back to a months-old `created`. git already records every real edit, so
 * deriving beats asking sessions to remember.
 *
 * Committer date, not author date: the question is when the edit landed in the
 * tree the registry points at.
 */

interface Memo {
  fingerprint: string;
  dates: Map<string, string>;
}
const memo = new Map<string, Memo>();
let spawns = 0;

/** Test-only: cases reuse temp paths, so the memo has to be droppable. */
export function __resetGitDateMemo(): void {
  memo.clear();
  spawns = 0;
}

/** Test-only: proves a memo hit doesn't shell out. */
export function __gitSpawnCount(): number {
  return spawns;
}

/**
 * null for every failure alike — not a repo, no git installed, timeout,
 * oversized output. All degrade to the `created` fallback that was the only
 * rung before this module; throwing would 500 every project's board over one
 * project's setup. Bounded because this runs synchronously inside a request.
 */
function run(cwd: string, args: string[]): string | null {
  spawns++;
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
}

/**
 * Nearest `.git` walking up — same walk the skills do, since a registered
 * project need not be a repo root. Read off the filesystem rather than via
 * `git rev-parse` because a memo hit that still spawns git has already paid
 * the dominant cost of a miss.
 *
 * A `.git` file is followed to its `gitdir:` and deliberately not on to
 * `commondir`: a linked worktree's own index and reflog are what move when
 * work happens in that tree.
 */
function resolveGitDir(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, '.git');
    try {
      if (statSync(candidate).isDirectory()) return candidate;
      const pointer = readFileSync(candidate, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (pointer !== null) return resolve(dir, pointer[1].trim());
    } catch {
      // No `.git` here; keep climbing.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Cheap stand-in for "could any commit date here have changed" — both files
 * are rewritten by every commit, merge, amend, rebase and checkout.
 *
 * Either can be absent (reflogs disabled, a repo with no index yet). When
 * BOTH are, there is no key that can move, and a memo keyed on something
 * constant is the stale cache this module exists to avoid — so the caller
 * recomputes instead.
 */
function fingerprint(cwd: string): string | null {
  const dir = resolveGitDir(cwd);
  if (dir === null) return null;

  const parts = ['index', 'logs/HEAD'].map((rel) => {
    try {
      return `${rel}:${statSync(join(dir, rel)).mtimeMs}`;
    } catch {
      return `${rel}:none`;
    }
  });
  if (parts.every((p) => p.endsWith(':none'))) return null;
  return `${dir} ${parts.join(' ')}`;
}

/** NUL can't occur in a path, so it separates dates from filenames unambiguously. */
const NUL = '\u0000';

/**
 * Commit dates under `<projectPath>/backlog`, keyed by POSIX path relative to
 * `projectPath` — `--relative`, because a monorepo package registers its own
 * directory and repo-root-relative keys would match nothing the scan builds.
 * `core.quotePath=false` for the same reason: the default octal-escapes
 * non-ASCII filenames.
 *
 * Memoised because this costs 84–396ms per project (~1.0s for five) and
 * `scanProject` runs on both `/api/items` and `/api/projects`.
 */
export function lastCommitDates(projectPath: string): Map<string, string> {
  const key = fingerprint(projectPath);
  if (key !== null) {
    const hit = memo.get(projectPath);
    if (hit !== undefined && hit.fingerprint === key) return hit.dates;
  }

  const dates = new Map<string, string>();
  const out = run(projectPath, [
    '-c', 'core.quotePath=false',
    'log', '--format=%x00%cI', '--name-only', '--relative', '--', 'backlog'
  ]);

  if (out !== null) {
    let date = '';
    for (const line of out.split('\n')) {
      if (line === '') continue;
      if (line.startsWith(NUL)) {
        date = line.slice(NUL.length);
        continue;
      }
      // `log` walks newest-first, so first sighting is the last commit that
      // touched the path; overwriting would report each file's oldest date.
      if (date !== '' && !dates.has(line)) dates.set(line, date);
    }
  }

  if (key !== null) memo.set(projectPath, { fingerprint: key, dates });
  return dates;
}
