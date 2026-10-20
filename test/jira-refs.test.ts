import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOTS_ENV, repoRoots } from '../server/src/jira/env.util';
import { readRepoRefs, readWorktrees } from '../server/src/jira/refs.util';
import type { JiraRefBranch, JiraRepoRefs } from '../shared/types';

/**
 * Jira repo/branch, Task 3 (spec §4 and §5.2) — the server's reads of a mapped repo's branches and worktrees, against REAL git in a temp directory: a bare
 * origin, a clone, a second clone that pushes behind the first one's back, and a linked worktree. A mocked `runGit` would pin the argument list and prove
 * nothing about what git answers, which is the whole job here. The fixture's tmp root is realpath'd up front because macOS reports `/var/...` as
 * `/private/var/...` from `rev-parse --show-toplevel`, and the server compares realpaths.
 */

const AUTHOR = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };

/** Runs git in `cwd`; `date` pins both the author and the committer date so branch order is a fact of the fixture, not of the clock. */
function git(cwd: string, args: string[], date?: string): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...AUTHOR, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** One empty-tree commit on the checked-out branch of `cwd`. */
function commit(cwd: string, message: string, date: string): void {
  git(cwd, ['commit', '--allow-empty', '-m', message], date);
}

let root: string;
let origin: string;
let clone: string;
let linked: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bm-jira-refs-')));
  origin = join(root, 'origin.git');
  clone = join(root, 'clone');
  linked = join(root, 'linked');
  const other = join(root, 'other');

  git(root, ['init', '--bare', '-b', 'develop', origin]);
  git(root, ['clone', origin, clone]);
  git(clone, ['checkout', '-B', 'develop']);
  commit(clone, 'base', '2026-01-01T10:00:00Z');
  git(clone, ['push', '-u', 'origin', 'develop']);
  git(clone, ['remote', 'set-head', 'origin', 'develop']);

  // feature/timify-123-a: local AND origin, upstream set, the local copy one commit behind (pushed from `other`, fetched here).
  git(clone, ['branch', '--no-track', 'feature/timify-123-a', 'develop']);
  git(clone, ['push', '-u', 'origin', 'feature/timify-123-a']);
  // feature/other: not a ticket branch, upstream set, also behind — the `%(upstream:track)` path.
  git(clone, ['branch', '--no-track', 'feature/other', 'develop']);
  git(clone, ['push', '-u', 'origin', 'feature/other']);
  // plain: not a ticket branch, on both sides, NO upstream — sync stays null by design.
  git(clone, ['branch', '--no-track', 'plain', 'develop']);
  git(clone, ['push', 'origin', 'plain']);
  // timify-123-c: a ticket branch on both sides with no upstream, the local copy one commit ahead.
  git(clone, ['checkout', '-b', 'timify-123-c', 'develop', '--no-track']);
  commit(clone, 'c1', '2026-01-02T10:00:00Z');
  git(clone, ['push', 'origin', 'timify-123-c']);
  commit(clone, 'c2', '2026-01-03T10:00:00Z');
  // feature/timify-1234: a longer number, so NOT ticket 123's.
  git(clone, ['checkout', '-b', 'feature/timify-1234', 'develop', '--no-track']);
  commit(clone, 'x', '2026-01-09T10:00:00Z');
  git(clone, ['checkout', 'develop']);

  git(root, ['clone', origin, other]);
  git(other, ['checkout', '-B', 'feature/timify-123-a', 'origin/feature/timify-123-a']);
  commit(other, 'a1', '2026-01-04T10:00:00Z');
  git(other, ['push', 'origin', 'feature/timify-123-a']);
  git(other, ['checkout', '-B', 'feature/other', 'origin/feature/other']);
  commit(other, 'o1', '2026-01-04T11:00:00Z');
  git(other, ['push', 'origin', 'feature/other']);
  git(other, ['checkout', '-b', 'TIMIFY-123-b', 'origin/develop', '--no-track']);
  commit(other, 'b1', '2026-01-05T10:00:00Z');
  git(other, ['push', 'origin', 'TIMIFY-123-b']);
  git(clone, ['fetch', 'origin']);

  git(clone, ['worktree', 'add', linked, 'feature/timify-123-a']);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function available(refs: JiraRepoRefs): Extract<JiraRepoRefs, { available: true }> {
  if (!refs.available) throw new Error(`unexpectedly unavailable: ${refs.reason}`);
  return refs;
}

function byName(refs: JiraRepoRefs, name: string): JiraRefBranch {
  const found = available(refs).branches.find((b) => b.name === name);
  if (!found) throw new Error(`no branch ${name}`);
  return found;
}

describe('readRepoRefs', () => {
  it('lists the ticket branches first, newest commit first, and every other branch once, by name', async () => {
    const refs = available(await readRepoRefs(clone, 'TIMIFY-123', null, null));
    expect(refs.branches.map((b) => b.name)).toEqual([
      'TIMIFY-123-b',
      'feature/timify-123-a',
      'timify-123-c',
      'develop',
      'feature/other',
      'feature/timify-1234',
      'plain'
    ]);
    expect(refs.branches.filter((b) => b.ticket).map((b) => b.name)).toEqual(['TIMIFY-123-b', 'feature/timify-123-a', 'timify-123-c']);
    expect(refs.branches.filter((b) => b.name === 'develop')).toHaveLength(1);
    expect(refs.branches.some((b) => b.name.startsWith('origin/') || b.name === 'HEAD')).toBe(false);
    expect(byName(refs, 'feature/timify-1234').ticket).toBe(false);
  });

  it('says where each branch lives, and the newer tip is its committedAt', async () => {
    const refs = await readRepoRefs(clone, 'TIMIFY-123', null, null);
    expect(byName(refs, 'TIMIFY-123-b')).toMatchObject({ local: false, remote: true, committedAt: '2026-01-05T10:00:00.000Z' });
    expect(byName(refs, 'feature/timify-1234')).toMatchObject({ local: true, remote: false, committedAt: '2026-01-09T10:00:00.000Z' });
    // The remote tip (a1, Jan 4) is newer than the stale local one — the entry reports the newer.
    expect(byName(refs, 'feature/timify-123-a')).toMatchObject({ local: true, remote: true, committedAt: '2026-01-04T10:00:00.000Z' });
  });

  it('sync: ticket branches by rev-list on the name, the rest by an upstream of origin/<name>, else null', async () => {
    const refs = await readRepoRefs(clone, 'TIMIFY-123', null, null);
    expect(byName(refs, 'feature/timify-123-a').sync).toBe('behind');
    expect(byName(refs, 'timify-123-c').sync).toBe('ahead'); // NO upstream, found by name
    expect(byName(refs, 'TIMIFY-123-b').sync).toBeNull(); // origin only
    expect(byName(refs, 'feature/timify-1234').sync).toBeNull(); // local only
    expect(byName(refs, 'develop').sync).toBe('same');
    expect(byName(refs, 'feature/other').sync).toBe('behind'); // %(upstream:track)
    expect(byName(refs, 'plain').sync).toBeNull(); // both sides, no upstream, not a ticket branch: not asked
  });

  it('a ticket branch whose two sides each have a commit the other lacks is diverged', async () => {
    git(clone, ['checkout', '-b', 'timify-123-d', 'develop', '--no-track']);
    commit(clone, 'd1', '2026-01-02T10:00:00Z');
    git(clone, ['push', 'origin', 'timify-123-d']);
    git(clone, ['reset', '--hard', 'HEAD~1']);
    commit(clone, 'd2', '2026-01-02T11:00:00Z');
    git(clone, ['checkout', 'develop']);
    try {
      expect(byName(await readRepoRefs(clone, 'TIMIFY-123', null, null), 'timify-123-d').sync).toBe('diverged');
    } finally {
      git(clone, ['branch', '-D', 'timify-123-d']);
      git(clone, ['push', 'origin', ':timify-123-d']);
    }
  });

  it('without a key `ticket` is false everywhere and the order is by name', async () => {
    const refs = available(await readRepoRefs(clone, null, null, null));
    expect(refs.branches.every((b) => !b.ticket)).toBe(true);
    const names = refs.branches.map((b) => b.name);
    expect(names).toEqual([...names].sort());
  });

  it('worktree is the linked tree for its branch and the clone for the checked-out one; mainBranch is the latter', async () => {
    const refs = await readRepoRefs(clone, 'TIMIFY-123', null, null);
    expect(byName(refs, 'feature/timify-123-a').worktree).toBe(linked);
    expect(byName(refs, 'develop').worktree).toBe(clone);
    expect(byName(refs, 'plain').worktree).toBeNull();
    expect(available(refs).mainBranch).toBe('develop');
  });

  it('defaultBase: origin/HEAD\'s target without origin/, or the stored base when there is one', async () => {
    expect(available(await readRepoRefs(clone, null, null, null)).defaultBase).toBe('develop');
    expect(available(await readRepoRefs(clone, null, null, 'release/2')).defaultBase).toBe('release/2');
  });

  it('fetchedAt is FETCH_HEAD\'s mtime as ISO', async () => {
    const stamp = new Date('2026-02-03T04:05:06Z');
    utimesSync(join(clone, '.git', 'FETCH_HEAD'), stamp, stamp);
    expect(available(await readRepoRefs(clone, null, null, null)).fetchedAt).toBe('2026-02-03T04:05:06.000Z');
  });

  it('a repo with no origin and no FETCH_HEAD: fetchedAt null, every branch local only, defaultBase falls to the checked-out branch', async () => {
    const solo = join(root, 'solo');
    mkdirSync(solo);
    git(solo, ['init', '-b', 'trunk']);
    commit(solo, 'one', '2026-01-01T10:00:00Z');
    git(solo, ['branch', 'side']);
    const refs = available(await readRepoRefs(solo, null, null, null));
    expect(refs.fetchedAt).toBeNull();
    expect(refs.branches.map((b) => [b.name, b.local, b.remote, b.sync])).toEqual([
      ['side', true, false, null],
      ['trunk', true, false, null]
    ]);
    expect(refs.mainBranch).toBe('trunk');
    expect(refs.defaultBase).toBe('trunk');
  });

  it('a clone on a detached HEAD: mainBranch null, the listing intact, defaultBase null with no origin/HEAD', async () => {
    const det = join(root, 'detached');
    mkdirSync(det);
    git(det, ['init', '-b', 'trunk']);
    commit(det, 'one', '2026-01-01T10:00:00Z');
    git(det, ['branch', 'side']);
    git(det, ['checkout', '--detach']);
    const refs = available(await readRepoRefs(det, null, null, null));
    expect(refs.mainBranch).toBeNull();
    expect(refs.defaultBase).toBeNull();
    expect(refs.branches.map((b) => b.name)).toEqual(['side', 'trunk']);
    expect(refs.branches.every((b) => b.worktree === null)).toBe(true);
  });

  it('reads a path that reaches the repo through a symlink', async () => {
    const link = join(root, 'clone-link');
    symlinkSync(clone, link);
    expect((await readRepoRefs(link, null, null, null)).available).toBe(true);
  });

  it('is available when the path sits under a root, and the root check is on whole path segments', async () => {
    expect((await readRepoRefs(clone, null, [root], null)).available).toBe(true);
    expect((await readRepoRefs(clone, null, [`${root}/`], null)).available).toBe(true);
    expect(await readRepoRefs('/data/abc/repo', null, ['/data/ab'], null)).toEqual({ repo: '/data/abc/repo', available: false, reason: 'not mounted into the board' });
  });
});

describe('unavailable, in the spec\'s order', () => {
  it('outside every root → not mounted into the board, before the path is even looked at', async () => {
    expect(await readRepoRefs(clone, null, ['/elsewhere'], null)).toEqual({ repo: clone, available: false, reason: 'not mounted into the board' });
    expect(await readWorktrees(clone, ['/elsewhere'])).toBe('not mounted into the board');
  });

  it('roots null and a missing path → does not exist', async () => {
    const missing = join(root, 'nope');
    expect(await readRepoRefs(missing, null, null, null)).toEqual({ repo: missing, available: false, reason: 'does not exist' });
    expect(await readWorktrees(missing, null)).toBe('does not exist');
  });

  it('a plain file is not a directory, so it does not exist as a repo either', async () => {
    const file = join(root, 'a-file');
    writeFileSync(file, 'x');
    expect(await readWorktrees(file, null)).toBe('does not exist');
  });

  it('an empty directory → not a git repository', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(await readRepoRefs(empty, null, null, null)).toEqual({ repo: empty, available: false, reason: 'not a git repository' });
    expect(await readWorktrees(empty, null)).toBe('not a git repository');
  });

  it('a subdirectory of a repo → not a git repository', async () => {
    const sub = join(clone, 'sub');
    mkdirSync(sub);
    expect(await readRepoRefs(sub, null, null, null)).toEqual({ repo: sub, available: false, reason: 'not a git repository' });
    expect(await readWorktrees(sub, null)).toBe('not a git repository');
  });
});

describe('readWorktrees', () => {
  it('lists every tree, the repo\'s own first and marked main, with its branch (null when detached)', async () => {
    const detachedTree = join(root, 'detached-tree');
    git(clone, ['worktree', 'add', '--detach', detachedTree]);
    try {
      const trees = await readWorktrees(clone, null);
      if (typeof trees === 'string') throw new Error(`unexpectedly unavailable: ${trees}`);
      expect(trees[0]).toEqual({ repo: clone, path: clone, branch: 'develop', main: true });
      // The order of the linked trees is git's own, not a promise worth pinning.
      expect(trees.slice(1)).toHaveLength(2);
      expect(trees.slice(1)).toEqual(
        expect.arrayContaining([
          { repo: clone, path: detachedTree, branch: null, main: false },
          { repo: clone, path: linked, branch: 'feature/timify-123-a', main: false }
        ])
      );
    } finally {
      git(clone, ['worktree', 'remove', '--force', detachedTree]);
    }
  });
});

describe('repoRoots', () => {
  it('is null unset or empty, and splits on : dropping empty segments', () => {
    expect(REPO_ROOTS_ENV).toBe('BM_REPO_ROOTS');
    expect(repoRoots({})).toBeNull();
    expect(repoRoots({ BM_REPO_ROOTS: '' })).toBeNull();
    expect(repoRoots({ BM_REPO_ROOTS: ':' })).toBeNull();
    expect(repoRoots({ BM_REPO_ROOTS: '/a:/b' })).toEqual(['/a', '/b']);
    expect(repoRoots({ BM_REPO_ROOTS: '/a::' })).toEqual(['/a']);
  });

  it('reads process.env at call time by default', () => {
    const saved = process.env.BM_REPO_ROOTS;
    try {
      process.env.BM_REPO_ROOTS = '/x:/y';
      expect(repoRoots()).toEqual(['/x', '/y']);
      delete process.env.BM_REPO_ROOTS;
      expect(repoRoots()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.BM_REPO_ROOTS;
      else process.env.BM_REPO_ROOTS = saved;
    }
  });
});
