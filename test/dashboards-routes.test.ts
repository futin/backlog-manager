import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { DashboardsService } from '../server/src/agents/dashboards/dashboards.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { makeRegistry } from './helpers/store';
import type { DashboardsView } from '../shared/types';

/**
 * `GET /api/dashboards` and its four guarded POSTs end to end through a real `AppModule`, over a throwaway `dashboards.json` (`BM_DASHBOARDS_FILE`) — the path
 * the service reads per call, so every case points it at its own directory before the app is built. The two tokens below are the values the leak assertion
 * greps for: they are set in the environment, so a response that so much as echoed `process.env` would carry them (Review Focus 3).
 */

const HOME_TOKEN = 'tok-home-123';
const PRO_TOKEN = 'tok-pro-456';

const pro = { name: 'Pro', url: 'http://pro-mac:4173', bmUrl: 'http://pro-mac:4322', host: 'pro-mac' };

describe('the dashboards settings routes', () => {
  let app: INestApplication | undefined;
  let tmpRoot: string;
  let file: string;
  const env = { ...process.env };

  async function createApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    const created = moduleRef.createNestApplication();
    await created.init();
    await listenLoopback(created);
    app = created;
    return created;
  }

  const get = async (): Promise<DashboardsView> =>
    (
      await request((await createApp()).getHttpServer())
        .get('/api/dashboards')
        .expect(200)
    ).body;
  const post = (path: string, body: unknown) =>
    request(app!.getHttpServer())
      .post(`/api/dashboards${path}`)
      .send(body as object);
  const writeFixture = (raw: unknown): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(raw, null, 2));
  };
  const onDisk = (): { order: string[]; dashboards: { name: string }[]; strategy: string; threshold: number } => JSON.parse(readFileSync(file, 'utf8'));

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-dashboards-routes-'));
    file = join(tmpRoot, 'settings', 'dashboards.json');
    process.env.BM_DASHBOARDS_FILE = file;
    process.env.BM_AGENTS_TOKEN = HOME_TOKEN;
    process.env.BM_AGENTS_URL = 'http://home-dash.test:4173';
    process.env.BM_AGENTS_TOKEN_PRO = PRO_TOKEN;
    delete process.env.BM_AGENTS_TOKEN_STUDIO;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    process.env = { ...env };
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('GET', () => {
    it('with no file answers the default: home only, its token set, order [home]', async () => {
      const body = await get();
      expect(body.source).toBe('default');
      expect(body.file).toBe(file);
      expect(body.home).toMatchObject({ label: 'Home', url: 'http://home-dash.test:4173', account: null, tokenVar: 'BM_AGENTS_TOKEN', tokenSet: true });
      expect(body.home.models).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
      expect(body.dashboards).toEqual([]);
      expect(body.order).toEqual(['home']);
      expect(body.strategy).toBe('prefer');
      expect(body.threshold).toBe(80);
    });

    it('home tokenSet is false when BM_AGENTS_TOKEN is unset', async () => {
      delete process.env.BM_AGENTS_TOKEN;
      expect((await get()).home.tokenSet).toBe(false);
    });

    it('lists an entry with its token var and whether that token is set, read per call', async () => {
      await createApp();
      await post('/entries', { entry: pro }).expect(200);
      const first: DashboardsView = (await request(app!.getHttpServer()).get('/api/dashboards').expect(200)).body;
      expect(first.dashboards).toHaveLength(1);
      expect(first.dashboards[0]).toMatchObject({ ...pro, tokenVar: 'BM_AGENTS_TOKEN_PRO', tokenSet: true });
      expect(first.dashboards[0].models).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
      delete process.env.BM_AGENTS_TOKEN_PRO;
      const second: DashboardsView = (await request(app!.getHttpServer()).get('/api/dashboards').expect(200)).body;
      expect(second.dashboards[0].tokenSet).toBe(false);
    });

    it('never carries a token value, in the GET body or in any POST answer', async () => {
      await createApp();
      const answers = [
        (await post('/entries', { entry: pro }).expect(200)).text,
        (await post('/home', { label: 'Max' }).expect(200)).text,
        (await post('/settings', { threshold: 70 }).expect(200)).text,
        (await request(app!.getHttpServer()).get('/api/dashboards').expect(200)).text,
        (await post('/entries/delete', { name: 'Pro' }).expect(200)).text
      ];
      for (const text of answers) {
        expect(text).not.toContain(HOME_TOKEN);
        expect(text).not.toContain(PRO_TOKEN);
      }
    });

    it('an unreadable file answers source unreadable with no remotes', async () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{ not json');
      const body = await get();
      expect(body.source).toBe('unreadable');
      expect(body.dashboards).toEqual([]);
      expect(body.order).toEqual(['home']);
    });
  });

  describe('POST /entries', () => {
    it('a duplicate name in another case, without replaces, is a 400 and writes nothing', async () => {
      await createApp();
      await post('/entries', { entry: pro }).expect(200);
      const before = readFileSync(file, 'utf8');
      const res = await post('/entries', { entry: { ...pro, name: 'pro' } }).expect(400);
      expect(res.body.error).toBe('a dashboard named "pro" already exists');
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('the same name again is an upsert: the entry is updated in place', async () => {
      await createApp();
      await post('/entries', { entry: pro }).expect(200);
      const res = await post('/entries', { entry: { ...pro, account: 'Pro plan' } }).expect(200);
      expect(res.body.dashboards).toHaveLength(1);
      expect(res.body.dashboards[0].account).toBe('Pro plan');
    });

    it('a ninth entry is a 400 `at most 8 dashboards` and writes nothing', async () => {
      await createApp();
      for (let i = 1; i <= 8; i++) await post('/entries', { entry: { ...pro, name: `M${i}`, host: `m${i}` } }).expect(200);
      const before = readFileSync(file, 'utf8');
      const res = await post('/entries', { entry: { ...pro, name: 'M9', host: 'm9' } }).expect(400);
      expect(res.body.error).toBe('at most 8 dashboards');
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('an eighth entry already present can still be edited', async () => {
      await createApp();
      for (let i = 1; i <= 8; i++) await post('/entries', { entry: { ...pro, name: `M${i}`, host: `m${i}` } }).expect(200);
      await post('/entries', { entry: { ...pro, name: 'M8', host: 'm8', account: 'x' } }).expect(200);
    });

    it('replaces renames the entry, in place, and the order follows it', async () => {
      await createApp();
      await post('/entries', { entry: pro }).expect(200);
      await post('/entries', { entry: { ...pro, name: 'Studio', host: 'studio-mini' } }).expect(200);
      await post('/settings', { order: ['Studio', 'home', 'Pro'] }).expect(200);
      const res = await post('/entries', { entry: { ...pro, name: 'Laptop' }, replaces: 'Pro' }).expect(200);
      expect(res.body.dashboards.map((d: { name: string }) => d.name)).toEqual(['Laptop', 'Studio']);
      expect(res.body.order).toEqual(['Studio', 'home', 'Laptop']);
      expect(onDisk().order).toEqual(['Studio', 'home', 'Laptop']);
    });

    it('a rename onto another entry that exists is a 400; onto itself in another case is allowed', async () => {
      await createApp();
      await post('/entries', { entry: pro }).expect(200);
      await post('/entries', { entry: { ...pro, name: 'Studio', host: 'studio-mini' } }).expect(200);
      const clash = await post('/entries', { entry: { ...pro, name: 'studio' }, replaces: 'Pro' }).expect(400);
      expect(clash.body.error).toBe('a dashboard named "studio" already exists');
      await post('/entries', { entry: { ...pro, name: 'PRO' }, replaces: 'Pro' }).expect(200);
    });

    it('replaces naming no entry is a 404', async () => {
      await createApp();
      const res = await post('/entries', { entry: pro, replaces: 'Ghost' }).expect(404);
      expect(res.body.error).toBe('no dashboard named "Ghost"');
    });

    it('a malformed entry is a 400 with the util message', async () => {
      await createApp();
      const res = await post('/entries', { entry: { ...pro, url: 'nope' } }).expect(400);
      expect(res.body.error).toBe('url must be an http(s) origin');
      expect((await post('/entries', {}).expect(400)).body.error).toBe('entry must be an object');
    });

    it('leaves no temp file beside the dashboards file', async () => {
      await createApp();
      await post('/entries', { entry: pro }).expect(200);
      expect(readdirSync(dirname(file))).toEqual(['dashboards.json']);
    });
  });

  describe('POST /entries/delete', () => {
    it('drops the entry and its id in order', async () => {
      await createApp();
      await post('/entries', { entry: pro }).expect(200);
      await post('/settings', { order: ['Pro', 'home'] }).expect(200);
      const res = await post('/entries/delete', { name: 'Pro' }).expect(200);
      expect(res.body.dashboards).toEqual([]);
      expect(res.body.order).toEqual(['home']);
      expect(onDisk().order).toEqual(['home']);
    });

    it('an unknown name is a 404 and a non-string one a 400', async () => {
      await createApp();
      expect((await post('/entries/delete', { name: 'Ghost' }).expect(404)).body.error).toBe('no dashboard named "Ghost"');
      expect((await post('/entries/delete', { name: 3 }).expect(400)).body.error).toBe('name must be a string');
    });
  });

  describe('POST /settings', () => {
    it('rejects a strategy outside the three', async () => {
      await createApp();
      const res = await post('/settings', { strategy: 'fastest' }).expect(400);
      expect(res.body.error).toBe('strategy must be one of prefer, headroom, runway');
    });

    it('rejects a non-integer or out-of-range threshold — a POST does not clamp', async () => {
      await createApp();
      for (const threshold of [80.5, 0, 101, '80']) {
        const res = await post('/settings', { threshold }).expect(400);
        expect(res.body.error).toBe('threshold must be an integer 1–100');
      }
    });

    it('rejects an order that repeats a machine, omits one or names a stranger', async () => {
      await createApp();
      await post('/entries', { entry: pro }).expect(200);
      for (const order of [['home', 'home'], ['home'], ['home', 'Pro', 'Ghost'], 'home']) {
        const res = await post('/settings', { order }).expect(400);
        expect(res.body.error).toBe('order must list configured machines once each');
      }
    });

    it('accepts and persists a full order, a strategy and a threshold', async () => {
      await createApp();
      await post('/entries', { entry: pro }).expect(200);
      const res = await post('/settings', { order: ['Pro', 'home'], strategy: 'runway', threshold: 65 }).expect(200);
      expect(res.body).toMatchObject({ order: ['Pro', 'home'], strategy: 'runway', threshold: 65 });
      expect(onDisk()).toMatchObject({ order: ['Pro', 'home'], strategy: 'runway', threshold: 65 });
    });
  });

  describe('POST /home', () => {
    it('rejects an empty label', async () => {
      await createApp();
      const res = await post('/home', { label: '' }).expect(400);
      expect(res.body.error).toBe('label must be 1–24 characters');
    });

    it('persists a models list and GET reports it', async () => {
      await createApp();
      await post('/home', { models: ['opus'] }).expect(200);
      expect((await request(app!.getHttpServer()).get('/api/dashboards').expect(200)).body.home.models).toEqual(['opus']);
    });

    it('patches: an omitted key stays, null clears, label and account are trimmed', async () => {
      await createApp();
      await post('/home', { label: '  Max ', account: ' me@x ', efforts: ['low'] }).expect(200);
      const res = await post('/home', { account: null, models: ['sonnet'] }).expect(200);
      expect(res.body.home).toMatchObject({ label: 'Max', account: null, models: ['sonnet'], efforts: ['low'] });
    });

    it('rejects a models list outside the known ones', async () => {
      await createApp();
      const res = await post('/home', { models: ['gpt'] }).expect(400);
      expect(res.body.error).toMatch(/^models must be a non-empty subset of/);
    });
  });

  describe('an unreadable file', () => {
    it('is a 409 naming the file on every POST, and its bytes are never touched', async () => {
      mkdirSync(dirname(file), { recursive: true });
      const bytes = '{ "dashboards": [ oops';
      writeFileSync(file, bytes);
      await createApp();
      const posts: [string, unknown][] = [
        ['/entries', { entry: pro }],
        ['/entries/delete', { name: 'Pro' }],
        ['/home', { label: 'Max' }],
        ['/settings', { threshold: 70 }]
      ];
      for (const [path, body] of posts) {
        const res = await post(path, body).expect(409);
        expect(res.body.error).toContain(file);
      }
      expect(readFileSync(file, 'utf8')).toBe(bytes);
      expect(existsSync(file)).toBe(true);
      expect(readdirSync(dirname(file))).toEqual(['dashboards.json']);
    });
  });

  describe('DashboardsService lookups', () => {
    const studio = { name: 'Studio', url: 'http://studio:4173', bmUrl: 'http://studio:4322', host: 'studio-mini' };
    let svc: DashboardsService;

    beforeEach(async () => {
      writeFixture({ dashboards: [pro, studio] });
      svc = (await createApp()).get(DashboardsService);
    });

    it('machines() is home first, then the remotes in configured order, with the cfg each is called through', () => {
      process.env.BM_AGENTS = 'on';
      process.env.BM_AGENTS_TOKEN_STUDIO = 'tok-studio-789';
      const machines = svc.machines();
      expect(machines.map((m) => m.id)).toEqual(['home', 'Pro', 'Studio']);
      expect(machines[0]).toMatchObject({
        label: 'Home',
        home: true,
        host: null,
        bmUrl: null,
        cfg: { enabled: true, url: 'http://home-dash.test:4173', token: HOME_TOKEN }
      });
      expect(machines[1]).toMatchObject({
        label: 'Pro',
        home: false,
        host: 'pro-mac',
        bmUrl: 'http://pro-mac:4322',
        cfg: { enabled: true, url: 'http://pro-mac:4173', token: PRO_TOKEN }
      });
      expect(machines[2].cfg.token).toBe('tok-studio-789');
    });

    it('a remote with no token env var has an empty token, not an error; a remote is enabled exactly when home is', () => {
      delete process.env.BM_AGENTS;
      const [home, , studioMachine] = svc.machines();
      expect(studioMachine.cfg.token).toBe('');
      expect(home.cfg.enabled).toBe(false);
      expect(studioMachine.cfg.enabled).toBe(false);
    });

    it('machine() resolves undefined and any case of home to home, a remote by id, and a stranger to null', () => {
      expect(svc.machine(undefined)?.id).toBe('home');
      expect(svc.machine('HOME')?.id).toBe('home');
      expect(svc.machine('Pro')?.id).toBe('Pro');
      expect(svc.machine('nope')).toBeNull();
    });

    it('byHost() matches a remote host exactly, and never home or a stranger', () => {
      expect(svc.byHost('pro-mac')?.id).toBe('Pro');
      expect(svc.byHost('studio-mini')?.id).toBe('Studio');
      expect(svc.byHost('ghost')).toBeNull();
      expect(svc.byHost(undefined)).toBeNull();
    });

    it('settings() reads the file per call', () => {
      expect(svc.settings()).toEqual({ order: ['home', 'Pro', 'Studio'], strategy: 'prefer', threshold: 80 });
      writeFixture({ dashboards: [pro, studio], order: ['Studio', 'home', 'Pro'], strategy: 'headroom', threshold: 55 });
      expect(svc.settings()).toEqual({ order: ['Studio', 'home', 'Pro'], strategy: 'headroom', threshold: 55 });
    });

    it('an unreadable file leaves home alone (fail closed) and default settings', () => {
      writeFileSync(file, 'garbage');
      expect(svc.machines().map((m) => m.id)).toEqual(['home']);
      expect(svc.byHost('pro-mac')).toBeNull();
      expect(svc.machine('Pro')).toBeNull();
      expect(svc.settings()).toEqual({ order: ['home'], strategy: 'prefer', threshold: 80 });
    });
  });
});
