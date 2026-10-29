import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { writeSyncInterval } from '../server/src/tracker/sync-config.util';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { FAKE_REPO, FakeGithub } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';
import type { PrRepoView, PullRequestsPayload } from '../shared/types';

/**
 * The PRs page's routes (Plan B, task 4): `GET /api/prs` and the three guarded writes — merge, auto-merge, update-branch — each serialised per
 * `<repo>#<number>`, each re-reading the PR it touched and splicing the answer into the on-demand cache.
 *
 * The app is the whole `AppModule`, as `allowed-hosts.test.ts` builds it, so the Host allowlist and the per-route `SameOriginPostGuard` are the real ones;
 * only the registry and the GitHub client's `fetch` are swapped. Fixtures discriminate: #7 on `futin/x` with head SHA `a…a`, #12 on `futin/y` with head SHA
 * `b…b` — a write that reached the wrong repo or the wrong PR cannot pass on the other's answer.
 */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const PERMISSION = 'the token lacks permission for this — ';
const Y_OFF = 'sync is off for futin/y — turn it on in GitHub › Settings';

const dirs: string[] = [];
const env = { ...process.env };
let app: INestApplication;
let gh: FakeGithub;

function githubProject(name: string, repo: string): string {
  const root = makeProject(name, [], JSON.stringify({ kind: 'github', repo }));
  dirs.push(root);
  return root;
}

beforeEach(async () => {
  process.env[GITHUB_TOKEN_ENV] = 'tok';
  delete process.env.BM_ALLOWED_HOSTS;
  const settings = mkdtempSync(join(tmpdir(), 'bm-prs-write-'));
  dirs.push(settings);
  process.env.BM_TRACKER_SYNC_FILE = join(settings, 'tracker-sync.json');

  gh = new FakeGithub();
  gh.addPr(FAKE_REPO, { number: 7, headRefOid: A });
  gh.addPr('futin/y', { number: 12, headRefOid: B });
  const registry = makeRegistry([
    { name: 'x', path: githubProject('prs-x', FAKE_REPO) },
    { name: 'y', path: githubProject('prs-y', 'futin/y') }
  ]);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(registry)
    .overrideProvider(GithubClient)
    .useValue(new GithubClient(gh.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  // The poller arms itself at bootstrap (github projects and a token): one awaited tick, disarmed, and the log cleared — every call from here is the case's.
  const poller = app.get(TrackerPollerService);
  await poller.tick();
  poller.disarm();
  gh.calls.length = 0;
});

afterEach(async () => {
  await app.close();
  process.env = { ...env };
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function post(route: 'merge' | 'auto-merge' | 'update-branch', body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(`/api/prs/${route}`).send(body);
}

async function list(): Promise<PullRequestsPayload> {
  const res = await request(app.getHttpServer()).get('/api/prs').expect(200);
  return res.body as PullRequestsPayload;
}

function view(payload: PullRequestsPayload, repo: string): PrRepoView {
  const found = payload.repos.find((r) => r.repo === repo);
  if (found === undefined) throw new Error(`no view for ${repo}`);
  return found;
}

const lists = (repo: string): number => gh.graphqlCalls('PullRequests', repo).length;
const puts = (fragment: string): number => gh.matching(fragment, 'PUT').length;

/** Wait until `done()` holds — how a held case knows the requests it started have reached the fake. */
async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('POST /api/prs/merge', () => {
  it('merges, splices the PR out of the cache, and the next GET makes no list query', async () => {
    expect(view(await list(), FAKE_REPO).prs.map((p) => p.number)).toEqual([7]);
    expect(lists(FAKE_REPO)).toBe(1);

    const res = await post('merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: A }).expect(200);
    expect(res.body).toEqual({ ok: true, outcome: 'merged', pr: null, reread: true });
    const sent = gh.matching(`/repos/${FAKE_REPO}/pulls/7/merge`, 'PUT');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ merge_method: 'squash', sha: A });
    expect(puts('/repos/futin/y/')).toBe(0);

    const after = await list();
    expect(view(after, FAKE_REPO).prs).toEqual([]);
    expect(view(after, 'futin/y').prs.map((p) => p.number)).toEqual([12]);
    expect(lists(FAKE_REPO)).toBe(1);
  });

  it('a second merge of the same PR reads as already merged, and another PR is not queued behind them', async () => {
    const release = gh.holdAnswers();
    const first = post('merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: A }).then((r) => r);
    const second = post('merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: A }).then((r) => r);
    const other = post('merge', { repo: 'futin/y', number: 12, method: 'merge', headSha: B }).then((r) => r);

    // Both PRs' first PUT is in flight while answers are held — #12 started before #7's pair finished — and #7's second merge is still queued.
    await until(() => puts('/pulls/7/merge') === 1 && puts('/pulls/12/merge') === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(puts('/pulls/7/merge')).toBe(1);
    release();

    const [a, b, c] = await Promise.all([first, second, other]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect([a.body.outcome, b.body.outcome].sort()).toEqual(['already-merged', 'merged']);
    expect(c.body.outcome).toBe('merged');
    expect(gh.maxConcurrent.get(`${FAKE_REPO}#7`)).toBe(1);
    expect(puts('/pulls/7/merge')).toBe(2);
  });

  it('a moved head answers 409 with GitHub’s message and puts the re-read row in the cache', async () => {
    await list();
    gh.pulls.get(FAKE_REPO)![0].headRefOid = C;

    const res = await post('merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: A }).expect(409);
    expect(res.body.error).toBe('Head branch was modified. Review and try the merge again.');

    const x = view(await list(), FAKE_REPO);
    expect(x.prs.map((p) => p.headSha)).toEqual([C]);
    expect(lists(FAKE_REPO)).toBe(1);
  });

  it('a protection refusal (405) answers 409 with GitHub’s message', async () => {
    gh.failNext = { fragment: '/pulls/7/merge', status: 405, message: 'Required status check is expected' };
    const res = await post('merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: A }).expect(409);
    expect(res.body.error).toBe('Required status check is expected');
  });

  it('a 403 that is not a rate limit answers 502 naming the token’s permission', async () => {
    gh.failNext = {
      fragment: '/pulls/7/merge',
      status: 403,
      message: 'Resource not accessible by personal access token',
      headers: { 'x-ratelimit-remaining': '4999' }
    };
    const res = await post('merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: A }).expect(502);
    expect(res.body.error).toBe(`${PERMISSION}Resource not accessible by personal access token`);
  });

  it('a rate limit answers 429 and sleeps that repo for writes, not the other one', async () => {
    gh.failNext = { fragment: '/pulls/7/merge', status: 429, message: 'API rate limit exceeded', headers: { 'retry-after': '60' } };
    const res = await post('merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: A }).expect(429);
    expect(res.body.error).toMatch(/^rate limit reached — resets /);

    const before = gh.calls.length;
    const again = await post('update-branch', { repo: FAKE_REPO, number: 7, headSha: A }).expect(429);
    expect(again.body.error).toBe(res.body.error);
    expect(gh.calls.length).toBe(before);

    await post('update-branch', { repo: 'futin/y', number: 12, headSha: B }).expect(202);
  });

  it('answers 200 merged with reread: false when the re-read fails', async () => {
    gh.failNext = { fragment: '/graphql', operation: 'PullRequest', status: 502, message: 'Bad gateway' };
    const res = await post('merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: A }).expect(200);
    expect(res.body).toEqual({ ok: true, outcome: 'merged', pr: null, reread: false });
  });

  it('accepts a tailnet Host with its matching origin', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/prs/merge')
      .set('host', 'mac.tail1234.ts.net:5177')
      .set('origin', 'http://mac.tail1234.ts.net:5177')
      .send({ repo: FAKE_REPO, number: 7, method: 'squash', headSha: A })
      .expect(200);
    expect(res.body.outcome).toBe('merged');
  });
});

describe('POST /api/prs/auto-merge', () => {
  it('enables, disables, then answers noop with no mutation; a repo with auto-merge off is GitHub’s 409', async () => {
    const on = await post('auto-merge', { repo: 'futin/y', number: 12, enable: true, method: 'rebase' }).expect(200);
    expect(on.body).toMatchObject({ ok: true, outcome: 'auto-merge-enabled', reread: true });
    expect(on.body.pr.number).toBe(12);
    expect(on.body.pr.autoMerge.method).toBe('rebase');
    expect(gh.graphqlCalls('EnableAutoMerge', 'futin/y')).toHaveLength(1);

    const off = await post('auto-merge', { repo: 'futin/y', number: 12, enable: false }).expect(200);
    expect(off.body).toMatchObject({ ok: true, outcome: 'auto-merge-disabled', reread: true });
    expect(off.body.pr.autoMerge).toBeNull();
    expect(gh.graphqlCalls('DisableAutoMerge')).toHaveLength(1);

    const noop = await post('auto-merge', { repo: 'futin/y', number: 12, enable: false }).expect(200);
    expect(noop.body).toMatchObject({ ok: true, outcome: 'noop' });
    expect(gh.graphqlCalls('DisableAutoMerge')).toHaveLength(1);

    gh.setRepoSettings(FAKE_REPO, { autoMergeAllowed: false });
    const refused = await post('auto-merge', { repo: FAKE_REPO, number: 7, enable: true, method: 'squash' }).expect(409);
    expect(refused.body.error).toBe('Pull request Auto merge is not allowed for this repository');
  });
});

describe('POST /api/prs/update-branch', () => {
  it('answers 202 update-requested with the re-read, sending the expected head', async () => {
    const res = await post('update-branch', { repo: 'futin/y', number: 12, headSha: B }).expect(202);
    expect(res.body).toMatchObject({ ok: true, outcome: 'update-requested', reread: true });
    expect(res.body.pr.number).toBe(12);
    expect(res.body.pr.headSha).not.toBe(B);
    const sent = gh.matching('/repos/futin/y/pulls/12/update-branch', 'PUT');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ expected_head_sha: B });
    expect(puts(`/repos/${FAKE_REPO}/`)).toBe(0);
  });

  it('a 422 answers 409 with GitHub’s message', async () => {
    const res = await post('update-branch', { repo: 'futin/y', number: 12, headSha: C }).expect(409);
    expect(res.body.error).toBe('expected_head_sha does not match the current head SHA of the pull request');
  });
});

describe('the PR write refusals', () => {
  it('sync off refuses every PR write on that repo with no outbound call, and the list still shows its PRs', async () => {
    writeSyncInterval('futin/y', 'off');

    const refusals = [
      await post('merge', { repo: 'futin/y', number: 12, method: 'squash', headSha: B }),
      await post('auto-merge', { repo: 'futin/y', number: 12, enable: true, method: 'squash' }),
      await post('update-branch', { repo: 'futin/y', number: 12, headSha: B })
    ];
    for (const res of refusals) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(Y_OFF);
    }
    expect(gh.calls).toHaveLength(0);

    const updated = await post('update-branch', { repo: FAKE_REPO, number: 7, headSha: A }).expect(202);
    const head = updated.body.pr.headSha as string;
    await post('auto-merge', { repo: FAKE_REPO, number: 7, enable: true, method: 'squash' }).expect(200);
    await post('merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: head }).expect(200);

    const y = view(await list(), 'futin/y');
    expect(y.syncOff).toBe(Y_OFF);
    expect(y.prs.map((p) => p.number)).toEqual([12]);
  });

  it.each([
    ['merge', { repo: 'nope', number: 7, method: 'squash', headSha: A }, 400, 'repo must be an owner/name repository'],
    ['merge', { repo: FAKE_REPO, number: 0, method: 'squash', headSha: A }, 400, 'number must be a positive integer'],
    ['merge', { repo: FAKE_REPO, number: 7, method: 'fast', headSha: A }, 400, 'method must be one of squash, merge, rebase'],
    ['merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: 'abc' }, 400, 'headSha must be a 40-character lowercase hex SHA'],
    ['auto-merge', { repo: FAKE_REPO, number: 7, enable: true }, 400, 'method is required to enable auto-merge'],
    ['auto-merge', { repo: FAKE_REPO, number: 7, enable: 'yes', method: 'squash' }, 400, 'enable must be a boolean'],
    ['update-branch', { repo: FAKE_REPO, number: 7, headSha: A.toUpperCase() }, 400, 'headSha must be a 40-character lowercase hex SHA'],
    ['merge', { repo: 'futin/z', number: 7, method: 'squash', headSha: A }, 404, 'futin/z is not the repo of a registered GitHub project']
  ] as const)('%s %j answers %i with no outbound call', async (route, body, status, error) => {
    const res = await post(route, body).expect(status);
    expect(res.body.error).toBe(error);
    expect(gh.calls).toHaveLength(0);
  });

  it('answers 503 with no outbound call when there is no token', async () => {
    delete process.env[GITHUB_TOKEN_ENV];
    for (const [route, body] of [
      ['merge', { repo: FAKE_REPO, number: 7, method: 'squash', headSha: A }],
      ['auto-merge', { repo: FAKE_REPO, number: 7, enable: false }],
      ['update-branch', { repo: FAKE_REPO, number: 7, headSha: A }]
    ] as const) {
      const res = await post(route, body).expect(503);
      expect(res.body.error).toBe('BM_GITHUB_TOKEN is not set on this machine');
    }
    expect(gh.calls).toHaveLength(0);
  });
});
