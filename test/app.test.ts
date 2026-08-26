import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { clientDistModules } from '../server/src/static';
import { makeRegistry } from './helpers/store';

describe('app bootstrap', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers /api/health', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, { ok: true });
  });

  it('answers /api/items with an empty index on an empty registry — never a 500', async () => {
    await request(app.getHttpServer()).get('/api/items').expect(200, { items: [], errors: [] });
  });

  it('registers no static module when there is no client bundle', () => {
    expect(clientDistModules('/definitely/not/built')).toEqual([]);
  });
});
