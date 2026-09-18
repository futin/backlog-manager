import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { originRepo, parseGithubRemote } from '../server/src/tracker/origin.util';

/**
 * The Trackers card's "here is the command to connect this project" read
 * (task-45, spec §5.6): a files project's `origin`, resolved to `owner/name`,
 * per request and memoised nowhere.
 *
 * Real git repositories for the `originRepo` cases, the same choice
 * `test/uncommitted.test.ts` makes: the failure modes are git's own answers
 * (no repo at all, a repo with no `origin`) and a mock would assert the mock's
 * idea of them.
 */

const dirs: string[] = [];

function repo(origin?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'bm-origin-'));
  dirs.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (origin !== undefined) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
  return root;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('parseGithubRemote', () => {
  it('reads the three shapes a clone actually produces', () => {
    expect(parseGithubRemote('git@github.com:futin/backlog-manager.git')).toBe('futin/backlog-manager');
    expect(parseGithubRemote('https://github.com/futin/backlog-manager.git')).toBe('futin/backlog-manager');
    expect(parseGithubRemote('https://github.com/futin/backlog-manager')).toBe('futin/backlog-manager');
    expect(parseGithubRemote('ssh://git@github.com/futin/backlog-manager.git')).toBe('futin/backlog-manager');
    // Trailing newline, which `git remote get-url` always prints.
    expect(parseGithubRemote('git@github.com:futin/backlog-manager.git\n')).toBe('futin/backlog-manager');
  });

  it('answers null for anything that is not a GitHub repo', () => {
    // A suggestion this app cannot honour is worse than no suggestion: the
    // command it would print names a platform with no adapter behind it.
    expect(parseGithubRemote('git@gitlab.com:futin/x.git')).toBeNull();
    expect(parseGithubRemote('https://example.com/futin/x.git')).toBeNull();
    expect(parseGithubRemote('/srv/git/local.git')).toBeNull();
    expect(parseGithubRemote('')).toBeNull();
    // A path with an extra segment is not `owner/name` and must not be
    // truncated into one.
    expect(parseGithubRemote('https://github.com/futin/x/tree/main')).toBeNull();
  });
});

describe('originRepo', () => {
  it('reads a repo’s origin', () => {
    expect(originRepo(repo('git@github.com:futin/backlog-manager.git'))).toBe('futin/backlog-manager');
  });

  it('answers null for a repo with no origin and for a directory that is not a repo', () => {
    expect(originRepo(repo())).toBeNull();
    const plain = mkdtempSync(join(tmpdir(), 'bm-plain-'));
    dirs.push(plain);
    expect(originRepo(plain)).toBeNull();
  });
});
