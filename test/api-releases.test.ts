import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { formatTagMessage, readReleases } from 'release-kit';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import * as gitRun from '../server/src/git-run.util';
import { ReleasesService, findRepoRoot } from '../server/src/releases/releases.service';
import { listenLoopback } from './helpers/app';
import { makeRegistry } from './helpers/store';

/*
 * GET /api/releases over real tmpdir repositories, through the real route table. Each case points `BM_RELEASES_ROOT` at its own fixture (the variable is
 * read per request), and the memo key includes the root, so cases never see each other's answer — but a fixture is never reused across cases that need a
 * fresh read, because changing `origin` does not move the key (only HEAD and the tag refs do).
 *
 * The parity case is the reason the server can run git itself (spec R4) without drifting: for the same repo, the route must answer exactly what
 * release-kit's own `readReleases` does.
 */

jest.setTimeout(20_000);

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const scratch: string[] = [];

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bm-releases-'));
  scratch.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  return root;
}

function commit(cwd: string, message: string): string {
  git(cwd, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function baseline(cwd: string, sha = 'HEAD'): void {
  git(cwd, ['tag', '-a', 'v0.1.0', sha, '-m', 'Baseline — versioning starts here']);
}

type TagInput = Parameters<typeof formatTagMessage>[0];

const FEAT: TagInput = { title: 'feat(releases): version chip', type: 'feat', scope: 'releases', pr: 12, breaking: false, notes: '- Shows the running version' };
const FIX: TagInput = { title: 'fix(api)!: tighten', type: 'fix', scope: 'api', pr: 13, breaking: true, notes: '' };

function release(cwd: string, name: string, input: TagInput, sha = 'HEAD', env: Record<string, string> = {}): void {
  const file = join(cwd, '.git', `msg-${name}`);
  writeFileSync(file, formatTagMessage(input));
  git(cwd, ['tag', '-a', name, sha, '-F', file, '--cleanup=verbatim'], env);
}

/** baseline v0.1.0, then v0.2.0 (FEAT), then v0.2.1 (FIX) on HEAD. */
function populated(origin?: string): string {
  const root = repo();
  commit(root, 'chore: start');
  baseline(root);
  commit(root, 'feat(releases): version chip (#12)');
  release(root, 'v0.2.0', FEAT);
  commit(root, 'fix(api)!: tighten (#13)');
  release(root, 'v0.2.1', FIX);
  if (origin !== undefined) git(root, ['remote', 'add', 'origin', origin]);
  return root;
}

const EMPTY = { current: null, releases: [] };

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry([]))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
});

afterAll(async () => {
  await app.close();
  delete process.env.BM_RELEASES_ROOT;
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function releasesAt(root: string): Promise<request.Response> {
  process.env.BM_RELEASES_ROOT = root;
  const res = await request(app.getHttpServer()).get('/api/releases');
  expect(res.status).toBe(200);
  return res;
}

const versions = (res: request.Response): string[] => res.body.releases.map((r: { version: string }) => r.version);

describe('GET /api/releases — the empty shape', () => {
  it('a folder that is not a checkout answers the empty shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-releases-plain-'));
    scratch.push(dir);
    expect((await releasesAt(dir)).body).toEqual(EMPTY);
  });

  it('a checkout with commits and no tags answers the empty shape', async () => {
    const root = repo();
    commit(root, 'chore: start');
    expect((await releasesAt(root)).body).toEqual(EMPTY);
  });

  it('lightweight tags — even a full vX.Y.Z and a floating v1 — are not releases', async () => {
    const root = repo();
    commit(root, 'chore: start');
    git(root, ['tag', 'v9.9.9']);
    git(root, ['tag', 'v1']);
    expect((await releasesAt(root)).body).toEqual(EMPTY);
  });
});

describe('GET /api/releases — a populated checkout', () => {
  it('lists every release newest first, the baseline typed baseline, and HEAD on the newest as ahead 0', async () => {
    const body = (await releasesAt(populated())).body;
    expect(body.releases.map((r: { version: string }) => r.version)).toEqual(['0.2.1', '0.2.0', '0.1.0']);
    const [fix, feat, base] = body.releases;
    expect(base).toMatchObject({ version: '0.1.0', type: 'baseline', breaking: false, title: 'Baseline — versioning starts here' });
    expect(base.pr).toBeUndefined();
    expect(feat).toMatchObject({
      version: '0.2.0',
      title: 'feat(releases): version chip',
      type: 'feat',
      scope: 'releases',
      pr: 12,
      breaking: false,
      notes: '- Shows the running version'
    });
    expect(fix).toMatchObject({ version: '0.2.1', type: 'fix', breaking: true, notes: '' });
    expect(typeof feat.date).toBe('string');
    expect(Number.isNaN(Date.parse(feat.date))).toBe(false);
    expect(body.current).toEqual({ version: '0.2.1', ahead: 0 });
  });

  it('a commit after the first read moves ahead to 1, and a tag cut without moving HEAD appears', async () => {
    const root = populated();
    expect((await releasesAt(root)).body.current).toEqual({ version: '0.2.1', ahead: 0 });
    commit(root, 'chore: later');
    expect((await releasesAt(root)).body.current).toEqual({ version: '0.2.1', ahead: 1 });
    // Annotated, on an older commit: HEAD stays where it is, so only the tag refs can move the memo key.
    const first = git(root, ['rev-list', '--max-parents=0', 'HEAD']);
    release(root, 'v0.1.5', { ...FEAT, pr: 11 }, first);
    expect(versions(await releasesAt(root))).toContain('0.1.5');
  });

  it('a GitHub origin gives each PR its URL; another host or no origin gives none', async () => {
    const github = (await releasesAt(populated('https://github.com/futin/backlog-manager.git'))).body;
    expect(github.releases[1].url).toBe('https://github.com/futin/backlog-manager/pull/12');

    const gitlab = (await releasesAt(populated('git@gitlab.com:x/y.git'))).body;
    expect('url' in gitlab.releases[1]).toBe(false);

    const none = (await releasesAt(populated())).body;
    expect('url' in none.releases[1]).toBe(false);
  });

  it('tags cut in the same second are ordered by version, newest first', async () => {
    const root = repo();
    commit(root, 'chore: start');
    const when = { GIT_COMMITTER_DATE: '2026-10-16T12:00:00+00:00' };
    // Cut in an order that ascending-refname tie-breaking would NOT fix: 0.10.0 sorts before 0.2.0 and 0.9.0 by name.
    release(root, 'v0.2.0', { ...FEAT, pr: 1 }, 'HEAD', when);
    release(root, 'v0.10.0', { ...FEAT, pr: 3 }, 'HEAD', when);
    release(root, 'v0.9.0', { ...FEAT, pr: 2 }, 'HEAD', when);
    expect(versions(await releasesAt(root))).toEqual(['0.10.0', '0.9.0', '0.2.0']);
  });

  it('tags not reachable from HEAD are listed, with current null', async () => {
    const root = repo();
    commit(root, 'chore: start');
    git(root, ['checkout', '-q', '-b', 'side']);
    commit(root, 'feat: on the side (#12)');
    baseline(root);
    git(root, ['checkout', '-q', 'main']);
    commit(root, 'chore: main moves on');
    const body = (await releasesAt(root)).body;
    expect(body.current).toBeNull();
    expect(body.releases.map((r: { version: string }) => r.version)).toEqual(['0.1.0']);
  });

  it('a linked worktree reads the common dir: a tag cut from the main tree after the first read appears', async () => {
    const root = populated();
    const tree = join(mkdtempSync(join(tmpdir(), 'bm-releases-wt-')), 'tree');
    scratch.push(tree);
    git(root, ['worktree', 'add', '-q', '-b', 'wt', tree]);
    expect(versions(await releasesAt(tree))).toEqual(['0.2.1', '0.2.0', '0.1.0']);
    release(root, 'v0.3.0', { ...FEAT, pr: 14 });
    expect(versions(await releasesAt(tree))).toContain('0.3.0');
  });

  it('parity: the route answers exactly what release-kit readReleases answers for the same repo', async () => {
    const root = populated('https://github.com/futin/backlog-manager.git');
    const body = (await releasesAt(root)).body;
    expect(body).toEqual(JSON.parse(JSON.stringify(await readReleases(root))));
  });
});

describe('GET /api/releases — failure is a value, and is never memoised', () => {
  const realPath = process.env.PATH as string;
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const fakeDir = mkdtempSync(join(tmpdir(), 'bm-releases-fake-git-'));
  scratch.push(fakeDir);
  // test/git-run.test.ts's fake: sleeps only on matching invocations, and kills its own sleep on TERM so a timed-out run leaves nothing behind.
  writeFileSync(
    join(fakeDir, 'git'),
    `#!/bin/sh
if echo "$*" | grep -q -- "$FAKE_GIT_ONLY"; then
  sleep "\${FAKE_GIT_SLEEP:-0}" &
  trap 'kill $!; exit 143' TERM
  wait $!
fi
exec "$FAKE_GIT_REAL" "$@"
`
  );
  chmodSync(join(fakeDir, 'git'), 0o755);

  afterEach(() => {
    process.env.PATH = realPath;
    delete process.env.FAKE_GIT_REAL;
    delete process.env.FAKE_GIT_SLEEP;
    delete process.env.FAKE_GIT_ONLY;
    gitRun.__setGitTimeoutMs(null);
  });

  it('a for-each-ref timeout answers the empty shape with 200, and the next request after it is lifted is populated', async () => {
    const root = populated();
    process.env.PATH = `${fakeDir}:${realPath}`;
    process.env.FAKE_GIT_REAL = realGit;
    process.env.FAKE_GIT_SLEEP = '2';
    process.env.FAKE_GIT_ONLY = 'for-each-ref';
    gitRun.__setGitTimeoutMs(300);
    expect((await releasesAt(root)).body).toEqual(EMPTY);

    process.env.PATH = realPath;
    gitRun.__setGitTimeoutMs(null);
    expect(versions(await releasesAt(root))).toEqual(['0.2.1', '0.2.0', '0.1.0']);
  });

  it('a describe timeout alone gives current null with releases kept, and is not memoised either', async () => {
    const root = populated();
    process.env.PATH = `${fakeDir}:${realPath}`;
    process.env.FAKE_GIT_REAL = realGit;
    process.env.FAKE_GIT_SLEEP = '2';
    process.env.FAKE_GIT_ONLY = 'describe';
    gitRun.__setGitTimeoutMs(300);
    const slow = (await releasesAt(root)).body;
    expect(slow.current).toBeNull();
    expect(slow.releases).toHaveLength(3);

    process.env.PATH = realPath;
    gitRun.__setGitTimeoutMs(null);
    expect((await releasesAt(root)).body.current).toEqual({ version: '0.2.1', ahead: 0 });
  });
});

describe('ReleasesService', () => {
  it('two reads started together under one key share one for-each-ref', async () => {
    const root = populated();
    process.env.BM_RELEASES_ROOT = root;
    const spy = jest.spyOn(gitRun, 'runGit');
    try {
      const service = app.get(ReleasesService);
      const [a, b] = await Promise.all([service.read(), service.read()]);
      expect(a).toEqual(b);
      expect(spy.mock.calls.filter(([args]) => args.includes('for-each-ref'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('findRepoRoot', () => {
  it('stops at a .git FILE too, so a server started inside a linked worktree finds that worktree', () => {
    const root = populated();
    const tree = join(mkdtempSync(join(tmpdir(), 'bm-releases-wt-')), 'tree');
    scratch.push(tree);
    git(root, ['worktree', 'add', '-q', '-b', 'wt2', tree]);
    const deep = join(tree, 'server', 'dist');
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(tree);
  });

  it('answers null when no ancestor holds a .git entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-releases-none-'));
    scratch.push(dir);
    // tmpdir itself is never inside a checkout on any machine this runs on; if it ever is, this case says so loudly rather than passing on a guess.
    expect(findRepoRoot(dir)).toBeNull();
  });
});
