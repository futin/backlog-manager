import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { runGit } from '../git-run.util';

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
/**
 * The one git spawn currently running for a project, keyed like `memo` and
 * stamped with the fingerprint it was started under (#277). A burst of N
 * `/api/items` requests landing while a slow git is still running must spawn
 * ONE git, not N — otherwise the memo that exists to make this read cheap
 * would be bypassed in exactly the situation (a slow repository) where it
 * matters most, and the pile-up would be the server's own doing. A caller
 * whose fingerprint differs from the pending one is NOT served it: that spawn
 * started before whatever moved the fingerprint, so its answer may already be
 * stale. The entry is removed when its spawn settles, success or failure, so a
 * failed read is retried by the next call instead of being handed out again.
 *
 * This sharing is `lastCommitDates`' alone. `uncommittedItemPaths` and
 * `originRepo` deliberately have none (CLAUDE.md: per request, memoised
 * nowhere) — the answer they give is about the working tree or a remote, and
 * a request that arrives after an edit must not be handed a read that began
 * before it.
 */
interface Pending {
  fingerprint: string;
  promise: Promise<Map<string, string>>;
}
const inflight = new Map<string, Pending>();
let spawns = 0;

/** Test-only: cases reuse temp paths, so the memo has to be droppable. */
export function __resetGitDateMemo(): void {
  memo.clear();
  inflight.clear();
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
 * project's setup. Async and time-bounded (`runGit`) because this runs inside
 * a request and a slow repository must not freeze the process (#277).
 */
function run(cwd: string, args: string[]): Promise<string | null> {
  spawns++;
  return runGit(args, { cwd, maxBuffer: 32 * 1024 * 1024 });
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
 * `scanProject` runs on both `/api/items` and `/api/projects`. A FAILED read
 * (timeout, not a repo) is not memoised: it answers the empty map, which every
 * caller reads as "fall back to `created`", and the next call asks again — so
 * a repository that was merely slow once is not pinned to the fallback until a
 * commit moves the fingerprint.
 */
export async function lastCommitDates(projectPath: string): Promise<Map<string, string>> {
  const key = fingerprint(projectPath);
  if (key === null) return compute(projectPath, null);

  const hit = memo.get(projectPath);
  if (hit !== undefined && hit.fingerprint === key) return hit.dates;
  const pending = inflight.get(projectPath);
  if (pending !== undefined && pending.fingerprint === key) return pending.promise;

  const entry: Pending = { fingerprint: key, promise: compute(projectPath, key) };
  inflight.set(projectPath, entry);
  // Dropped when the spawn settles, success OR failure. `compute` does not
  // reject today (`run` turns every failure into null), but the entry's
  // lifetime is the invariant — a rejection that left it in place would pin a
  // failing promise to this fingerprint for good — so the rejection arm is
  // handled here rather than leaning on that. Handling it also marks THIS
  // derived chain handled; the callers awaiting `entry.promise` still see the
  // rejection themselves. Dropped only if still ours: a later call under a
  // newer fingerprint may already have replaced it.
  const drop = (): void => {
    if (inflight.get(projectPath) === entry) inflight.delete(projectPath);
  };
  void entry.promise.then(drop, drop);
  return entry.promise;
}

async function compute(projectPath: string, key: string | null): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  const out = await run(projectPath, ['-c', 'core.quotePath=false', 'log', '--format=%x00%cI', '--name-only', '--relative', '--', 'backlog']);
  if (out === null) return dates;

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

  if (key !== null) memo.set(projectPath, { fingerprint: key, dates });
  return dates;
}
