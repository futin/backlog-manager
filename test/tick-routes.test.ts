import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { makeRegistry } from './helpers/store';
import type { TickProject, TicksPayload } from '../shared/types';

/**
 * `GET /api/ticks`, `POST /api/ticks/config` and `POST /api/ticks/reset` end to end through a real `AppModule`, over a throwaway tick home, `tick.json` and
 * registry — the three the module reads per request, so each case points them at its own directory before the app is built.
 *
 * The two project roots below are plain strings that never exist on disk: a root only has to be an absolute path whose `encodeURIComponent` names a directory
 * under the tick home (a vanished root is still listed, by basename — spec "My call").
 */

const T = (n: number): string => `2026-10-22T10:${String(n).padStart(2, '0')}:00.000Z`;
const rec = (n: number, outcome: string) => ({ at: T(n), id: `bug-${n}`, kind: 'execute', outcome, reason: outcome === 'ok' ? '' : 'boom' });

const ROOT_A = '/work/alpha';
const ROOT_B = '/work/beta';

describe('the tick breaker routes', () => {
  let app: INestApplication | undefined;
  let tmpRoot: string;
  let home: string;
  let file: string;
  let registryProjects: { name: string; path: string }[];
  const env = { ...process.env };

  async function createApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(REGISTRY_FILE).useValue(makeRegistry(registryProjects)).compile();
    const created = moduleRef.createNestApplication();
    await created.init();
    await listenLoopback(created);
    app = created;
    return created;
  }

  /** `<home>/<encodeURIComponent(root)>/` — the exact layout `projectDir()` in tick-lib.mjs writes. */
  function projectDir(root: string): string {
    const dir = join(home, encodeURIComponent(root));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeState(root: string, recent: unknown[]): void {
    writeFileSync(join(projectDir(root), 'state.json'), JSON.stringify({ items: {}, recent }, null, 2));
  }

  function writeFixture(raw: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(raw, null, 2));
  }

  const readFile = (): { haltAfter: number; resetAt: Record<string, string> } => JSON.parse(readFileSync(file, 'utf8'));
  const row = (body: TicksPayload, root: string): TickProject => body.projects.find((p) => p.root === root)!;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-tick-routes-'));
    home = join(tmpRoot, 'tick');
    file = join(tmpRoot, 'settings', 'tick.json');
    mkdirSync(home, { recursive: true });
    process.env.BM_TICK_HOME = home;
    process.env.BM_TICK_FILE = file;
    registryProjects = [{ name: 'Alpha Display', path: ROOT_A }];
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    process.env = { ...env };
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('GET /api/ticks', () => {
    it('derives each project from its own recent: A halted, B not, newest first', async () => {
      writeState(ROOT_A, [rec(1, 'failed'), rec(2, 'failed'), rec(3, 'failed')]);
      writeState(ROOT_B, [rec(4, 'failed'), rec(5, 'ok')]);
      const res = await request((await createApp()).getHttpServer()).get('/api/ticks').expect(200);
      const body = res.body as TicksPayload;
      expect(body.projects).toHaveLength(2);
      const a = row(body, ROOT_A);
      expect(a).toMatchObject({ streak: 3, halted: true, haltedSince: T(1), lock: null });
      expect(a.recent.map((r) => r.at)).toEqual([T(3), T(2), T(1)]);
      const b = row(body, ROOT_B);
      expect(b).toMatchObject({ streak: 0, halted: false, lock: null });
      expect(b.haltedSince).toBeUndefined();
      expect(b.recent.map((r) => r.at)).toEqual([T(5), T(4)]);
    });

    it('names a registered root by the registry and an unregistered one by its basename', async () => {
      writeState(ROOT_A, []);
      writeState(ROOT_B, []);
      const body = (await request((await createApp()).getHttpServer()).get('/api/ticks').expect(200)).body as TicksPayload;
      expect(row(body, ROOT_A).name).toBe('Alpha Display');
      expect(row(body, ROOT_B).name).toBe('beta');
    });

    it('lists a directory holding a lock and no state.json with an empty history and the lock', async () => {
      writeFileSync(
        join(projectDir(ROOT_A), 'lock'),
        JSON.stringify({ host: 'mac-1', verdict: { kind: 'execute', id: 'bug-9' }, base: 'abc', at: T(7) })
      );
      const body = (await request((await createApp()).getHttpServer()).get('/api/ticks').expect(200)).body as TicksPayload;
      expect(row(body, ROOT_A)).toMatchObject({ recent: [], streak: 0, halted: false, lock: { kind: 'execute', id: 'bug-9', host: 'mac-1', at: T(7) } });
    });

    it('answers a not-JSON state.json with an error and no streak or halted', async () => {
      writeFileSync(join(projectDir(ROOT_A), 'state.json'), '{ nope');
      writeState(ROOT_B, [rec(1, 'failed')]);
      const body = (await request((await createApp()).getHttpServer()).get('/api/ticks').expect(200)).body as TicksPayload;
      const a = row(body, ROOT_A);
      expect(a.error).toMatch(/state\.json: not valid JSON/);
      expect(a).not.toHaveProperty('streak');
      expect(a).not.toHaveProperty('halted');
      expect(a.recent).toEqual([]);
      // The broken row does not blank its neighbour.
      expect(row(body, ROOT_B).streak).toBe(1);
    });

    it('skips an undecodable and a relative-path directory and still answers 200 with the rest', async () => {
      mkdirSync(join(home, '%E0%A4%A'));
      mkdirSync(join(home, 'foo'));
      mkdirSync(join(home, '%2falpha')); // decodes to an absolute path but is not the name tick.mjs writes
      writeFileSync(join(home, 'stray-file'), 'x');
      writeState(ROOT_A, [rec(1, 'failed')]);
      const body = (await request((await createApp()).getHttpServer()).get('/api/ticks').expect(200)).body as TicksPayload;
      expect(body.projects.map((p) => p.root)).toEqual([ROOT_A]);
    });

    it('answers an empty list when the tick home does not exist yet', async () => {
      rmSync(home, { recursive: true });
      const body = (await request((await createApp()).getHttpServer()).get('/api/ticks').expect(200)).body as TicksPayload;
      expect(body.projects).toEqual([]);
    });

    it('reports config.source default / file / unreadable, and reads a file edit on the next request', async () => {
      const server = (await createApp()).getHttpServer();
      expect(((await request(server).get('/api/ticks').expect(200)).body as TicksPayload).config).toEqual({ haltAfter: 3, source: 'default' });
      writeFixture({ haltAfter: 5 });
      expect(((await request(server).get('/api/ticks').expect(200)).body as TicksPayload).config).toEqual({ haltAfter: 5, source: 'file' });
      writeFileSync(file, '{ not json');
      const config = ((await request(server).get('/api/ticks').expect(200)).body as TicksPayload).config;
      expect(config).toMatchObject({ haltAfter: 3, source: 'unreadable' });
      // The Settings card shows this verbatim as its hint, so it must name the file: the pinned BM_TICK_FILE path, then `: `, then the reason.
      expect(config.error?.startsWith(`${file}: `)).toBe(true);
      expect(config.error?.length).toBeGreaterThan(`${file}: `.length);
    });

    it('applies the file’s haltAfter and the project’s resetAt to the streak', async () => {
      writeState(ROOT_A, [rec(1, 'failed'), rec(2, 'failed'), rec(3, 'failed')]);
      writeFixture({ haltAfter: 4, resetAt: { [ROOT_A]: T(1) } });
      const a = row(((await request((await createApp()).getHttpServer()).get('/api/ticks').expect(200)).body as TicksPayload), ROOT_A);
      expect(a).toMatchObject({ streak: 2, halted: false, resetAt: T(1) });
    });

    it('still renders every project’s figures when tick.json is unreadable', async () => {
      writeState(ROOT_A, [rec(1, 'failed'), rec(2, 'failed'), rec(3, 'failed')]);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '[]');
      const body = (await request((await createApp()).getHttpServer()).get('/api/ticks').expect(200)).body as TicksPayload;
      expect(body.config.source).toBe('unreadable');
      expect(row(body, ROOT_A)).toMatchObject({ streak: 3, halted: true });
    });
  });

  describe('POST /api/ticks/config', () => {
    const post = (server: ReturnType<INestApplication['getHttpServer']>, body: unknown) => request(server).post('/api/ticks/config').send(body as object);

    beforeEach(() => writeFixture({ haltAfter: 5, resetAt: { [ROOT_A]: T(10), [ROOT_B]: T(20) } }));

    it('writes haltAfter, keeps both resetAt keys byte-equal, and answers the fresh payload', async () => {
      const before = readFile().resetAt;
      const res = await post((await createApp()).getHttpServer(), { haltAfter: 7 }).expect(200);
      expect((res.body as TicksPayload).config).toEqual({ haltAfter: 7, source: 'file' });
      const after = readFile();
      expect(after.haltAfter).toBe(7);
      expect(JSON.stringify(after.resetAt)).toBe(JSON.stringify(before));
    });

    it.each([
      [0, 1],
      [42, 10]
    ])('clamps %i to %i', async (sent, stored) => {
      await post((await createApp()).getHttpServer(), { haltAfter: sent }).expect(200);
      expect(readFile().haltAfter).toBe(stored);
    });

    it.each([['a string', { haltAfter: '7' }], ['a float', { haltAfter: 2.5 }], ['no haltAfter', {}], ['an array body', [1]]])(
      'refuses %s with a 400 and leaves the file alone',
      async (_label, body) => {
        const bytes = readFileSync(file, 'utf8');
        await post((await createApp()).getHttpServer(), body).expect(400);
        expect(readFileSync(file, 'utf8')).toBe(bytes);
      }
    );

    it('answers 409 naming the file, and leaves it byte-identical, when tick.json is unreadable', async () => {
      writeFileSync(file, '{ half');
      const res = await post((await createApp()).getHttpServer(), { haltAfter: 7 }).expect(409);
      expect(JSON.stringify(res.body)).toContain(file);
      expect(readFileSync(file, 'utf8')).toBe('{ half');
    });

    it('leaves no temp file beside tick.json', async () => {
      await post((await createApp()).getHttpServer(), { haltAfter: 6 }).expect(200);
      expect(readdirSync(dirname(file))).toEqual(['tick.json']);
    });

    it('is refused by the guard when cross-origin or not JSON', async () => {
      const server = (await createApp()).getHttpServer();
      const bytes = readFileSync(file, 'utf8');
      await request(server).post('/api/ticks/config').set('origin', 'http://evil.example').send({ haltAfter: 7 }).expect(403);
      await request(server).post('/api/ticks/config').type('form').send('haltAfter=7').expect(403);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    });
  });

  describe('POST /api/ticks/reset', () => {
    const post = (server: ReturnType<INestApplication['getHttpServer']>, body: unknown) => request(server).post('/api/ticks/reset').send(body as object);

    it.each([['an array body', [ROOT_A]], ['a missing project', {}], ['a number', { project: 42 }], ['a relative path', { project: 'rel/path' }]])(
      'refuses %s with a 400',
      async (_label, body) => {
        writeState(ROOT_A, [rec(1, 'failed')]);
        await post((await createApp()).getHttpServer(), body).expect(400);
        expect(existsSync(file)).toBe(false);
      }
    );

    it('answers 404 for an absolute path with no tick directory, and writes nothing', async () => {
      writeState(ROOT_A, []);
      await post((await createApp()).getHttpServer(), { project: '/not/a/tick/project' }).expect(404);
      expect(existsSync(file)).toBe(false);
    });

    it('stamps resetAt[root] ≈ now and answers that project at streak 0', async () => {
      writeState(ROOT_A, [rec(1, 'failed'), rec(2, 'failed'), rec(3, 'failed')]);
      const t0 = Date.now();
      const res = await post((await createApp()).getHttpServer(), { project: ROOT_A }).expect(200);
      const stamped = Date.parse(readFile().resetAt[ROOT_A]);
      expect(stamped).toBeGreaterThanOrEqual(t0);
      expect(stamped).toBeLessThanOrEqual(Date.now());
      expect(row(res.body as TicksPayload, ROOT_A)).toMatchObject({ streak: 0, halted: false, resetAt: new Date(stamped).toISOString() });
    });

    it('keeps haltAfter and B’s resetAt byte-equal, and B’s row keeps its streak, halted and haltedSince', async () => {
      writeState(ROOT_A, [rec(1, 'failed'), rec(2, 'failed')]);
      writeState(ROOT_B, [rec(20, 'failed'), rec(21, 'failed'), rec(22, 'failed')]);
      writeFixture({ haltAfter: 5, resetAt: { [ROOT_B]: T(19) } });
      const bBefore = readFile().resetAt[ROOT_B];
      writeFixture({ haltAfter: 2, resetAt: { [ROOT_B]: bBefore } });
      const res = await post((await createApp()).getHttpServer(), { project: ROOT_A }).expect(200);
      const after = readFile();
      expect(after.haltAfter).toBe(2);
      expect(after.resetAt[ROOT_B]).toBe(bBefore);
      const b = row(res.body as TicksPayload, ROOT_B);
      expect(b).toMatchObject({ streak: 3, halted: true, haltedSince: T(20) });
    });

    it('stamps the newest at when it is ahead of the server clock (a container clock behind the host’s)', async () => {
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      writeState(ROOT_A, [{ ...rec(1, 'failed'), at: new Date(Date.now() + 5 * 60 * 1000).toISOString() }, { ...rec(2, 'failed'), at: future }]);
      const res = await post((await createApp()).getHttpServer(), { project: ROOT_A }).expect(200);
      expect(readFile().resetAt[ROOT_A]).toBe(future);
      expect(row(res.body as TicksPayload, ROOT_A)).toMatchObject({ streak: 0, halted: false });
    });

    it('resets a project whose state.json is not JSON: 200, stamped ≈ now, the row still carries its error', async () => {
      writeFileSync(join(projectDir(ROOT_A), 'state.json'), '{ nope');
      const t0 = Date.now();
      const res = await post((await createApp()).getHttpServer(), { project: ROOT_A }).expect(200);
      expect(Date.parse(readFile().resetAt[ROOT_A])).toBeGreaterThanOrEqual(t0);
      expect(row(res.body as TicksPayload, ROOT_A).error).toMatch(/not valid JSON/);
      expect(readFileSync(join(projectDir(ROOT_A), 'state.json'), 'utf8')).toBe('{ nope');
    });

    it('resets a lock-only project: 200, stamped ≈ now, and the lock file byte-identical after', async () => {
      const lockFile = join(projectDir(ROOT_A), 'lock');
      writeFileSync(lockFile, JSON.stringify({ host: 'h', verdict: { kind: 'execute', id: 'bug-1' }, at: T(1) }));
      const bytes = readFileSync(lockFile, 'utf8');
      const t0 = Date.now();
      const res = await post((await createApp()).getHttpServer(), { project: ROOT_A }).expect(200);
      expect(Date.parse(readFile().resetAt[ROOT_A])).toBeGreaterThanOrEqual(t0);
      expect(readFileSync(lockFile, 'utf8')).toBe(bytes);
      expect(row(res.body as TicksPayload, ROOT_A).lock).toMatchObject({ id: 'bug-1' });
    });

    it('answers 409 and leaves tick.json byte-identical when it is unreadable', async () => {
      writeState(ROOT_A, [rec(1, 'failed')]);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'null');
      const res = await post((await createApp()).getHttpServer(), { project: ROOT_A }).expect(409);
      expect(JSON.stringify(res.body)).toContain(file);
      expect(readFileSync(file, 'utf8')).toBe('null');
    });

    it('is refused by the guard when cross-origin or not JSON', async () => {
      writeState(ROOT_A, [rec(1, 'failed')]);
      const server = (await createApp()).getHttpServer();
      await request(server).post('/api/ticks/reset').set('origin', 'http://evil.example').send({ project: ROOT_A }).expect(403);
      await request(server).post('/api/ticks/reset').type('form').send(`project=${ROOT_A}`).expect(403);
      expect(existsSync(file)).toBe(false);
    });
  });
});
