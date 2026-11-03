import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * The main checkout a session's `projectPath` belongs to, for branch detection (Jira sessions §5): a session launched in a ticket's linked worktree
 * (`<repo>/.worktrees/PAY-151-x`) has a launch cwd that is never the path Setup maps, so detection resolves it back to the repo it was cut from.
 *
 * A plain read of `<path>/.git`, never a git spawn — the server spawns git only through `runGit` (async, bounded) and only to read, and this question does not
 * need git at all: in a main checkout `.git` is a directory, in a linked worktree it is a one-line FILE, `gitdir: <main>/.git/worktrees/<name>`. A relative
 * `gitdir:` (git writes them when `worktree.useRelativePaths` is on) resolves against `path`.
 *
 * `path` itself when `.git` is a directory; the main checkout `<x>` when it is a worktree file; `null` for anything else — a missing or unreadable `.git`, a
 * file that is not a `gitdir:` line, a `gitdir:` that is not under `<x>/.git/worktrees/` (a submodule's `.git/modules/…`, a bare repo's worktree). `null` is
 * "cannot say", never "is not a repo": the caller then compares the path as given and nothing more.
 */
export function mainCheckoutOf(path: string): string | null {
  const dotGit = resolve(path, '.git');
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) return resolve(path);
    if (!stat.isFile()) return null;
    const line = readFileSync(dotGit, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('gitdir:'));
    if (line === undefined) return null;
    const gitdir = resolve(path, line.slice('gitdir:'.length).trim());
    const worktrees = dirname(gitdir);
    const gitDir = dirname(worktrees);
    if (basename(worktrees) !== 'worktrees' || basename(gitDir) !== '.git') return null;
    return dirname(gitDir);
  } catch {
    return null;
  }
}
