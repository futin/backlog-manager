import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../server/src/app.module';
import { REGISTRY_FILE } from '../../server/src/registry/registry.service';
import { clientDistModules } from '../../server/src/static';
import { listenLoopback } from '../helpers/app';
import { makeRegistry } from '../helpers/store';

describe('app bootstrap', () => {
  let app: INestApplication;

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

  it('answers /api/health', async () => {
    const first = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(first.body.ok).toBe(true);
    expect(typeof first.body.bootedAt).toBe('string');
    expect(Number.isFinite(Date.parse(first.body.bootedAt))).toBe(true);
    // The stamp is fixed per process: tick.mjs compares it by identity, so a second request must answer the same value.
    const second = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(second.body.bootedAt).toBe(first.body.bootedAt);
  });

  it('answers /api/items with an empty index on an empty registry — never a 500', async () => {
    await request(app.getHttpServer()).get('/api/items').expect(200, { items: [], errors: [] });
  });

  it('registers no static module when there is no client bundle', () => {
    expect(clientDistModules('/definitely/not/built')).toEqual([]);
  });
});
