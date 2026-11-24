import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../server/src/app.module';
import { AgentsController } from '../../server/src/agents/agents.controller';
import { REGISTRY_FILE } from '../../server/src/registry/registry.service';
import { listenLoopback } from '../helpers/app';
import { makeRegistry } from '../helpers/store';

/*
 * agents-subagents.test.ts — `GET /api/agents/sessions/:id/subagents` (#611, spec docs/superpowers/specs/2026-11-24-subagent-visibility-design.md,
 * "Server route"): a proxy of the dashboard's `GET /api/sessions/:id` that validates the id before any fetch, refuses while agents are off, maps every
 * failure to the spec's sentence, and rebuilds the body field by field rather than forwarding it.
 */

const AGENT_A = {
  id: 'toolu_a',
  type: 'Explore',
  description: 'map the server',
  status: 'running',
  startedAt: '2026-01-01T10:00:00.000Z',
  endedAt: null,
  durationMs: null,
  tokens: null,
  agentId: 'ag-a',
  toolUses: 3,
  background: true,
  model: 'sonnet',
  lastWriteAt: '2026-01-01T10:05:00.000Z',
  lastTool: 'Read(server/src/main.ts)',
  endStatus: null,
  blockedReason: 'rate-limit'
};
const AGENT_B = {
  id: 'toolu_b',
  type: 'general-purpose',
  description: 'write the tests',
  status: 'done',
  startedAt: '2026-01-01T09:00:00.000Z',
  endedAt: '2026-01-01T09:04:00.000Z',
  durationMs: 240000,
  tokens: 1234,
  agentId: 'ag-b',
  toolUses: 9,
  resumed: true,
  background: false,
  model: 'opus',
  lastWriteAt: null,
  lastTool: null,
  endStatus: 'completed',
  blockedReason: null
};

type Reply = { status: number; body?: unknown } | Error;

/** Answers the dashboard's detail read with `reply` and records every URL asked for. */
function stubDashboard(reply: Reply) {
  const calls: string[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    calls.push(String(input));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({ ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: () => Promise.resolve(reply.body) } as Response);
  }) as jest.Mock;
  return calls;
}

describe('GET /api/agents/sessions/:id/subagents', () => {
  let app: INestApplication;
  const env = { ...process.env };
  const realFetch = global.fetch;
  const get = (id: string) => request(app.getHttpServer()).get(`/api/agents/sessions/${id}/subagents`);

  beforeEach(async () => {
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    delete process.env.BM_AGENTS_TOKEN;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('1: passes every known field of each agent, the counts and parentLive', async () => {
    const calls = stubDashboard({ status: 200, body: { id: 's-1', agents: [AGENT_A, AGENT_B], running: 1, finished: 1, parentLive: false } });
    const res = await get('s-1').expect(200);
    expect(res.body).toEqual({ agents: [AGENT_A, AGENT_B], running: 1, finished: 1, parentLive: false });
    expect(calls).toEqual(['http://dash.test:4173/api/sessions/s-1']);
  });

  it('1b: drops unknown keys, mistyped fields and out-of-set enum values, and the detail’s own id', async () => {
    const bad = { ...AGENT_A, foo: 'bar', endStatus: 'bogus', blockedReason: 7, background: 'yes' };
    stubDashboard({ status: 200, body: { id: 's-1', agents: [bad], running: 1, finished: 0 } });
    const res = await get('s-1').expect(200);
    const agent = res.body.agents[0];
    expect(agent).not.toHaveProperty('foo');
    expect(agent).not.toHaveProperty('endStatus');
    expect(agent).not.toHaveProperty('blockedReason');
    expect(agent).not.toHaveProperty('background');
    expect(agent.lastTool).toBe(AGENT_A.lastTool);
    expect(res.body).not.toHaveProperty('id');
    expect(res.body).not.toHaveProperty('parentLive');
  });

  it.each([
    ['a leading dot', '.x'],
    ['an encoded slash', 'a%2Fb'],
    ['129 characters', 'a'.repeat(129)]
  ])('2: 400 `not a session id` for %s, and nothing is fetched', async (_label, id) => {
    const calls = stubDashboard({ status: 200, body: { agents: [], running: 0, finished: 0 } });
    expect((await get(id).expect(400)).body).toEqual({ error: 'not a session id' });
    expect(calls).toEqual([]);
  });

  /* supertest's `new URL` collapses `..` before the request leaves, so the route never sees it over HTTP — the handler is called directly, as
     test/jira/agents-jira-stop.test.ts reaches its validator. */
  it('2b: 400 `not a session id` for `..`, and nothing is fetched', async () => {
    const calls = stubDashboard({ status: 200, body: { agents: [], running: 0, finished: 0 } });
    const controller = app.get(AgentsController);
    const thrown = await controller.subagents('..').then(
      () => null,
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(400);
    expect((thrown as HttpException).getResponse()).toEqual({ error: 'not a session id' });
    expect(calls).toEqual([]);
  });

  it('3: 409 `agents are off` while BM_AGENTS is off, and nothing is fetched', async () => {
    process.env.BM_AGENTS = 'off';
    const calls = stubDashboard({ status: 200, body: { agents: [], running: 0, finished: 0 } });
    expect((await get('s-1').expect(409)).body).toEqual({ error: 'agents are off' });
    expect(calls).toEqual([]);
  });

  it('4: the dashboard’s 404 is a 404 saying it has no transcript', async () => {
    stubDashboard({ status: 404, body: { error: 'no such session' } });
    expect((await get('s-1').expect(404)).body).toEqual({ error: 'the dashboard has no transcript for this session' });
  });

  it.each([500, 400])('5: a dashboard %i is a 502 naming the status', async (status) => {
    stubDashboard({ status, body: {} });
    expect((await get('s-1').expect(502)).body).toEqual({ error: `the dashboard session detail answered ${status}` });
  });

  it.each([
    ['`error: true`', { error: true }],
    ['no agents array', {}]
  ])('6: a 200 carrying %s is a 502, never an empty list', async (_label, body) => {
    stubDashboard({ status: 200, body });
    expect((await get('s-1').expect(502)).body).toEqual({ error: 'the dashboard session detail carried no agents' });
  });

  it('7: a network failure is a 502 naming the read', async () => {
    stubDashboard(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const res = await get('s-1').expect(502);
    expect(res.body.error).toMatch(/^the dashboard session detail/);
    expect(res.body.error).toContain('ECONNREFUSED');
  });

  it('7: a timeout is a 502 naming the timeout', async () => {
    stubDashboard(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    expect((await get('s-1').expect(502)).body.error).toMatch(/^the dashboard session detail timed out after \d+ms$/);
  });

  it('8: no cache — two requests are two fetches, the id URI-encoded into the path', async () => {
    const calls = stubDashboard({ status: 200, body: { agents: [], running: 0, finished: 0 } });
    await get('a.b_c-1').expect(200);
    await get('a.b_c-1').expect(200);
    expect(calls).toEqual(['http://dash.test:4173/api/sessions/a.b_c-1', 'http://dash.test:4173/api/sessions/a.b_c-1']);
  });
});
