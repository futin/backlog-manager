import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ItemsModule } from '../server/src/items/items.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { uncommittedItemPaths } from '../server/src/items/uncommitted.util';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { TRACKER_LABELS } from '../server/src/tracker/labels';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { listenLoopback } from './helpers/app';
import { item, makeProject, makeRegistry } from './helpers/store';
import type { ItemsIndex, ProjectSummary, TrackersPayload } from '../shared/types';

/**
 * The seam end to end with BOTH adapters registered (task-45): one files
 * project and one GitHub project in one registry, answered by one
 * `/api/items`. This is the suite that proves phase 1's claim — the service
 * dispatches over the adapters and its control flow did not change to accept
 * the second one.
 *
 * The network is faked at `GithubClient`, which is the module's one outbound
 * seam, and the poller is ticked explicitly rather than waited for: `arm()` is
 * deliberately fire-and-forget (see its comment), so a suite that asserted
 * against whatever the first render happened to catch would be a race with a
 * 15-second timer.
 */

const TOKEN = process.env[GITHUB_TOKEN_ENV];
const dirs: string[] = [];

const ISSUES = [
  {
    number: 31,
    title: 'the board lies',
    body: '## Symptom\n\nx\n\n## Cause\n\nc\n\n## Fix\n\nf\n',
    html_url: 'https://github.com/futin/x/issues/31',
    state: 'open',
    state_reason: null,
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-02T10:00:00Z',
    labels: [{ name: 'type:bug' }],
    assignees: [{ login: 'futin' }]
  },
  {
    number: 32,
    title: 'already shipped',
    body: '## Goal\n\ng\n\n## Plan\n\n1. do it\n',
    html_url: 'https://github.com/futin/x/issues/32',
    state: 'closed',
    state_reason: 'completed',
    created_at: '2026-09-01T11:00:00Z',
    updated_at: '2026-09-03T10:00:00Z',
    labels: [{ name: 'type:task' }],
    assignees: []
  },
  // A pull request, which the issues endpoint returns alongside real issues.
  {
    number: 33,
    title: 'a PR',
    body: '',
    html_url: 'https://github.com/futin/x/pull/33',
    state: 'open',
    state_reason: null,
    created_at: '2026-09-01T12:00:00Z',
    updated_at: '2026-09-04T10:00:00Z',
    labels: [],
    assignees: [],
    pull_request: { url: 'https://api.github.com/repos/futin/x/pulls/33' }
  }
];

/** Answers the three endpoints a sync touches, and nothing else. */
function fakeFetch(issues: unknown[] = ISSUES): typeof fetch {
  const impl = async (url: string): Promise<Response> => {
    if (url.includes('/issues?state=all')) return new Response(JSON.stringify(issues), { status: 200 });
    if (url.endsWith('/labels?per_page=100')) return new Response(JSON.stringify(TRACKER_LABELS.map((l) => ({ name: l.name }))), { status: 200 });
    if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'futin' }), { status: 200 });
    return new Response('[]', { status: 200 });
  };
  return impl as unknown as typeof fetch;
}

async function build(registryFile: string, fetchImpl: typeof fetch = fakeFetch()): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(registryFile)
    .overrideProvider(GithubClient)
    .useValue(new GithubClient(fetchImpl))
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  return app;
}

function project(name: string, marker?: string, items: Parameters<typeof makeProject>[1] = []): string {
  const root = makeProject(name, items, marker);
  dirs.push(root);
  return root;
}

/**
 * Make a fixture a real git repository, on `main`, with everything committed.
 *
 * Needed by exactly one case and load-bearing for it: `uncommittedItemPaths`
 * answers `known: false` for a directory that is not a repo, so a tracker
 * project in a bare temp directory would report `known: false` whether or not
 * the tracker branch existed at all — the case would pass with the feature
 * reverted, which is the one thing a test may not do. With a real repo behind
 * it, `known: false` can only come from the branch under test.
 */
function gitInit(root: string): void {
  const ident = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', [...ident, 'add', '-A'], { cwd: root });
  execFileSync('git', [...ident, 'commit', '-q', '-m', 'fixture'], { cwd: root });
}

const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: 'futin/x' });

beforeEach(() => {
  process.env[GITHUB_TOKEN_ENV] = 'tok';
});

afterEach(() => {
  if (TOKEN === undefined) delete process.env[GITHUB_TOKEN_ENV];
  else process.env[GITHUB_TOKEN_ENV] = TOKEN;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('both adapters in one payload', () => {
  let app: INestApplication;
  let files: string;
  let tracker: string;
  let registryFile: string;

  beforeEach(async () => {
    files = project('files', undefined, [
      { leaf: 'bugs/open', filename: 'bug-1-it-breaks.md', content: item('bug-1', 'it breaks', '## Symptom\n\nx\n\n## Cause\n\nc\n\n## Fix\n\nf\n') }
    ]);
    tracker = project('tracker', GITHUB_MARKER);
    gitInit(tracker);
    registryFile = makeRegistry([{ name: 'files', path: files }, { name: 'tracker', path: tracker }]);
    app = await build(registryFile);
    await app.get(TrackerPollerService).tick();
  });

  afterEach(async () => {
    app.get(TrackerPollerService).disarm();
    await app.close();
  });

  it('returns both projects’ items in one payload, distinguished by source', async () => {
    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    const index = res.body as ItemsIndex;
    expect(index.items.map((i) => `${i.source}:${i.id}`).sort()).toEqual(['files:bug-1', 'github:#31', 'github:#32']);
    // The PR is absent entirely — not an untyped idea, not an error.
    expect(index.errors).toEqual([]);
  });

  it('counts a tracker project over the cache, excluding done exactly as today', async () => {
    const res = await request(app.getHttpServer()).get('/api/projects').expect(200);
    const summary = (res.body as ProjectSummary[]).find((p) => p.name === 'tracker');
    // #31 is an open bug; #32 is closed-completed, so `done`, so uncounted.
    expect(summary?.counts).toEqual({ bugs: 1, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 });
    expect(summary?.source).toBe('github');
  });

  it('gives a files project four nulls and the tracker project its connection state', async () => {
    const res = await request(app.getHttpServer()).get('/api/projects').expect(200);
    const summaries = res.body as ProjectSummary[];
    const filesSummary = summaries.find((p) => p.name === 'files');
    expect(filesSummary).toMatchObject({ source: 'files', repo: null, polledAt: null, access: null, detail: null });

    const trackerSummary = summaries.find((p) => p.name === 'tracker');
    expect(trackerSummary?.repo).toBe('futin/x');
    expect(trackerSummary?.access).toBe('ok');
    expect(typeof trackerSummary?.polledAt).toBe('string');
    expect(trackerSummary?.missing).toBe(false);
  });

  it('serves a tracker body by URN and a files body by path, from one route', async () => {
    const urn = await request(app.getHttpServer()).get('/api/items/body').query({ path: 'gh:futin/x#31' }).expect(200);
    expect(urn.text).toContain('## Cause');

    const index = (await request(app.getHttpServer()).get('/api/items').expect(200)).body as ItemsIndex;
    const filePath = index.items.find((i) => i.source === 'files')?.path as string;
    const fromDisk = await request(app.getHttpServer()).get('/api/items/body').query({ path: filePath }).expect(200);
    expect(fromDisk.text).toContain('## Symptom');
  });

  it('404s a URN whose repo nobody is connected to, without touching the files allowlist', async () => {
    await request(app.getHttpServer()).get('/api/items/body').query({ path: 'gh:someone/else#1' }).expect(404);
  });

  it('404s a cached repo the registry no longer connects — the gate is the registry, not the cache', async () => {
    // The issue IS in the poller's cache (the beforeEach ticked), and is
    // readable while the project is registered.
    await request(app.getHttpServer()).get('/api/items/body').query({ path: 'gh:futin/x#31' }).expect(200);

    // Disconnect the project by rewriting the registry the server re-reads per
    // request — the same event as someone running `unregister`. The cache is
    // untouched, so only the registry gate can produce the 404 below, which is
    // what makes this case pin the gate rather than "the cache happens to be
    // empty".
    writeFileSync(registryFile, JSON.stringify({ projects: [{ name: 'files', path: files, createdAt: '2026-08-26T00:00:00.000Z' }] }));
    await request(app.getHttpServer()).get('/api/items/body').query({ path: 'gh:futin/x#31' }).expect(404);
  });

  it('answers known: false for a tracker project’s uncommitted read', async () => {
    // The fixture is a real repo on `main` with a clean tree, so the FILES
    // answer here would be `{ paths: [], known: true }` — see `gitInit`.
    const filesAnswer = uncommittedItemPaths(tracker);
    expect(filesAnswer.known).toBe(true);

    const res = await request(app.getHttpServer()).get('/api/items/uncommitted').query({ project: tracker }).expect(200);
    // The question has no meaning for a project with no item files, and the
    // sheet's existing `known` gate keeps the chip off. Nothing derived reads
    // this, and it remains a sibling endpoint rather than a `BacklogItem`
    // field.
    expect(res.body).toEqual({ paths: [], known: false });
  });

  it('never puts the token in a payload', async () => {
    // Asserted over every route this module serves, because "the token is
    // process-only" is a claim about the whole surface rather than about one
    // handler (spec §11).
    for (const path of ['/api/items', '/api/projects', '/api/trackers']) {
      const res = await request(app.getHttpServer()).get(path).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('tok');
    }
  });
});

describe('a tracker project with no token', () => {
  let app: INestApplication;

  beforeEach(async () => {
    delete process.env[GITHUB_TOKEN_ENV];
    const tracker = project('tracker-no-token', GITHUB_MARKER);
    app = await build(makeRegistry([{ name: 'tracker', path: tracker }]));
  });

  afterEach(async () => {
    app.get(TrackerPollerService).disarm();
    await app.close();
  });

  it('reads access no-token and is explicitly not missing', async () => {
    const res = await request(app.getHttpServer()).get('/api/projects').expect(200);
    const summary = (res.body as ProjectSummary[])[0];
    expect(summary.access).toBe('no-token');
    // The sentence §5.4 spends a line on: `missing` keeps its one meaning —
    // no `backlog/` at all — and a connected project with an unreadable
    // credential still has its store.
    expect(summary.missing).toBe(false);
    expect(summary.polledAt).toBeNull();
    expect(summary.source).toBe('github');
  });
});

describe('GET /api/trackers', () => {
  let app: INestApplication;
  let files: string;

  beforeEach(async () => {
    files = project('files-origin');
    const tracker = project('tracker-card', GITHUB_MARKER);
    app = await build(makeRegistry([{ name: 'files', path: files }, { name: 'tracker', path: tracker }]));
    await app.get(TrackerPollerService).tick();
  });

  afterEach(async () => {
    app.get(TrackerPollerService).disarm();
    await app.close();
  });

  it('reports the platform without the token, and one row per registered project', async () => {
    const res = await request(app.getHttpServer()).get('/api/trackers').expect(200);
    const payload = res.body as TrackersPayload;
    expect(payload.platforms).toEqual([{ kind: 'github', hasToken: true, login: 'futin', limit: null, remaining: null, reset: null }]);

    const rows = payload.projects;
    expect(rows.map((r) => r.name).sort()).toEqual(['files', 'tracker']);
    const tracked = rows.find((r) => r.name === 'tracker');
    expect(tracked).toMatchObject({ source: 'github', repo: 'futin/x', access: 'ok', connect: null });
    // The files project's temp directory is not a git repo, so there is no
    // origin and nothing to suggest — `null`, never a guessed command.
    expect(rows.find((r) => r.name === 'files')).toMatchObject({ source: 'files', repo: null, connect: null });
  });
});
