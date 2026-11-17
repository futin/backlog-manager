import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../server/src/app.module';
import { GitlabClient } from '../../server/src/gitlab/gitlab.client';
import { GitlabPollerService } from '../../server/src/gitlab/poller.service';
import { listenLoopback } from '../helpers/app';
import { FakeGitlab } from '../helpers/gitlab';

/** `GET /api/gitlab`, `POST /api/gitlab/sweep` and `POST /api/gitlab/sync` over the real `AppModule`, the GitLab client on an in-memory `FakeGitlab`. */

const SITE = 'www.gitlab.example.com';
const TOKEN = 'glpat-SECRET-123';
const REMOTE_PAT = 'glpat-abc';
const env = { ...process.env };
const dirs: string[] = [];
let app: INestApplication;
/** This case's `gitlab-sync.json`, under its own temp root and not yet created — never the developer's real one. */
let syncFile: string;

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function build(opts: { configured: boolean; fake?: FakeGitlab; remote?: boolean; syncContent?: string }): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'bm-gitlab-routes-'));
  dirs.push(root);
  process.env.BM_WATCHDOG = 'off';
  process.env.BM_ORCH_HOME = join(root, 'orchestrator');
  process.env.BM_GITLAB_SITE = opts.configured ? SITE : '';
  process.env.BM_GITLAB_TOKEN = opts.configured ? TOKEN : '';
  syncFile = join(root, 'settings', 'gitlab-sync.json');
  process.env.BM_GITLAB_SYNC_FILE = syncFile;
  if (opts.syncContent !== undefined) {
    mkdirSync(join(root, 'settings'), { recursive: true });
    writeFileSync(syncFile, opts.syncContent);
  }
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
const sync = (body: unknown) => request(app.getHttpServer()).post('/api/gitlab/sync').set('content-type', 'application/json').send(JSON.stringify(body));

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

describe('POST /api/gitlab/sync', () => {
  const ERROR = 'interval must be one of 15s, 1m, 5m, off';

  it('writes the interval, answers the value read back, and GET then reports it', async () => {
    await build({ configured: true, fake: new FakeGitlab(), remote: true });
    expect((await sync({ interval: '5m' }).expect(200)).body).toEqual({ interval: '5m' });
    expect(JSON.parse(readFileSync(syncFile, 'utf8'))).toEqual({ interval: '5m' });
    expect((await get().expect(200)).body.status.interval).toBe('5m');
  });

  it.each([
    ['an unknown interval', { interval: '2m' }],
    ['no interval', {}],
    ['an array body', ['5m']]
  ])('%s is a 400 and creates no file', async (_name, body) => {
    await build({ configured: true, fake: new FakeGitlab(), remote: true });
    expect((await sync(body).expect(400)).body).toEqual({ error: ERROR });
    expect(existsSync(syncFile)).toBe(false);
  });

  it('a file that does not parse is a 409 and is left unchanged', async () => {
    await build({ configured: true, fake: new FakeGitlab(), remote: true, syncContent: '{not json' });
    const res = await sync({ interval: '5m' }).expect(409);
    expect(res.body.error).toContain('does not parse as JSON');
    expect(readFileSync(syncFile, 'utf8')).toBe('{not json');
  });

  it('a cross-origin post is refused by the guard and creates no file', async () => {
    await build({ configured: false });
    await sync({ interval: '5m' }).set('origin', 'http://evil.test').expect(403);
    expect(existsSync(syncFile)).toBe(false);
  });

  it('unconfigured GitLab still takes the write, and GET reports it', async () => {
    await build({ configured: false });
    expect((await sync({ interval: 'off' }).expect(200)).body).toEqual({ interval: 'off' });
    expect(JSON.parse(readFileSync(syncFile, 'utf8'))).toEqual({ interval: 'off' });
    expect((await get().expect(200)).body.status.interval).toBe('off');
  });

  it('reschedules the poller once after a 200, and never after a 400 or a 409', async () => {
    await build({ configured: true, fake: new FakeGitlab(), remote: true });
    const reschedule = jest.spyOn(app.get(GitlabPollerService), 'reschedule');
    await sync({ interval: '2m' }).expect(400);
    expect(reschedule).not.toHaveBeenCalled();
    await sync({ interval: '15s' }).expect(200);
    expect(reschedule).toHaveBeenCalledTimes(1);
    writeFileSync(syncFile, '{not json');
    await sync({ interval: '5m' }).expect(409);
    expect(reschedule).toHaveBeenCalledTimes(1);
  });
});
