import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { SWEEP_FLOOR_MS, TrackerPollerService } from '../server/src/tracker/poller.service';
import { PR_TTL_MS } from '../server/src/tracker/pulls.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { listenLoopback } from './helpers/app';
import { FAKE_REPO, FakeGithub } from './helpers/github';
import { makeProject, makeRegistry } from './helpers/store';

/**
 * `POST /api/github/sweep` — the popover head's `Sync now` (plan 4 Task 5, spec §5). One app per case over an in-memory GitHub behind a real `GithubClient`.
 * `Date.now` is shifted by `skew` so a case can step past the floor or the PR cache's TTL without sleeping; the poller, the PR cache and the fake all read it.
 */

const OTHER = 'futin/y';
const OFF_REPO = 'futin/z';
const env = { ...process.env };
const realNow = Date.now.bind(Date);
const dirs: string[] = [];
let skew = 0;
let app: INestApplication;
let gh: FakeGithub;
let poller: TrackerPollerService;

const marker = (repo: string) => JSON.stringify({ kind: 'github', repo });

/** `repos` are registered one project each; `intervals` is the tracker-sync file (`off` for a repo that is not polled). */
async function build(repos: string[], opts: { intervals?: Record<string, string>; token?: boolean } = {}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'bm-gh-sweep-'));
  dirs.push(root);
  if (opts.token === false) delete process.env[GITHUB_TOKEN_ENV];
  else process.env[GITHUB_TOKEN_ENV] = 'tok';
  process.env.BM_WATCHDOG = 'off';
  process.env.BM_ORCH_HOME = join(root, 'orchestrator');
  mkdirSync(join(root, 'settings'));
  process.env.BM_TRACKER_SYNC_FILE = join(root, 'settings', 'tracker-sync.json');
  writeFileSync(process.env.BM_TRACKER_SYNC_FILE, JSON.stringify(opts.intervals ?? {}));
  gh = new FakeGithub();
  gh.addPr(FAKE_REPO, { number: 7 });
  gh.addRepo(OTHER);
  gh.addRepo(OFF_REPO);
  const registry = makeRegistry(repos.map((repo, i) => ({ name: `p${i}`, path: makeProject(`gh-sweep-${i}`, [], marker(repo)) })));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(registry)
    .overrideProvider(GithubClient)
    .useValue(new GithubClient(gh.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  poller = app.get(TrackerPollerService);
  // The poller arms itself at bootstrap; settle that first sweep, then forget its calls so every count below is the press's own.
  await poller.tick();
  gh.calls.length = 0;
  skew += SWEEP_FLOOR_MS + 1_000;
}

const sweep = (body: unknown = {}) =>
  request(app.getHttpServer()).post('/api/github/sweep').set('content-type', 'application/json').send(JSON.stringify(body));
/** Issue-list reads per repo: the poller's one call per synced repo. */
const syncs = (repo: string) => gh.calls.filter((c) => c.method === 'GET' && c.url.includes(`/repos/${repo}/issues?`)).length;
const prReads = (repo: string) => gh.graphqlCalls('PullRequests', repo).length;
const stateOf = (repo: string) => (poller as unknown as { stateOf(r: string): { sleepUntil: number | null; secondaryUntil: number | null } }).stateOf(repo);

beforeEach(() => {
  skew = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await app.close();
  process.env = { ...env };
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/github/sweep', () => {
  it('is 409 with no token, and makes no call', async () => {
    await build([FAKE_REPO], { token: false });
    expect((await sweep().expect(409)).body).toEqual({ message: 'GitHub is not being polled' });
    expect(gh.calls).toEqual([]);
  });

  it('a press whose sweep finds the token gone leaves no forced repo behind for the next one', async () => {
    await build([FAKE_REPO], { intervals: { [FAKE_REPO]: '5m' } });
    // Armed (a timer is pending) but the token is removed before the sweep runs: the sweep exits at its no-token check.
    delete process.env[GITHUB_TOKEN_ENV];
    await poller.sweepNow();
    expect((poller as unknown as { forceNow: Set<string> }).forceNow.size).toBe(0);
  });

  it('is 409 when nothing is armed: every connected repo off, its cold sync spent', async () => {
    await build([OFF_REPO], { intervals: { [OFF_REPO]: 'off' } });
    expect((await sweep().expect(409)).body).toEqual({ message: 'GitHub is not being polled' });
  });

  it('skips an off repo, syncs the others regardless of due, and answers the trackers payload', async () => {
    await build([FAKE_REPO, OTHER, OFF_REPO], { intervals: { [FAKE_REPO]: '5m', [OTHER]: '5m', [OFF_REPO]: 'off' } });
    // 1h repos are not due a second after their cold sync; the press syncs them anyway.
    const res = await sweep().expect(200);
    expect(syncs(FAKE_REPO)).toBe(1);
    expect(syncs(OTHER)).toBe(1);
    expect(syncs(OFF_REPO)).toBe(0);
    expect(res.body.platforms[0]).toMatchObject({ kind: 'github', hasToken: true });
    expect(res.body.projects).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toContain('tok"');
  });

  it('two concurrent presses make one call per repo', async () => {
    await build([FAKE_REPO, OTHER], { intervals: { [FAKE_REPO]: '5m', [OTHER]: '5m' } });
    await Promise.all([sweep().expect(200), sweep().expect(200)]);
    expect(syncs(FAKE_REPO)).toBe(1);
    expect(syncs(OTHER)).toBe(1);
  });

  it('a press a second later makes no call', async () => {
    await build([FAKE_REPO], { intervals: { [FAKE_REPO]: '5m' } });
    await sweep().expect(200);
    const after = gh.calls.length;
    skew += 1_000;
    await sweep().expect(200);
    expect(gh.calls.length).toBe(after);
  });

  it('names one repo: only it is synced', async () => {
    await build([FAKE_REPO, OTHER], { intervals: { [FAKE_REPO]: '5m', [OTHER]: '5m' } });
    await sweep({ repo: OTHER }).expect(200);
    expect(syncs(OTHER)).toBe(1);
    expect(syncs(FAKE_REPO)).toBe(0);
  });

  it('an unregistered repo is 404 with the existing sentence', async () => {
    await build([FAKE_REPO]);
    const res = await sweep({ repo: 'nobody/else' }).expect(404);
    expect(res.body).toEqual({ error: 'nobody/else is not the repo of a registered GitHub project' });
    expect(gh.calls).toEqual([]);
  });

  it.each([[{ repo: 3 }], [{ repo: 'not a repo' }], [{ repo: '' }]])('the body %j is 400', async (body) => {
    await build([FAKE_REPO]);
    const res = await sweep(body).expect(400);
    expect(res.body.error).toContain('repo');
    expect(gh.calls).toEqual([]);
  });

  it('an asleep named repo is 429 with the later of both ends, and makes no call', async () => {
    await build([FAKE_REPO]);
    const hourly = Date.now() + 600_000;
    const secondary = Date.now() + 900_000;
    Object.assign(stateOf(FAKE_REPO), { sleepUntil: hourly, secondaryUntil: secondary });
    const res = await sweep({ repo: FAKE_REPO }).expect(429);
    expect(res.body).toEqual({ message: 'rate limited', retryAt: new Date(secondary).toISOString() });
    expect(gh.calls).toEqual([]);
  });

  it('with no repo named, an asleep repo is left untouched and the rest is a 200', async () => {
    await build([FAKE_REPO, OTHER], { intervals: { [FAKE_REPO]: '5m', [OTHER]: '5m' } });
    Object.assign(stateOf(FAKE_REPO), { sleepUntil: Date.now() + 600_000 });
    await sweep().expect(200);
    expect(syncs(FAKE_REPO)).toBe(0);
    expect(syncs(OTHER)).toBe(1);
  });

  it('a 401 is a 200 and leaves the cache as it was, with access saying why', async () => {
    await build([FAKE_REPO], { intervals: { [FAKE_REPO]: '5m' } });
    const polledBefore = (await request(app.getHttpServer()).get('/api/trackers')).body.projects[0].polledAt;
    gh.failNext = { fragment: `/repos/${FAKE_REPO}/issues`, status: 401, message: 'Bad credentials' };
    const res = await sweep().expect(200);
    expect(res.body.projects[0]).toMatchObject({ access: 'forbidden', polledAt: polledBefore });
  });

  it('re-reads the PR cache once per swept repo, and only past its TTL', async () => {
    await build([FAKE_REPO, OTHER], { intervals: { [FAKE_REPO]: '5m', [OTHER]: '5m' } });
    // The cache is cold: the press fills it, one read per repo, joined by two presses.
    await Promise.all([sweep().expect(200), sweep().expect(200)]);
    expect(prReads(FAKE_REPO)).toBe(1);
    expect(prReads(OTHER)).toBe(1);
    // Past the floor but inside the TTL: the repos are swept again, the cache is not.
    skew += SWEEP_FLOOR_MS + 1_000;
    await sweep().expect(200);
    expect(syncs(FAKE_REPO)).toBe(2);
    expect(prReads(FAKE_REPO)).toBe(1);
    // Past the TTL: one more read each.
    skew += PR_TTL_MS;
    await sweep().expect(200);
    expect(prReads(FAKE_REPO)).toBe(2);
    expect(prReads(OTHER)).toBe(2);
  });

  it('is refused by the guard from another origin and with no content type', async () => {
    await build([FAKE_REPO]);
    await sweep().set('origin', 'http://evil.test').expect(403);
    await request(app.getHttpServer()).post('/api/github/sweep').send('{}').expect(403);
    expect(gh.calls).toEqual([]);
  });
});
