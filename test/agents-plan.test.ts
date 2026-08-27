import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';

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
  });

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
    expect(res.body.defaultMode).toBe('acceptEdits');
    expect(res.body.blocked).toBeUndefined();
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
});
