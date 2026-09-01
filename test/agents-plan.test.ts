import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun, RunStage } from '../shared/types';

// Plain JSON, so TS widens its string fields to `string` rather than the
// literal unions (`RunStage`) the run-claim case below turns on.
const runFixture = rawFixture as OrchestratorRun;

const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nit breaks\n\n## Cause\n\na typo\n\n## Fix\n\nfix the typo\n');
const RAW_BUG = item('bug-1', 'a fresh bug', '## Symptom\n\nit breaks\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n');
const IDEA = item('idea-1', 'an idea', '## Sketch\n\nsomething\n');
const OOS = item('oos-1', 'declined', '## Why not\n\nno\n');

let projectPath: string;

function stubDashboard(over: Record<string, unknown> = {}) {
  global.fetch = jest.fn((input: RequestInfo | URL) =>
    Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(
        String(input).endsWith('/api/management')
          ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
          : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits', ...over }
      )
    } as Response)
  ) as jest.Mock;
}

describe('POST /api/agents/plan', () => {
  let app: INestApplication;
  let tmpRoot: string;
  let orchHome: string;
  const env = { ...process.env };
  // See the same constant in test/agents-dispatch.test.ts: a mock left on
  // global.fetch is inherited by whatever runs next in this worker, where a
  // case that forgot to stub passes on leftovers instead of failing loudly.
  const realFetch = global.fetch;

  beforeEach(async () => {
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-1-a-fresh-bug.md', content: RAW_BUG },
      { leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG },
      { leaf: 'ideas/open', filename: 'idea-1-an-idea.md', content: IDEA },
      { leaf: 'out-of-scope', filename: 'oos-1-declined.md', content: OOS }
    ]);

    // A fresh, empty BM_ORCH_HOME per case. plan() now consults the
    // orchestrator's run files, and without this the suite reads the
    // developer's real ~/.backlog-manager/orchestrator/ and answers on
    // whatever run happens to be live on their machine — see the same guard,
    // stated at length, in test/orchestrator-start.test.ts.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bm-plan-'));
    orchHome = join(tmpRoot, 'orchestrator');
    process.env.BM_ORCH_HOME = orchHome;

    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    global.fetch = realFetch;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /* The layout orchestrate.mjs's own runFilePath() writes — duplicated here
     for the reason test/orchestrator-start.test.ts's copy records: that
     script is standalone, with no exported package boundary into this TS
     project. */
  function writeRun(id: string, stage: RunStage): void {
    const run: OrchestratorRun = {
      ...runFixture,
      project: projectPath,
      updatedAt: new Date().toISOString(),
      queue: [{ ...runFixture.queue[0], id, stage }]
    };
    const dir = join(orchHome, encodeURIComponent(run.project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  const post = (body: unknown) =>
    request(app.getHttpServer()).post('/api/agents/plan').send(body as object);

  const itemPath = (leaf: string, name: string) => join(projectPath, 'backlog', leaf, name);

  it('plans a groom for an ungroomed bug, offering only modes up to the ceiling', async () => {
    stubDashboard();
    const res = await post({ itemPath: itemPath('bugs/open', 'bug-1-a-fresh-bug.md') }).expect(201);
    expect(res.body.action).toBe('groom');
    expect(res.body.project).toBe('alpha');
    expect(res.body.prompt).toContain('backlog-manager:backlog-groom');
    expect(res.body.allowedModes).toEqual(['plan', 'acceptEdits']);
    // The composed default is `auto`, so this is the clamp: a host that caps at
    // acceptEdits gets acceptEdits, and the sheet never offers a rung the
    // dashboard would refuse anyway.
    expect(res.body.defaultMode).toBe('acceptEdits');
    expect(res.body.blocked).toBeUndefined();
  });

  // `auto`, not the ceiling. The rung matters: a dispatched session runs
  // unattended — often with nobody at the terminal the prompt would appear on —
  // so a mode that stops on every tool call is a session that silently does
  // nothing. `bypassPermissions`, the rung above, is a different bargain and
  // stays a per-launch choice.
  it('defaults to auto when the ceiling allows it', async () => {
    stubDashboard({ spawnMaxPermission: 'bypassPermissions' });
    const res = await post({ itemPath: itemPath('bugs/open', 'bug-1-a-fresh-bug.md') }).expect(201);
    expect(res.body.allowedModes).toEqual(['plan', 'acceptEdits', 'auto', 'bypassPermissions']);
    expect(res.body.defaultMode).toBe('auto');
  });

  it('plans an execute for a groomed bug', async () => {
    stubDashboard();
    const res = await post({ itemPath: itemPath('bugs/open', 'bug-2-a-known-bug.md') }).expect(201);
    expect(res.body.action).toBe('execute');
    expect(res.body.prompt).toContain('backlog-manager:backlog-execute');
  });

  it('404s an item with no next step', async () => {
    stubDashboard();
    await post({ itemPath: itemPath('out-of-scope', 'oos-1-declined.md') })
      .expect(404, { error: 'nothing to dispatch for this item' });
  });

  it('404s a path outside every registered backlog', async () => {
    stubDashboard();
    await post({ itemPath: '/etc/passwd' }).expect(404, { error: 'not found' });
  });

  it('400s a missing itemPath', async () => {
    stubDashboard();
    await post({}).expect(400, { error: 'itemPath is required' });
  });

  it('still plans, with a reason, when the dashboard cannot see the project', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          String(input).endsWith('/api/management')
            ? { projects: [{ dirName: '-x', name: 'x', path: '/somewhere/else', lastActiveMs: 1 }] }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' }
        )
      } as Response)
    ) as jest.Mock;
    const res = await post({ itemPath: itemPath('ideas/open', 'idea-1-an-idea.md') }).expect(201);
    expect(res.body.action).toBe('groom');
    expect(res.body.blocked).toContain(projectPath);
  });

  it('plans with plan-only modes when the dashboard is unreachable', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as jest.Mock;
    const res = await post({ itemPath: itemPath('ideas/open', 'idea-1-an-idea.md') }).expect(201);
    expect(res.body.allowedModes).toEqual(['plan']);
    expect(res.body.blocked).toContain('unreachable');
  });

  /* `blocked` is filled, not thrown, for the same reason every other block on
     this route is: the sheet that asked can explain the state, where a failed
     request just fails. A sheet opened after a run claimed the item shows the
     reason instead of a launch button — and the dispatch route re-checks it
     anyway for the sheet that was already open (see test/agents-dispatch). */
  it('reports a run claim as the reason the launch is blocked', async () => {
    stubDashboard();
    writeRun('bug-2', 'verifying');
    const res = await post({ itemPath: itemPath('bugs/open', 'bug-2-a-known-bug.md') }).expect(201);
    expect(res.body.blocked).toContain('verifying');
  });

  /* The negative half, on the same route: a run that has finished with the
     item leaves the sheet exactly as it was. Without this, a `blocked` that
     was accidentally set for every item in any run file at all would still
     pass the case above. */
  it('leaves the launch unblocked for an item the run has merged', async () => {
    stubDashboard();
    writeRun('bug-2', 'merged');
    const res = await post({ itemPath: itemPath('bugs/open', 'bug-2-a-known-bug.md') }).expect(201);
    expect(res.body.blocked).toBeUndefined();
  });
});
