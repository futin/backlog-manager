import { GitlabClient, type RawMr } from '../server/src/gitlab/gitlab.client';
import { GitlabPollerService } from '../server/src/gitlab/poller.service';
import { GITLAB_POLL_MS, GITLAB_SWEEP_WAIT_MS, type GitlabPayload } from '../shared/types';
import { FakeGitlab, rawMr } from './helpers/gitlab';

const SITE = 'www.gitlab.timify.io';
const TOKEN = 'glpat-secret-token';
/** The PAT a remote on this machine can carry in its userinfo (Review Focus 1); it must never reach a payload. */
const REMOTE_PAT = 'glpat-abc';
const MS = 'development/backend/microservice';
const PROXY = 'development/dev-api-graphql-proxy';
const T0 = Date.parse('2026-11-12T10:00:00.000Z');

const ORIGINS: Record<string, string> = {
  '/repos/microservice': `git@${SITE}:${MS}.git`,
  '/repos/proxy': `https://oauth2:${REMOTE_PAT}@${SITE}/${PROXY}.git`,
  '/repos/gh': 'git@github.com:acme/widgets.git'
};

const listPath = (project: string): string => `/api/v4/projects/${encodeURIComponent(project)}/merge_requests`;
const detailPath = (project: string, iid: number): string => `${listPath(project)}/${iid}`;

/** A Response body is read through streams, which take event-loop turns, not just microtasks: an un-awaited identity read needs a few to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Harness {
  svc: GitlabPollerService;
  fake: FakeGitlab;
  clock: { now: number };
  listeners: (() => void)[];
  setRepos(r: Record<string, string[]>): void;
  setEnv(e: NodeJS.ProcessEnv): void;
  userCalls(): number;
  paths(): string[];
}

const made: GitlabPollerService[] = [];

function setup(
  opts: { repos?: Record<string, string[]>; env?: NodeJS.ProcessEnv; client?: GitlabClient; fake?: FakeGitlab } = {}
): Harness {
  const fake = opts.fake ?? new FakeGitlab();
  const clock = { now: T0 };
  const listeners: (() => void)[] = [];
  let repos = opts.repos ?? { TIMIFY: ['/repos/microservice'] };
  let env: NodeJS.ProcessEnv = opts.env ?? { BM_GITLAB_SITE: SITE, BM_GITLAB_TOKEN: TOKEN };
  const svc = new GitlabPollerService(
    opts.client ?? new GitlabClient(fake.fetch),
    { onReposChanged: (l: () => void) => void listeners.push(l) },
    {
      repos: () => repos,
      readOrigin: async (p) => ORIGINS[p] ?? null,
      env: () => env,
      now: () => clock.now
    }
  );
  made.push(svc);
  return {
    svc,
    fake,
    clock,
    listeners,
    setRepos: (r) => (repos = r),
    setEnv: (e) => (env = e),
    userCalls: () => fake.calls.filter((c) => new URL(c.url).pathname === '/api/v4/user').length,
    paths: () => fake.calls.map((c) => new URL(c.url).pathname)
  };
}

afterEach(() => {
  for (const svc of made.splice(0)) {
    // Every case, whatever it drove: neither the server's token nor a remote's PAT reaches the payload.
    const json = JSON.stringify(svc.payload());
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(REMOTE_PAT);
    svc.onApplicationShutdown();
  }
  jest.useRealTimers();
});

/** Bootstrap and wait for the immediate sweep it starts. */
async function boot(h: Harness): Promise<GitlabPayload> {
  h.svc.onApplicationBootstrap();
  await h.svc.tick();
  return h.svc.payload();
}

describe('GitlabPollerService — configuration and arming', () => {
  it('unconfigured: the status says so and nothing is asked of GitLab', async () => {
    const h = setup({ env: {} });
    expect(h.svc.payload().status).toMatchObject({ state: 'unconfigured', site: null, malformedSite: false, armed: false, user: null, mappedRepos: 0 });
    h.svc.arm();
    h.svc.onApplicationBootstrap();
    await settle();
    expect(h.fake.calls).toHaveLength(0);
    expect(h.svc.armed).toBe(false);
  });

  it('a malformed site is unconfigured with malformedSite set', () => {
    const h = setup({ env: { BM_GITLAB_SITE: 'https://www.gitlab.timify.io', BM_GITLAB_TOKEN: TOKEN } });
    expect(h.svc.payload().status).toMatchObject({ state: 'unconfigured', site: null, malformedSite: true });
  });

  it('armed reads true while the first sweep is still waiting on GitLab', async () => {
    const h = setup();
    h.fake.script.set(listPath(MS), { delay: 50 });
    h.svc.onApplicationBootstrap();
    await settle();
    expect(h.paths()).toContain(listPath(MS));
    expect(h.svc.armed).toBe(true);
    expect(h.svc.payload().status.armed).toBe(true);
    await h.svc.tick();
  });

  it('a healthy first sweep is connected, with the user, one mapped repo and its project view', async () => {
    const h = setup();
    const p = await boot(h);
    expect(p.status).toMatchObject({
      state: 'connected',
      site: SITE,
      user: { username: 'ada', name: 'Ada Lovelace' },
      mappedRepos: 1,
      armed: true,
      httpStatus: null,
      reason: null,
      retryAt: null,
      problems: []
    });
    expect(p.jiraProjects.TIMIFY[0]).toEqual({ path: MS, repo: 'microservice', polledAt: new Date(T0).toISOString(), capped: false, failed: false });
  });

  it('bootstrap with a healthy identity and a mapped repo makes exactly one /user call through the first sweep', async () => {
    const h = setup();
    await boot(h);
    expect(h.userCalls()).toBe(1);
  });

  it('no repo on the site: idle, disarmed, the found hosts named; a repos save that maps one arms it', async () => {
    const h = setup({ repos: { TIMIFY: ['/repos/gh'] } });
    const p = await boot(h);
    expect(p.status).toMatchObject({ state: 'idle', armed: false, mappedRepos: 0, foundHosts: ['github.com'] });
    expect(h.paths().some((x) => x.includes('/merge_requests'))).toBe(false);

    h.setRepos({ TIMIFY: ['/repos/microservice'] });
    for (const l of h.listeners) l();
    await h.svc.tick();
    expect(h.paths()).toContain(listPath(MS));
    expect(h.svc.payload().status).toMatchObject({ state: 'connected', armed: true, mappedRepos: 1 });
  });

  it('an origin that cannot be read is a per-repo problem', async () => {
    const h = setup({ repos: { TIMIFY: ['/repos/microservice', '/repos/missing'] } });
    const p = await boot(h);
    expect(p.status.problems).toEqual([{ kind: 'origin', repo: 'missing' }]);
    expect(p.status.state).toBe('connected');
  });
});

describe('GitlabPollerService — what a sweep reads', () => {
  function seedFixture(fake: FakeGitlab): void {
    fake.seed(MS, 'opened', [
      rawMr(412, { source_branch: 'timify-123-export', head_pipeline: { status: 'success' } }),
      rawMr(419, { title: 'TIMIFY-150 | split', draft: true, head_pipeline: { status: 'failed' } }),
      rawMr(500, { source_branch: 'chore/deps', head_pipeline: { status: 'success' } })
    ]);
    fake.seed(MS, 'merged', [rawMr(398, { state: 'merged', source_branch: 'fix/timify-118', merged_at: '2026-11-05T10:00:00.000Z' })]);
    fake.seed(MS, 'closed', [rawMr(390, { state: 'closed', source_branch: 'timify-117' })]);
  }

  it('keeps keyed MRs only, reads a pipeline for open ones only', async () => {
    const h = setup();
    seedFixture(h.fake);
    const p = await boot(h);
    expect(p.mrs.map((m) => m.iid)).toEqual([412, 419, 398, 390]);
    const by = new Map(p.mrs.map((m) => [m.iid, m]));
    expect(by.get(412)).toMatchObject({ keys: ['TIMIFY-123'], pipeline: 'success', state: 'opened', draft: false, project: MS, sourceBranch: 'timify-123-export' });
    expect(by.get(419)).toMatchObject({ keys: ['TIMIFY-150'], pipeline: 'failed', state: 'opened', draft: true, title: 'TIMIFY-150 | split' });
    expect(by.get(398)).toMatchObject({ keys: ['TIMIFY-118'], pipeline: null, state: 'merged', mergedAt: '2026-11-05T10:00:00.000Z' });
    expect(by.get(390)).toMatchObject({ keys: ['TIMIFY-117'], pipeline: null, state: 'closed', mergedAt: null });
    expect(by.has(500)).toBe(false);

    const details = h.paths()
      .map((x) => /\/merge_requests\/(\d+)$/.exec(x)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    expect(details).toEqual([412, 419]);
  });

  it('asks merged and closed lists for the last 30 days only', async () => {
    const h = setup();
    await boot(h);
    const lists = h.fake.calls.map((c) => new URL(c.url)).filter((u) => u.pathname === listPath(MS));
    const since = new Date(T0 - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(lists.map((u) => [u.searchParams.get('state'), u.searchParams.get('updated_after')])).toEqual([
      ['opened', null],
      ['merged', since],
      ['closed', since]
    ]);
  });

  it('a pipeline survives a failed detail read; a new MR whose detail fails reads none; 0/5xx turns the state unreachable, 404 does not', async () => {
    const h = setup();
    h.fake.seed(MS, 'opened', [rawMr(412, { source_branch: 'timify-123-export', head_pipeline: { status: 'success' } })]);
    await boot(h);
    expect(h.svc.payload().mrs[0].pipeline).toBe('success');

    h.fake.seed(MS, 'opened', [
      rawMr(412, { source_branch: 'timify-123-export', head_pipeline: { status: 'success' } }),
      rawMr(413, { source_branch: 'timify-124-new', head_pipeline: { status: 'success' } })
    ]);
    h.fake.script.set(detailPath(MS, 412), { status: 500 });
    h.fake.script.set(detailPath(MS, 413), { status: 500 });
    h.clock.now = T0 + GITLAB_POLL_MS;
    await h.svc.tick();
    let p = h.svc.payload();
    expect(p.mrs.find((m) => m.iid === 412)?.pipeline).toBe('success');
    expect(p.mrs.find((m) => m.iid === 413)?.pipeline).toBe('none');
    expect(p.jiraProjects.TIMIFY[0]).toMatchObject({ failed: false, polledAt: new Date(T0 + GITLAB_POLL_MS).toISOString() });
    expect(p.status).toMatchObject({ state: 'unreachable', httpStatus: 500 });

    h.fake.script.set(detailPath(MS, 412), { status: 404 });
    h.fake.script.set(detailPath(MS, 413), { status: 404 });
    await h.svc.tick();
    p = h.svc.payload();
    expect(p.status.state).toBe('connected');
    expect(p.mrs.find((m) => m.iid === 412)?.pipeline).toBe('success');
    expect(p.mrs.find((m) => m.iid === 413)?.pipeline).toBe('none');
  });

  it('two Jira keys over two projects: each key sees only its projects, each MR only its project keys', async () => {
    const h = setup({ repos: { TIMIFY: ['/repos/microservice', '/repos/proxy'], PAY: ['/repos/microservice'] } });
    h.fake.seed(PROXY, 'opened', [rawMr(7, { source_branch: 'pay-7' })]);
    h.fake.seed(MS, 'opened', [rawMr(8, { source_branch: 'pay-8-fix' })]);
    const p = await boot(h);
    expect(p.jiraProjects.PAY.map((v) => v.path)).toEqual([MS]);
    expect(p.jiraProjects.TIMIFY.map((v) => v.path)).toEqual([MS, PROXY]);
    expect(p.jiraProjects.TIMIFY[1].repo).toBe('proxy');
    expect(p.mrs).toHaveLength(1);
    expect(p.mrs[0]).toMatchObject({ iid: 8, project: MS, keys: ['PAY-8'] });
    expect(p.status.mappedRepos).toBe(2);
  });

  it('caps a project at five pages: capped, a problem naming the rows shown, and no finished list asked', async () => {
    const h = setup();
    h.fake.seed(MS, 'opened', Array.from({ length: 600 }, (_, i) => rawMr(1000 + i)));
    const p = await boot(h);
    const lists = h.fake.calls.map((c) => new URL(c.url)).filter((u) => u.pathname === listPath(MS));
    expect(lists.map((u) => `${u.searchParams.get('state')}:${u.searchParams.get('page')}`)).toEqual([
      'opened:1',
      'opened:2',
      'opened:3',
      'opened:4',
      'opened:5'
    ]);
    expect(p.jiraProjects.TIMIFY[0].capped).toBe(true);
    expect(p.status.problems).toEqual([{ kind: 'capped', path: MS, shown: 500 }]);
    expect(p.status.state).toBe('connected');
  });

  it('a project whose list answers 404 is failed with a cannot-read problem, and the state stays connected', async () => {
    const h = setup({ repos: { TIMIFY: ['/repos/microservice', '/repos/proxy'] } });
    h.fake.script.set(listPath(PROXY), { status: 404, body: { message: '404 Project Not Found' } });
    const p = await boot(h);
    const views = new Map(p.jiraProjects.TIMIFY.map((v) => [v.path, v]));
    expect(views.get(MS)?.failed).toBe(false);
    expect(views.get(PROXY)).toMatchObject({ failed: true, polledAt: null });
    expect(p.status.problems).toEqual([{ kind: 'cannot-read', path: PROXY, status: 404 }]);
    expect(p.status.state).toBe('connected');
  });

  it('failure keeps the last good answer: status 0, then a refused redirect, then a healthy sweep', async () => {
    const h = setup();
    h.fake.seed(MS, 'opened', [rawMr(412, { source_branch: 'timify-123-export', head_pipeline: { status: 'running' } })]);
    await boot(h);
    const polledAt = new Date(T0).toISOString();

    h.fake.script.set(listPath(MS), { throws: new TypeError('fetch failed') });
    h.clock.now = T0 + GITLAB_POLL_MS;
    await h.svc.tick();
    let p = h.svc.payload();
    expect(p.mrs.map((m) => m.iid)).toEqual([412]);
    expect(p.mrs[0].pipeline).toBe('running');
    expect(p.jiraProjects.TIMIFY[0]).toMatchObject({ failed: true, polledAt });
    expect(p.status).toMatchObject({ state: 'unreachable', reason: 'fetch failed', user: { username: 'ada' } });
    expect(p.status.problems).toEqual([]);

    h.fake.script.set(listPath(MS), { status: 302, headers: { location: 'https://gitlab.timify.io/elsewhere' } });
    await h.svc.tick();
    p = h.svc.payload();
    expect(p.status).toMatchObject({ state: 'unreachable', reason: 'redirect refused (302)' });
    expect(p.mrs.map((m) => m.iid)).toEqual([412]);
    expect(h.fake.calls.every((c) => new URL(c.url).host === SITE)).toBe(true);

    h.fake.script.delete(listPath(MS));
    h.clock.now = T0 + 3 * GITLAB_POLL_MS;
    await h.svc.tick();
    p = h.svc.payload();
    expect(p.status).toMatchObject({ state: 'connected', reason: null });
    expect(p.jiraProjects.TIMIFY[0]).toMatchObject({ failed: false, polledAt: new Date(T0 + 3 * GITLAB_POLL_MS).toISOString() });
  });
});

describe('GitlabPollerService — identity', () => {
  async function identityAnswering(status: number, body?: unknown): Promise<GitlabPayload['status']> {
    const h = setup({ repos: {} });
    h.fake.script.set('/api/v4/user', { status, body });
    expect(h.svc.payload().status.state).toBe('checking');
    await settle();
    return h.svc.payload().status;
  }

  it('401 and 403 are rejected, with the status and GitLab’s message', async () => {
    expect(await identityAnswering(401, { message: '401 Unauthorized' })).toMatchObject({
      state: 'rejected',
      httpStatus: 401,
      reason: '401 Unauthorized',
      user: null
    });
    expect(await identityAnswering(403, { error: 'insufficient_scope' })).toMatchObject({ state: 'rejected', httpStatus: 403, reason: 'insufficient_scope' });
  });

  it('a token refused from boot leaves every mapped project never read and failed, so a ticket reads “could not be read”, not “not read yet”', async () => {
    const h = setup();
    h.fake.script.set('/api/v4/user', { status: 401, body: { message: '401 Unauthorized' } });
    const p = await boot(h);
    expect(p.status.state).toBe('rejected');
    expect(h.paths().filter((x) => x.startsWith(listPath(MS)))).toEqual([]);
    expect(p.jiraProjects.TIMIFY[0]).toEqual({ path: MS, repo: 'microservice', polledAt: null, capped: false, failed: true });
  });

  it('a refused 302 and a 503 are unreachable', async () => {
    expect(await identityAnswering(302)).toMatchObject({ state: 'unreachable', reason: 'redirect refused (302)', httpStatus: null });
    expect(await identityAnswering(503)).toMatchObject({ state: 'unreachable', httpStatus: 503 });
  });

  it('an unreachable identity outranks healthy MR reads', async () => {
    const h = setup();
    h.fake.script.set('/api/v4/user', { status: 503 });
    h.fake.seed(MS, 'opened', [rawMr(412, { source_branch: 'timify-123-export' })]);
    const p = await boot(h);
    expect(p.status).toMatchObject({ state: 'unreachable', user: null });
    expect(p.mrs.map((m) => m.iid)).toEqual([412]);
  });

  it('payload() retries an unreachable identity at most once a minute, from the last read’s start', async () => {
    const h = setup();
    h.fake.script.set('/api/v4/user', { status: 503 });
    await boot(h);
    expect(h.svc.payload().status.state).toBe('unreachable');
    expect(h.userCalls()).toBe(1);

    h.fake.script.delete('/api/v4/user');
    h.clock.now = T0 + 30_000;
    h.svc.payload();
    await settle();
    expect(h.userCalls()).toBe(1);
    expect(h.svc.payload().status.state).toBe('unreachable');

    h.clock.now = T0 + 60_000;
    h.svc.payload();
    await settle();
    expect(h.userCalls()).toBe(2);
    expect(h.svc.payload().status).toMatchObject({ state: 'connected', user: { username: 'ada' } });
  });

  it('a sweep retries an unreachable identity once the minute is up', async () => {
    const h = setup();
    h.fake.script.set('/api/v4/user', { status: 503 });
    await boot(h);
    h.fake.script.delete('/api/v4/user');
    h.clock.now = T0 + 60_000;
    await h.svc.tick();
    expect(h.userCalls()).toBe(2);
    expect(h.svc.payload().status.state).toBe('connected');
  });

  it('the repo-less variant of the sweep retry ends idle', async () => {
    const h = setup({ repos: {} });
    h.fake.script.set('/api/v4/user', { status: 503 });
    await boot(h);
    expect(h.svc.payload().status.state).toBe('unreachable');
    h.fake.script.delete('/api/v4/user');
    h.clock.now = T0 + 60_000;
    await h.svc.tick();
    expect(h.userCalls()).toBe(2);
    expect(h.svc.payload().status).toMatchObject({ state: 'idle', armed: false });
  });

  it('a 401 on a project list re-reads the identity within that sweep', async () => {
    const h = setup();
    await boot(h);
    expect(h.svc.payload().status.state).toBe('connected');

    h.fake.script.set(listPath(MS), { status: 401, body: { message: '401 Unauthorized' } });
    h.fake.script.set('/api/v4/user', { status: 401, body: { message: '401 Unauthorized' } });
    await h.svc.tick();
    expect(h.userCalls()).toBe(2);
    expect(h.svc.payload().status).toMatchObject({ state: 'rejected', httpStatus: 401, user: null });
  });

  it('a changed token reads checking and is asked for again', async () => {
    const h = setup({ repos: {} });
    h.svc.payload();
    await settle();
    expect(h.svc.payload().status.state).toBe('idle');
    expect(h.userCalls()).toBe(1);

    h.setEnv({ BM_GITLAB_SITE: SITE, BM_GITLAB_TOKEN: 'glpat-another-token' });
    expect(h.svc.payload().status.state).toBe('checking');
    expect(h.userCalls()).toBe(2);
    const last = h.fake.calls[h.fake.calls.length - 1];
    expect(new Headers(last.init?.headers).get('PRIVATE-TOKEN')).toBe('glpat-another-token');
    await settle();
    expect(JSON.stringify(h.svc.payload())).not.toContain('glpat-another-token');
  });
});

describe('GitlabPollerService — rate limit and sweepNow', () => {
  it('a 429 opens the window: retryAt on the status, sweepNow waits, and the window expires where read', async () => {
    const h = setup();
    h.fake.script.set(listPath(MS), { status: 429, headers: { 'retry-after': '30' } });
    const p = await boot(h);
    expect(p.status.retryAt).toBe(new Date(T0 + 30_000).toISOString());
    expect(p.status.state).toBe('connected');
    expect(await h.svc.sweepNow()).toEqual({ kind: 'wait', retryAt: T0 + 30_000 });

    h.clock.now = T0 + 30_001;
    expect(h.svc.payload().status.retryAt).toBeNull();
  });

  it('one sweep in flight: two sweepNow() calls and a tick() share it', async () => {
    const h = setup();
    h.fake.script.set(listPath(MS), { delay: 50 });
    h.svc.onApplicationBootstrap();
    const all = Promise.all([h.svc.sweepNow(), h.svc.sweepNow(), h.svc.tick()]);
    const [a, b] = await all;
    expect(a).toEqual({ kind: 'done' });
    expect(b).toEqual({ kind: 'done' });
    const firstPages = h.fake.calls
      .map((c) => new URL(c.url))
      .filter((u) => u.pathname === listPath(MS) && u.searchParams.get('state') === 'opened' && u.searchParams.get('page') === '1');
    expect(firstPages).toHaveLength(1);
  });

  it('sweepNow() with nothing mapped answers not-armed, even straight after arm()', async () => {
    const h = setup({ repos: {} });
    h.svc.arm();
    expect(await h.svc.sweepNow()).toEqual({ kind: 'not-armed' });
    expect(await h.svc.sweepNow()).toEqual({ kind: 'not-armed' });
  });

  it('sweepNow() joins the re-arm sweep an arm() that landed mid-sweep started, rather than answering not-armed', async () => {
    const h = setup({ repos: {} });
    h.fake.script.set('/api/v4/user', { delay: 50 });
    h.svc.arm(); // sweep 1 starts, derives an empty mapping, then waits on the identity read
    h.setRepos({ TIMIFY: ['/repos/microservice'] });
    h.svc.arm(); // lands mid-sweep: sweep 1 will disarm, then re-arm itself
    expect(await h.svc.sweepNow()).toEqual({ kind: 'done' });
    expect(h.svc.armed).toBe(true);
  });

  it('sweepNow() on an armed poller sweeps again', async () => {
    const h = setup();
    await boot(h);
    const before = h.paths().filter((x) => x === listPath(MS)).length;
    expect(await h.svc.sweepNow()).toEqual({ kind: 'done' });
    expect(h.paths().filter((x) => x === listPath(MS)).length).toBeGreaterThan(before);
  });

  it('sweepNow() answers done after GITLAB_SWEEP_WAIT_MS when GitLab never answers', async () => {
    jest.useFakeTimers({ doNotFake: ['Date', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    // A client that never settles at all — not even at the client's own deadline — so the only thing that can end the wait is the sweep route's bound.
    const never = (): Promise<never> => new Promise<never>(() => undefined);
    const client = { currentUser: never, listMergeRequests: never, mergeRequest: never } as unknown as GitlabClient;
    const h = setup({ client });
    h.svc.arm();
    let answer: unknown = null;
    void h.svc.sweepNow().then((r) => (answer = r));
    await jest.advanceTimersByTimeAsync(GITLAB_SWEEP_WAIT_MS - 1);
    expect(answer).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ kind: 'done' });
  });
});
