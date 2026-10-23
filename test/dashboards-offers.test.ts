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
import { OffersService } from '../server/src/agents/dashboards/offers.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { EFFORTS, MODELS } from '../shared/agent';
import type { MachineOffer, ProjectOffers } from '../shared/types';
import { listenLoopback } from './helpers/app';
import { makeProject, makeRegistry } from './helpers/store';

/**
 * `GET /api/dashboards/offers?project=` end to end through a real `AppModule`. Every outbound peer is a real HTTP server on `127.0.0.1` — home's dashboard,
 * Pro's dashboard and Pro's backlog-manager ("board") — so the timeouts, the connection failures and the request log are the real ones, not a mock's idea of
 * them. Each stub records every path it was asked for, which is how the "no usage request" and "no token to the board" cases are proven.
 *
 * The local project is a real tracker project (a committed `backlog/source.json` naming `futin/backlog-manager`); the files case uses a project with no marker.
 */

const HOME_TOKEN = 'tok-home-123';
const PRO_TOKEN = 'tok-pro-456';
const REMOTE_PATH = '/Users/p/bm';
const REPO = 'futin/backlog-manager';

const HEALTH = { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' };
const NOW_ISO = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const ACCOUNT = (five: number, week: number) => ({
  usageStatus: 'ok',
  usage: { fiveHour: { utilization: five, resetsAt: NOW_ISO(3_600_000) }, sevenDay: { utilization: week, resetsAt: NOW_ISO(4 * 86_400_000) } }
});
const PROFILE = () => ({ exhaustAt: null, walkAbsent: null, resetsAt: NOW_ISO(4 * 86_400_000) });

/** A route's answer: a JSON body (200), a bare status code, or `'hang'` — the request is accepted and never answered. */
type Answer = unknown;
interface Stub {
  url: string;
  seen: { path: string; auth: string | undefined }[];
  close(): Promise<void>;
}

const servers: Server[] = [];

async function stub(routes: Record<string, Answer>): Promise<Stub> {
  const seen: Stub['seen'] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0];
    seen.push({ path, auth: req.headers.authorization });
    const answer = routes[path];
    if (answer === 'hang') return;
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
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

/** An origin nothing listens on: bind an ephemeral port, then give it back. A request there is refused at once. */
async function deadUrl(): Promise<string> {
  const s = await stub({});
  await s.close();
  servers.splice(servers.length - 1, 1);
  return s.url;
}

const homeDashboard = (projectPath: string, account: unknown = ACCOUNT(10, 20)) =>
  stub({
    '/api/health': HEALTH,
    '/api/configs': { projects: [{ dirName: '-local', path: projectPath }] },
    '/api/account': account,
    '/api/usage/profile': PROFILE()
  });
const proDashboard = (paths: string[] = [REMOTE_PATH], account: unknown = ACCOUNT(5, 5)) =>
  stub({
    '/api/health': HEALTH,
    '/api/configs': { projects: paths.map((p, i) => ({ dirName: `-p${i}`, path: p })) },
    '/api/account': account,
    '/api/usage/profile': PROFILE()
  });
const boardEntry = (over: Record<string, unknown> = {}) => ({
  name: 'bm',
  path: REMOTE_PATH,
  createdAt: '2026-08-26T00:00:00.000Z',
  missing: false,
  counts: {},
  source: 'github',
  repo: 'Futin/backlog-manager',
  polledAt: null,
  access: 'ok',
  detail: null,
  interval: '1m',
  ...over
});
const proBoard = (projects: unknown = [boardEntry()]) => stub({ '/api/projects': projects });

const USAGE_ROUTES = ['/api/account', '/api/usage/profile'];
const askedForUsage = (s: Stub): boolean => s.seen.some((r) => USAGE_ROUTES.includes(r.path));

describe('GET /api/dashboards/offers', () => {
  let app: INestApplication | undefined;
  let file: string;
  let tracker: string;
  let files: string;
  const env = { ...process.env };

  async function offers(project: string): Promise<ProjectOffers> {
    const res = await request(app!.getHttpServer()).get('/api/dashboards/offers').query({ project }).expect(200);
    return res.body as ProjectOffers;
  }
  const byId = (o: ProjectOffers, id: string): MachineOffer => o.machines.find((m) => m.machine === id)!;

  async function start(dashboards: { url: string; bmUrl: string }[] | null, extra: Record<string, unknown> = {}): Promise<void> {
    if (dashboards !== null) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ dashboards: dashboards.map((d) => ({ name: 'Pro', url: d.url, bmUrl: d.bmUrl, host: 'pro-mac' })), ...extra }, null, 2)
      );
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(
        makeRegistry([
          { name: 'bm', path: tracker },
          { name: 'plain', path: files }
        ])
      )
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
  }

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'bm-offers-'));
    file = join(root, 'settings', 'dashboards.json');
    tracker = makeProject('bm', [], JSON.stringify({ kind: 'github', repo: REPO }));
    files = makeProject('plain', []);
    process.env.BM_DASHBOARDS_FILE = file;
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_TOKEN = HOME_TOKEN;
    process.env.BM_AGENTS_TOKEN_PRO = PRO_TOKEN;
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

  it('home-only (no file): home alone, offered and suggested by default, and no request to any usage route (Review Focus 1)', async () => {
    const home = await homeDashboard(tracker);
    process.env.BM_AGENTS_URL = home.url;
    await start(null);
    const body = await offers(tracker);
    expect(body).toEqual({
      project: tracker,
      machines: [
        {
          machine: 'home',
          label: 'Home',
          home: true,
          account: null,
          offered: true,
          reason: null,
          usage: null,
          usageAgeMs: null,
          models: [...MODELS],
          efforts: [...EFFORTS]
        }
      ],
      suggestion: { machine: 'home', reason: 'No usage figures — Home by default', basis: 'default' }
    });
    expect(askedForUsage(home)).toBe(false);
  });

  it('a files project with a Pro entry: home alone, and Pro is never asked anything', async () => {
    const home = await homeDashboard(files);
    const proDash = await proDashboard();
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const body = await offers(files);
    expect(body.machines.map((m) => m.machine)).toEqual(['home']);
    expect(body.machines[0].offered).toBe(true);
    expect(body.suggestion).toEqual({ machine: 'home', reason: 'No usage figures — Home by default', basis: 'default' });
    expect(proDash.seen).toEqual([]);
    expect(board.seen).toEqual([]);
    expect(askedForUsage(home)).toBe(false);
  });

  it('offers Pro when its board lists the repo (compared case-insensitively) with sync on, with its usage', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const body = await offers(tracker);
    expect(body.machines.map((m) => m.machine)).toEqual(['home', 'Pro']);
    const pro = byId(body, 'Pro');
    expect(pro).toMatchObject({ label: 'Pro', home: false, offered: true, reason: null });
    expect(pro.usage).toMatchObject({ fiveHour: { pct: 5 }, week: { pct: 5 } });
    expect(pro.usageAgeMs).toBe(0);
    expect(byId(body, 'home')).toMatchObject({ offered: true, reason: null, usage: { fiveHour: { pct: 10 }, week: { pct: 20 } } });
    // Prefer order defaults to home first, and home is under 80% on both windows.
    expect(body.suggestion).toEqual({ machine: 'home', reason: 'Prefer order: Home comes first under 80% on both windows', basis: 'usage' });
  });

  it('lists machines in the prefer order the file sets, and the suggestion follows it', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }], { order: ['Pro', 'home'] });
    const body = await offers(tracker);
    expect(body.machines.map((m) => m.machine)).toEqual(['Pro', 'home']);
    expect(body.suggestion).toEqual({ machine: 'Pro', reason: 'Prefer order: Pro comes first under 80% on both windows', basis: 'usage' });
  });

  it('sync off on Pro → not offered, and its usage is never fetched', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    const board = await proBoard([boardEntry({ interval: 'off' })]);
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const pro = byId(await offers(tracker), 'Pro');
    expect(pro).toMatchObject({ offered: false, reason: 'sync is off for futin/backlog-manager on Pro', usage: null, usageAgeMs: null });
    expect(askedForUsage(proDash)).toBe(false);
  });

  it('a board entry with no interval reads as sync off', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    const board = await proBoard([boardEntry({ interval: null })]);
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    expect(byId(await offers(tracker), 'Pro').reason).toBe('sync is off for futin/backlog-manager on Pro');
  });

  it('Pro board lacks the repo → not registered, and no usage request', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    // A files entry at the same path and a github entry for another repo: neither is this project.
    const board = await proBoard([boardEntry({ source: 'files', repo: null }), boardEntry({ repo: 'futin/other' })]);
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const pro = byId(await offers(tracker), 'Pro');
    expect(pro).toMatchObject({ offered: false, reason: 'futin/backlog-manager is not registered on Pro' });
    expect(askedForUsage(proDash)).toBe(false);
  });

  it('Pro board down → board unreachable', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: await deadUrl() }]);
    const pro = byId(await offers(tracker), 'Pro');
    expect(pro.offered).toBe(false);
    expect(pro.reason).toMatch(/^board unreachable — \S/);
  });

  it('Pro dashboard down → dashboard unreachable', async () => {
    const home = await homeDashboard(tracker);
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: await deadUrl(), bmUrl: board.url }]);
    const pro = byId(await offers(tracker), 'Pro');
    expect(pro.offered).toBe(false);
    expect(pro.reason).toMatch(/^dashboard unreachable — \S/);
  });

  it('both down → the dashboard reason, which is checked first', async () => {
    const home = await homeDashboard(tracker);
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: await deadUrl(), bmUrl: await deadUrl() }]);
    expect(byId(await offers(tracker), 'Pro').reason).toMatch(/^dashboard unreachable — \S/);
  });

  it("Pro's dashboard does not list the remote path → not offered", async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard(['/Users/p/elsewhere']);
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const pro = byId(await offers(tracker), 'Pro');
    expect(pro).toMatchObject({ offered: false, reason: "Pro's dashboard does not list /Users/p/bm" });
    expect(askedForUsage(proDash)).toBe(false);
  });

  // T4 / final-review I1: health answered, the heavy project-list read did not. On a remote that is a dashboard failing, not a dashboard that has never
  // seen the project, so the reason is rung 1's — never rung 5's "does not list", which would send the person to open a session on a machine whose
  // dashboard is the thing that is broken.
  it("Pro's /api/configs answers 500 → dashboard unreachable with that error, not 'does not list'", async () => {
    const home = await homeDashboard(tracker);
    const proDash = await stub({ '/api/health': HEALTH, '/api/configs': 500, '/api/account': ACCOUNT(5, 5), '/api/usage/profile': PROFILE() });
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const body = await offers(tracker);
    expect(byId(body, 'Pro')).toMatchObject({ offered: false, reason: 'dashboard unreachable — /api/configs answered 500', usage: null });
    expect(askedForUsage(proDash)).toBe(false);
    expect(byId(body, 'home')).toMatchObject({ offered: true, reason: null });
  });

  it("Pro's /api/configs hangs past the 5 s read limit → dashboard unreachable, timed out", async () => {
    const home = await homeDashboard(tracker);
    const proDash = await stub({ '/api/health': HEALTH, '/api/configs': 'hang' });
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const t0 = Date.now();
    const body = await offers(tracker);
    expect(Date.now() - t0).toBeLessThan(7_000);
    expect(byId(body, 'Pro')).toMatchObject({ offered: false, reason: 'dashboard unreachable — the dashboard project list timed out after 5000ms' });
    expect(byId(body, 'home')).toMatchObject({ offered: true, reason: null });
  }, 15_000);

  // Home keeps the swallow (Review Focus 1): `GET /api/agents/status` has always read a failed project list as an empty one, and the offers judge home
  // through that same read, so home's reason stays rung 5's.
  it("home's /api/configs answering 500 still reads as 'does not list' — home's swallow is unchanged", async () => {
    const home = await stub({ '/api/health': HEALTH, '/api/configs': 500 });
    process.env.BM_AGENTS_URL = home.url;
    await start(null);
    expect(byId(await offers(tracker), 'home')).toMatchObject({ offered: false, reason: `Home's dashboard does not list ${tracker}` });
    const status = await request(app!.getHttpServer()).get('/api/agents/status').expect(200);
    expect(status.body).toMatchObject({ enabled: true, reachable: true, projectPaths: [] });
    expect(status.body.error).toBeUndefined();
  });

  it('Pro board hangs → offers answers within the timeout, Pro not offered, home offered and suggested (Review Focus 2)', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    const board = await stub({ '/api/projects': 'hang' });
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const t0 = Date.now();
    const body = await offers(tracker);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(7_000);
    expect(byId(body, 'Pro')).toMatchObject({ offered: false });
    expect(byId(body, 'Pro').reason).toMatch(/^board unreachable — .*timed out/);
    expect(byId(body, 'home')).toMatchObject({ offered: true, reason: null });
    expect(body.suggestion?.machine).toBe('home');
  }, 15_000);

  it('carries no token value, and the board is never sent one (Review Focus 3)', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const res = await request(app!.getHttpServer()).get('/api/dashboards/offers').query({ project: tracker }).expect(200);
    expect(res.text).not.toContain(HOME_TOKEN);
    expect(res.text).not.toContain(PRO_TOKEN);
    // Each dashboard gets its own token, and the board — another app entirely — gets none.
    expect(home.seen.every((r) => r.auth === `Bearer ${HOME_TOKEN}`)).toBe(true);
    expect(proDash.seen.every((r) => r.auth === `Bearer ${PRO_TOKEN}`)).toBe(true);
    expect(board.seen.length).toBeGreaterThan(0);
    expect(board.seen.every((r) => r.auth === undefined)).toBe(true);
  });

  it("reading Pro's project map never evicts home's: each dashboard's /api/configs is fetched once per TTL", async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    await offers(tracker);
    await offers(tracker);
    await request(app!.getHttpServer()).get('/api/agents/status').expect(200);
    const configs = (s: Stub) => s.seen.filter((r) => r.path === '/api/configs').length;
    expect(configs(home)).toBe(1);
    expect(configs(proDash)).toBe(1);
  });

  it('a request with no project is a 400', async () => {
    const home = await homeDashboard(tracker);
    process.env.BM_AGENTS_URL = home.url;
    await start(null);
    await request(app!.getHttpServer()).get('/api/dashboards/offers').expect(400);
  });

  it('remotePath: the board path for a registered repo, the reason otherwise, and the project itself on home', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    const board = await proBoard();
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const svc = app!.get(OffersService, { strict: false });
    const machines = app!.get(DashboardsService, { strict: false }).machines();
    const [homeM, proM] = machines;
    await expect(svc.remotePath(tracker, proM)).resolves.toEqual({ path: REMOTE_PATH });
    await expect(svc.remotePath(tracker, homeM)).resolves.toEqual({ path: tracker });
    await expect(svc.remotePath(files, proM)).resolves.toEqual({ reason: `Pro runs tracker projects only — ${files} is files-backed` });
  });

  it('remotePath: sync off is a reason, not a path', async () => {
    const home = await homeDashboard(tracker);
    const proDash = await proDashboard();
    const board = await proBoard([boardEntry({ interval: 'off' })]);
    process.env.BM_AGENTS_URL = home.url;
    await start([{ url: proDash.url, bmUrl: board.url }]);
    const svc = app!.get(OffersService, { strict: false });
    const proM = app!.get(DashboardsService, { strict: false }).machines()[1];
    await expect(svc.remotePath(tracker, proM)).resolves.toEqual({ reason: 'sync is off for futin/backlog-manager on Pro' });
  });
});
