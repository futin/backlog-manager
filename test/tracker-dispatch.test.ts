import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { GithubSource } from '../server/src/items/sources/github.source';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { GithubClient } from '../server/src/tracker/github.client';
import { TrackerPollerService } from '../server/src/tracker/poller.service';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';
import { FakeGithub, FAKE_REPO } from './helpers/github';
import { listenLoopback } from './helpers/app';
import { item, makeProject, makeRegistry } from './helpers/store';
import type { ClaimRecord } from '../shared/types';

/**
 * The dispatch lift (task-46, Step 8): `plan` and `dispatch` reach a tracker
 * item, and `orchestrate` refuses a tracker project.
 *
 * Task-45 made both of those one line — `deriveAction` answered `null` for
 * every tracker item, so there was no dispatch AND no orchestrate. Phase 3
 * split them: a tracker item has exactly the next steps a files item has, and
 * a tracker PROJECT still cannot be orchestrated until phase 4. This suite
 * drives both halves through the real routes, with a files project in the same
 * registry so every case can show the two answering differently.
 *
 * Two fakes, and they are deliberately separate: `GithubClient` gets the
 * in-memory GitHub (`helpers/github.ts`), and the global `fetch` gets the
 * dashboard — `AgentsService` calls the dashboard through global `fetch`, and
 * one stub answering both would make "which of the two did this call go to" a
 * question the suite could not ask.
 */

const GITHUB_MARKER = JSON.stringify({ kind: 'github', repo: FAKE_REPO });
const TOKEN = 'ghp_task46DispatchSentinel';
const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n');

const dirs: string[] = [];
const env = { ...process.env };
const realFetch = global.fetch;

let app: INestApplication;
let gh: FakeGithub;
let filesPath: string;
let trackerPath: string;
/** Every URL the DASHBOARD stub was asked for — a spawn in here is a session
 *  that would have started for real. */
let spawned: string[];

function project(name: string, marker?: string, items: Parameters<typeof makeProject>[1] = []): string {
  const root = makeProject(name, items, marker);
  dirs.push(root);
  return root;
}

/** The dashboard, on global `fetch`: health, the project map, and `/api/spawn`. */
function stubDashboard(): void {
  spawned = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    spawned.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url.endsWith('/api/management')
            ? {
                projects: [
                  { dirName: '-abs-alpha', name: 'alpha', path: filesPath, lastActiveMs: 1 },
                  { dirName: '-abs-gamma', name: 'gamma', path: trackerPath, lastActiveMs: 1 }
                ]
              }
            : url.endsWith('/api/spawn')
              ? { sessionId: 'sess-1' }
              : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' }
        )
    } as Response);
  }) as jest.Mock;
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

const bugPath = (): string => join(filesPath, 'backlog', 'bugs/open', 'bug-2-a-known-bug.md');

beforeEach(async () => {
  process.env.BM_AGENTS = 'on';
  process.env.BM_AGENTS_URL = 'http://dash.test:4173';
  process.env[GITHUB_TOKEN_ENV] = TOKEN;

  gh = new FakeGithub();
  gh.issue();
  filesPath = project('alpha', undefined, [{ leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG }]);
  trackerPath = project('gamma', GITHUB_MARKER);
  stubDashboard();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(
      makeRegistry([
        { name: 'alpha', path: filesPath },
        { name: 'gamma', path: trackerPath }
      ])
    )
    .overrideProvider(GithubClient)
    .useValue(new GithubClient(gh.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  app.get(GithubSource).settleMs = 0;

  // Seed the cache the way a real sweep would, then stand the poller down: the
  // read path answers from the cache, and a background tick would make the
  // dashboard stub's call log non-deterministic.
  const poller = app.get(TrackerPollerService);
  await poller.tick();
  poller.disarm();
  spawned = [];
});

afterEach(async () => {
  await app.close();
  process.env = { ...env };
  global.fetch = realFetch;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('plan', () => {
  it('resolves a tracker item by URN and derives its action', async () => {
    const res = await request(app.getHttpServer()).post('/api/agents/plan').send({ itemPath: `gh:${FAKE_REPO}#31` }).expect(201);
    expect(res.body.action).toBe('execute');
    expect(res.body.project).toBe('gamma');
    expect(res.body.prompt).toContain('#31');
    expect(res.body.blocked).toBeUndefined();
  });

  /* The registry gate, on the tracker side of `find`: a URN naming a repo no
     registered project is connected to is a 404 and never reaches the cache —
     the same answer an unallowlisted path gets, and for the same reason. */
  it('answers 404 for a URN naming a repo nobody is connected to', async () => {
    await request(app.getHttpServer()).post('/api/agents/plan').send({ itemPath: 'gh:other/y#31' }).expect(404);
  });

  it('still resolves a files item by path, exactly as before', async () => {
    const res = await request(app.getHttpServer()).post('/api/agents/plan').send({ itemPath: bugPath() }).expect(201);
    expect(res.body.action).toBe('execute');
    expect(res.body.project).toBe('alpha');
  });

  /**
   * The per-item in-progress block works for a tracker item for FREE, and this
   * case pins the half the SERVER is responsible for: the plan carries a
   * `started` and a `phase` read off the live claim, which is exactly what
   * `progressBlock` (`client/src/lib/item-progress.ts`) needs.
   *
   * The block itself is NOT asserted here, because the server has never
   * enforced it — for a files item either. `plan.blocked` is
   * `dispatchBlock ?? runClaimBlock`; `progressBlock` is the client's own
   * second of three per-item blocks and swallows the click in the browser.
   * The task item's Test cases section expected a server-side 409 for a
   * claimed tracker item, which would have been new asymmetric behaviour —
   * enforced for a tracker item and not for a files one — so it is not what
   * was built. `test/tracker-board.test.tsx` holds the rendered half.
   */
  it('carries the live claim-s started and phase, which is what the client-s block reads', async () => {
    gh.claim(record({ session: 'A', phase: 'groom' }), 31, 100);
    await app.get(TrackerPollerService).tick();

    const index = (await request(app.getHttpServer()).get('/api/items').expect(200)).body as { items: { id: string; started: string; phase: string }[] };
    const issue = index.items.find((i) => i.id === '#31');
    expect(issue?.started).not.toBe('');
    expect(issue?.phase).toBe('groom');

    // And the plan still offers the dispatch: the claim is the CLIENT's reason
    // to disable the control, not the server's reason to refuse it.
    const res = await request(app.getHttpServer()).post('/api/agents/plan').send({ itemPath: `gh:${FAKE_REPO}#31` }).expect(201);
    expect(res.body.action).toBe('execute');
  });
});

describe('dispatch', () => {
  it('spawns for a tracker item, naming the session after the issue', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agents/dispatch')
      .send({ itemPath: `gh:${FAKE_REPO}#31`, action: 'execute', prompt: 'Use the backlog-execute skill on #31.', permissionMode: 'acceptEdits' })
      .expect(201);

    expect(res.body).toEqual({ sessionId: 'sess-1' });
    expect(spawned.some((u) => u.endsWith('/api/spawn'))).toBe(true);
  });

  it('409s when the client disagrees with the derived action', async () => {
    await request(app.getHttpServer())
      .post('/api/agents/dispatch')
      .send({ itemPath: `gh:${FAKE_REPO}#31`, action: 'groom', prompt: 'x', permissionMode: 'acceptEdits' })
      .expect(409);
    expect(spawned.some((u) => u.endsWith('/api/spawn'))).toBe(false);
  });

  /* An orchestrator claim IS a server-side refusal — `runClaimBlock` is read
     by `dispatch` itself — and it reaches a tracker item through exactly the
     same code as a files one. There are no runs for a tracker project until
     phase 4, so the project-wide `starting` half is what this can drive today;
     it is asserted because the lift is what first lets a tracker item reach
     that check at all. */
  it('409s when a run is starting for the project, and spawns nothing', async () => {
    await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: filesPath }).expect(201);
    spawned = [];

    const res = await request(app.getHttpServer())
      .post('/api/agents/dispatch')
      .send({ itemPath: bugPath(), action: 'execute', prompt: 'x', permissionMode: 'acceptEdits' })
      .expect(409);
    expect(res.body.error).toMatch(/orchestrator run/i);
    expect(spawned.some((u) => u.endsWith('/api/spawn'))).toBe(false);
  });
});

describe('orchestrate', () => {
  /* Phase 4's refusal, and the reason it needs a gate of its own: until the
     lift this case was covered for free by `deriveAction` answering `null` for
     every tracker item, so no id could ever be runnable. With the lift,
     `resolveIds` — which scans FILES — would find none of them and 409 each id
     as "not an open bug or task in this project", which is both wrong and
     unactionable. */
  it('refuses a tracker project with a 400 naming phase 4, before any id check and with no spawn', async () => {
    const res = await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: trackerPath }).expect(400);
    expect(res.body.error).toContain('phase 4');
    expect(spawned.some((u) => u.endsWith('/api/spawn'))).toBe(false);
  });

  /* Before the ID check, asserted by handing it ids that are nonsense for this
     project: the answer must still be the tracker refusal, not a complaint
     about `task-3`. */
  it('answers the tracker refusal even when the ids are also wrong', async () => {
    const res = await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: trackerPath, ids: ['task-3'] }).expect(400);
    expect(res.body.error).toContain('phase 4');
  });

  it('still starts a run for a files project', async () => {
    await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: filesPath }).expect(201);
    expect(spawned.some((u) => u.endsWith('/api/spawn'))).toBe(true);
  });
});
