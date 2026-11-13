import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../server/src/app.module';
import { GitlabClient } from '../../server/src/gitlab/gitlab.client';
import { listenLoopback } from '../helpers/app';
import { FakeGitlab } from '../helpers/gitlab';

/** `GET /api/gitlab` and `POST /api/gitlab/sweep` over the real `AppModule`, the GitLab client on an in-memory `FakeGitlab`. */

const SITE = 'www.gitlab.example.com';
const TOKEN = 'glpat-SECRET-123';
const REMOTE_PAT = 'glpat-abc';
const env = { ...process.env };
const dirs: string[] = [];
let app: INestApplication;

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function build(opts: { configured: boolean; fake?: FakeGitlab; remote?: boolean }): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'bm-gitlab-routes-'));
  dirs.push(root);
  process.env.BM_WATCHDOG = 'off';
  process.env.BM_ORCH_HOME = join(root, 'orchestrator');
  process.env.BM_GITLAB_SITE = opts.configured ? SITE : '';
  process.env.BM_GITLAB_TOKEN = opts.configured ? TOKEN : '';
  if (opts.remote) {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', `https://oauth2:${REMOTE_PAT}@${SITE}/ns/repo.git`]);
    process.env.BM_JIRA_FILE = join(root, 'jira.json');
    writeFileSync(process.env.BM_JIRA_FILE, JSON.stringify({ boards: [], repos: { TIMIFY: [repo] } }));
  }
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (opts.fake) builder = builder.overrideProvider(GitlabClient).useValue(new GitlabClient(opts.fake.fetch));
  app = (await builder.compile()).createNestApplication();
  await app.init();
  await listenLoopback(app);
  await settle();
}

const sweep = () => request(app.getHttpServer()).post('/api/gitlab/sweep').set('content-type', 'application/json').send('{}');
const get = () => request(app.getHttpServer()).get('/api/gitlab');

afterEach(async () => {
  await app.close();
  process.env = { ...env };
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('/api/gitlab', () => {
  it('unconfigured: GET says so, an empty list; the sweep is 409', async () => {
    await build({ configured: false });
    const res = await get().expect(200);
    expect(res.body.status.state).toBe('unconfigured');
    expect(res.body.mrs).toEqual([]);
    expect((await sweep().expect(409)).body).toEqual({ message: 'GitLab is not being polled' });
  });

  it('a cross-origin sweep is refused by the guard', async () => {
    await build({ configured: false });
    await sweep().set('origin', 'http://evil.test').expect(403);
  });

  it.each([
    ['identity 200', 200],
    ['identity 401', 401]
  ])('never puts the token or a remote\'s userinfo in the body (%s)', async (_name, status) => {
    const fake = new FakeGitlab();
    if (status !== 200) fake.script.set('/api/v4/user', { status, body: { message: '401 Unauthorized' } });
    await build({ configured: true, fake, remote: true });
    await sweep();
    await settle();
    const res = await get().expect(200);
    if (status === 200) expect(res.body.jiraProjects.TIMIFY[0].path).toBe('ns/repo');
    for (const secret of [TOKEN, REMOTE_PAT, 'oauth2']) expect(res.text).not.toContain(secret);
  });

  it('armed and healthy: the sweep is 200 { ok: true }', async () => {
    await build({ configured: true, fake: new FakeGitlab(), remote: true });
    expect((await sweep().expect(200)).body).toEqual({ ok: true });
  });

  it('inside a 429 window the sweep is 429 with an ISO retryAt', async () => {
    const fake = new FakeGitlab();
    fake.script.set('/api/v4/user', { status: 429, headers: { 'retry-after': '30' } });
    await build({ configured: true, fake, remote: true });
    const res = await sweep().expect(429);
    expect(res.body.message).toBe('rate limited');
    expect(new Date(res.body.retryAt).toISOString()).toBe(res.body.retryAt);
  });
});
