import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * bug-37: `.gitignore` carried `node_modules/` — a trailing slash, so a directory-only pattern (gitignore(5): "If there is a separator at the end of the
 * pattern then the pattern will only match directories"). Git records a symbolic link as a blob with mode `120000`, which is a file and not a directory, so
 * the pattern never fired for a `node_modules` **symlink**, and `git add -A` staged it like any other untracked file.
 *
 * That combination is reached by an ordinary orchestrator run on this machine: a per-item worktree has no `node_modules` of its own, the runner links one in so
 * the verify step can resolve dependencies, and `backlog-orchestrate` §6 commits the item's work with `git add -A`. The symlink rode onto `backlog/task-45` as
 * a root-level blob pointing at `../../node_modules`, which resolves outside any clone that is not that one worktree.
 *
 * The assertions run git for real against a scratch repository seeded with THIS repo's `.gitignore`, rather than reading the file's text for a pattern, for two
 * reasons. Git's own matcher is the thing under test — a text assertion would be a second, weaker copy of gitignore(5) — and a scratch repo is the only way to
 * ask the question honestly on a developer machine: `git check-ignore` inside this worktree consults `info/exclude` too, and every machine that has hit this
 * bug has since hand-added `node_modules` there, which would make a check run in place pass while `.gitignore` stayed broken for every fresh clone.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_NOSYSTEM` are set for the same reason one rung out: a `core.excludesFile` in the developer's own `~/.gitconfig` that happens
 * to list `node_modules` would otherwise answer for `.gitignore` and hide a regression from everyone but CI.
 */
const GITIGNORE = readFileSync(join(__dirname, '..', '.gitignore'), 'utf8');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  });
}

/** A fresh repository whose only ignore source is this repo's `.gitignore`. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bm-gitignore-'));
  git(dir, ['init', '-q', '-b', 'main', '.']);
  writeFileSync(join(dir, '.gitignore'), GITIGNORE);
  return dir;
}

/** `check-ignore` exits 1 — not an error — when nothing matches, so the non-zero exit is the answer rather than a failure. */
function isIgnored(dir: string, relative: string): boolean {
  try {
    git(dir, ['check-ignore', '-q', '--', relative]);
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return false;
    throw error;
  }
}

describe('.gitignore node_modules', () => {
  let dir: string;

  beforeEach(() => {
    dir = scratchRepo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a node_modules symlink at the repo root', () => {
    symlinkSync('../../node_modules', join(dir, 'node_modules'));

    expect(isIgnored(dir, 'node_modules')).toBe(true);
  });

  it('keeps a node_modules symlink out of `git add -A`', () => {
    // The repro from the item, end to end: this is what §6's commit step actually runs, and the staged mode 120000 blob is what reached the branch.
    symlinkSync('../../node_modules', join(dir, 'node_modules'));

    git(dir, ['add', '-A']);

    expect(git(dir, ['ls-files', '-s'])).not.toContain('node_modules');
  });

  it('still ignores a real node_modules directory', () => {
    // The half that always worked. Widening the pattern must not be paid for by the case the pattern was written for.
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'pkg.js'), '');

    expect(isIgnored(dir, 'node_modules/pkg.js')).toBe(true);
  });
});
