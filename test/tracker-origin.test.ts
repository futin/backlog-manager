import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/**
 * Every remote shape either parser has an opinion about, in one table — the
 * input to the drift guard below as well as to the cases above.
 */
const SHARED_REMOTES: string[] = [
  'git@github.com:futin/backlog-manager.git',
  'git@github.com:futin/backlog-manager',
  'https://github.com/futin/backlog-manager.git',
  'https://github.com/futin/backlog-manager',
  'https://github.com/futin/backlog-manager/',
  'https://github.com/futin/backlog-manager.git/',
  'https://www.github.com/futin/backlog-manager.git',
  'http://github.com/futin/backlog-manager',
  'ssh://git@github.com/futin/backlog-manager.git',
  'ssh://git@github.com:22/futin/backlog-manager.git',
  'git://github.com/futin/backlog-manager.git',
  'https://user:pass@github.com/futin/backlog-manager.git',
  'GIT@GITHUB.COM:futin/backlog-manager.git',
  'git@gitlab.com:futin/x.git',
  'https://example.com/futin/x.git',
  'https://github.com/futin/x/tree/main',
  'https://github.com/futin',
  '/srv/git/local.git',
  '',
  '   '
];

describe('the two parsers of one rule', () => {
  /**
   * `parseGithubRemote` here and `parseOriginRepo` in
   * `skills/backlog/tools/backlog.mjs` answer the same question for two
   * surfaces — the Trackers card's suggested command, and `connect`'s own
   * default — and they CANNOT be one implementation: a skill's `tools/` is
   * installed as a standalone copy of what was pushed, with no build step and
   * no path back into `server/`, which is the same boundary `labels.ts`
   * describes for the label set.
   *
   * So the agreement is enforced from the outside, the way that pair's is: the
   * skill's own parser is RUN — in a node child, over a file URL, never
   * imported into jest — against the same table this file's cases use, and
   * every answer must match. A guard that compared the two regexes as text
   * would pass on two spellings of different behaviour; this one compares the
   * only thing that matters.
   *
   * It caught a real divergence the day it was written: the skill accepted
   * `www.github.com` and any URL scheme while this file accepted neither, so
   * the card stayed silent for an origin `connect` would have connected.
   */
  it('answers identically to the skill’s own parser on every shape', () => {
    const skill = pathToFileURL(join(__dirname, '..', 'skills', 'backlog', 'tools', 'backlog.mjs')).href;
    const script = `
      const remotes = ${JSON.stringify(SHARED_REMOTES)};
      const mod = await import(${JSON.stringify(skill)});
      process.stdout.write(JSON.stringify(remotes.map((r) => mod.parseOriginRepo(r))));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(JSON.parse(out) as (string | null)[]).toEqual(SHARED_REMOTES.map((r) => parseGithubRemote(r)));
  });

  it('agrees on the answers a reader would predict, so the case above cannot pass on two matching bugs', () => {
    // The guard above proves the pair AGREES; this proves what they agree ON.
    // Two parsers that both returned null for everything would satisfy one and
    // not the other.
    expect(parseGithubRemote('https://www.github.com/futin/backlog-manager.git')).toBe('futin/backlog-manager');
    expect(parseGithubRemote('https://github.com/futin/backlog-manager.git/')).toBe('futin/backlog-manager');
    expect(parseGithubRemote('GIT@GITHUB.COM:futin/backlog-manager.git')).toBe('futin/backlog-manager');
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
