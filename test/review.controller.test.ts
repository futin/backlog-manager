import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { DEFAULT_REVIEW_CONFIG } from '../shared/agent';
import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { makeRegistry } from './helpers/store';

/** `GET` and `POST /api/settings/review`: a valid config round-trips, a malformed one is a 400 that writes nothing, and the POST is guarded. */
describe('/api/settings/review', () => {
  let app: INestApplication;
  let dir: string;
  let file: string;
  const saved = process.env.BM_REVIEW_FILE;

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
    dir = mkdtempSync(join(tmpdir(), 'bm-review-route-'));
    file = join(dir, 'review.json');
    process.env.BM_REVIEW_FILE = file;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BM_REVIEW_FILE;
    else process.env.BM_REVIEW_FILE = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const get = () => request(app.getHttpServer()).get('/api/settings/review');
  const post = (body: unknown) =>
    request(app.getHttpServer()).post('/api/settings/review').set('content-type', 'application/json').send(JSON.stringify(body));
  const valid = { ...DEFAULT_REVIEW_CONFIG, mode: 'same', same: { model: 'opus', effort: 'high' } };

  it('answers the defaults with no file', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULT_REVIEW_CONFIG);
  });

  it('stores a valid config and answers it', async () => {
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(valid);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(valid);
    expect((await get()).body).toEqual(valid);
  });

  it.each([['"300"', '300'], ['300.5', 300.5]])('refuses smallMaxLines %s with a 400 and leaves the file alone', async (_label, n) => {
    await post(valid);
    const before = readFileSync(file, 'utf8');
    const res = await post({ ...valid, smallMaxLines: n });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('smallMaxLines');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses without a same-origin content type, and writes nothing', async () => {
    const res = await request(app.getHttpServer()).post('/api/settings/review').set('content-type', 'text/plain').send(JSON.stringify(valid));
    expect(res.status).toBe(403);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('refuses a foreign origin', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/settings/review')
      .set('content-type', 'application/json')
      .set('origin', 'http://evil.example')
      .send(JSON.stringify(valid));
    expect(res.status).toBe(403);
  });

  it('flags a corrupt file, and a valid POST replaces it', async () => {
    writeFileSync(file, '{nope');
    expect((await get()).body).toEqual({ ...DEFAULT_REVIEW_CONFIG, fileError: true });
    expect((await post(valid)).status).toBe(200);
    expect((await get()).body).toEqual(valid);
  });
});
