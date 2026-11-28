import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { DEFAULT_HEADLESS_PLUGINS, HEADLESS_PLUGINS_MAX, parseHeadlessConfig } from '../../shared/agent';
import { AppModule } from '../../server/src/app.module';
import { REGISTRY_FILE } from '../../server/src/registry/registry.service';
import { listenLoopback } from '../helpers/app';
import { makeRegistry } from '../helpers/store';

/**
 * #625 — the plugin allowlist an orchestrator run's per-item sessions are launched with: `parseHeadlessConfig` (whose twin `orchestrate.mjs` reads the file
 * with) and `GET`/`POST /api/settings/headless`, headless.json's one writer.
 */
describe('parseHeadlessConfig', () => {
  it('round-trips a valid body, duplicates dropped in first-seen order', () => {
    expect(parseHeadlessConfig({ enabled: false, plugins: ['caveman', 'superpowers', 'caveman', 'x@y'] })).toEqual({
      ok: true,
      config: { enabled: false, plugins: ['caveman', 'superpowers', 'x@y'] }
    });
    expect(parseHeadlessConfig({ enabled: true, plugins: [] })).toEqual({ ok: true, config: { enabled: true, plugins: [] } });
  });

  it.each<[string, unknown, string]>([
    ['a string enabled', { enabled: 'true', plugins: [] }, 'enabled'],
    ['a string plugins', { enabled: true, plugins: 'x' }, 'plugins'],
    ['33 names', { enabled: true, plugins: Array.from({ length: HEADLESS_PLUGINS_MAX + 1 }, (_, i) => `p${i}`) }, 'plugins'],
    // The cap counts entries before duplicates are dropped, so 33 copies of one name are refused too.
    ['33 duplicates', { enabled: true, plugins: Array.from({ length: HEADLESS_PLUGINS_MAX + 1 }, () => 'p') }, 'plugins'],
    ['a spaced name', { enabled: true, plugins: ['ok', 'a b'] }, 'plugins[1]'],
    ['a bare marketplace', { enabled: true, plugins: ['@x'] }, 'plugins[0]'],
    ['a flag-shaped name with a path', { enabled: true, plugins: ['../x'] }, 'plugins[0]'],
    ['a non-string entry', { enabled: true, plugins: [1] }, 'plugins[0]'],
    ['an extra key', { enabled: true, plugins: [], more: 1 }, 'headless'],
    ['a missing key', { enabled: true }, 'headless'],
    ['an array', [], 'headless'],
    ['null', null, 'headless']
  ])('refuses %s, naming the member', (_label, value, member) => {
    expect(parseHeadlessConfig(value)).toEqual({ ok: false, member });
  });
});

describe('/api/settings/headless', () => {
  let app: INestApplication;
  let dir: string;
  let file: string;
  const saved = process.env.BM_HEADLESS_FILE;
  const defaults = { enabled: true, plugins: [...DEFAULT_HEADLESS_PLUGINS] };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bm-headless-route-'));
    file = join(dir, 'headless.json');
    process.env.BM_HEADLESS_FILE = file;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BM_HEADLESS_FILE;
    else process.env.BM_HEADLESS_FILE = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const get = () => request(app.getHttpServer()).get('/api/settings/headless');
  const post = (body: unknown) =>
    request(app.getHttpServer()).post('/api/settings/headless').set('content-type', 'application/json').send(JSON.stringify(body));
  const valid = { enabled: true, plugins: ['backlog-manager', 'caveman'] };

  it('answers the defaults with no file', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ config: defaults, source: 'default' });
  });

  it('answers the defaults marked unreadable over a garbage file', async () => {
    writeFileSync(file, '{nope');
    expect((await get()).body).toEqual({ config: defaults, source: 'unreadable' });
  });

  it('stores a valid config and answers it, duplicates dropped', async () => {
    const res = await post({ enabled: true, plugins: ['backlog-manager', 'caveman', 'caveman'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(valid);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(valid);
    expect((await get()).body).toEqual({ config: valid, source: 'file' });
  });

  it('refuses an invalid body with a 400 naming the member, and leaves the file byte-identical', async () => {
    await post(valid);
    const before = readFileSync(file, 'utf8');
    const res = await post({ enabled: true, plugins: ['a b'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('plugins[0]');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a foreign origin and writes nothing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/settings/headless')
      .set('content-type', 'application/json')
      .set('origin', 'http://evil.example')
      .send(JSON.stringify(valid));
    expect(res.status).toBe(403);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('refuses with a 409 naming the file over an unreadable one, and leaves it byte-identical', async () => {
    writeFileSync(file, '{"enabled":true,"plugins":"hand edited"}');
    const res = await post(valid);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(file);
    expect(readFileSync(file, 'utf8')).toBe('{"enabled":true,"plugins":"hand edited"}');
  });
});
