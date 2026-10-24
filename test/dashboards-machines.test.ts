import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { DashboardsService } from '../server/src/agents/dashboards/dashboards.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import type { MachinesStatus, MachineStatus } from '../shared/types';
import { listenLoopback } from './helpers/app';
import { makeRegistry } from './helpers/store';

/**
 * `GET /api/dashboards/machines` end to end through a real `AppModule`, the way `dashboards-offers.test.ts` drives the offers: every peer is a real HTTP
 * server on `127.0.0.1` that records each path it is asked for, so "health only", "usage not read for an unreachable machine" and "nothing contacted with
 * BM_AGENTS off" are proved from the request log and not from a mock's idea of it. Usage figures differ per machine (Home 12/30, Linux 64/81) so a machine's
 * usage cannot be another's by accident.
 */

const HOME_TOKEN = 'tok-home-secret-111';
const LINUX_TOKEN = 'tok-linux-secret-222';

const HEALTH = { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' };
const NOW_ISO = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const ACCOUNT = (five: number, week: number) => ({
  usageStatus: 'ok',
  usage: { fiveHour: { utilization: five, resetsAt: NOW_ISO(3_600_000) }, sevenDay: { utilization: week, resetsAt: NOW_ISO(4 * 86_400_000) } }
});
const PROFILE = () => ({ exhaustAt: null, walkAbsent: null, resetsAt: NOW_ISO(4 * 86_400_000) });

type Answer = unknown;
interface Stub {
  url: string;
  seen: string[];
}

const servers: Server[] = [];

async function stub(routes: Record<string, Answer>): Promise<Stub> {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0];
    seen.push(path);
    const answer = routes[path];
    if (answer === undefined) {
      res.writeHead(404).end();
      return;
    }
    if (typeof answer === 'number') {
      res.writeHead(answer).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** An origin nothing listens on: bind an ephemeral port, then give it back. A request there is refused at once. */
async function deadUrl(): Promise<string> {
  const s = await stub({});
  const server = servers.pop()!;
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return s.url;
}

const dashboard = (five: number, week: number, health: unknown = HEALTH) =>
  stub({ '/api/health': health, '/api/account': ACCOUNT(five, week), '/api/usage/profile': PROFILE() });

const USAGE_ROUTES = ['/api/account', '/api/usage/profile'];

describe('GET /api/dashboards/machines', () => {
  let app: INestApplication | undefined;
  let file: string;
  const env = { ...process.env };

  async function start(remotes: { name: string; url: string }[] | null, extra: Record<string, unknown> = {}): Promise<void> {
    if (remotes !== null) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ dashboards: remotes.map((d) => ({ name: d.name, url: d.url, bmUrl: d.url, host: `${d.name}-mac` })), ...extra }, null, 2)
      );
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(REGISTRY_FILE).useValue(makeRegistry([])).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
  }
  const get = () => request(app!.getHttpServer()).get('/api/dashboards/machines').expect(200);
  const machines = async (): Promise<MachineStatus[]> => ((await get()).body as MachinesStatus).machines;
  const byId = (all: MachineStatus[], id: string): MachineStatus => all.find((m) => m.machine === id)!;

  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'bm-machines-')), 'settings', 'dashboards.json');
    process.env.BM_DASHBOARDS_FILE = file;
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_TOKEN = HOME_TOKEN;
    process.env.BM_AGENTS_TOKEN_LINUX = LINUX_TOKEN;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          })
      )
    );
    process.env = { ...env };
  });

  it('answers every machine in machines() order, each with its own health and usage', async () => {
    const home = await dashboard(12, 30);
    const linux = await dashboard(64, 81);
    const pro = await dashboard(5, 5);
    process.env.BM_AGENTS_URL = home.url;
    await start(
      [
        { name: 'Linux', url: linux.url },
        { name: 'Pro', url: pro.url }
      ],
      { order: ['Linux', 'home', 'Pro'] }
    );
    const expected = app!
      .get(DashboardsService)
      .machines()
      .map((m) => m.id);
    const all = await machines();
    expect(all.map((m) => m.machine)).toEqual(expected);
    expect(expected).toHaveLength(3);
    const l = byId(all, 'Linux');
    expect(l.enabled).toBe(true);
    expect(l.reachable).toBe(true);
    expect(l.remoteAnswer).toBe(true);
    expect(l.spawnAvailable).toBe(true);
    expect(l.spawnMaxPermission).toBe('auto');
    expect(l.usage?.fiveHour.pct).toBe(64);
    expect(l.usage?.week.pct).toBe(81);
    expect(typeof l.usageAgeMs).toBe('number');
    expect(l.usageAgeMs).toBeGreaterThanOrEqual(0);
    expect(byId(all, 'home').usage?.fiveHour.pct).toBe(12);
    expect(byId(all, 'Pro').usage?.fiveHour.pct).toBe(5);
  });

  it('an unreachable remote is an answer, not an error, and the others still answer', async () => {
    const home = await dashboard(12, 30);
    const linux = await dashboard(64, 81);
    process.env.BM_AGENTS_URL = home.url;
    await start([
      { name: 'Linux', url: linux.url },
      { name: 'Pro', url: await deadUrl() }
    ]);
    const all = await machines();
    const pro = byId(all, 'Pro');
    expect(pro.enabled).toBe(true);
    expect(pro.reachable).toBe(false);
    expect(typeof pro.error).toBe('string');
    expect(pro.error!.length).toBeGreaterThan(0);
    expect(pro.usage).toBeNull();
    expect(pro.usageAgeMs).toBeNull();
    expect(byId(all, 'Linux').usage?.fiveHour.pct).toBe(64);
    expect(byId(all, 'home').reachable).toBe(true);
  });

  it('does not read the usage of a machine whose health failed', async () => {
    const home = await dashboard(12, 30);
    const linux = await stub({ '/api/health': 500, '/api/account': ACCOUNT(64, 81), '/api/usage/profile': PROFILE() });
    process.env.BM_AGENTS_URL = home.url;
    await start([{ name: 'Linux', url: linux.url }]);
    const l = byId(await machines(), 'Linux');
    expect(l.reachable).toBe(false);
    expect(l.usage).toBeNull();
    expect(linux.seen).toContain('/api/health');
    for (const r of USAGE_ROUTES) expect(linux.seen).not.toContain(r);
  });

  it('a machine that answers but cannot take a launch is reachable, says so, and still shows usage', async () => {
    const home = await dashboard(12, 30);
    const linux = await dashboard(64, 81, { ...HEALTH, remoteAnswer: false });
    process.env.BM_AGENTS_URL = home.url;
    await start([{ name: 'Linux', url: linux.url }]);
    const l = byId(await machines(), 'Linux');
    expect(l.reachable).toBe(true);
    expect(l.remoteAnswer).toBe(false);
    expect(l.usage?.fiveHour.pct).toBe(64);
  });

  it('reads health only: no machine is asked for /api/configs', async () => {
    const home = await stub({ '/api/health': HEALTH, '/api/configs': { projects: [] }, '/api/account': ACCOUNT(12, 30), '/api/usage/profile': PROFILE() });
    const linux = await stub({ '/api/health': HEALTH, '/api/configs': { projects: [] }, '/api/account': ACCOUNT(64, 81), '/api/usage/profile': PROFILE() });
    process.env.BM_AGENTS_URL = home.url;
    await start([{ name: 'Linux', url: linux.url }]);
    await get();
    expect(home.seen).toContain('/api/health');
    expect(linux.seen).toContain('/api/health');
    expect(home.seen).not.toContain('/api/configs');
    expect(linux.seen).not.toContain('/api/configs');
  });

  it('carries no token, no URL and none of the config keys', async () => {
    const home = await dashboard(12, 30);
    const linux = await dashboard(64, 81);
    process.env.BM_AGENTS_URL = home.url;
    await start([{ name: 'Linux', url: linux.url }]);
    const raw = (await get()).text;
    expect(raw).not.toContain(HOME_TOKEN);
    expect(raw).not.toContain(LINUX_TOKEN);
    expect(raw).not.toContain('http://');
    for (const key of ['url', 'bmUrl', 'projectPaths', 'tokenVar']) expect(raw).not.toContain(`"${key}"`);
  });

  it('with BM_AGENTS off nothing is contacted and every machine reads as not enabled', async () => {
    process.env.BM_AGENTS = 'off';
    const home = await dashboard(12, 30);
    const linux = await dashboard(64, 81);
    process.env.BM_AGENTS_URL = home.url;
    await start([{ name: 'Linux', url: linux.url }]);
    const all = await machines();
    expect(all).toHaveLength(2);
    for (const m of all) {
      expect(m.enabled).toBe(false);
      expect(m.reachable).toBe(false);
      expect(m.usage).toBeNull();
      expect(m.usageAgeMs).toBeNull();
    }
    expect(home.seen).toEqual([]);
    expect(linux.seen).toEqual([]);
  });

  it('an unreadable dashboards.json answers Home alone', async () => {
    const home = await dashboard(12, 30);
    process.env.BM_AGENTS_URL = home.url;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'not json');
    await start(null);
    const all = await machines();
    expect(all.map((m) => m.machine)).toEqual(['home']);
  });

  it('with no file Home is the one entry and its usage is read all the same', async () => {
    const home = await dashboard(12, 30);
    process.env.BM_AGENTS_URL = home.url;
    await start(null);
    const all = await machines();
    expect(all.map((m) => m.machine)).toEqual(['home']);
    expect(all[0].usage?.fiveHour.pct).toBe(12);
    expect(home.seen).toContain('/api/account');
  });
});
