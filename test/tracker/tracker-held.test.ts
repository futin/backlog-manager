import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ItemsModule } from '../../server/src/items/items.module';
import { REGISTRY_FILE } from '../../server/src/registry/registry.service';
import { GithubClient } from '../../server/src/tracker/github.client';
import { GITHUB_TOKEN_ENV } from '../../server/src/tracker/token.util';
import { FakeGithub, FAKE_REPO } from '../helpers/github';
import { listenLoopback } from '../helpers/app';
import { gitRepoWithBranches, makeProject, makeRegistry } from '../helpers/store';

/**
 * `GET /api/items/held` (the in-review-without-PR spec): what THIS machine still holds for a tracker item under execute's names — a local `execute/<n>`
 * branch, a `.worktrees/execute-<n>` directory. The board's Lift review confirmation reads it to warn before a person drops the guard over work that was
 * never pushed. It never decides anything, so every case here is a plain read of a real `git init`ed fixture.
 *
 * No token is ever set: the route makes no GitHub request, and without a token the poller cannot arm, so `gh.calls` staying empty is the proof.
 */

const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: FAKE_REPO });

const dirs: string[] = [];
const env = { ...process.env };

let app: INestApplication;
let gh: FakeGithub;
let trackerPath: string;
let filesPath: string;
let badRepoPath: string;

beforeEach(async () => {
  delete process.env[GITHUB_TOKEN_ENV];
  gh = new FakeGithub();
  trackerPath = makeProject('held', [], GITHUB_MARKER);
  filesPath = makeProject('held-files', []);
  badRepoPath = makeProject('held-bad', [], JSON.stringify({ kind: 'github', repo: 'not-a-repo' }));
  dirs.push(trackerPath, filesPath, badRepoPath);
  gitRepoWithBranches(trackerPath, []);

  const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(
      makeRegistry([
        { name: 'held', path: trackerPath },
        { name: 'held-files', path: filesPath },
        { name: 'held-bad', path: badRepoPath }
      ])
    )
    .overrideProvider(GithubClient)
    .useValue(new GithubClient(gh.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
});

afterEach(async () => {
  await app.close();
  process.env = { ...env };
  expect(gh.calls).toEqual([]);
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A local branch in the fixture repo, cut from its one commit — what an in-place execute leaves behind. */
function branch(name: string): void {
  execFileSync('git', ['-C', trackerPath, 'branch', name], { stdio: 'ignore' });
}

function held(project: string | undefined, id: string | undefined): request.Test {
  const query: Record<string, string> = {};
  if (project !== undefined) query.project = project;
  if (id !== undefined) query.id = id;
  return request(app.getHttpServer()).get('/api/items/held').query(query);
}

describe('GET /api/items/held', () => {
  it('answers nothing held when neither the branch nor the worktree exists', async () => {
    const res = await held(trackerPath, '#214').expect(200);
    expect(res.body).toEqual({ branch: false, tree: false });
  });

  it('finds a local execute/<n> branch, whichever of the three id shapes names it', async () => {
    branch('execute/214');
    for (const id of ['#214', '214', `gh:${FAKE_REPO}#214`]) {
      const res = await held(trackerPath, id).expect(200);
      expect(res.body).toEqual({ branch: true, tree: false });
    }
  });

  it('matches the ref exactly: execute/2140 does not hold item 214', async () => {
    branch('execute/2140');
    const res = await held(trackerPath, '214').expect(200);
    expect(res.body).toEqual({ branch: false, tree: false });
  });

  it('finds a .worktrees/execute-<n> directory on its own', async () => {
    mkdirSync(join(trackerPath, '.worktrees', 'execute-214'), { recursive: true });
    const res = await held(trackerPath, '#214').expect(200);
    expect(res.body).toEqual({ branch: false, tree: true });
  });

  it('400s a blank project or id, by name', async () => {
    expect((await held(undefined, '#214').expect(400)).body).toEqual({ error: 'project is required' });
    expect((await held('  ', '#214').expect(400)).body).toEqual({ error: 'project is required' });
    expect((await held(trackerPath, undefined).expect(400)).body).toEqual({ error: 'id is required' });
  });

  it('404s an unregistered path and 400s a files project with the write routes’ sentence', async () => {
    await held('/nowhere/at/all', '#214').expect(404);
    const files = await held(filesPath, '#214').expect(400);
    expect(files.body).toEqual({ error: "this project's items are files — the skills write them directly" });
  });

  it('400s an id that names no issue in this repo', async () => {
    const other = await held(trackerPath, 'gh:other/repo#214').expect(400);
    expect(other.body).toEqual({ error: `gh:other/repo#214 does not name an issue in ${FAKE_REPO}` });
    const junk = await held(trackerPath, 'abc').expect(400);
    expect(junk.body).toEqual({ error: `abc does not name an issue in ${FAKE_REPO}` });
  });

  it('400s a marker whose repo is not owner/name, before any git', async () => {
    const res = await held(badRepoPath, '#214').expect(400);
    expect(res.body).toEqual({ error: 'backlog/source.json names no valid "repo" (expected "owner/name")' });
  });

  it('is a read only: a POST to the same path is no route', async () => {
    await request(app.getHttpServer()).post('/api/items/held').send({ project: trackerPath, id: '#214' }).expect(404);
  });
});
