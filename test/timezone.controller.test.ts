import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { makeRegistry } from './helpers/store';

/**
 * `GET` and `POST /api/settings/timezone` (#241): the canonical id round-trips, a malformed body is a 400 that writes nothing, and the POST is guarded like
 * every other one on this server.
 */
describe('/api/settings/timezone', () => {
  let app: INestApplication;
  let dir: string;
  let file: string;
  const saved = process.env.BM_TIMEZONE_FILE;

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
    dir = mkdtempSync(join(tmpdir(), 'bm-timezone-route-'));
    file = join(dir, 'timezone.json');
    process.env.BM_TIMEZONE_FILE = file;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.BM_TIMEZONE_FILE;
    else process.env.BM_TIMEZONE_FILE = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const get = () => request(app.getHttpServer()).get('/api/settings/timezone');
  const post = (body: unknown) =>
    request(app.getHttpServer()).post('/api/settings/timezone').set('content-type', 'application/json').send(JSON.stringify(body));

  it('answers null with no file', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: null });
  });

  it('stores a zone, and the next GET agrees', async () => {
    const res = await post({ timeZone: 'Europe/Belgrade' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: 'Europe/Belgrade' });
    expect((await get()).body).toEqual({ timeZone: 'Europe/Belgrade' });
  });

  it('answers the canonical id', async () => {
    const res = await post({ timeZone: 'etc/utc' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: 'UTC' });
  });

  it('clears to null', async () => {
    await post({ timeZone: 'Europe/Belgrade' });
    const res = await post({ timeZone: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: null });
  });

  it.each([[{ timeZone: 'Mars/Olympus' }], [{ timeZone: 42 }], [{}], [[]]])('refuses %j with a 400 and leaves the file alone', async (body) => {
    await post({ timeZone: 'Asia/Kolkata' });
    const before = readFileSync(file, 'utf8');
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'timeZone must be an IANA time zone id or null' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a non-JSON content type', async () => {
    const res = await request(app.getHttpServer()).post('/api/settings/timezone').set('content-type', 'text/plain').send('{"timeZone":"UTC"}');
    expect(res.status).toBe(403);
  });

  it('refuses a foreign origin', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/settings/timezone')
      .set('content-type', 'application/json')
      .set('origin', 'http://evil.example')
      .send(JSON.stringify({ timeZone: 'UTC' }));
    expect(res.status).toBe(403);
  });
});
