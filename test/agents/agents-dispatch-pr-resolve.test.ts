import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AgentsService } from '../../server/src/agents/agents.service';
import { PrResolveService } from '../../server/src/agents/pr-resolve.service';
import { JIRA_LIVE_GRACE_MS } from '../../server/src/agents/jira-live.service';
import { fileKey, parseFileKey } from '../../server/src/agents/pr-resolve.util';
import { AppModule } from '../../server/src/app.module';
import { REGISTRY_FILE } from '../../server/src/registry/registry.service';
import { PullRequestsService } from '../../server/src/tracker/pulls.service';
import { writeSyncInterval } from '../../server/src/tracker/sync-config.util';
import { GITHUB_TOKEN_ENV } from '../../server/src/tracker/token.util';
import { clampMode, DEFAULT_MODEL, projectDispatchGate } from '../../shared/agent';
import type { PrResolveOutcome, PullRequestRow } from '../../shared/types';
import { listenLoopback } from '../helpers/app';
import { makeProject, makeRegistry } from '../helpers/store';

/**
 * `POST /api/agents/dispatch-pr-resolve` and `GET /api/agents/pr-resolve` (PR conflict resolve, Task 4): the ladder, the reservation, the leftover-lock rung and
 * the live rule. The whole `AppModule` on a socket, so the origin guard and the Host allowlist are the real ones. Two fakes, one per side: the dashboard on
 * `global.fetch` (health, projects, spawn, and the one-session row), and `PullRequestsService.readOne` — the one-PR read has its own suite (Task 3), so here it
 * is answered per case and what the route does with each answer is what is under test.
 *
 * Time moves only through a `Date.now` stub, never fake timers: a fake clock would also fire the spawn's own timeout and drop the reservation a case asserts
 * is kept.
 */

const REPO = 'acme/web';
const A = 'a'.repeat(40);
const GRACE = JIRA_LIVE_GRACE_MS;

interface Dash {
  /** Present: the spawn answers this status (200 with a session id otherwise). */
  spawnStatus?: number;
  /** The spawn never answers — a hung dashboard. */
  hang?: boolean;
  healthDown?: boolean;
  /** The listed project paths; default is every registered project. */
  paths?: string[];
  /** `/api/sessions/<id>/row` answers: a row object, or `'down'` to fail the fetch; an id not in the map is the dashboard's 404. */
  rows: Record<string, { processLive?: boolean } | 'down'>;
  /** Every row lookup waits this long before answering. */
  rowDelayMs?: number;
}

let env: NodeJS.ProcessEnv;
let app: INestApplication;
let root: string;
let home: string;
let paths: string[];
let dash: Dash;
let spawns: Record<string, unknown>[];
let urls: string[];
let spawnCount: number;
/** The spawns a case left hanging, answered in teardown so the held request does not keep `app.close()` waiting. */
let hung: (() => void)[];
const realFetch = global.fetch;

function stubDashboard(): void {
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const reply = (body: unknown, status = 200): Promise<Response> =>
      Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);
    if (url.endsWith('/api/spawn')) {
      spawns.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (dash.hang === true)
        return new Promise<Response>((resolve) => hung.push(() => resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)));
      spawnCount += 1;
      return dash.spawnStatus !== undefined && dash.spawnStatus !== 200
        ? reply({ error: 'boom' }, dash.spawnStatus)
        : reply({ sessionId: `sess-${spawnCount}` });
    }
    const row = /\/api\/sessions\/([^/]+)\/row$/.exec(url);
    if (row !== null) {
      const answer = dash.rows[decodeURIComponent(row[1])];
      const settle = (): Promise<Response> => {
        if (answer === 'down') return Promise.reject(new TypeError('fetch failed'));
        return answer === undefined ? reply({ error: 'no such session' }, 404) : reply({ status: 'working', ...answer });
      };
      return dash.rowDelayMs === undefined ? settle() : new Promise((resolve) => setTimeout(() => resolve(settle()), dash.rowDelayMs));
    }
    if (url.endsWith('/api/health') && dash.healthDown === true) return Promise.reject(new TypeError('fetch failed'));
    if (url.endsWith('/api/configs')) {
      return reply({ projects: (dash.paths ?? paths).map((path, i) => ({ dirName: `-dir-${i}`, name: `p${i}`, path, lastActiveMs: 1 })) });
    }
    return reply({ ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' });
  }) as jest.Mock;
}

function conflicting(over: Partial<PullRequestRow> = {}, state: 'OPEN' | 'CLOSED' | 'MERGED' = 'OPEN'): { ok: true; pr: unknown } {
  const row = { number: 7, headSha: A, crossRepository: false, mergeable: 'conflicting', ...over };
  return { ok: true, pr: { id: 'PR_1', state, row, checksDetail: null } };
}

function readOne(answer: unknown | (() => Promise<unknown>)): jest.SpyInstance {
  const fn = typeof answer === 'function' ? (answer as () => Promise<unknown>) : () => Promise.resolve(answer);
  return jest.spyOn(app.get(PullRequestsService), 'readOne').mockImplementation(fn as never);
}

const outcome = (over: Partial<PrResolveOutcome> = {}): Record<string, unknown> => ({
  outcome: 'stopped',
  reason: 'a judgment hunk',
  fromSha: A,
  headSha: A,
  sessionId: 'sess-x',
  at: '2026-11-17T10:00:00.000Z',
  ...over
});

function writeOutcome(repo: string, n: number, body: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, `${fileKey(repo, n)}.json`), typeof body === 'string' ? body : JSON.stringify(body));
}

function writeLock(repo: string, n: number, sessionId: string | null, at: number): void {
  mkdirSync(join(home, 'locks'), { recursive: true });
  writeFileSync(join(home, 'locks', `${fileKey(repo, n)}.lock`), JSON.stringify({ sessionId, at: new Date(at).toISOString() }));
}

const post = (body: unknown): request.Test =>
  request(app.getHttpServer())
    .post('/api/agents/dispatch-pr-resolve')
    .send(body as object);
const get = (): request.Test => request(app.getHttpServer()).get('/api/agents/pr-resolve');
const spawned = (): number => urls.filter((u) => u.endsWith('/api/spawn')).length;

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function boot(
  projects: { name: string; repo: string }[] = [
    { name: 'web', repo: REPO },
    { name: 'api', repo: 'acme/api' }
  ]
): Promise<void> {
  paths = projects.map((p) => makeProject(`prr-${p.name}`, [], JSON.stringify({ kind: 'github', repo: p.repo })));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry(projects.map((p, i) => ({ name: p.name, path: paths[i] }))))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
}

beforeEach(() => {
  env = { ...process.env };
  root = mkdtempSync(join(tmpdir(), 'bm-pr-resolve-'));
  home = join(root, 'home');
  process.env.BM_PR_RESOLVE_HOME = home;
  process.env.BM_TRACKER_SYNC_FILE = join(root, 'tracker-sync.json');
  process.env.BM_AGENTS = 'on';
  process.env.BM_AGENTS_URL = 'http://dash.test:4173';
  process.env.BM_AGENTS_TOKEN = 's3cret';
  delete process.env[GITHUB_TOKEN_ENV];
  delete process.env.BM_ALLOWED_HOSTS;
  dash = { rows: {} };
  spawns = [];
  urls = [];
  spawnCount = 0;
  hung = [];
  stubDashboard();
});

afterEach(async () => {
  jest.restoreAllMocks();
  for (const release of hung) release();
  await app?.close();
  process.env = env;
  global.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

describe('the ladder', () => {
  beforeEach(boot as () => Promise<void>);

  it('400s a malformed body', async () => {
    const want = 'body must be { repo: "owner/name", number }';
    for (const body of [
      {},
      { repo: 'acme/web', number: '7' },
      { repo: 'acme', number: 7 },
      { repo: 'acme/web', number: 0 },
      { repo: 'acme/web', number: 1.5 },
      []
    ]) {
      const res = await post(body).expect(400);
      expect(res.body.error).toBe(want);
    }
  });

  it('404s a repo no registered GitHub project resolves to', async () => {
    const res = await post({ repo: 'acme/other', number: 7 }).expect(404);
    expect(res.body.error).toBe('acme/other is not the repo of a registered GitHub project');
  });

  it('409s sync off with its sentence', async () => {
    writeSyncInterval(REPO, 'off');
    const res = await post({ repo: REPO, number: 7 }).expect(409);
    expect(res.body.error).toBe(`sync is off for ${REPO} — turn it on in GitHub › Settings`);
  });

  /** The gate's own sentence for the project, computed the way the route does — never a hand copy of the text. */
  const gateReason = async (): Promise<string> => {
    const gate = projectDispatchGate(await app.get(AgentsService).status(), paths[0]);
    if (gate.control === 'enabled') throw new Error('the gate is open');
    return gate.reason;
  };

  it('409s agents off with the gate text, and 502s an unreachable dashboard, both before the PR is read', async () => {
    const read = readOne(conflicting());
    process.env.BM_AGENTS = 'off';
    const off = await post({ repo: REPO, number: 7 }).expect(409);
    expect(off.body.error).toBe(await gateReason());
    process.env.BM_AGENTS = 'on';
    dash.healthDown = true;
    const down = await post({ repo: REPO, number: 7 }).expect(502);
    expect(down.body.error).toBe(await gateReason());
    expect(read).not.toHaveBeenCalled();
    expect(spawned()).toBe(0);
  });

  it('409s sync off ahead of the gate: with BM_AGENTS off too, the sync-off sentence wins', async () => {
    const read = readOne(conflicting());
    writeSyncInterval(REPO, 'off');
    process.env.BM_AGENTS = 'off';
    const res = await post({ repo: REPO, number: 7 }).expect(409);
    expect(res.body.error).toBe(`sync is off for ${REPO} — turn it on in GitHub › Settings`);
    expect(read).not.toHaveBeenCalled();
  });

  it('409s a project the dashboard does not list, before the PR is read', async () => {
    const read = readOne(conflicting());
    dash.paths = ['/somewhere/else'];
    const res = await post({ repo: REPO, number: 7 }).expect(409);
    expect(res.body.error).toBe(`the dashboard does not list ${paths[0]} — most likely no Claude session there inside its LOOKBACK_HOURS`);
    expect(res.body.error).toBe(await gateReason());
    expect(read).not.toHaveBeenCalled();
  });

  it('passes the one-PR read refusals through: 503, 429, 502', async () => {
    for (const [status, error] of [
      [503, 'BM_GITHUB_TOKEN is not set on this machine'],
      [429, 'rate limited until 12:00'],
      [502, `could not read ${REPO}#7 from GitHub`]
    ] as const) {
      readOne({ ok: false, status, error });
      const res = await post({ repo: REPO, number: 7 }).expect(status);
      expect(res.body.error).toBe(error);
    }
  });

  it('409s a PR that is closed, merged, not found, a fork, still computing, or has no conflicts', async () => {
    const cases: [unknown, string][] = [
      [conflicting({}, 'CLOSED'), `${REPO}#7 is not open`],
      [conflicting({}, 'MERGED'), `${REPO}#7 is not open`],
      [{ ok: true, pr: null }, `${REPO}#7 is not open`],
      [conflicting({ crossRepository: true }), `${REPO}#7 is from a fork — the session cannot push to it`],
      [conflicting({ mergeable: 'unknown' }), 'GitHub is still computing mergeability — try again in a moment'],
      [conflicting({ mergeable: 'mergeable' }), `${REPO}#7 has no conflicts`]
    ];
    for (const [answer, error] of cases) {
      readOne(answer);
      const res = await post({ repo: REPO, number: 7 }).expect(409);
      expect(res.body.error).toBe(error);
    }
    expect(spawned()).toBe(0);
  });
});

describe('the spawn', () => {
  it('answers 201 with the plain trigger, the default model, no effort, and the FIRST registered path of the repo', async () => {
    await boot([
      { name: 'web1', repo: REPO },
      { name: 'web2', repo: REPO }
    ]);
    readOne(conflicting());
    const res = await post({ repo: REPO, number: 7 }).expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });
    expect(spawns).toHaveLength(1);
    expect(spawns[0].prompt).toBe('/backlog-manager:pr-resolve acme/web#7');
    expect(spawns[0].model).toBe(DEFAULT_MODEL);
    expect('effort' in spawns[0]).toBe(false);
    expect(spawns[0].remoteControl).toBe(false);
    // Asks for `auto`, clamped to the dashboard's cap the way every other spawn is — the cap is the status's, not a literal of this route.
    expect(spawns[0].permissionMode).toBe(clampMode('auto', (await app.get(AgentsService).status()).spawnMaxPermission));
    expect(spawns[0].project).toBe('-dir-0');
    expect(spawns[0].name).toBe('pr-resolve acme/web#7');
  });

  describe('reservation', () => {
    beforeEach(boot as () => Promise<void>);

    it('refuses a second POST while the first is inside the grace', async () => {
      readOne(conflicting());
      await post({ repo: REPO, number: 7 }).expect(201);
      const again = await post({ repo: REPO, number: 7 }).expect(409);
      expect(again.body.error).toBe(`a resolve of ${REPO}#7 is already running`);
      expect(spawned()).toBe(1);
    });

    it.each([
      ['no outcome file', false],
      ["a terminal run's outcome file (sessionId null)", true]
    ])('two POSTs fired together spawn once — %s', async (_name, withOutcome) => {
      if (withOutcome) writeOutcome(REPO, 7, outcome({ sessionId: null }));
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const spy = readOne(() => held.then(() => conflicting()));
      const a = post({ repo: REPO, number: 7 }).then((r) => r);
      const b = post({ repo: REPO, number: 7 }).then((r) => r);
      await until(() => spy.mock.calls.length === 2);
      release();
      const statuses = [(await a).status, (await b).status].sort();
      expect(statuses).toEqual([201, 409]);
      expect(spawned()).toBe(1);
    });

    it('keys by repo and number: another number and another repo both pass', async () => {
      readOne(conflicting());
      await post({ repo: REPO, number: 7 }).expect(201);
      await post({ repo: REPO, number: 8 }).expect(201);
      await post({ repo: 'acme/api', number: 7 }).expect(201);
    });

    it('keeps a spawn held past the grace as live, and refuses a second POST', async () => {
      readOne(conflicting());
      dash.hang = true;
      const first = post({ repo: REPO, number: 7 }).then((r) => r);
      await until(() => spawned() === 1);
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + GRACE + 1000);
      const listed = await get().expect(200);
      expect(listed.body.resolves).toEqual([{ repo: REPO, number: 7, live: { sessionId: null }, outcome: null }]);
      const again = await post({ repo: REPO, number: 7 }).expect(409);
      expect(again.body.error).toBe(`a resolve of ${REPO}#7 is already running`);
      expect(spawned()).toBe(1);
      void first;
    });

    it('drops the reservation when the spawn fails, so an immediate retry is not refused as running', async () => {
      readOne(conflicting());
      dash.spawnStatus = 500;
      const failed = await post({ repo: REPO, number: 7 });
      expect(failed.status).toBe(502);
      expect(failed.body).toEqual({ error: 'boom' });
      expect(failed.body.error).not.toBe(`a resolve of ${REPO}#7 is already running`);
      dash.spawnStatus = 200;
      await post({ repo: REPO, number: 7 }).expect(201);
      expect(spawned()).toBe(2);
    });

    it('drops the reservation of an entry whose session is gone, past the grace, before the next click', async () => {
      readOne(conflicting());
      await post({ repo: REPO, number: 7 }).expect(201);
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + GRACE + 1000);
      dash.rows = { 'sess-1': { processLive: false } };
      await post({ repo: REPO, number: 7 }).expect(201);
      expect(spawned()).toBe(2);
    });
  });

  describe('the leftover lock', () => {
    beforeEach(async () => {
      await boot();
      readOne(conflicting());
    });

    it('a live owner is the 409', async () => {
      writeLock(REPO, 7, 'old', Date.now() - 10 * 60_000);
      dash.rows = { old: { processLive: true } };
      const res = await post({ repo: REPO, number: 7 }).expect(409);
      expect(res.body.error).toBe(`a resolve of ${REPO}#7 is already running`);
      expect(spawned()).toBe(0);
      // The refusal dropped its reservation: once the owner is dead the same click goes through.
      dash.rows = {};
      await post({ repo: REPO, number: 7 }).expect(201);
    });

    it('a dead owner is reclaimed through the trigger', async () => {
      writeLock(REPO, 7, 'old', Date.now() - 10 * 60_000);
      await post({ repo: REPO, number: 7 }).expect(201);
      expect(spawns[0].prompt).toBe('/backlog-manager:pr-resolve acme/web#7 --reclaim old');
    });

    it('an unreachable dashboard on that lookup is the 409, never a reclaim', async () => {
      writeLock(REPO, 7, 'old', Date.now() - 10 * 60_000);
      dash.rows = { old: 'down' };
      await post({ repo: REPO, number: 7 }).expect(409);
      expect(spawned()).toBe(0);
    });

    it('a lock younger than the grace is the 409 without asking the dashboard', async () => {
      writeLock(REPO, 7, 'old', Date.now() - 30_000);
      await post({ repo: REPO, number: 7 }).expect(409);
      expect(urls.some((u) => u.includes('/api/sessions/'))).toBe(false);
    });

    it('a lock with no session id is the 409 for 3 hours and a plain trigger after', async () => {
      writeLock(REPO, 7, null, Date.now() - 60 * 60_000);
      await post({ repo: REPO, number: 7 }).expect(409);
      writeLock(REPO, 7, null, Date.now() - 4 * 60 * 60_000);
      await post({ repo: REPO, number: 7 }).expect(201);
      expect(spawns[0].prompt).toBe('/backlog-manager:pr-resolve acme/web#7');
    });

    it('a session id that is not a plain token never reaches the prompt: the null-id rule, a 409 under 3 hours', async () => {
      writeLock(REPO, 7, 'x\n/other-skill', Date.now() - 10 * 60_000);
      await post({ repo: REPO, number: 7 }).expect(409);
      expect(spawned()).toBe(0);
      expect(urls.some((u) => u.includes('/api/sessions/'))).toBe(false);
    });

    it('and past 3 hours the plain trigger, with no reclaim and nothing of the id in the prompt', async () => {
      writeLock(REPO, 7, 'x\n/other-skill', Date.now() - 4 * 60 * 60_000);
      await post({ repo: REPO, number: 7 }).expect(201);
      expect(spawns[0].prompt).toBe('/backlog-manager:pr-resolve acme/web#7');
    });
  });
});

describe('an unreadable registry', () => {
  it('is the 503 naming registry.json, before anything else', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = join(mkdtempSync(join(tmpdir(), 'bm-brokenreg-')), 'registry.json');
    writeFileSync(broken, '{"projects": [');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(broken)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
    const res = await post({ repo: REPO, number: 7 }).expect(503);
    expect(res.body.error).toContain('registry.json');
    expect(spawned()).toBe(0);
  });
});

describe('GET /api/agents/pr-resolve', () => {
  beforeEach(boot as () => Promise<void>);

  it('is empty with no home directory', async () => {
    const res = await get().expect(200);
    expect(res.body).toEqual({ resolves: [] });
  });

  it('lists outcome files and live entries, skipping unreadable and hand-made files', async () => {
    writeOutcome(REPO, 7, outcome());
    writeOutcome(REPO, 8, '{"outcome": "pushed", "rea');
    writeOutcome(REPO, 10, outcome({ outcome: 'done' as never }));
    writeOutcome('acme/my__lib', 12, outcome());
    writeFileSync(join(home, 'notakey.json'), JSON.stringify(outcome()));
    readOne(conflicting());
    await post({ repo: REPO, number: 9 }).expect(201);
    const res = await get().expect(200);
    const want = outcome();
    delete want.at;
    expect(res.body.resolves).toEqual([
      { repo: 'acme/my__lib', number: 12, live: null, outcome: want },
      { repo: REPO, number: 7, live: null, outcome: want },
      { repo: REPO, number: 9, live: { sessionId: 'sess-1' }, outcome: null }
    ]);
  });

  it('merges an older outcome file and a live entry of one PR into one entry', async () => {
    writeOutcome(REPO, 7, outcome({ sessionId: 'old' }));
    readOne(conflicting());
    await post({ repo: REPO, number: 7 }).expect(201);
    const res = await get().expect(200);
    expect(res.body.resolves).toHaveLength(1);
    expect(res.body.resolves[0].live).toEqual({ sessionId: 'sess-1' });
    expect(res.body.resolves[0].outcome.sessionId).toBe('old');
  });

  describe('the live rule', () => {
    const resolves = async (now: number): ReturnType<PrResolveService['list']> => app.get(PrResolveService).list(now);

    beforeEach(async () => {
      readOne(conflicting());
      await post({ repo: REPO, number: 7 }).expect(201);
    });

    it('inside the grace the entry is live with no dashboard lookup, whatever the dashboard says', async () => {
      const before = urls.length;
      const listed = await resolves(Date.now() + 1000);
      expect(listed.resolves[0].live).toEqual({ sessionId: 'sess-1' });
      expect(urls.slice(before).some((u) => u.includes('/api/sessions/'))).toBe(false);
    });

    it('past the grace, a row that is not processLive, or no row, drops it', async () => {
      dash.rows = { 'sess-1': { processLive: false } };
      expect((await resolves(Date.now() + GRACE + 1000)).resolves).toEqual([]);
    });

    it('past the grace, no row at all drops it', async () => {
      expect((await resolves(Date.now() + GRACE + 1000)).resolves).toEqual([]);
    });

    it('past the grace, a processLive row keeps it, and an unreachable dashboard keeps it', async () => {
      dash.rows = { 'sess-1': { processLive: true } };
      expect((await resolves(Date.now() + GRACE + 1000)).resolves[0].live).toEqual({ sessionId: 'sess-1' });
      dash.rows = { 'sess-1': 'down' };
      expect((await resolves(Date.now() + GRACE + 1000)).resolves[0].live).toEqual({ sessionId: 'sess-1' });
    });

    it("an outcome file carrying the entry's session id ends it, inside the grace and with no lookup", async () => {
      writeOutcome(REPO, 7, outcome({ sessionId: 'sess-1' }));
      const before = urls.length;
      const listed = await resolves(Date.now() + 1000);
      expect(listed.resolves).toHaveLength(1);
      expect(listed.resolves[0].live).toBeNull();
      expect(listed.resolves[0].outcome?.sessionId).toBe('sess-1');
      expect(urls.length).toBe(before);
    });
  });

  it('a spawning entry (sessionId null) beside an outcome file with sessionId null is still live', async () => {
    readOne(conflicting());
    dash.hang = true;
    void post({ repo: REPO, number: 7 }).then((r) => r);
    await until(() => spawned() === 1);
    writeOutcome(REPO, 7, outcome({ sessionId: null }));
    const res = await get().expect(200);
    expect(res.body.resolves).toHaveLength(1);
    expect(res.body.resolves[0].live).toEqual({ sessionId: null });
    expect(res.body.resolves[0].outcome.sessionId).toBeNull();
  });

  it('looks the live entries up in parallel', async () => {
    readOne(conflicting());
    for (const n of [7, 8, 9]) await post({ repo: REPO, number: n }).expect(201);
    dash.rows = { 'sess-1': { processLive: true }, 'sess-2': { processLive: true }, 'sess-3': { processLive: true } };
    dash.rowDelayMs = 300;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + GRACE + 1000);
    const t0 = performance.now();
    const res = await get().expect(200);
    expect(res.body.resolves).toHaveLength(3);
    expect(performance.now() - t0).toBeLessThan(600);
  });
});

describe('parseFileKey', () => {
  it('round-trips fileKey, including a repo name with a double underscore', () => {
    for (const [repo, n] of [
      ['acme/web', 7],
      ['acme/my__lib', 12],
      ['acme/_x', 3],
      ['acme/x_', 4]
    ] as const) {
      expect(parseFileKey(fileKey(repo, n))).toEqual({ repo, number: n });
    }
    expect(parseFileKey('notakey')).toBeNull();
    expect(parseFileKey('acme__web__0')).toBeNull();
    expect(parseFileKey('acme__web__x')).toBeNull();
  });
});

describe('origin guard', () => {
  beforeEach(boot as () => Promise<void>);

  it('refuses a cross-origin POST', async () => {
    await request(app.getHttpServer()).post('/api/agents/dispatch-pr-resolve').set('Origin', 'http://evil.example').send({ repo: REPO, number: 7 }).expect(403);
  });
});
