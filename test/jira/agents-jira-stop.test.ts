import { mkdtempSync, rmSync } from 'node:fs';
import { RUN_META } from '../helpers/jira';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../server/src/app.module';
import { JiraLiveService } from '../../server/src/jira/live.service';
import { REGISTRY_FILE } from '../../server/src/registry/registry.service';
import { listenLoopback } from '../helpers/app';
import { makeRegistry } from '../helpers/store';

/**
 * `POST /api/agents/jira-stop` (Jira phase 5, Task 6; spec §5; sessions §7.3) — Stop: ask the dashboard to stop ONE named session of a ticket, then end that
 * session's link `stopped`. A ticket can hold several live sessions (a Run plus a detected branch session), so the body is `{ key, sessionId }` and the id
 * must be live on that key.
 *
 * The live map is seeded directly (`reserve` + `confirm`) rather than through `dispatch-jira`, so this suite owns exactly one route; the dashboard is the stub
 * `agents-dispatch-jira.test.ts` uses, on `global.fetch`. Jira is not configured at all: the route must never call it, and an app with no Jira token is the
 * strongest form of that — a call would have nowhere to go. A fresh app per case, because the live map is per-process memory.
 */

const REPO = '/work/pay';
const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE', 'BM_AGENTS', 'BM_AGENTS_URL', 'BM_AGENTS_TOKEN', 'BM_ORCH_HOME'] as const;

let saved: Record<string, string | undefined>;
let dir: string;
let app: INestApplication;
let live: JiraLiveService;
const realFetch = global.fetch;

interface Call {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
}

let calls: Call[];
let stop: { status: number; body: unknown } | 'reject';

function stubDashboard(): void {
  calls = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
    const answer = stop;
    if (answer === 'reject') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve({ ok: answer.status < 400, status: answer.status, json: () => Promise.resolve(answer.body) } as Response);
  }) as jest.Mock;
}

const post = (body: unknown) =>
  request(app.getHttpServer()).post('/api/agents/jira-stop').set('content-type', 'application/json').send(JSON.stringify(body));

/** A key with a session the dashboard can be asked to stop. */
function seedLive(key = 'PAY-1', sessionId = 'sess-1'): void {
  expect(live.reserve(key, REPO)).toBe(true);
  live.confirm(key, sessionId, RUN_META);
}

/** A detected `branch` link beside whatever the key already holds — the second live session a ticket can carry. */
function seedBranch(key: string, sessionId: string): void {
  expect(
    live.addLink({
      key,
      sessionId,
      how: 'branch',
      action: null,
      name: 'feature work',
      repo: REPO,
      branch: `feat/${key.toLowerCase()}`,
      surface: 'dashboard',
      model: null,
      effort: null,
      snapshot: { summary: 'Refund', type: 'Story', parentKey: null },
      startedAt: new Date().toISOString()
    })
  ).toBe('added');
}

/** The store's pair, ended or not — what a stop must leave behind as history rather than delete. */
const linkOf = (key: string, sessionId: string) => live.links().find((l) => l.key === key && l.sessionId === sessionId);

beforeAll(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-stop-'));
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const k of ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE']) delete process.env[k];
  process.env.BM_AGENTS = 'on';
  process.env.BM_AGENTS_URL = 'http://dash.test:4173';
  process.env.BM_AGENTS_TOKEN = 's3cret';
  // An empty orchestrator home, for the reason agents-dispatch.test.ts gives: the app boots the watchdog, which must not read a real run.
  process.env.BM_ORCH_HOME = join(dir, 'orchestrator');
  stop = { status: 200, body: { stopped: true } };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(REGISTRY_FILE).useValue(makeRegistry([])).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  live = app.get(JiraLiveService);
  stubDashboard();
});

afterEach(async () => {
  await app?.close();
  global.fetch = realFetch;
});

describe('a stop the dashboard accepts', () => {
  it('200 stops the session, ends its link `stopped` as history and answers ok — through the dashboard, never Jira', async () => {
    seedLive();
    expect((await post({ key: 'PAY-1', sessionId: 'sess-1' }).expect(200)).body).toEqual({ ok: true });
    expect(calls).toEqual([{ url: 'http://dash.test:4173/api/sessions/sess-1/stop', method: 'POST', authorization: 'Bearer s3cret' }]);
    expect(live.get('PAY-1')).toBeNull();
    expect(linkOf('PAY-1', 'sess-1')).toMatchObject({ endReason: 'stopped', endedAt: expect.any(String) });
  });

  /* The point of naming a session: the ticket holds a Run (s1) and a detected branch session (s2), and a Stop on one must leave the other running. */
  it('stops only the named session of a ticket that holds two', async () => {
    seedLive('PAY-7', 's1');
    seedBranch('PAY-7', 's2');
    await post({ key: 'PAY-7', sessionId: 's1' }).expect(200);
    expect(calls.map((c) => c.url)).toEqual(['http://dash.test:4173/api/sessions/s1/stop']);
    expect(linkOf('PAY-7', 's1')?.endReason).toBe('stopped');
    expect(linkOf('PAY-7', 's2')).toMatchObject({ endedAt: null, endReason: null });
    expect(live.liveLinks().map((l) => l.sessionId)).toEqual(['s2']);
  });

  it('stops the branch session of that pair just the same, leaving the Run live', async () => {
    seedLive('PAY-7', 's1');
    seedBranch('PAY-7', 's2');
    await post({ key: 'PAY-7', sessionId: 's2' }).expect(200);
    expect(linkOf('PAY-7', 's2')?.endReason).toBe('stopped');
    expect(linkOf('PAY-7', 's1')?.endedAt).toBeNull();
    expect(live.get('PAY-7')?.sessionId).toBe('s1');
  });

  /* The process is already gone: the person asked for it to be stopped, and it is — the entry has nothing left to describe. */
  it('the dashboard`s `no live session` 404 clears the entry just the same', async () => {
    seedLive();
    stop = { status: 404, body: { error: 'no live session' } };
    expect((await post({ key: 'PAY-1', sessionId: 'sess-1' }).expect(200)).body).toEqual({ ok: true });
    expect(live.get('PAY-1')).toBeNull();
    expect(linkOf('PAY-1', 'sess-1')?.endReason).toBe('stopped');
  });

  it('clears only the key it was asked about', async () => {
    seedLive('PAY-1', 'sess-1');
    seedLive('PAY-2', 'sess-2');
    await post({ key: 'PAY-2', sessionId: 'sess-2' }).expect(200);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
    expect(live.get('PAY-2')).toBeNull();
  });
});

describe('a stop the dashboard does not confirm — the session may still be running, so the entry stays', () => {
  it('502s on a 404 that is not `no live session`, naming that Jira is untouched', async () => {
    seedLive();
    stop = { status: 404, body: { error: 'remote answers disabled' } };
    const res = await post({ key: 'PAY-1', sessionId: 'sess-1' }).expect(502);
    expect(res.body).toEqual({ error: 'the dashboard did not stop session sess-1: remote answers disabled — Jira is untouched' });
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('502s on a 500', async () => {
    seedLive();
    stop = { status: 500, body: { error: 'boom' } };
    await post({ key: 'PAY-1', sessionId: 'sess-1' }).expect(502);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('502s when the dashboard cannot be reached', async () => {
    seedLive();
    stop = 'reject';
    await post({ key: 'PAY-1', sessionId: 'sess-1' }).expect(502);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });
});

describe('refusals — the dashboard is not asked', () => {
  it.each([
    ['a lower-case key', { key: 'pay-1' }],
    ['no key', {}],
    ['a numeric key', { key: 1 }]
  ])('400 for %s', async (_label, body) => {
    seedLive();
    expect((await post({ sessionId: 'sess-1', ...body }).expect(400)).body).toEqual({ error: 'invalid issue key' });
    expect(calls).toEqual([]);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  /* A body with no session id is today's `{ key }` — the strip's old Stop — and is refused, not guessed at: with two live sessions there is no "the" session. */
  it.each([
    ['no sessionId', { key: 'PAY-1' }],
    ['a numeric sessionId', { key: 'PAY-1', sessionId: 7 }],
    ['an empty sessionId', { key: 'PAY-1', sessionId: '' }],
    ['a sessionId with a path in it', { key: 'PAY-1', sessionId: '../x' }],
    ['an over-long sessionId', { key: 'PAY-1', sessionId: 'a'.repeat(129) }],
    ['`..` as the sessionId', { key: 'PAY-1', sessionId: '..' }],
    ['a sessionId with a leading dot', { key: 'PAY-1', sessionId: '.x' }]
  ])('400 `invalid session id` for %s', async (_label, body) => {
    seedLive();
    expect((await post(body).expect(400)).body).toEqual({ error: 'invalid session id' });
    expect(calls).toEqual([]);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  /* The leading-alphanumeric rule must not cost a legitimate id: it passes the validator and is refused only for not being live. */
  it('accepts a short id and an id with inner dots, dashes and underscores', async () => {
    seedLive('PAY-1', 'a.b_c-1');
    await post({ key: 'PAY-1', sessionId: 'a.b_c-1' }).expect(200);
    seedLive('PAY-2', 's1');
    await post({ key: 'PAY-2', sessionId: 's1' }).expect(200);
  });

  /* Not live on THIS key: another key's session, an unknown one, and one that already ended all read the same — nothing to stop, and the dashboard is not asked. */
  it('409 for a session id not live on the key, naming its first 8 characters', async () => {
    seedLive('PAY-7', 's1');
    seedBranch('PAY-7', 's2');
    seedLive('PAY-8', 'other-session-id');
    expect((await post({ key: 'PAY-7', sessionId: 's9' }).expect(409)).body).toEqual({ error: 'PAY-7 has no live session s9' });
    expect((await post({ key: 'PAY-7', sessionId: 'other-session-id' }).expect(409)).body).toEqual({ error: 'PAY-7 has no live session other-se' });
    expect(calls).toEqual([]);
    expect(live.liveLinks().map((l) => l.sessionId).sort()).toEqual(['other-session-id', 's1', 's2']);
  });

  it('409 for a session that already ended, and ends nothing twice', async () => {
    seedLive('PAY-7', 's1');
    seedBranch('PAY-7', 's2');
    await post({ key: 'PAY-7', sessionId: 's1' }).expect(200);
    const first = linkOf('PAY-7', 's1')?.endedAt;
    calls.length = 0;
    expect((await post({ key: 'PAY-7', sessionId: 's1' }).expect(409)).body).toEqual({ error: 'PAY-7 has no live session s1' });
    expect(calls).toEqual([]);
    expect(linkOf('PAY-7', 's1')?.endedAt).toBe(first);
  });

  it('409 for a key the map does not hold', async () => {
    expect((await post({ key: 'PAY-9', sessionId: 'sess-1' }).expect(409)).body).toEqual({ error: 'no live session for PAY-9' });
    expect(calls).toEqual([]);
  });

  /* A starting entry has no session id yet, so there is nothing to stop; its own Start will confirm or release it. */
  it('409 for a starting entry, and leaves it for its own Start to settle', async () => {
    expect(live.reserve('PAY-1', REPO)).toBe(true);
    expect((await post({ key: 'PAY-1', sessionId: 'sess-1' }).expect(409)).body).toEqual({ error: 'PAY-1 is still starting' });
    expect(calls).toEqual([]);
    expect(live.get('PAY-1')?.sessionId).toBeNull();
  });

  it('409 with the environment`s sentence while agents are off', async () => {
    seedLive();
    process.env.BM_AGENTS = 'off';
    expect((await post({ key: 'PAY-1', sessionId: 'sess-1' }).expect(409)).body).toEqual({ error: 'dispatch is off — set BM_AGENTS=on for the API' });
    expect(calls).toEqual([]);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });

  it('403 for a cross-origin POST — the guard every agents POST carries', async () => {
    seedLive();
    await post({ key: 'PAY-1', sessionId: 'sess-1' }).set('origin', 'http://evil.example').expect(403);
    expect(calls).toEqual([]);
    expect(live.get('PAY-1')?.sessionId).toBe('sess-1');
  });
});
