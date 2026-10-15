import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as gitRun from '../server/src/git-run.util';
import { __gitSpawnCount, __resetGitDateMemo, lastCommitDates } from '../server/src/items/git-dates.util';

/**
 * Real temp repos, not a stubbed `execFileSync`: what's under test is mostly
 * git's own output contract — `log` ordering, `--relative` from a subdirectory,
 * `core.quotePath=false`, which files a merge lists.
 */

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bm-git-dates-'));
  git(dir, 'init', '-q', '.');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  // Keeps a developer's global signing config from prompting mid-test.
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/** Takes a repo-relative POSIX path. */
function write(root: string, rel: string, text: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

function headDate(root: string): string {
  return execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: root, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  __resetGitDateMemo();
});

describe('lastCommitDates', () => {
  it('reports the newest commit that touched a file, not the oldest', async () => {
    const root = repo();
    write(root, 'backlog/bugs/open/bug-1.md', 'first\n');
    commit(root, 'one');
    const first = headDate(root);

    write(root, 'backlog/bugs/open/bug-1.md', 'second\n');
    commit(root, 'two');
    const second = headDate(root);

    // Guards the fixture: same-second commits would pass for the wrong reason.
    expect(second >= first).toBe(true);
    expect((await lastCommitDates(root)).get('backlog/bugs/open/bug-1.md')).toBe(second);
  });

  it('reports every file a single commit touched', async () => {
    const root = repo();
    write(root, 'backlog/bugs/open/bug-1.md', 'a\n');
    write(root, 'backlog/tasks/open/task-1.md', 'b\n');
    commit(root, 'both');
    const date = headDate(root);

    const map = await lastCommitDates(root);
    expect(map.get('backlog/bugs/open/bug-1.md')).toBe(date);
    expect(map.get('backlog/tasks/open/task-1.md')).toBe(date);
  });

  it('keys paths relative to the registered directory when it is a repo subdirectory', async () => {
    const root = repo();
    write(root, 'sub/backlog/bugs/open/bug-1.md', 'a\n');
    commit(root, 'one');
    const date = headDate(root);

    // A monorepo package registers its own directory; repo-root-relative keys
    // would match nothing and read as "this project has no history".
    const map = await lastCommitDates(join(root, 'sub'));
    expect(map.get('backlog/bugs/open/bug-1.md')).toBe(date);
    expect(map.has('sub/backlog/bugs/open/bug-1.md')).toBe(false);
  });

  it('reports a non-ASCII filename as raw UTF-8, not octal-escaped', async () => {
    const root = repo();
    write(root, 'backlog/bugs/open/bug-2-café.md', 'a\n');
    commit(root, 'one');

    expect((await lastCommitDates(root)).get('backlog/bugs/open/bug-2-café.md')).toBe(headDate(root));
  });

  it('omits a file that exists on disk but was never committed', async () => {
    const root = repo();
    write(root, 'backlog/bugs/open/bug-1.md', 'a\n');
    commit(root, 'one');
    write(root, 'backlog/bugs/open/bug-2.md', 'uncommitted\n');

    const map = await lastCommitDates(root);
    expect(map.has('backlog/bugs/open/bug-1.md')).toBe(true);
    // A just-captured item's `created` is the honest answer; inventing a date
    // here would be worse than the absence.
    expect(map.has('backlog/bugs/open/bug-2.md')).toBe(false);
  });

  it('resolves a file whose only edit landed through a --no-ff merge', async () => {
    const root = repo();
    write(root, 'backlog/bugs/open/bug-1.md', 'base\n');
    commit(root, 'base');
    const main = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    git(root, 'checkout', '-q', '-b', 'backlog/bug-2');
    write(root, 'backlog/bugs/open/bug-2.md', 'on a branch\n');
    commit(root, 'work');
    const branchDate = headDate(root);

    git(root, 'checkout', '-q', main);
    git(root, 'merge', '--no-ff', '--no-edit', '-q', 'backlog/bug-2');

    // `backlog-orchestrate`'s exact shape. A merge lists no files under
    // `--name-only`, so if history simplification pruned the branch commit
    // every orchestrated item would look untouched since it was created.
    expect((await lastCommitDates(root)).get('backlog/bugs/open/bug-2.md')).toBe(branchDate);
  });

  it('returns an empty map for a directory that is not a git repository', async () => {
    // A project kept outside git is supported, not an error — and a throw here
    // would take every other project's board down with it.
    const plain = mkdtempSync(join(tmpdir(), 'bm-git-dates-plain-'));
    expect((await lastCommitDates(plain)).size).toBe(0);
  });

  it('returns an empty map for a path that does not exist at all', async () => {
    expect((await lastCommitDates(join(tmpdir(), 'bm-git-dates-absent-does-not-exist'))).size).toBe(0);
  });
});

describe('lastCommitDates memo', () => {
  it('does not shell out twice when nothing in the repo changed', async () => {
    const root = repo();
    write(root, 'backlog/bugs/open/bug-1.md', 'a\n');
    commit(root, 'one');

    const first = await lastCommitDates(root);
    const spawns = __gitSpawnCount();
    const second = await lastCommitDates(root);

    expect(__gitSpawnCount()).toBe(spawns);
    expect(second).toBe(first);
  });

  it('drops its in-flight entry when the shared spawn REJECTS, so the next call spawns again', async () => {
    // `compute` does not reject today — `runGit` turns every failure into null —
    // so the only way to reach the rejection arm is to make the seam itself
    // throw. What this pins is the entry's lifetime ("removed when its spawn
    // settles, success or failure"): an entry that survived a rejection would
    // hand every later call at this fingerprint the same failed promise, for
    // good, because nothing else removes it and nothing memoised a result.
    const root = repo();
    write(root, 'backlog/bugs/open/bug-1.md', 'a\n');
    commit(root, 'one');

    const spy = jest.spyOn(gitRun, 'runGit').mockRejectedValueOnce(new Error('spawn exploded'));
    try {
      const before = __gitSpawnCount();
      const burst = await Promise.allSettled([lastCommitDates(root), lastCommitDates(root)]);
      // Both callers shared the one rejected spawn and both saw its failure.
      expect(__gitSpawnCount() - before).toBe(1);
      expect(burst.map((r) => r.status)).toEqual(['rejected', 'rejected']);

      // The entry is gone: this call spawns for itself (the mock's one rejection is
      // spent, so it reaches the real git) and answers a real map.
      const again = await lastCommitDates(root);
      expect(__gitSpawnCount() - before).toBe(2);
      expect(again.get('backlog/bugs/open/bug-1.md')).toBe(headDate(root));
    } finally {
      spy.mockRestore();
    }
  });

  it('recomputes after a new commit lands', async () => {
    const root = repo();
    write(root, 'backlog/bugs/open/bug-1.md', 'a\n');
    commit(root, 'one');
    await lastCommitDates(root);

    write(root, 'backlog/bugs/open/bug-1.md', 'b\n');
    commit(root, 'two');

    // A hit here would serve a date from before work that has already landed.
    expect((await lastCommitDates(root)).get('backlog/bugs/open/bug-1.md')).toBe(headDate(root));
  });

  it('recomputes when a file is committed that the previous call never saw', async () => {
    const root = repo();
    write(root, 'backlog/bugs/open/bug-1.md', 'a\n');
    commit(root, 'one');
    expect((await lastCommitDates(root)).has('backlog/bugs/open/bug-2.md')).toBe(false);

    write(root, 'backlog/bugs/open/bug-2.md', 'b\n');
    commit(root, 'two');
    expect((await lastCommitDates(root)).has('backlog/bugs/open/bug-2.md')).toBe(true);
  });
});
