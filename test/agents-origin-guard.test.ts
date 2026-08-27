import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';

const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n');

let projectPath: string;

/**
 * The whole point of these cases is that NOTHING leaves this process, so the
 * stub records rather than answers usefully: an assertion of `[]` against this
 * array is the real subject, and a case that somehow got past the guard still
 * meets a plausible dashboard, so it fails on the fetch log rather than on a
 * rejected promise that could be mistaken for the guard working.
 */
function recordFetches(): string[] {
  const sent: string[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    sent.push(url);
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(
        url.endsWith('/api/management')
          ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
          : url.endsWith('/api/spawn')
            ? { sessionId: 'sess-1' }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
      )
    } as Response);
  }) as jest.Mock;
  return sent;
}

/**
 * Every route in this app was a read-only GET before dispatch existed, so
 * "loopback is the access control" covered it. It does not cover a POST that
 * spawns a Claude Code session: the developer's own browser sits inside the
 * loopback boundary, and Nest registers `express.urlencoded` on every app — so
 * a hidden cross-origin form, which needs no CORS preflight, would otherwise
 * reach /api/agents/dispatch and start a session carrying an attacker-written
 * prompt. See server/src/agents/origin.guard.ts.
 */
describe('the agents POST guard', () => {
  let app: INestApplication;
  const env = { ...process.env };
  const realFetch = global.fetch;

  beforeEach(async () => {
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG }
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

  const bugPath = (): string => join(projectPath, 'backlog', 'bugs/open', 'bug-2-a-known-bug.md');
  const body = (): Record<string, unknown> => ({
    itemPath: bugPath(),
    action: 'execute',
    prompt: 'Use the backlog-manager:backlog-execute skill on bug-2.',
    permissionMode: 'acceptEdits',
    remoteControl: true
  });

  for (const route of ['plan', 'dispatch']) {
    /* The exact shape of a cross-origin form auto-submit: the one content type
       that needs no preflight, carrying a body Nest's unconditional urlencoded
       parser is happy to parse. */
    it('403s a urlencoded POST to ' + route + ' without any outbound call', async () => {
      const sent = recordFetches();
      const res = await request(app.getHttpServer())
        .post('/api/agents/' + route)
        .type('form')
        .send({ itemPath: bugPath(), action: 'execute', prompt: 'do something else entirely' })
        .expect(403);
      expect(res.body.error).toMatch(/application\/json/);
      expect(sent).toEqual([]);
    });

    it('403s a cross-origin JSON POST to ' + route + ' without any outbound call', async () => {
      const sent = recordFetches();
      const res = await request(app.getHttpServer())
        .post('/api/agents/' + route)
        .set('origin', 'http://evil.example')
        .send(body())
        .expect(403);
      expect(res.body.error).toMatch(/cross-origin/);
      expect(sent).toEqual([]);
    });

    /* A sandboxed iframe, a data: document and a redirected form all send this
       one. No same-origin request ever does, which is why the origin half of
       the guard exists at all: the content-type check alone lets it through. */
    it('403s an Origin: null POST to ' + route, async () => {
      const sent = recordFetches();
      await request(app.getHttpServer())
        .post('/api/agents/' + route)
        .set('origin', 'null')
        .send(body())
        .expect(403);
      expect(sent).toEqual([]);
    });
  }

  it('still spawns for a same-origin JSON POST', async () => {
    const sent = recordFetches();
    // Host and Origin set together, and to the same thing: the guard compares
    // one against the other, so a hardcoded origin alone would only ever
    // exercise the mismatch branch.
    const res = await request(app.getHttpServer())
      .post('/api/agents/dispatch')
      .set('host', 'localhost:4322')
      .set('origin', 'http://localhost:4322')
      .send(body())
      .expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });
    expect(sent.some((u) => u.endsWith('/api/spawn'))).toBe(true);
  });

  /* The dev path, which is the one most likely to be broken by a careless
     origin check: vite.config.ts sets no changeOrigin, so a request proxied
     through :5177 arrives with BOTH headers naming the Vite port. */
  it('still spawns through the Vite proxy, where Host is the client port', async () => {
    const sent = recordFetches();
    await request(app.getHttpServer())
      .post('/api/agents/dispatch')
      .set('host', 'localhost:5177')
      .set('origin', 'http://localhost:5177')
      .send(body())
      .expect(201);
    expect(sent.some((u) => u.endsWith('/api/spawn'))).toBe(true);
  });

  it('still plans for a JSON POST with no origin header at all — curl, and every other suite here', async () => {
    recordFetches();
    const res = await request(app.getHttpServer())
      .post('/api/agents/plan')
      .send({ itemPath: bugPath() })
      .expect(201);
    expect(res.body.action).toBe('execute');
  });

  /* A charset parameter is ordinary — some clients always send one — and must
     not read as a different media type. */
  it('accepts application/json with a charset parameter', async () => {
    recordFetches();
    await request(app.getHttpServer())
      .post('/api/agents/plan')
      .set('content-type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ itemPath: bugPath() }))
      .expect(201);
  });

  /* The read-only route is deliberately outside the guard: every other GET in
     this app is open by the same posture, and a status probe starts nothing. */
  it('leaves GET /api/agents/status open', async () => {
    recordFetches();
    await request(app.getHttpServer())
      .get('/api/agents/status')
      .set('origin', 'http://evil.example')
      .expect(200);
  });
});
