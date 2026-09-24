import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ItemsModule } from '../server/src/items/items.module';
import { GithubSource } from '../server/src/items/sources/github.source';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { parseClaim, renderClaim } from '../server/src/tracker/claim';
import { FakeGithub } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';
import { CLAIM_STALE_MS } from '../shared/types';
import type { ClaimRecord, ClaimRun, ItemsIndex } from '../shared/types';

/**
 * The eight write routes and the claim protocol, end to end (task-46,
 * spec §6.2 and §6.3; `queue` is the orchestrator:queued spec's §2).
 *
 * The network is an in-memory GitHub behind a REAL `GithubClient`
 * (`test/helpers/github.ts` — see its header for why a whole little server
 * rather than a stub per case).
 *
 * ## The settle window is zero here
 *
 * `GithubSource.settleMs` is set to `0` in `build`. The cases are about which
 * comments are in the UNION, and a real one-second wait in each of them would
 * add a minute to the suite to test nothing it is about.
 */

const REPO = 'futin/x';
const TOKEN = 'ghp_task46SentinelValueNoPayloadMayCarry';
const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: REPO });

const dirs: string[] = [];

let app: INestApplication;
let gh: FakeGithub;
let filesPath: string;
let trackerPath: string;
let registryFile: string;
const env = { ...process.env };

function project(name: string, marker?: string): string {
  const root = makeProject(name, [], marker);
  dirs.push(root);
  return root;
}

/**
 * One files project and one GitHub project in one registry, so every case can
 * assert both halves of its rule — the write lands on `gamma`, and `alpha` is
 * refused — in the same app.
 */
async function build(): Promise<void> {
  gh = new FakeGithub();
  filesPath = project('alpha');
  trackerPath = project('gamma', GITHUB_MARKER);
  registryFile = makeRegistry([
    { name: 'alpha', path: filesPath },
    { name: 'gamma', path: trackerPath }
  ]);

  const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(registryFile)
    .overrideProvider(GithubClient)
    .useValue(new GithubClient(gh.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  app.get(GithubSource).settleMs = 0;
  // The poller arms itself at bootstrap (a github project is registered and a
  // token is present), so a case that asserted `gh.calls` was empty would be
  // asserting against whatever that background sweep happened to have made. One
  // awaited tick, disarmed, and the log cleared — from here every recorded call
  // belongs to the case.
  await sync();
}

/** Seed the poller's cache the way a real sweep would, then forget the calls
 *  it made — every case counts the requests its OWN write produced. */
async function sync(): Promise<void> {
  const poller = app.get(TrackerPollerService);
  await poller.tick();
  poller.disarm();
  gh.calls.length = 0;
}

function post(route: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(`/api/items/${route}`).send(body);
}

/** The claim inside one comment of the fake, parsed back out — what every
 *  protocol case asserts against. */
function claimIn(id: number): ClaimRecord | null {
  const comment = gh.comments.get(id);
  return comment === undefined ? null : parseClaim(comment as never);
}

/** The registry entry the routes resolve for `gamma` — what the two
 *  adapter-level cases below pass in place of going through HTTP. */
function registryEntry(): { name: string; path: string; createdAt: string } {
  return { name: 'gamma', path: trackerPath, createdAt: '2026-08-26T00:00:00.000Z' };
}

function record(over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    v: 1,
    session: 'A',
    phase: 'groom',
    at: new Date(Date.now() - 60_000).toISOString(),
    heartbeat: new Date().toISOString(),
    counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 },
    ...over
  };
}

beforeEach(async () => {
  process.env[GITHUB_TOKEN_ENV] = TOKEN;
  await build();
});

afterEach(async () => {
  await app.close();
  process.env = { ...env };
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/* =========================================================================
 * The project gate — the four refusals answered before any adapter is reached.
 * ========================================================================= */

describe('the project gate', () => {
  it('refuses a files project with a 400 naming files, and makes no request', async () => {
    const res = await post('create', { project: filesPath, section: 'bugs', title: 't', body: 'b' }).expect(400);
    expect(res.body.error).toMatch(/files/);
    expect(gh.calls).toEqual([]);
  });

  it('answers 404 for a path nobody registered, and makes no request', async () => {
    await post('create', { project: '/nowhere', section: 'bugs', title: 't', body: 'b' }).expect(404);
    expect(gh.calls).toEqual([]);
  });

  it('answers 400 carrying resolveSource-s own reason for an unsupported marker, and makes no request', async () => {
    const gitlab = project('delta', JSON.stringify({ kind: 'gitlab', repo: 'a/b' }));
    const file = makeRegistry([{ name: 'delta', path: gitlab }]);
    await app.close();
    const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(file)
      .overrideProvider(GithubClient)
      .useValue(new GithubClient(gh.fetch))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);

    const res = await post('create', { project: gitlab, section: 'bugs', title: 't', body: 'b' }).expect(400);
    expect(res.body.error).toMatch(/unsupported source kind "gitlab"/);
    expect(gh.calls).toEqual([]);
  });

  /* 503 and not 401: a missing credential is a fact about THIS machine that the
     person reading the message can fix, and sending an empty Authorization
     header would earn a 401 that reads like a revoked token. */
  it('answers 503 naming BM_GITHUB_TOKEN when there is no token, and makes no request', async () => {
    delete process.env[GITHUB_TOKEN_ENV];
    const res = await post('create', { project: trackerPath, section: 'bugs', title: 't', body: 'b' }).expect(503);
    expect(res.body.error).toContain('BM_GITHUB_TOKEN');
    expect(gh.calls).toEqual([]);
  });

  it('refuses a malformed body before it looks at the project at all', async () => {
    await post('create', { project: trackerPath, section: 'nonsense', title: 't', body: 'b' }).expect(400);
    await post('claim', { project: trackerPath, id: '#31', phase: 'sideways', session: 'A' }).expect(400);
    await post('release', { project: trackerPath, id: '#31', commentId: 1.5, session: 'A', reason: 'x' }).expect(400);
    expect(gh.calls).toEqual([]);
  });

  /* Another repo's URN is refused, and this is the load-bearing one: the route
     already knows which repo it is writing to, so a URN naming a different one
     is a caller asking this project's credential to write somewhere else. */
  it('refuses a URN naming another repo', async () => {
    await sync();
    await post('comment', { project: trackerPath, id: 'gh:other/y#31', body: 'hello' }).expect(404);
    expect(gh.matching('/comments', 'POST')).toEqual([]);
  });
});

/* =========================================================================
 * create / state / body / comment
 * ========================================================================= */

describe('create', () => {
  it('labels a bug type:bug and answers every handle', async () => {
    await sync();
    const res = await post('create', { project: trackerPath, section: 'bugs', title: 't', body: 'b' }).expect(201);
    expect(res.body).toEqual({ id: '#77', urn: 'gh:futin/x#77', url: 'https://github.com/futin/x/issues/77', number: 77 });

    const posts = gh.matching('/issues', 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ title: 't', body: 'b', labels: ['type:bug'] });
  });

  /* Absorption: the created issue is in the cache before the request returns,
     so the very next board read shows it. Without this a person watching the
     board would not see an issue they just filed for up to a poll interval. */
  it('shows the new item on the next /api/items with no poll tick', async () => {
    await sync();
    await post('create', { project: trackerPath, section: 'bugs', title: 'brand new', body: 'b' }).expect(201);

    /* The token is removed before the read, and that is what makes this case
       prove anything: `list` arms the poller on every call, so with a token in
       place a background sweep could fetch the issue and the assertion would
       pass with absorption reverted. With no token `shouldPoll` is false, no
       request is possible at all, and the only way `#77` can be in the payload
       is the cache the write itself filled. */
    gh.calls.length = 0;
    delete process.env[GITHUB_TOKEN_ENV];

    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    expect((res.body as ItemsIndex).items.map((i) => i.id)).toContain('#77');
    expect(gh.calls).toEqual([]);
  });

  it('adds a kind label for a refactor', async () => {
    await sync();
    await post('create', { project: trackerPath, section: 'refactors', title: 't', body: 'b', kind: 'debt' }).expect(201);
    expect(gh.matching('/issues', 'POST')[0].body).toMatchObject({ labels: ['type:refactor', 'kind:debt'] });
  });

  /* A 400 rather than a dropped field, and no request: GitHub CREATES an
     unknown label silently on first use, so a dropped `kind: 'big'` would show
     up as a mystery grey label instead of a refusal. */
  it('refuses a kind this build does not know, without asking GitHub', async () => {
    await sync();
    await post('create', { project: trackerPath, section: 'refactors', title: 't', body: 'b', kind: 'big' }).expect(400);
    expect(gh.matching('/issues', 'POST')).toEqual([]);
  });

  it('adds the runner-fix label only for a literal true', async () => {
    await sync();
    await post('create', { project: trackerPath, section: 'tasks', title: 't', body: 'b', runnerFix: true }).expect(201);
    expect(gh.matching('/issues', 'POST')[0].body).toMatchObject({ labels: ['type:task', 'runner-fix'] });

    gh.calls.length = 0;
    await post('create', { project: trackerPath, section: 'tasks', title: 't', body: 'b', runnerFix: 'yes' }).expect(201);
    expect(gh.matching('/issues', 'POST')[0].body).toMatchObject({ labels: ['type:task'] });
  });

  it('prepends the from line to the body', async () => {
    await sync();
    await post('create', { project: trackerPath, section: 'tasks', title: 't', body: '## Goal\n\ng\n', from: '#12' }).expect(201);
    expect(gh.matching('/issues', 'POST')[0].body?.body).toBe('_From #12._\n\n## Goal\n\ng\n');
  });

  /* The tracker spelling of `oos-N`: no type label at all, and a close with
     `not_planned` in the same call, which is what makes it map to out-of-scope. */
  it('creates an out-of-scope item untyped and closed not_planned', async () => {
    await sync();
    await post('create', { project: trackerPath, section: 'out-of-scope', title: 'no thanks', body: 'b' }).expect(201);

    expect(gh.matching('/issues', 'POST')[0].body).toMatchObject({ labels: [] });
    const patch = gh.matching('/issues/77', 'PATCH');
    expect(patch).toHaveLength(1);
    expect(patch[0].body).toEqual({ state: 'closed', state_reason: 'not_planned' });

    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    const created = (res.body as ItemsIndex).items.find((i) => i.id === '#77');
    expect(created?.section).toBe('out-of-scope');
    expect(created?.status).toBe('terminal');
  });
});

describe('state', () => {
  it('posts the outcome comment before it closes the issue', async () => {
    gh.issue();
    await sync();
    await post('state', { project: trackerPath, id: '#31', status: 'done', outcome: 'it worked' }).expect(201);

    const order = gh.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH');
    expect(order[0].url).toContain('/issues/31/comments');
    expect(order[0].body).toEqual({ body: 'it worked' });
    expect(order[1].method).toBe('PATCH');
    expect(order[1].body).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('closes an out-of-scope move as not_planned', async () => {
    gh.issue();
    await sync();
    await post('state', { project: trackerPath, id: '#31', status: 'out-of-scope' }).expect(201);
    expect(gh.matching('/issues/31', 'PATCH')[0].body).toEqual({ state: 'closed', state_reason: 'not_planned' });
  });

  it('posts no comment for an empty outcome', async () => {
    gh.issue();
    await sync();
    await post('state', { project: trackerPath, id: '#31', status: 'done', outcome: '   ' }).expect(201);
    expect(gh.matching('/comments', 'POST')).toEqual([]);
  });

  /* `release` clears `in-progress` and nothing else does — a `state` that
     tidied it away would hide the honest reading that something still holds
     the item. */
  it('leaves the in-progress label alone', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }, { name: 'in-progress' }] });
    await sync();
    await post('state', { project: trackerPath, id: '#31', status: 'done' }).expect(201);
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).toContain('in-progress');
    expect(gh.matching('/labels', 'DELETE')).toEqual([]);
  });

  it('shows the item as closed on the next read with no poll tick', async () => {
    gh.issue();
    await sync();
    await post('state', { project: trackerPath, id: '#31', status: 'done' }).expect(201);

    // Token removed for the reason `create`'s own absorption case gives.
    gh.calls.length = 0;
    delete process.env[GITHUB_TOKEN_ENV];

    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    expect((res.body as ItemsIndex).items.find((i) => i.id === '#31')?.status).toBe('done');
    expect(gh.calls).toEqual([]);
  });
});

describe('body', () => {
  it('reads the issue fresh, then patches when the stamp matches', async () => {
    const issue = gh.issue();
    await sync();
    const res = await post('body', { project: trackerPath, id: '#31', body: 'new text', ifUpdatedAt: issue.updated_at }).expect(201);

    const gets = gh.matching('/issues/31', 'GET');
    expect(gets).toHaveLength(1);
    const patches = gh.matching('/issues/31', 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ body: 'new text' });
    expect(res.body.updatedAt).toBe(gh.issues.get(31)?.updated_at);
  });

  /* The overwrite this check exists to prevent: somebody else rewrote the body
     between the caller's read and its write. 409 carrying the CURRENT stamp, so
     the caller can re-read and re-apply without a round trip to learn it. */
  it('refuses with a 409 and the current stamp when the issue moved, and patches nothing', async () => {
    gh.issue();
    await sync();
    const res = await post('body', { project: trackerPath, id: '#31', body: 'new text', ifUpdatedAt: '2001-01-01T00:00:00Z' }).expect(409);
    expect(res.body.updatedAt).toBe('2026-09-02T10:00:00Z');
    expect(gh.matching('/issues/31', 'PATCH')).toEqual([]);
  });

  /* Bug #220. The stamp a caller holds is the one `show --json` printed — the
     cached issue's, which is what `GET /api/items` answers as `updated`. The
     claim protocol's own writes (the `in-progress` label on `start`, the
     claim-comment edit on `heartbeat`) move GitHub's `updated_at` without the
     cache hearing about it, so a stamp comparison alone read our own
     bookkeeping as somebody else's edit.

     Read straight from the poller's cache — the value `mapIssue` hands out as
     `updated`, byte for byte — rather than through `GET /api/items`. That
     route arms the poller, and in this suite `sync()` leaves it with no timer
     pending, so `arm()` starts a sweep at once and absorbs GitHub's newer
     stamp behind the case's back. The served app always has a timer pending,
     so a `show --json` there never sweeps. */
  function cachedStamp(): string {
    const stamp = app.get(TrackerPollerService).issue(REPO, 31)?.updated_at;
    if (typeof stamp !== 'string') throw new Error('#31 has no cached stamp');
    return stamp;
  }

  it('patches after a start, on the stamp show --json hands out, though the label add moved updated_at', async () => {
    gh.issue();
    await sync();
    await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }).expect(201);
    const stamp = cachedStamp();
    // The premise: GitHub's stamp has moved on past the one the caller holds.
    expect(gh.issues.get(31)?.updated_at).not.toBe(stamp);
    gh.calls.length = 0;

    await post('body', { project: trackerPath, id: '#31', body: 'new text', ifUpdatedAt: stamp }).expect(201);
    const patches = gh.matching('/issues/31', 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ body: 'new text' });
  });

  it('patches after a start and a heartbeat, on the stamp read between them', async () => {
    gh.issue();
    await sync();
    const claimed = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }).expect(201);
    const stamp = cachedStamp();
    await post('heartbeat', { project: trackerPath, id: '#31', commentId: claimed.body.commentId, session: 'A' }).expect(201);
    gh.calls.length = 0;

    await post('body', { project: trackerPath, id: '#31', body: 'new text', ifUpdatedAt: stamp }).expect(201);
    expect(gh.matching('/issues/31', 'PATCH')).toHaveLength(1);
    expect(gh.issues.get(31)?.body).toBe('new text');
  });

  /* The overwrite the check exists for, through the new path: the stamp still
     names the cached copy, but somebody else's groom rewrote the body since. */
  it('refuses when the body itself changed since the cached read, even though the caller holds the cached stamp', async () => {
    gh.issue();
    await sync();
    const stamp = cachedStamp();
    const theirs = gh.issues.get(31)!;
    gh.issues.set(31, { ...theirs, body: 'another machine groomed this', updated_at: '2026-09-02T11:00:00Z' });
    gh.calls.length = 0;

    const res = await post('body', { project: trackerPath, id: '#31', body: 'new text', ifUpdatedAt: stamp }).expect(409);
    expect(res.body.updatedAt).toBe('2026-09-02T11:00:00Z');
    expect(gh.matching('/issues/31', 'PATCH')).toEqual([]);
  });

  /* The conservative side, pinned: once a poll refreshed the cache past the
     caller's stamp, the copy that stamp named is gone and nothing proves the
     body the caller read is the body GitHub holds. One retry, never an
     overwrite. */
  it('refuses when the cache has moved past the caller-s stamp, even if only labels changed', async () => {
    gh.issue();
    await sync();
    const stamp = cachedStamp();
    const issue = gh.issues.get(31)!;
    gh.issues.set(31, { ...issue, labels: [...issue.labels, { name: 'in-progress' }], updated_at: '2026-09-02T11:00:00Z' });
    await sync();

    const res = await post('body', { project: trackerPath, id: '#31', body: 'new text', ifUpdatedAt: stamp }).expect(409);
    expect(res.body.updatedAt).toBe('2026-09-02T11:00:00Z');
    expect(gh.matching('/issues/31', 'PATCH')).toEqual([]);
  });
});

describe('comment', () => {
  it('appends a comment and answers its id and url', async () => {
    gh.issue();
    await sync();
    const res = await post('comment', { project: trackerPath, id: '#31', body: 'a note' }).expect(201);
    expect(res.body.commentId).toBe(100);
    expect(res.body.url).toContain('#issuecomment-100');
    expect(gh.comments.get(100)?.body).toBe('a note');
  });
});

/* =========================================================================
 * queue — the eighth write route (the orchestrator:queued spec, §2)
 * ========================================================================= */

describe('queue', () => {
  it('adds orchestrator:queued for queued: true, and answers the id and the flag', async () => {
    gh.issue();
    await sync();
    const res = await post('queue', { project: trackerPath, id: '#31', queued: true }).expect(201);
    expect(res.body).toEqual({ id: '#31', queued: true });

    const adds = gh.matching('/issues/31/labels', 'POST');
    expect(adds).toHaveLength(1);
    expect(adds[0].body).toEqual({ labels: ['orchestrator:queued'] });
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).toContain('orchestrator:queued');
  });

  it('removes the label for queued: false', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }, { name: 'orchestrator:queued' }] });
    await sync();
    const res = await post('queue', { project: trackerPath, id: '#31', queued: false }).expect(201);
    expect(res.body).toEqual({ id: '#31', queued: false });

    expect(gh.matching('/issues/31/labels/orchestrator%3Aqueued', 'DELETE')).toHaveLength(1);
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).toEqual(['type:bug']);
  });

  /* Every caller of `false` is a sweep, and a sweep's contract is "the label is
     not there" — which a 404 from the removal says it is not. Asserting the
     DELETE was made is what stops a route that skipped the call from passing. */
  it('answers success when the removal 404s because the label was never there', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }] });
    await sync();
    const res = await post('queue', { project: trackerPath, id: '#31', queued: false }).expect(201);
    expect(res.body).toEqual({ id: '#31', queued: false });
    expect(gh.matching('/labels/orchestrator%3Aqueued', 'DELETE')).toHaveLength(1);
  });

  it('does not refuse a closed issue — removing a stale label from one is a cleanup', async () => {
    gh.issue({ state: 'closed', state_reason: 'completed', labels: [{ name: 'type:bug' }, { name: 'orchestrator:queued' }] });
    await sync();
    await post('queue', { project: trackerPath, id: '#31', queued: false }).expect(201);
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).toEqual(['type:bug']);
  });

  it('maps any other failure through the refusal table — an add on a missing issue is a 404', async () => {
    await sync();
    await post('queue', { project: trackerPath, id: '#31', queued: true }).expect(404);
  });

  it('400s a queued that is not a boolean, and a missing id, reaching GitHub not at all', async () => {
    gh.issue();
    await sync();
    const bad = await post('queue', { project: trackerPath, id: '#31', queued: 'yes' }).expect(400);
    expect(bad.body.error).toMatch(/queued/);
    await post('queue', { project: trackerPath, id: '#31' }).expect(400);
    const noId = await post('queue', { project: trackerPath, queued: true }).expect(400);
    expect(noId.body.error).toMatch(/id/);
    expect(gh.calls).toEqual([]);
  });

  it('refuses a files project the way the other seven do, and makes no request', async () => {
    const res = await post('queue', { project: filesPath, id: '#31', queued: true }).expect(400);
    expect(res.body.error).toMatch(/files/);
    expect(gh.calls).toEqual([]);
  });

  /* Driven at the adapter for the reason the claim-serialisation cases below
     spell out: two supertest calls never overlap here. The queue add is fired
     first, so on the item's chain it runs first and the claim's swap then takes
     it off — the end state a run's `init` followed by its first claim produces. */
  it('serialises a concurrent queue and claim on one item — both resolve, and the claim wins the label', async () => {
    gh.issue();
    await sync();
    const source = app.get(GithubSource);
    const project = registryEntry();
    const marker = { kind: 'github', repo: REPO };

    const [queued, claimed] = await Promise.all([
      source.queue(project, marker, { project: trackerPath, id: '#31', queued: true }),
      source.claim(project, marker, { project: trackerPath, id: '#31', phase: 'execute', session: 'A' })
    ]);
    expect(queued.ok).toBe(true);
    expect(claimed.ok).toBe(true);

    // The queue add lands before the claim's first request: not interleaved.
    const queueAdd = gh.calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/issues/31/labels') && JSON.stringify(c.body).includes('orchestrator:queued'));
    const claimPost = gh.calls.findIndex((c) => c.method === 'POST' && c.url.includes('/issues/31/comments'));
    expect(queueAdd).toBeGreaterThanOrEqual(0);
    expect(queueAdd).toBeLessThan(claimPost);

    const names = gh.issues.get(31)?.labels.map((l) => l.name);
    expect(names).toContain('in-progress');
    expect(names).not.toContain('orchestrator:queued');
  });
});

/* =========================================================================
 * The protocol
 * ========================================================================= */

describe('claim', () => {
  it('takes an uncontested issue, sets the assignee and the label, and seeds zero counters', async () => {
    gh.issue();
    await sync();
    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }).expect(201);

    expect(res.body.record.session).toBe('A');
    expect(res.body.record.counters).toEqual({ groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 });

    expect(gh.matching('/issues/31/comments', 'POST')).toHaveLength(1);
    expect(gh.matching('/issues/31/comments', 'GET')).toHaveLength(2);
    expect(gh.matching('/issues/31', 'PATCH')[0].body).toEqual({ assignees: ['futin'] });
    expect(gh.matching('/issues/31/labels', 'POST')[0].body).toEqual({ labels: ['in-progress'] });
  });

  /* The claim swap (the orchestrator:queued spec, §3.3): the claim is the
     moment an item stops being planned and starts being worked, and every
     claimant goes through this one method. */
  it('takes orchestrator:queued off as it puts in-progress on, on a won claim', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }, { name: 'orchestrator:queued' }] });
    await sync();
    await post('claim', { project: trackerPath, id: '#31', phase: 'execute', session: 'A' }).expect(201);

    expect(gh.matching('/issues/31/labels/orchestrator%3Aqueued', 'DELETE')).toHaveLength(1);
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).toEqual(['type:bug', 'in-progress']);
  });

  it('leaves orchestrator:queued alone on a lost claim — the winner-s claim already took it off', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }, { name: 'orchestrator:queued' }] });
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();
    await post('claim', { project: trackerPath, id: '#31', phase: 'execute', session: 'B' }).expect(409);

    expect(gh.matching('/labels/orchestrator%3Aqueued', 'DELETE')).toEqual([]);
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).toContain('orchestrator:queued');
  });

  it('maps the claimed item as in progress, with in-progress consumed from tags', async () => {
    gh.issue();
    await sync();
    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }).expect(201);

    const index = (await request(app.getHttpServer()).get('/api/items').expect(200)).body as ItemsIndex;
    const item = index.items.find((i) => i.id === '#31');
    expect(item?.started).toBe(res.body.record.at);
    expect(item?.phase).toBe('groom');
    expect(item?.tags).toEqual([]);
  });

  /* Lowest LIVE comment id wins — posted first. The loser deletes its own
     comment, which is the one thing this protocol ever deletes. */
  it('loses to an older live claim, deletes its own comment and names the holder', async () => {
    gh.issue();
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'B' }).expect(409);
    expect(res.body.holder.session).toBe('A');
    expect(res.body.holder.commentId).toBe(100);
    expect(typeof res.body.holder.ageMs).toBe('number');
    expect(res.body.holder.ageMs).toBeGreaterThanOrEqual(0);

    expect(gh.matching('/issues/comments/101', 'DELETE')).toHaveLength(1);
    expect(gh.comments.has(101)).toBe(false);
    // A's claim is untouched — not edited, not released — and B set no assignee
    // and no label, because a loser touches nothing but its own comment.
    expect(claimIn(100)).toMatchObject({ session: 'A' });
    expect(claimIn(100)?.released).toBeUndefined();
    expect(gh.matching('/issues/comments/100', 'PATCH')).toEqual([]);
    expect(gh.matching('/issues/31', 'PATCH')).toEqual([]);
    expect(gh.matching('/labels', 'POST')).toEqual([]);
  });

  /* The UNION decides, never the second list alone: GitHub's listing is
     eventually consistent, so the winner's comment can be missing from one of
     the two reads. Here it is missing from the FIRST. */
  it('still loses when the winner-s comment is missing from the first list', async () => {
    gh.issue();
    gh.claim(record({ session: 'A' }), 31, 100);
    gh.hideFromFirstList = new Set([100]);
    await sync();

    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'B' }).expect(409);
    expect(res.body.holder.session).toBe('A');
  });

  /* A dead claim is RELEASED, never deleted (spec §6.3 step 5): it is a
     permanent record of work somebody did, with the counters to prove it. */
  it('retires a stale claim by releasing it, never by deleting it', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', heartbeat: new Date(Date.now() - CLAIM_STALE_MS - 1).toISOString() }), 31, 100);
    await sync();

    await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'B' }).expect(201);

    const retired = claimIn(100);
    expect(retired?.released?.reason).toBe('stale');
    expect(retired?.released?.by).toBe('B');
    expect(gh.matching('/issues/comments/100', 'DELETE')).toEqual([]);
  });

  /* The same session claiming twice is a LOSS, not a no-op: the second comment
     is deleted and the first one still holds the issue. */
  it('refuses the same session-s second claim and leaves the first one alone', async () => {
    gh.issue();
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }).expect(409);
    expect(res.body.holder.session).toBe('A');
    expect(res.body.holder.commentId).toBe(100);
    expect(gh.comments.has(101)).toBe(false);
  });

  it('refuses a closed issue before writing anything', async () => {
    gh.issue({ state: 'closed', state_reason: 'completed' });
    await sync();
    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }).expect(409);
    expect(res.body.error).toMatch(/done/);
    expect(gh.matching('/comments', 'POST')).toEqual([]);
  });

  /* One comment is a whole history: a new claim carries forward the counters of
     the newest prior one, so an item's accumulated totals survive every
     start/stop cycle without being summed across comments. */
  it('seeds its counters from the newest prior claim', async () => {
    gh.issue();
    gh.claim(
      record({
        session: 'A',
        counters: { groomElapsed: 120, executeElapsed: 7, groomTokens: 4000, executeTokens: 1 },
        released: { at: new Date().toISOString(), reason: 'stopped', by: 'A' }
      }),
      31,
      100
    );
    await sync();

    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'execute', session: 'B' }).expect(201);
    expect(res.body.record.counters).toEqual({ groomElapsed: 120, executeElapsed: 7, groomTokens: 4000, executeTokens: 1 });
  });

  /**
   * In-process serialisation (spec §6.2), driven at the ADAPTER rather than
   * through HTTP — and the difference is the whole reason these two cases
   * exist.
   *
   * Two supertest requests fired without awaiting do NOT overlap here: each one
   * is a socket read, and with the settle window at zero the first handler runs
   * to completion in microtasks before the second request's bytes are even
   * parsed. So a pair of HTTP calls would pass identically with the chain
   * ripped out, which is the one thing a test may not do. Calling the adapter
   * twice without awaiting is what actually produces two overlapping
   * `await`-chains, and therefore what the chain has to hold apart.
   */
  function writerArgs(): [ReturnType<typeof registryEntry>, { kind: string; repo: string }] {
    return [registryEntry(), { kind: 'github', repo: REPO }];
  }

  it('serialises two concurrent claims on one item — one wins, one is refused', async () => {
    gh.issue();
    await sync();
    const source = app.get(GithubSource);
    const [project, marker] = writerArgs();

    const [first, second] = await Promise.all([
      source.claim(project, marker, { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }),
      source.claim(project, marker, { project: trackerPath, id: '#31', phase: 'groom', session: 'B' })
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);

    // The second claim's POST comes after the first one's LAST write — the
    // label add, which is the final call the winning path makes.
    const commentPosts = gh.calls.map((c, i) => ({ ...c, i })).filter((c) => c.method === 'POST' && c.url.includes('/issues/31/comments'));
    const firstLabelAdd = gh.calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/issues/31/labels'));
    expect(commentPosts).toHaveLength(2);
    expect(firstLabelAdd).toBeGreaterThanOrEqual(0);
    expect(commentPosts[1].i).toBeGreaterThan(firstLabelAdd);
  });

  it('lets writes to two different items interleave', async () => {
    gh.issue({ number: 31 });
    gh.issue({ number: 32 });
    await sync();
    const source = app.get(GithubSource);
    const [project, marker] = writerArgs();

    await Promise.all([
      source.claim(project, marker, { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }),
      source.claim(project, marker, { project: trackerPath, id: '#32', phase: 'groom', session: 'B' })
    ]);

    // #32's FIRST request lands before #31's LAST one: the chains are per item,
    // so two items' writes overlap and a board-wide operation is not as slow as
    // the sum of its parts.
    const firstFor32 = gh.calls.findIndex((c) => c.url.includes('/issues/32'));
    let lastFor31 = -1;
    gh.calls.forEach((c, i) => {
      if (c.url.includes('/issues/31')) lastFor31 = i;
    });
    expect(firstFor32).toBeGreaterThanOrEqual(0);
    expect(firstFor32).toBeLessThan(lastFor31);
  });
});

describe('release', () => {
  it('records the release, writes the counters verbatim and removes in-progress', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }, { name: 'in-progress' }], assignees: [{ login: 'futin' }] });
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    const counters = { groomElapsed: 100, executeElapsed: 0, groomTokens: 5000, executeTokens: 0 };
    const res = await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'A', reason: 'stopped', counters }).expect(201);

    expect(res.body.record.released).toMatchObject({ reason: 'stopped', by: 'A' });
    expect(claimIn(100)?.counters).toEqual(counters);
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).not.toContain('in-progress');
    // The assignee records who last worked the issue, and stays true after they
    // stop — clearing it would throw away the one field a person scanning the
    // repo's issue list can see.
    expect(gh.issues.get(31)?.assignees).toEqual([{ login: 'futin' }]);
  });

  /**
   * The one release that DOES unassign (bug-49's sibling). A session torn down
   * mid-item passes through no terminal stage, so the assignee it was given by
   * winning the claim records nothing that happened — the work did not finish,
   * and the issue goes on reading as owned by somebody who is gone. An abort is
   * the one reason that says exactly this, which is why the rule keys on it
   * rather than on every release: after `stopped`, `merged` or `imported`, the
   * assignee is a true record of who did the work and stays.
   */
  it('an aborted release clears the assignee the claim set, unlike every other reason', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }, { name: 'in-progress' }], assignees: [{ login: 'futin' }] });
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'A', reason: 'aborted' }).expect(201);

    expect(gh.issues.get(31)?.assignees).toEqual([]);
    // The claim comment is still the record of who held it — unassigning takes
    // nothing away that the timeline does not keep.
    expect(claimIn(100)?.released?.reason).toBe('aborted');
  });

  /**
   * The 404 the item's Test cases name by hand: "`removeLabel`'s 404 answers
   * `status: 404` (the poller/writer treats it as success — assert THAT in the
   * writer suite, not here)". `test/tracker-client-write.test.ts` pins the
   * client half; this is the writer half, and it was missing until the review
   * caught it.
   *
   * The issue here carries NO `in-progress` label, which is an ordinary state:
   * two sessions releasing the same dead claim, or a person who removed it by
   * hand. Today the release succeeds only because `github.source.ts` ignores the
   * result — so this case is what stops a plausible-looking
   * `if (removed.status !== 200) return refusal` from being added there, which
   * would break every release of an already-clean claim with nothing going red.
   */
  it('succeeds when in-progress is already gone, on a 404 from the label removal', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }] });
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    const res = await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'A', reason: 'stopped' }).expect(201);
    expect(res.body.record.released).toMatchObject({ reason: 'stopped', by: 'A' });
    expect(claimIn(100)?.released?.reason).toBe('stopped');

    // The attempt WAS made and GitHub WAS the one to say no — a release that
    // skipped the call entirely would pass an outcome-only assertion too.
    const removals = gh.matching('/labels/in-progress', 'DELETE');
    expect(removals).toHaveLength(1);
  });

  it('keeps the seeded counters when the caller sends none', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', counters: { groomElapsed: 9, executeElapsed: 8, groomTokens: 7, executeTokens: 6 } }), 31, 100);
    await sync();

    await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'A', reason: 'abandoned' }).expect(201);
    expect(claimIn(100)?.counters).toEqual({ groomElapsed: 9, executeElapsed: 8, groomTokens: 7, executeTokens: 6 });
  });

  it('clears started and phase on the mapped item, keeping the counters', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', counters: { groomElapsed: 9, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } }), 31, 100);
    await sync();
    await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'A', reason: 'stopped' }).expect(201);

    const index = (await request(app.getHttpServer()).get('/api/items').expect(200)).body as ItemsIndex;
    const item = index.items.find((i) => i.id === '#31');
    expect(item?.started).toBe('');
    expect(item?.phase).toBe('');
    expect(item?.groomElapsed).toBe(9);
  });

  it('refuses another session-s LIVE claim and patches nothing', async () => {
    gh.issue();
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    const res = await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'B', reason: 'stopped' }).expect(409);
    expect(res.body.holder.session).toBe('A');
    expect(gh.matching('/issues/comments/100', 'PATCH')).toEqual([]);
  });

  /* A dead claim is not somebody's property — it is litter. Requiring the
     original session to come back and clear it would wedge an issue on the
     crash of a process that is never coming back. */
  it('lets anyone release a DEAD claim, recording who did it', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', heartbeat: new Date(Date.now() - CLAIM_STALE_MS - 1).toISOString() }), 31, 100);
    await sync();

    await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'B', reason: 'stopped' }).expect(201);
    expect(claimIn(100)?.released?.by).toBe('B');
  });

  it('answers 404 for a comment that is not a claim on this issue', async () => {
    gh.issue();
    await sync();
    await post('release', { project: trackerPath, id: '#31', commentId: 999, session: 'A', reason: 'stopped' }).expect(404);
  });

  /* -------------------------------------------------------------------------
   * bug-42 — the run clause: **the holder always, the RUN that owns the claim, ANYONE once the claim is dead** (bug-48 later made it a quadruple).
   *
   * `claim` has known the same-run takeover since task-47 §7.6 and `release` never learned it, so a `/backlog-orchestrate --abort` spawned by
   * `POST /api/agents/stop` — a session that took the run's driver lease and is therefore the run, but is NOT the claim's holder — was refused every
   * release it sent. With the driver dead (the case a force stop exists for) nothing ever released the claim: it went stale and stayed unreleased, and
   * the mapper fills `started` off any unreleased claim, so the item's dispatch control stayed disabled on every machine until a person edited the
   * comment by hand.
   *
   * The case above this comment ('refuses another session-s LIVE claim and patches nothing') is deliberately left unedited as the regression pin for a
   * caller that sends no `runId` at all — `backlog.mjs stop` is that caller, and it gains no authority here.
   * ------------------------------------------------------------------------- */

  it('lets the RUN that owns the claim release another session-s LIVE claim', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }, { name: 'in-progress' }] });
    gh.claim(record({ session: 'A', run: RUN }), 31, 100);
    await sync();

    const res = await post('release', {
      project: trackerPath,
      id: '#31',
      commentId: 100,
      session: 'B',
      runId: RUN.runId,
      reason: 'aborted'
    }).expect(201);

    // `by` is the RELEASING session, not the holder — the honest record of who actually did it, and the reason the fix does not impersonate the driver.
    expect(res.body.record.released).toMatchObject({ reason: 'aborted', by: 'B' });
    expect(claimIn(100)?.released).toMatchObject({ reason: 'aborted', by: 'B' });
    // The rest of the route is unchanged: the label still comes off. Asserted on the CALL, because an outcome-only assertion passes for a route that
    // skipped the request entirely.
    expect(gh.matching('/labels/in-progress', 'DELETE')).toHaveLength(1);
  });

  /* The clause that keeps it a narrow authority rather than an open door: another machine's run has no more standing here than any other stranger. */
  it('refuses a release asserting a DIFFERENT runId, and patches nothing', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', run: RUN }), 31, 100);
    await sync();

    const res = await post('release', {
      project: trackerPath,
      id: '#31',
      commentId: 100,
      session: 'B',
      runId: 'run-20260919-999999',
      reason: 'aborted'
    }).expect(409);

    expect(res.body.holder.session).toBe('A');
    expect(gh.matching('/issues/comments/100', 'PATCH')).toEqual([]);
  });

  /* The `undefined === undefined` trap, and the reason the predicate carries a `typeof` and a `length` guard rather than the tempting
     `existing.run?.runId !== req.runId`: written that way, a hand claim with no `run` and a request with no `runId` compare equal, the refusal
     disappears, and any session on the machine could rip a live `backlog.mjs start` out from under the person holding it. `claim`'s own same-run filter
     guards the same shape the same way, and the two should read alike. */
  it('is never same-run with a live HAND claim, which carries no run at all', async () => {
    gh.issue();
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    const res = await post('release', {
      project: trackerPath,
      id: '#31',
      commentId: 100,
      session: 'B',
      runId: RUN.runId,
      reason: 'aborted'
    }).expect(409);

    expect(res.body.holder.session).toBe('A');
    expect(claimIn(100)?.released).toBeUndefined();
  });

  /* A 400 rather than a dropped field, for the reason `claimRunOf` gives about `run`: the SERVER branches on this one, and a silently dropped value
     turns an authorised release into a refusal nobody can explain. */
  it('400s a runId that is not a non-empty string, and reaches GitHub not at all', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', run: RUN }), 31, 100);
    await sync();

    const bad = await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'B', runId: 7, reason: 'aborted' }).expect(400);
    expect(bad.body.error).toContain('runId');
    await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'B', runId: '   ', reason: 'aborted' }).expect(400);

    // Answered before the adapter is reached at all.
    expect(gh.calls).toEqual([]);
  });

  /* "Anyone once the claim is dead" outranks the new clause and is reached first, through `isLive` — so a stale claim carrying a foreign `runId` still
     releases to anybody. Ordering, not a new rule. */
  it('lets anyone release a DEAD claim even while asserting a foreign runId', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', heartbeat: new Date(Date.now() - CLAIM_STALE_MS - 1).toISOString(), run: RUN }), 31, 100);
    await sync();

    await post('release', {
      project: trackerPath,
      id: '#31',
      commentId: 100,
      session: 'B',
      runId: 'run-20260919-999999',
      reason: 'stopped'
    }).expect(201);
    expect(claimIn(100)?.released?.by).toBe('B');
  });

  /* -------------------------------------------------------------------------
   * bug-48 — the FOURTH clause: **the holder always, the RUN that owns the claim, the HOST that holds the claim once it can show the session is gone,
   * ANYONE once the claim is dead.**
   *
   * A hand-run session killed mid-item passes through no terminal stage, so it releases nothing — and every clause of the old triple then answers about
   * somebody who no longer exists: the holder is gone, a hand claim carries no `run` by construction, and `isLive` is true because `heartbeat` was
   * re-stamped seconds before the kill. The item read as in progress on every machine for a full fifteen minutes with no command anywhere to clear it.
   *
   * The server's half of the clause is `sameHost` ALONE. It cannot see the caller's filesystem or process table, so the proof that the holding session is
   * actually gone lives in `backlog.mjs abort`, where the transcripts and the clock are — exactly as billing does, and for the same reason. That is a
   * MISTAKE boundary rather than a security one: `stop` already lets a caller send any `session` it likes, and the holder's id is printed in the refusal.
   * ------------------------------------------------------------------------- */

  it('lets the HOST that holds the claim release another session-s LIVE claim', async () => {
    gh.issue({ labels: [{ name: 'type:bug' }, { name: 'in-progress' }] });
    gh.claim(record({ session: 'sess-gone', host: 'futin@linux-box' }), 31, 100);
    await sync();

    const res = await post('release', {
      project: trackerPath,
      id: '#31',
      commentId: 100,
      session: 'sess-aborting',
      host: 'futin@linux-box',
      reason: 'aborted'
    }).expect(201);

    // `by` is the ABORTING session, never the holder — the same honest record bug-42's clause writes, for the same reason.
    expect(res.body.record.released).toMatchObject({ reason: 'aborted', by: 'sess-aborting' });
    expect(claimIn(100)?.released).toMatchObject({ reason: 'aborted', by: 'sess-aborting' });
    // Nothing else in `release` moves: the label still comes off, asserted on the CALL rather than the outcome.
    expect(gh.matching('/labels/in-progress', 'DELETE')).toHaveLength(1);
  });

  /* The clause that keeps it a repair rather than an open door: a machine that is not the one the claim was made on cannot know anything about the
     holder, which is bug-46's whole finding read from the other side. */
  it('refuses a release asserting a DIFFERENT host, and patches nothing', async () => {
    gh.issue();
    gh.claim(record({ session: 'sess-gone', host: 'futin@linux-box' }), 31, 100);
    await sync();

    const res = await post('release', {
      project: trackerPath,
      id: '#31',
      commentId: 100,
      session: 'sess-aborting',
      host: 'futin@other-box',
      reason: 'aborted'
    }).expect(409);

    expect(res.body.holder.session).toBe('sess-gone');
    expect(res.body.holder.host).toBe('futin@linux-box');
    expect(gh.matching('/issues/comments/100', 'PATCH')).toEqual([]);
  });

  /* The `undefined === undefined` trap again, one field over, and guarded the same way `sameRun` is: written as the tempting
     `existing.host !== req.host`, a request with no `host` against a claim written before that field existed compares equal and the refusal disappears
     for every pre-bug-46 claim on the tracker. **A claim with no `host` is never same-host with anything** — absence means "the machine was not
     recorded", never "this one", which is the sentence `ClaimRecord.host` already carries. */
  it('is never same-host with a claim that recorded no host at all', async () => {
    gh.issue();
    gh.claim(record({ session: 'sess-gone' }), 31, 100);
    await sync();

    const res = await post('release', {
      project: trackerPath,
      id: '#31',
      commentId: 100,
      session: 'sess-aborting',
      host: 'futin@linux-box',
      reason: 'aborted'
    }).expect(409);

    expect(res.body.holder.session).toBe('sess-gone');
    expect(claimIn(100)?.released).toBeUndefined();
  });

  /* A 400 rather than a dropped field, the rule `runId` already follows on this route and `host` follows on `claim`: the SERVER branches on it, and a
     silently dropped value turns an authorised abort into a refusal naming a session that no longer exists. */
  it('400s a host that is not a non-empty string, and reaches GitHub not at all', async () => {
    gh.issue();
    gh.claim(record({ session: 'sess-gone', host: 'futin@linux-box' }), 31, 100);
    await sync();

    const bad = await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'B', host: 7, reason: 'aborted' }).expect(400);
    expect(bad.body.error).toContain('host');
    await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'B', host: '   ', reason: 'aborted' }).expect(400);

    // Answered before the adapter is reached at all.
    expect(gh.calls).toEqual([]);
  });

  /* `abort` sends no `counters` key at all — `--abandon`'s rule, for `--abandon`'s reason: the stretch between the last heartbeat and the kill is not
     work anybody did, and zeros would erase what every earlier session accumulated. */
  it('keeps the claim-s original counters when a host-authorised abort sends none', async () => {
    gh.issue();
    const counters = { groomElapsed: 9, executeElapsed: 8, groomTokens: 7, executeTokens: 6 };
    gh.claim(record({ session: 'sess-gone', host: 'futin@linux-box', counters }), 31, 100);
    await sync();

    await post('release', {
      project: trackerPath,
      id: '#31',
      commentId: 100,
      session: 'sess-aborting',
      host: 'futin@linux-box',
      reason: 'aborted'
    }).expect(201);

    expect(claimIn(100)?.counters).toEqual(counters);
    expect(claimIn(100)?.released).toMatchObject({ reason: 'aborted', by: 'sess-aborting' });
  });
});

describe('heartbeat', () => {
  it('moves the heartbeat forward', async () => {
    gh.issue();
    const seeded = record({ session: 'A', heartbeat: new Date(Date.now() - 60_000).toISOString() });
    gh.claim(seeded, 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'A' }).expect(201);
    expect(Date.parse(claimIn(100)!.heartbeat)).toBeGreaterThan(Date.parse(seeded.heartbeat));
  });

  it('carries phase 4-s opaque state verbatim when one is sent', async () => {
    gh.issue();
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    const state = { stage: 'merging', queue: [1, 2, 3] };
    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'A', state }).expect(201);
    expect(claimIn(100)?.state).toEqual(state);
  });

  it('refuses a released claim and patches nothing', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', released: { at: new Date().toISOString(), reason: 'stopped', by: 'A' } }), 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'A' }).expect(409);
    expect(gh.matching('/issues/comments/100', 'PATCH')).toEqual([]);
  });
});

/* `finished` (task-48): `orchestrate.mjs finish` stamps the run's outcome on its
 * last-touched claim through this same route, and that claim is normally
 * released already — so the one exception to "a released claim refuses a
 * heartbeat" is pinned from both sides. */
describe('heartbeat.finished', () => {
  const FINISHED = { at: '2026-09-19T12:00:00.000Z', status: 'done' };

  it('H-1: stamps finished on a released claim and moves nothing else', async () => {
    gh.issue();
    const released = { at: '2026-09-19T11:59:00.000Z', reason: 'merged', by: 'A' };
    const seeded = record({ session: 'A', heartbeat: '2026-09-19T11:58:00.000Z', state: { stage: 'merged' }, released });
    gh.claim(seeded, 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'A', finished: FINISHED }).expect(201);
    const after = claimIn(100)!;
    expect(after.finished).toEqual(FINISHED);
    expect(after.heartbeat).toBe(seeded.heartbeat);
    expect(after.state).toEqual({ stage: 'merged' });
    expect(after.released).toEqual(released);
  });

  it('H-2: a released claim with no finished is still the existing 409', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', released: { at: new Date().toISOString(), reason: 'stopped', by: 'A' } }), 31, 100);
    await sync();

    const res = await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'A' }).expect(409);
    expect(res.body.error).toBe('claim 100 on #31 is released — nothing to heartbeat');
  });

  it('H-3: finished on a live claim sets it and moves the heartbeat', async () => {
    gh.issue();
    const seeded = record({ session: 'A', heartbeat: new Date(Date.now() - 60_000).toISOString() });
    gh.claim(seeded, 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'A', finished: { ...FINISHED, status: 'paused' } }).expect(201);
    const after = claimIn(100)!;
    expect(after.finished).toEqual({ ...FINISHED, status: 'paused' });
    expect(Date.parse(after.heartbeat)).toBeGreaterThan(Date.parse(seeded.heartbeat));
    expect(after.released).toBeUndefined();
  });

  it.each([
    ['a status outside the four', { at: FINISHED.at, status: 'bogus' }],
    ['an at that does not parse', { at: 'yesterday', status: 'done' }],
    ['a non-object', 'done']
  ])('H-4: refuses %s with a 400 and edits nothing', async (_label, finished) => {
    gh.issue();
    gh.claim(record({ session: 'A', released: { at: new Date().toISOString(), reason: 'merged', by: 'A' } }), 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'A', finished }).expect(400);
    expect(gh.matching('/issues/comments/100', 'PATCH')).toEqual([]);
    expect(claimIn(100)?.finished).toBeUndefined();
  });
});

/* =========================================================================
 * bug-45 — heartbeat authenticates its caller
 *
 * `heartbeat` was the one write route that authenticated nobody: any session
 * could keep any claim fresh. Two harms, and the second is the one that cost a
 * day. A rival's heartbeats hold the holder's claim live forever, so the
 * fifteen-minute staleness repair never fires for the issue that needs it
 * most; and a session that runs `heartbeat` as an "is this claim mine?" oracle
 * gets a 201 back and concludes it holds an issue another machine is executing
 * — which is what happened on guide-manager#5, both machines grooming the same
 * issue with one of them having already lost the race and deleted its comment.
 *
 * The rule is `release`'s quadruple minus its last TWO clauses: the HOLDER
 * always, and the RUN that owns the claim (task-47 §7.6 — a resumed driver has
 * a NEW session id and the same `runId`, and must keep heartbeating its own
 * items). Deliberately NOT "anyone once the claim is dead", and NOT bug-48's
 * "the host that can show the session is gone": both are about ENDING a claim,
 * and a stranger reviving a dead one is precisely the harm here. Retiring one
 * is `claim`'s business, which the protocol already answers by the lowest live
 * comment id.
 * ========================================================================= */

describe('heartbeat ownership (bug-45)', () => {
  it('HO-1: refuses a session that is not the holder, names the holder, and patches nothing', async () => {
    gh.issue();
    const seeded = record({ session: 'A', heartbeat: new Date(Date.now() - 60_000).toISOString() });
    gh.claim(seeded, 31, 100);
    await sync();

    const res = await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'B' }).expect(409);
    expect(res.body.holder.session).toBe('A');
    expect(claimIn(100)!.heartbeat).toBe(seeded.heartbeat);
    expect(gh.matching('/issues/comments/100', 'PATCH')).toEqual([]);
  });

  it('HO-2: the holder moves its own heartbeat forward', async () => {
    gh.issue();
    const seeded = record({ session: 'A', heartbeat: new Date(Date.now() - 60_000).toISOString() });
    gh.claim(seeded, 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'A' }).expect(201);
    expect(Date.parse(claimIn(100)!.heartbeat)).toBeGreaterThan(Date.parse(seeded.heartbeat));
  });

  it('HO-3: another session of the SAME run takes over — a resumed driver keeps heartbeating its own items', async () => {
    gh.issue();
    const seeded = record({ session: 'A', run: RUN, heartbeat: new Date(Date.now() - 60_000).toISOString() });
    gh.claim(seeded, 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'B', runId: RUN.runId }).expect(201);
    expect(Date.parse(claimIn(100)!.heartbeat)).toBeGreaterThan(Date.parse(seeded.heartbeat));
  });

  it('HO-4: a DIFFERENT run is not a takeover', async () => {
    gh.issue();
    const seeded = record({ session: 'A', run: RUN, heartbeat: new Date(Date.now() - 60_000).toISOString() });
    gh.claim(seeded, 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'B', runId: 'run-20260101-000000' }).expect(409);
    expect(claimIn(100)!.heartbeat).toBe(seeded.heartbeat);
  });

  it('HO-5: a claim with no run at all is never same-run with anything', async () => {
    gh.issue();
    const seeded = record({ session: 'A', heartbeat: new Date(Date.now() - 60_000).toISOString() });
    gh.claim(seeded, 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'B', runId: RUN.runId }).expect(409);
    expect(claimIn(100)!.heartbeat).toBe(seeded.heartbeat);
  });

  it('HO-6: a stranger is refused on a STALE claim too, because reviving it is the harm', async () => {
    gh.issue();
    const seeded = record({ session: 'A', heartbeat: new Date(Date.now() - CLAIM_STALE_MS - 60_000).toISOString() });
    gh.claim(seeded, 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'B' }).expect(409);
    expect(claimIn(100)!.heartbeat).toBe(seeded.heartbeat);
  });

  it('HO-7: a stranger cannot stamp finished on another session\'s claim', async () => {
    gh.issue();
    const released = { at: '2026-09-19T11:59:00.000Z', reason: 'merged', by: 'A' };
    gh.claim(record({ session: 'A', released }), 31, 100);
    await sync();

    await post('heartbeat', {
      project: trackerPath,
      id: '#31',
      commentId: 100,
      session: 'B',
      finished: { at: '2026-09-19T12:00:00.000Z', status: 'done' }
    }).expect(409);
    expect(claimIn(100)?.finished).toBeUndefined();
  });

  it('HO-8: a request with no session is a 400 and patches nothing', async () => {
    gh.issue();
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100 }).expect(400);
    expect(gh.matching('/issues/comments/100', 'PATCH')).toEqual([]);
  });
});


/* =========================================================================
 * The credential
 * ========================================================================= */

describe('the token', () => {
  /* The read side's own `never puts the token in a payload` case, extended to
     the write routes (spec §11): the credential is process-only, and a route
     that echoed a request header or a client error could leak it. */
  it('appears in no response of a create or a claim', async () => {
    gh.issue();
    await sync();
    const created = await post('create', { project: trackerPath, section: 'bugs', title: 't', body: 'b' }).expect(201);
    const claimed = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }).expect(201);
    expect(JSON.stringify(created.body)).not.toContain(TOKEN);
    expect(JSON.stringify(claimed.body)).not.toContain(TOKEN);
  });
});

/* =========================================================================
 * task-47 — `claim.run`, the same-run takeover, and `body.runnerFix`
 *
 * The takeover is the one place the SERVER branches on a field a caller sent,
 * and the whole reason `ClaimRun` is a declared shape rather than the opaque
 * blob task-46 reserved. What it solves is a resumed driver losing every one
 * of its own items to a session that no longer exists: the crashed session's
 * claims are still LIVE (it was heartbeating minutes ago) and still hold the
 * lowest comment ids, so under the plain protocol the resume waits fifteen
 * minutes per item for them to go stale.
 *
 * Three cases draw the line, and they only make sense together: the same run
 * takes over (C-3), a DIFFERENT run does not (C-4), and a hand claim with no
 * `run` at all is never same-run with anything (C-5).
 * ========================================================================= */

const RUN: ClaimRun = {
  runId: 'run-20260919-120000',
  startedAt: '2026-09-19T12:00:00.000Z',
  mergeMode: 'merge',
  questionMode: 'park',
  maxItems: null,
  base: 'main'
};

describe('claim.run', () => {
  it('writes the run into the claim comment verbatim, with all six keys', async () => {
    gh.issue();
    await sync();
    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'execute', session: 'A', run: RUN }).expect(201);

    // The COMMENT is the claim, so the assertion is against what landed on
    // GitHub rather than against the response alone — a reader on another
    // machine has only the comment.
    expect(claimIn(res.body.commentId)?.run).toEqual(RUN);
  });

  /* Field by field, and each refusal names the field. The caller is a CLI
     composing this object out of a run file: "something in `run` is wrong"
     sends it re-reading six fields, and one name sends it to the line. */
  it('400s a malformed run and names the field', async () => {
    gh.issue();
    await sync();
    const bad = await post('claim', { project: trackerPath, id: '#31', phase: 'execute', session: 'A', run: { runId: 5 } }).expect(400);
    expect(bad.body.error).toContain('run.runId');

    const worse = await post('claim', {
      project: trackerPath,
      id: '#31',
      phase: 'execute',
      session: 'A',
      run: { ...RUN, mergeMode: 'yolo' }
    }).expect(400);
    expect(worse.body.error).toContain('run.mergeMode');

    // Nothing was posted on either: a 400 is answered before the adapter is
    // reached at all.
    expect(gh.matching('/issues/31/comments', 'POST')).toEqual([]);
  });

  it('takes over its own run-s live claim, releasing it as resumed and carrying its counters forward', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', run: RUN, counters: { groomElapsed: 0, executeElapsed: 90, groomTokens: 0, executeTokens: 4200 } }), 31, 100);
    await sync();

    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'execute', session: 'B', run: RUN }).expect(201);

    // B won despite holding the HIGHER comment id, which is the takeover: A
    // was dropped from the live set before `winner` ran.
    expect(res.body.commentId).toBe(101);
    // A is RELEASED, never deleted — it is the permanent record of the work
    // that session did, and it carries the counters to prove it.
    expect(gh.comments.has(100)).toBe(true);
    expect(claimIn(100)?.released).toEqual(expect.objectContaining({ reason: 'resumed', by: 'B' }));
    // Seeded from the newest prior claim as always, so the totals survive the
    // takeover.
    expect(res.body.record.counters).toEqual({ groomElapsed: 0, executeElapsed: 90, groomTokens: 0, executeTokens: 4200 });
  });

  it('is refused by a live claim from a DIFFERENT run, and leaves it untouched', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', run: RUN }), 31, 100);
    await sync();

    const res = await post('claim', {
      project: trackerPath,
      id: '#31',
      phase: 'execute',
      session: 'B',
      run: { ...RUN, runId: 'run-20260919-999999' }
    }).expect(409);

    expect(res.body.holder.session).toBe('A');
    expect(claimIn(100)?.released).toBeUndefined();
    // The loser deletes its OWN comment, which is the one thing this protocol
    // ever deletes.
    expect(gh.comments.has(101)).toBe(false);
  });

  it('is refused by a live HAND claim, which carries no run and is never same-run with anything', async () => {
    gh.issue();
    // No `run` key: `backlog.mjs start` at a terminal. A run has no standing
    // to evict somebody working the item by hand.
    gh.claim(record({ session: 'A' }), 31, 100);
    await sync();

    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'execute', session: 'B', run: RUN }).expect(409);
    expect(res.body.holder.session).toBe('A');
    expect(claimIn(100)?.released).toBeUndefined();
  });

  /* The negative that keeps every phase-3 caller safe: `backlog.mjs start`
     sends no `run` key, and must behave exactly as it did before this field
     existed. */
  it('writes no run key at all when the caller sent none', async () => {
    gh.issue();
    await sync();
    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }).expect(201);
    expect('run' in (claimIn(res.body.commentId) ?? {})).toBe(false);
  });
});

/* ==========================================================================
 * bug-46 — the claim says WHERE its holder is
 *
 * A session id names a transcript under `~/.claude/projects` on exactly one
 * machine, so it is the one identifier a reader on another machine cannot
 * resolve. The check they can actually run answers "no" for every foreign
 * claim, live or dead — and that "no" gets read as proof the holder is dead.
 * `host` is what makes "made elsewhere" a readable answer.
 * ========================================================================= */

describe('claim.host', () => {
  it('writes the host into the claim comment when the caller sent one', async () => {
    gh.issue();
    await sync();
    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A', host: 'futin@mac' }).expect(201);

    // The COMMENT is the claim — a reader on another machine has only that.
    expect(claimIn(res.body.commentId)?.host).toBe('futin@mac');
    expect(gh.comments.get(res.body.commentId)?.body).toContain('session A on futin@mac holds this issue');
  });

  /* The negative every pre-bug-46 caller rests on: no key at all, not an empty
     string and not `unknown`. Absent means "the machine was not recorded", and
     a reader must not be able to mistake it for "local". */
  it('writes no host key at all when the caller sent none', async () => {
    gh.issue();
    await sync();
    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A' }).expect(201);
    expect('host' in (claimIn(res.body.commentId) ?? {})).toBe(false);
  });

  it('names the holder-s host in the claim refusal', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', host: 'futin@linux-box' }), 31, 100);
    await sync();

    const res = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'B', host: 'futin@mac' }).expect(409);
    expect(res.body.holder.session).toBe('A');
    expect(res.body.holder.host).toBe('futin@linux-box');
  });

  it('names the holder-s host in the release refusal', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', host: 'futin@linux-box' }), 31, 100);
    await sync();

    const res = await post('release', { project: trackerPath, id: '#31', commentId: 100, session: 'B', reason: 'stopped' }).expect(409);
    expect(res.body.holder.host).toBe('futin@linux-box');
  });

  it('names the holder-s host in the heartbeat refusal', async () => {
    gh.issue();
    gh.claim(record({ session: 'A', host: 'futin@linux-box' }), 31, 100);
    await sync();

    const res = await post('heartbeat', { project: trackerPath, id: '#31', commentId: 100, session: 'B' }).expect(409);
    expect(res.body.holder.host).toBe('futin@linux-box');
  });

  /* The shape rule `session` already follows: present means a non-empty
     string. A caller that sent a number or a blank has made a mistake worth
     hearing about, rather than one that silently publishes nothing. */
  it('400s a host that is not a non-empty string, and reaches GitHub not at all', async () => {
    gh.issue();
    await sync();

    const blank = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A', host: '   ' }).expect(400);
    expect(blank.body.error).toContain('host');

    const wrongType = await post('claim', { project: trackerPath, id: '#31', phase: 'groom', session: 'A', host: 7 }).expect(400);
    expect(wrongType.body.error).toContain('host');

    expect(gh.matching('/issues/31/comments', 'POST')).toEqual([]);
  });
});

describe('body.runnerFix', () => {
  it('adds the label with the patch, and adding it twice is still one label', async () => {
    const issue = gh.issue();
    await sync();
    await post('body', { project: trackerPath, id: '#31', body: 'v1', ifUpdatedAt: issue.updated_at, runnerFix: true }).expect(201);
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).toContain('runner-fix');

    await post('body', { project: trackerPath, id: '#31', body: 'v2', ifUpdatedAt: gh.issues.get(31)!.updated_at, runnerFix: true }).expect(201);
    expect(gh.issues.get(31)?.labels.filter((l) => l.name === 'runner-fix')).toHaveLength(1);
  });

  /* The DELETE is attempted and its 404 swallowed, the same reasoning
     `release` documents for `in-progress`: the contract is "the label is not
     there", and it is not there. Asserted on the CALL rather than only on the
     outcome — an outcome-only assertion passes just as well for a route that
     skipped the request entirely. */
  it('removes the label when asked, and a 404 from the removal is a success', async () => {
    const issue = gh.issue();
    await sync();
    await post('body', { project: trackerPath, id: '#31', body: 'v1', ifUpdatedAt: issue.updated_at, runnerFix: false }).expect(201);

    expect(gh.matching('/issues/31/labels/runner-fix', 'DELETE')).toHaveLength(1);
    expect(gh.issues.get(31)?.labels.map((l) => l.name)).not.toContain('runner-fix');
  });

  /* Three states, and the third is the important one: a body patch that said
     nothing about the marker must leave it exactly as it is, or every re-groom
     silently clears a decision somebody made deliberately. */
  it('leaves the label alone when the key is absent', async () => {
    const issue = gh.issue({ labels: [{ name: 'type:task' }, { name: 'runner-fix' }] });
    await sync();
    await post('body', { project: trackerPath, id: '#31', body: 'v1', ifUpdatedAt: issue.updated_at }).expect(201);

    expect(gh.issues.get(31)?.labels.map((l) => l.name)).toContain('runner-fix');
    expect(gh.matching('/issues/31/labels/runner-fix', 'DELETE')).toEqual([]);
    expect(gh.matching('/issues/31/labels', 'POST')).toEqual([]);
  });

  it('400s a runnerFix that is not a boolean, and patches nothing', async () => {
    const issue = gh.issue();
    await sync();
    await post('body', { project: trackerPath, id: '#31', body: 'v1', ifUpdatedAt: issue.updated_at, runnerFix: 'yes' }).expect(400);
    expect(gh.matching('/issues/31', 'PATCH')).toEqual([]);
  });
});
