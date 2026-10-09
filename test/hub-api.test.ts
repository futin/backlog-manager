import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun } from '../shared/types';

/**
 * `/api/hub/widgets` mounted on the real `AppModule` (#249): the route exists, the package answers what it does not declare, a POST changes nothing, and
 * the Host allowlist gates it like every other route. Run state and the registry point into a per-case temp dir, the way orchestrator-runs.test.ts does it.
 */

const fixture = rawFixture as OrchestratorRun;

/** Every file under `dir`, with its bytes — the "nothing on disk changes" snapshot. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

describe('/api/hub/widgets', () => {
  let app: INestApplication;
  let tmpRoot: string;
  const env = { ...process.env };

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-hub-'));
    const orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;
    process.env.BM_WATCHDOG_FILE = join(tmpRoot, 'settings', 'watchdog.json');
    process.env.BM_ORCH_CONTROL_HOME = join(tmpRoot, 'settings', 'orchestrator-control');

    // One fresh running run, so the `run` tile has something to reduce. Its heartbeat is stamped from the clock this case runs under.
    const dir = join(orchHome, encodeURIComponent(fixture.project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...fixture, status: 'running', updatedAt: new Date().toISOString() }, null, 2));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
    process.env = { ...env };
  });

  it('serves the contract-1 catalog with the three widgets', async () => {
    const res = await request(app.getHttpServer()).get('/api/hub/widgets');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.contract).toBe(1);
    expect(res.body.widgets.map((w: { id: string }) => w.id)).toEqual(['open-total', 'projects', 'run']);
  });

  it('serves the run widget with a state and an updatedAt', async () => {
    const res = await request(app.getHttpServer()).get('/api/hub/widgets/run');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('state');
    expect(res.body).toHaveProperty('updatedAt');
  });

  it('404s a widget id nothing declares', async () => {
    const res = await request(app.getHttpServer()).get('/api/hub/widgets/nope');
    expect(res.status).toBe(404);
  });

  it('404s a POST, and nothing on disk changes', async () => {
    const before = snapshot(tmpRoot);
    const res = await request(app.getHttpServer()).post('/api/hub/widgets/run').set('content-type', 'application/json').send({ input: 'x' });
    expect(res.status).toBe(404);
    expect(snapshot(tmpRoot)).toEqual(before);
  });

  it('403s a Host outside the allowlist', async () => {
    const res = await request(app.getHttpServer()).get('/api/hub/widgets').set('host', 'evil.test:4322');
    expect(res.status).toBe(403);
  });
});
