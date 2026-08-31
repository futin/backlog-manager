import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun } from '../shared/types';

// Same translation orchestrator-shapes.test.ts already does: the fixture is
// plain JSON (no `as const`), so TS would otherwise widen its string fields
// to `string` instead of the narrower literal unions (`RunStage`, etc.).
// This cast is what lets `{ ...fixture, updatedAt: ... }` below type-check
// as a real OrchestratorRun rather than a bag of strings.
const fixture = rawFixture as OrchestratorRun;

describe('GET /api/orchestrator/runs', () => {
  let app: INestApplication;
  let tmpRoot: string;
  let orchHome: string;
  const env = { ...process.env };

  // The exact layout orchestrate.mjs's own projectDir()/runFilePath() write:
  // <root>/<encodeURIComponent(absolute project path)>/run.json, plus a
  // sibling runs/ directory for archived runs. Duplicated here rather than
  // imported from the .mjs tool because that tool is a standalone script
  // with no exported package boundary into this TS project — the fixture
  // and this path shape are the cross-language contract, not a shared module.
  function projectDir(project: string): string {
    return join(orchHome, encodeURIComponent(project));
  }

  function writeRun(run: OrchestratorRun): string {
    const dir = projectDir(run.project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify(run, null, 2));
    return file;
  }

  beforeEach(async () => {
    // orchHome itself is deliberately never created here. A machine that has
    // never run the orchestrator has no ~/.backlog-manager/orchestrator/ at
    // all, and the first test case below depends on that directory genuinely
    // not existing — mkdtempSync gives us a fresh unique parent to point
    // BM_ORCH_HOME's child at, not the state dir itself.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-orch-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;

    // REGISTRY_FILE is overridden the same way app.test.ts and
    // agents-status.test.ts do it: AppModule also wires up ItemsModule and
    // AgentsModule, and leaving REGISTRY_FILE on its real-machine default
    // would have this suite reading the developer's actual
    // ~/.backlog-manager/registry.json on every test run.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // Explicitly listen once here rather than leaving it to supertest. Left
    // alone, supertest's Test#serverAddress calls `app.getHttpServer().listen(0)`
    // itself whenever the server isn't already listening, and its own end()
    // then calls `.close()` on that same server once the response lands —
    // see node_modules/supertest/lib/test.js. That is a listen/close cycle
    // per request, on the *same* underlying http.Server object, and it is
    // only safe if each cycle fully completes before the next begins. Every
    // other case in this file makes one request per test, so it never
    // exercises this — but "never caches" below makes two, with a disk write
    // in between, specifically to prove the endpoint re-reads per request.
    // Under `--runInBand`'s single process, with dozens of other suites
    // opening and closing their own Nest apps and ephemeral servers on the
    // same event loop, that back-to-back listen/close pair on one Server
    // instance was the flaky part: it reproduced as a bare `socket hang up`
    // roughly 1 run in 4 under the full suite, never in isolation, and never
    // on any single-request case in this same file. Listening once here (and
    // never again per request) means every `request(app.getHttpServer())`
    // call below finds `app.address()` already non-null, so supertest reuses
    // that one address for the whole test and never touches listen/close
    // itself — see the `if (!addr)` branch in serverAddress. `app.close()`
    // below still tears the one listener down at the end of each test.
    await app.listen(0);
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns an empty list when the state dir does not exist yet', async () => {
    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body).toEqual({ runs: [] });
  });

  it('reports a fresh running fixture with its queue passed through intact', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    writeRun(run);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    // toEqual over the whole object (not just a `fresh`/`pastRuns` check) is
    // what proves the queue — and every other field — survives verbatim.
    expect(res.body.runs).toEqual([{ ...run, fresh: true, pastRuns: 0 }]);
  });

  it('marks a run whose heartbeat is 16 minutes old as not fresh', async () => {
    const run: OrchestratorRun = {
      ...fixture,
      updatedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
    };
    writeRun(run);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].fresh).toBe(false);
  });

  it('never caches — a status flip on disk shows up on the very next request', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    const file = writeRun(run);

    const first = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(first.body.runs[0].status).toBe('running');

    writeFileSync(file, JSON.stringify({ ...run, status: 'done' }, null, 2));

    const second = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(second.body.runs[0].status).toBe('done');
  });

  it('skips a corrupt run.json for one project and still returns a valid sibling', async () => {
    const good: OrchestratorRun = { ...fixture, project: '/abs/good', updatedAt: new Date().toISOString() };
    writeRun(good);

    const badDir = projectDir('/abs/bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'run.json'), '{ this is not json');

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].project).toBe('/abs/good');
  });

  it('counts entries under runs/ as pastRuns', async () => {
    const run: OrchestratorRun = { ...fixture, updatedAt: new Date().toISOString() };
    const dir = projectDir(run.project);
    writeRun(run);
    const runsDir = join(dir, 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'run-20260101-000000.json'), '{}');
    writeFileSync(join(runsDir, 'run-20260102-000000.json'), '{}');

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    expect(res.body.runs[0].pastRuns).toBe(2);
  });
});
