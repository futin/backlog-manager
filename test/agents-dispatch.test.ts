import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';

const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n');
const RAW_BUG = item('bug-1', 'a fresh bug', '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n');
const OOS = item('oos-1', 'declined', '## Why not\n\nno\n');

let projectPath: string;

interface Sent { url: string; init?: RequestInit }

/** Records every outbound call and answers the three the service makes. */
function stubDashboard(spawn: { ok: boolean; status?: number; body?: unknown } = { ok: true }) {
  const sent: Sent[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url.endsWith('/api/spawn')) {
      return Promise.resolve({
        ok: spawn.ok, status: spawn.status ?? (spawn.ok ? 200 : 429),
        json: () => Promise.resolve(spawn.body ?? { sessionId: 'sess-1' })
      } as Response);
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(
        url.endsWith('/api/management')
          ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
          : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
      )
    } as Response);
  }) as jest.Mock;
  return sent;
}

describe('POST /api/agents/dispatch', () => {
  let app: INestApplication;
  const env = { ...process.env };
  // Captured once so every case — including the ones that replace
  // global.fetch outright rather than calling stubDashboard() — hands the
  // real implementation back afterwards. Without this, a ninth case that
  // forgets to stub inherits whatever the previous case's mock left behind
  // instead of failing loudly on a real network call.
  const realFetch = global.fetch;

  beforeEach(async () => {
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-1-a-fresh-bug.md', content: RAW_BUG },
      { leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG },
      { leaf: 'out-of-scope', filename: 'oos-1-declined.md', content: OOS }
    ]);
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    process.env.BM_AGENTS_TOKEN = 's3cret';
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

  const bugPath = (name: string) => join(projectPath, 'backlog', 'bugs/open', name);
  const post = (body: unknown) =>
    request(app.getHttpServer()).post('/api/agents/dispatch').send(body as object);

  const good = {
    itemPath: '',
    action: 'execute' as const,
    prompt: 'Use the backlog-manager:backlog-execute skill on bug-2.',
    permissionMode: 'acceptEdits' as const,
    remoteControl: true
  };

  it('spawns with the dashboard dirName, the bearer token, and a labelled name', async () => {
    const sent = stubDashboard();
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });

    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    expect(spawn).toBeDefined();
    expect((spawn?.init?.headers as Record<string, string>).authorization).toBe('Bearer s3cret');
    const body = JSON.parse(String(spawn?.init?.body));
    expect(body.project).toBe('-abs-alpha');
    expect(body.name).toBe('bl alpha bug-2');
    expect(body.permissionMode).toBe('acceptEdits');
    expect(body.remoteControl).toBe(true);
    // The client's prompt, byte for byte — not a `toContain` on some phrase
    // both the sent prompt and a server-recomposed one would satisfy. Editing
    // the prompt in the launch sheet is the whole point of the sheet, and only
    // an equality assertion can tell "forwards what was sent" from
    // "recomposes and silently discards the edit".
    expect(body.prompt).toBe(good.prompt);
    // A path must never be sent — dirName membership is the dashboard's own
    // contract and this is the assertion that keeps us inside it.
    expect(JSON.stringify(body)).not.toContain(projectPath);
  });

  it('refuses to execute an ungroomed bug and names the step it does have', async () => {
    stubDashboard();
    const res = await post({ ...good, itemPath: bugPath('bug-1-a-fresh-bug.md') }).expect(409);
    expect(res.body.error).toContain('groom');
  });

  it('clamps a mode above the ceiling instead of forwarding it', async () => {
    const sent = stubDashboard();
    await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), permissionMode: 'bypassPermissions'
    }).expect(201);
    const body = JSON.parse(String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body));
    expect(body.permissionMode).toBe('acceptEdits');
  });

  it('404s an unregistered path without spawning', async () => {
    const sent = stubDashboard();
    await post({ ...good, itemPath: '/etc/passwd' }).expect(404, { error: 'not found' });
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  it('400s an empty prompt', async () => {
    stubDashboard();
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md'), prompt: '   ' })
      .expect(400, { error: 'prompt is required' });
  });

  it('passes the dashboard error through verbatim', async () => {
    stubDashboard({ ok: false, status: 429, body: { error: 'too many launches in flight' } });
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') })
      .expect(429, { error: 'too many launches in flight' });
  });

  it('refuses when the dashboard has remote answers off, without spawning', async () => {
    const sent: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      sent.push(url);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          url.endsWith('/api/management')
            ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
            : { ok: true, remoteAnswer: false, spawnAvailable: true, spawnMaxPermission: 'auto' }
        )
      } as Response);
    }) as jest.Mock;
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(409);
    expect(res.body.error).toMatch(/remote answers/);
    expect(sent.some((u) => u.endsWith('/api/spawn'))).toBe(false);
  });

  it('502s when the dashboard is unreachable', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as jest.Mock;
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(502);
    expect(res.body.error).toContain('unreachable');
  });

  it('400s a prompt over the cap', async () => {
    stubDashboard();
    const res = await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), prompt: 'x'.repeat(9_000)
    }).expect(400, { error: 'prompt is too long' });
    expect(res.body.error).toBe('prompt is too long');
  });

  it('treats a stringy "true" as off, not on, for remoteControl', async () => {
    const sent = stubDashboard();
    await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), remoteControl: 'true'
    }).expect(201);
    const body = JSON.parse(String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body));
    expect(body.remoteControl).toBe(false);
  });

  it('409s "dispatch is off" without spawning, when BM_AGENTS is off', async () => {
    const sent = stubDashboard();
    process.env.BM_AGENTS = 'off';
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(409);
    expect(res.body.error).toContain('dispatch is off');
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  it('409s an item with no next step at all', async () => {
    stubDashboard();
    const res = await post({
      ...good, itemPath: join(projectPath, 'backlog', 'out-of-scope', 'oos-1-declined.md')
    }).expect(409);
    expect(res.body.error).toBe('nothing to dispatch for this item');
  });

  it('refuses a groom request when the item\'s actual next step is execute', async () => {
    stubDashboard();
    const res = await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), action: 'groom'
    }).expect(409);
    expect(res.body.error).toContain('execute');
  });
});
