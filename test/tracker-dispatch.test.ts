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
 * The dispatch lift (task-46, Step 8) and the orchestrate lift (task-47, phase
 * 4a): `plan`, `dispatch` AND `orchestrate` all reach a tracker project.
 *
 * Task-45 made all three one line — `deriveAction` answered `null` for every
 * tracker item, so there was no dispatch and no orchestrate. Phase 3 split
 * them: a tracker item gained the next steps a files item has, and a tracker
 * PROJECT kept a refusal of its own. Phase 4a removed that refusal too, and
 * what replaced it is `resolveIds` learning the tracker vocabulary — three
 * accepted spellings, one emitted, none of them carrying a `#` into the
 * prompt. This suite drives all of it through the real routes, with a files
 * project in the same registry so every case can show the two answering
 * identically where they should.
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
  /* task-47 (phase 4a) removed task-46's `orchestrating a tracker project
     arrives in phase 4` refusal, and these are what stand in its place. The
     three cases below are O-L1 to O-L3 of the item's Test cases.

     The interesting property is the LAST assertion of the first case: no `#`
     anywhere in the composed prompt. `resolveTrackerIds` accepts all three
     spellings a caller can hold — `#31`, the URN, and the bare number — and
     emits one, because `orchestrate.mjs` reads its argv as tokens and
     SKILL.md substitutes those tokens into fenced shell commands where `#`
     opens a comment. That normalisation is the reason CLAUDE.md's `isItemId`
     paragraph can still say a `#` never reaches a shell, now that the refusal
     which used to guarantee it is gone. */
  const promptOf = (): string => {
    const call = (global.fetch as jest.Mock).mock.calls.find(([url]) => String(url).endsWith('/api/spawn'));
    return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? '{}')).prompt as string;
  };

  it('starts a run for a tracker project, naming every id by bare number and no # anywhere', async () => {
    // #31 is the default issue (a `type:bug`); two more, one a task, so the
    // three accepted spellings each have a real open item behind them.
    gh.issue({ number: 32, labels: [{ name: 'type:task' }] });
    gh.issue({ number: 33, labels: [{ name: 'type:task' }] });
    await app.get(TrackerPollerService).tick();

    await request(app.getHttpServer())
      .post('/api/agents/orchestrate')
      .send({ project: trackerPath, ids: ['#31', `gh:${FAKE_REPO}#32`, '33'] })
      .expect(201);

    const prompt = promptOf();
    expect(prompt).toContain('/backlog-orchestrate 31 32 33');
    expect(prompt).not.toContain('#');
  });

  /* The two refusals, split the way the files path splits them: 409 when the
     request is well-formed and the PROJECT disagrees with it, 400 when it is
     not an id this project could ever name. */
  it('409s an id that is not an open bug or task, and 400s a malformed one', async () => {
    await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: trackerPath, ids: ['#99'] }).expect(409);
    await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: trackerPath, ids: ['#31; rm'] }).expect(400);
    expect(spawned.some((u) => u.endsWith('/api/spawn'))).toBe(false);
  });

  it('still starts a run for a files project', async () => {
    await request(app.getHttpServer()).post('/api/agents/orchestrate').send({ project: filesPath }).expect(201);
    expect(spawned.some((u) => u.endsWith('/api/spawn'))).toBe(true);
  });
});
