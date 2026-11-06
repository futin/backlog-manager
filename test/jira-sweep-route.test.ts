import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { JiraClient } from '../server/src/jira/jira.client';
import { JiraPollerService, SWEEP_FLOOR_MS } from '../server/src/jira/poller.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { FakeJira, makeRawIssue } from './helpers/jira';
import { makeRegistry } from './helpers/store';

/**
 * `POST /api/jira/sweep` — the popover head's site-wide `Sync now` (plan 4 Task 4, spec §5). One app per describe, as `jira-write-routes.test.ts` does,
 * because the configuration is the describe. `Date.now` is shifted by `skew` so a case can step past the floor (or stay inside it) without sleeping.
 */

const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE'] as const;
const ON = { id: 'b_0123abcd', name: 'On', roots: ['PAY-120'], queries: [], interval: '1m' };
const ON2 = { id: 'b_0123abce', name: 'On too', roots: ['PAY-120'], queries: [], interval: '5m' };
const OFF = { id: 'b_0123abcf', name: 'Off', roots: ['PAY-999'], queries: [], interval: 'off' };

let saved: Record<string, string | undefined>;
let dir: string;
let fake: FakeJira;
let app: INestApplication;
let skew = 0;
const realNow = Date.now.bind(Date);

async function build(name: string, boards: unknown[], on = true): Promise<void> {
  process.env.BM_JIRA_SITE = on ? 'acme.atlassian.net' : '';
  process.env.BM_JIRA_EMAIL = on ? 'ada@example.com' : '';
  process.env.BM_JIRA_TOKEN = on ? 't0k3n-SECRET' : '';
  const file = join(dir, `${name}.json`);
  process.env.BM_JIRA_FILE = file;
  writeFileSync(file, JSON.stringify({ boards }));
  fake = new FakeJira();
  for (const key of ['PAY-120', 'PAY-999']) {
    fake.issues.set(key, makeRawIssue({ key, fields: { issuetype: { name: 'Epic', hierarchyLevel: 1, subtask: false } } }));
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry([]))
    .overrideProvider(JiraClient)
    .useValue(new JiraClient(fake.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  await app.get(JiraPollerService).tick();
}

const sweep = () => request(app.getHttpServer()).post('/api/jira/sweep').set('content-type', 'application/json').send('{}');
/** One sweep of the non-off boards costs what the cold sweep at build cost for them: the call count per board is the walk's, not this route's. */
const onSearches = () => searches().filter((j) => !j.includes('PAY-999')).length;
const searches = () => fake.calls.filter((c) => c.url.endsWith('/search/jql')).map((c) => (c.body as { jql: string }).jql);
/** Step past the floor so the next press is a real sweep. */
const pastFloor = () => (skew += SWEEP_FLOOR_MS + 1_000);

beforeAll(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-sweep-'));
});
beforeEach(() => {
  skew = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await app.close();
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/jira/sweep', () => {
  it('is 409 when Jira is unconfigured, with no call', async () => {
    await build('unconfigured', [ON], false);
    expect((await sweep().expect(409)).body).toEqual({ message: 'Jira is not being polled' });
    expect(fake.calls).toEqual([]);
  });

  it('is 409 when only off boards remain, all already swept (the chain is disarmed)', async () => {
    await build('disarmed', [OFF]);
    const before = fake.calls.length;
    pastFloor();
    expect((await sweep().expect(409)).body).toEqual({ message: 'Jira is not being polled' });
    expect(fake.calls.length).toBe(before);
  });

  it('sweeps every non-off board once and leaves the off one alone, answering the status payload', async () => {
    await build('mixed', [ON, ON2, OFF]);
    const cold = onSearches();
    const offBefore = searches().filter((j) => j.includes('PAY-999')).length;
    pastFloor();
    const res = await sweep().expect(200);
    expect(res.body).toMatchObject({ configured: true, access: 'ok', live: {}, boards: expect.any(Array) });
    expect(res.body.boards).toHaveLength(3);
    expect(onSearches() - cold).toBe(cold);
    expect(searches().filter((j) => j.includes('PAY-999')).length).toBe(offBefore);
  });

  it('two concurrent presses make one sweep', async () => {
    await build('concurrent', [ON, ON2]);
    const cold = onSearches();
    pastFloor();
    await Promise.all([sweep().expect(200), sweep().expect(200)]);
    expect(onSearches() - cold).toBe(cold);
  });

  it('a second press a second later makes no call', async () => {
    await build('floor', [ON]);
    pastFloor();
    await sweep().expect(200);
    const after = fake.calls.length;
    skew += 1_000;
    await sweep().expect(200);
    expect(fake.calls.length).toBe(after);
  });

  it('inside a stored 429 window is 429 with that retryAt and makes no call', async () => {
    await build('window', [ON]);
    pastFloor();
    fake.rateLimit = { retryAfter: 120 };
    await sweep().expect(200);
    const stored = (await request(app.getHttpServer()).get('/api/jira')).body;
    expect(stored.access).toBe('rate-limited');
    const after = fake.calls.length;
    pastFloor();
    const res = await sweep().expect(429);
    expect(res.body).toEqual({ message: 'rate limited', retryAt: expect.any(String) });
    expect(Date.parse(res.body.retryAt)).toBeGreaterThan(Date.now());
    expect(fake.calls.length).toBe(after);
  });

  it('a 401 from Jira is still a 200, with access unauthorized', async () => {
    await build('unauthorized', [ON]);
    pastFloor();
    fake.unauthorized = true;
    const res = await sweep().expect(200);
    expect(res.body.access).toBe('unauthorized');
  });

  it('is refused by the guard from another origin and with no content type', async () => {
    await build('guard', [ON]);
    const before = fake.calls.length;
    await sweep().set('origin', 'http://evil.test').expect(403);
    await request(app.getHttpServer()).post('/api/jira/sweep').send('{}').expect(403);
    expect(fake.calls.length).toBe(before);
  });
});
