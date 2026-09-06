import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { readPauseRequest, writePauseRequest } from '../server/src/orchestrator/pause-control.util';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun } from '../shared/types';

const fixture = rawFixture as OrchestratorRun;

let projectPath: string;

/**
 * `POST /api/agents/pause` is the one route in `agents/` that never talks to
 * the dashboard, and the assertions here are built around that: every case
 * shares one `afterEach` proving `global.fetch` was never called at all.
 * A pause is a fact recorded on this machine's own disk about a run that is
 * already going — there is no session to spawn and nothing to ask anyone's
 * permission for, which is also why it is independent of `BM_AGENTS`
 * (case: "with agents off"). Making it depend on that switch would mean a
 * run started while agents were on could never be stopped after they were
 * turned off.
 */
describe('POST /api/agents/pause', () => {
  let app: INestApplication;
  let tmpRoot: string;
  let orchHome: string;
  let controlRoot: string;
  const env = { ...process.env };
  const realFetch = global.fetch;
  let fetchStub: jest.Mock;

  function projectDir(project: string): string {
    return join(orchHome, encodeURIComponent(project));
  }

  function writeRun(run: OrchestratorRun): void {
    const dir = projectDir(run.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  const runningRun = (over: Partial<OrchestratorRun> = {}): OrchestratorRun => ({
    ...fixture, project: projectPath, status: 'running', updatedAt: new Date().toISOString(), ...over
  });

  async function createApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
  }

  beforeEach(async () => {
    projectPath = makeProject('alpha', []);

    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-orch-pause-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;
    controlRoot = join(tmpRoot, 'settings', 'orchestrator-control');
    process.env.BM_ORCH_CONTROL_HOME = controlRoot;

    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    process.env.BM_WATCHDOG = 'off';

    // A stub that would ANSWER a dashboard call, so a route that made one
    // would pass rather than blow up — the point is the call count, not a
    // rejection that could mask itself as some other failure.
    fetchStub = jest.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({ ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' })
    } as Response)) as jest.Mock;
    global.fetch = fetchStub;

    await createApp();
  });

  afterEach(async () => {
    await app.close();
    // The suite-wide invariant, asserted once rather than in every case: this
    // route reaches no third process, ever.
    expect(fetchStub).not.toHaveBeenCalled();
    process.env = { ...env };
    global.fetch = realFetch;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    request(app.getHttpServer()).post('/api/agents/pause').send(body as object);

  it('400s a missing, empty or blank project', async () => {
    for (const body of [{}, { project: '' }, { project: '  ' }]) {
      const res = await post(body).expect(400);
      expect(res.body).toEqual({ error: 'project is required' });
    }
  });

  it('409s when the project has no run at all', async () => {
    const res = await post({ project: projectPath }).expect(409);
    expect(res.body).toEqual({ error: 'no running run to pause for this project' });
  });

  it.each([['done'], ['aborted'], ['failed'], ['paused']] as const)(
    '409s a run whose status is already %s',
    async (status) => {
      writeRun(runningRun({ status }));
      const res = await post({ project: projectPath }).expect(409);
      expect(res.body).toEqual({ error: 'no running run to pause for this project' });
      // Nothing written on a refusal — a request naming a run that cannot act
      // on it would sit there until the NEXT run started and be judged
      // against that one's runId instead.
      expect(readPauseRequest(projectPath, controlRoot)).toBeNull();
    }
  );

  it('writes a request pinned to the run for a fresh running run', async () => {
    writeRun(runningRun());

    const res = await post({ project: projectPath }).expect(200);

    expect(res.body).toEqual({ pauseRequested: true });
    expect(readPauseRequest(projectPath, controlRoot)).toEqual({
      runId: fixture.runId,
      requestedAt: expect.any(String)
    });
  });

  // A stale run is the case that matters most: a run whose heartbeat has
  // stopped may still be mid-`claude -p`, minutes from its next tool call,
  // and pausing it is exactly what a person watching a crashed-looking strip
  // wants to be able to do. `fresh` is deliberately not part of the gate.
  it('accepts a stale running run too', async () => {
    writeRun(runningRun({ updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() }));

    const res = await post({ project: projectPath }).expect(200);

    expect(res.body).toEqual({ pauseRequested: true });
    expect(readPauseRequest(projectPath, controlRoot)).not.toBeNull();
  });

  it('deletes the request on cancel, and is a no-op when there is nothing to cancel', async () => {
    writeRun(runningRun());
    writePauseRequest(projectPath, fixture.runId, new Date(), controlRoot);

    const first = await post({ project: projectPath, cancel: true }).expect(200);
    expect(first.body).toEqual({ pauseRequested: false });
    expect(readPauseRequest(projectPath, controlRoot)).toBeNull();

    const second = await post({ project: projectPath, cancel: true }).expect(200);
    expect(second.body).toEqual({ pauseRequested: false });
  });

  // `cancel` selects the direction that throws work away, so only the strict
  // boolean counts — a string `'true'` from a hand-rolled form post must not
  // silently undo a pause somebody asked for.
  it('treats any non-boolean cancel as a pause, not a cancel', async () => {
    writeRun(runningRun());

    const res = await post({ project: projectPath, cancel: 'true' }).expect(200);

    expect(res.body).toEqual({ pauseRequested: true });
    expect(readPauseRequest(projectPath, controlRoot)).not.toBeNull();
  });

  it('re-stamps an existing request rather than refusing a second one', async () => {
    writeRun(runningRun());

    const first = await post({ project: projectPath }).expect(200);
    expect(first.body).toEqual({ pauseRequested: true });
    const firstAt = readPauseRequest(projectPath, controlRoot)?.requestedAt ?? '';

    const second = await post({ project: projectPath }).expect(200);
    expect(second.body).toEqual({ pauseRequested: true });
    const secondAt = readPauseRequest(projectPath, controlRoot)?.requestedAt ?? '';

    expect(Date.parse(secondAt)).toBeGreaterThanOrEqual(Date.parse(firstAt));
  });

  it('the runs payload reports the pause on the very next read', async () => {
    writeRun(runningRun());
    await post({ project: projectPath }).expect(200);

    const res = await request(app.getHttpServer()).get('/api/orchestrator/runs').expect(200);
    const entry = res.body.runs.find((r: { project: string }) => r.project === projectPath);
    expect(entry.pauseRequested).toBe(true);
  });

  it('works with agents off — a pause is a fact on disk, not a dashboard call', async () => {
    await app.close();
    delete process.env.BM_AGENTS;
    await createApp();
    writeRun(runningRun());

    const res = await post({ project: projectPath }).expect(200);

    expect(res.body).toEqual({ pauseRequested: true });
  });
});
