import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { makeRegistry } from './helpers/store';

const HEALTH = {
  ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto'
};
const MANAGEMENT = {
  projects: [
    { dirName: '-abs-alpha', name: 'alpha', path: '/abs/alpha', lastActiveMs: 1 },
    { dirName: '-abs-beta', name: 'beta', path: '/abs/beta', lastActiveMs: 2 },
    // A malformed entry must be dropped, not crash the map build.
    { name: 'nameless' }
  ]
};

/** Answers the dashboard's two GETs and counts what was asked for. */
function stubDashboard() {
  const calls: string[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const payload = url.endsWith('/api/management') ? MANAGEMENT : HEALTH;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
  return calls;
}

describe('GET /api/agents/status', () => {
  let app: INestApplication;
  const env = { ...process.env };

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
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('reports the dashboard probe and the resolvable project paths', async () => {
    stubDashboard();
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(res.body).toEqual({
      enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
      spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha', '/abs/beta']
    });
  });

  it('makes no request at all when BM_AGENTS is off', async () => {
    const calls = stubDashboard();
    process.env.BM_AGENTS = 'off';
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(calls).toEqual([]);
    expect(res.body).toEqual({
      enabled: false, reachable: false, remoteAnswer: false, spawnAvailable: false,
      spawnMaxPermission: null, projectPaths: []
    });
  });

  it('reports why it is unreachable instead of failing the request', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))) as jest.Mock;
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.reachable).toBe(false);
    expect(res.body.error).toContain('ECONNREFUSED');
  });

  it('keeps a good health read when the heavy project scan fails', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      String(input).endsWith('/api/management')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(HEALTH) } as Response)
    ) as jest.Mock;
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(res.body.reachable).toBe(true);
    expect(res.body.projectPaths).toEqual([]);
  });

  it('reads an unrecognised ceiling as null rather than passing it through', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          String(input).endsWith('/api/management') ? MANAGEMENT : { ...HEALTH, spawnMaxPermission: 'godmode' }
        )
      } as Response)
    ) as jest.Mock;
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(res.body.spawnMaxPermission).toBeNull();
  });

  it('fetches the heavy project list once per TTL, health every time', async () => {
    const calls = stubDashboard();
    await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(calls.filter((u) => u.endsWith('/api/management'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/api/health'))).toHaveLength(2);
  });

  it('re-fetches the project list once the TTL has passed', async () => {
    const calls = stubDashboard();
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    clock.mockReturnValue(start + 61_000);
    await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(calls.filter((u) => u.endsWith('/api/management'))).toHaveLength(2);
  });
});
