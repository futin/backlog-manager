import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { JiraClient } from '../server/src/jira/jira.client';
import { JiraPollerService } from '../server/src/jira/poller.service';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import type { JiraStatusPayload } from '../shared/types';
import { listenLoopback } from './helpers/app';
import { FakeJira, makeRawIssue } from './helpers/jira';
import { makeRegistry } from './helpers/store';

/**
 * Jira phase 2 — the three write routes under `/api/jira` over the real `AppModule` (spec §5 and §8; Review Focus 1 and 2).
 *
 * The same shape as `test/jira-routes.test.ts`: one app per describe, because the configuration IS the describe (the fake's switches and the `jira.json` the
 * poller boots against must be in place before `app.init()`), every app on a `JiraClient` over a fake `fetch`, so nothing here reaches a real Jira.
 */

const EMAIL = 'ada@example.com';
const TOKEN = 't0k3n-SECRET';
const KEYS = ['BM_JIRA_SITE', 'BM_JIRA_EMAIL', 'BM_JIRA_TOKEN', 'BM_JIRA_FILE'] as const;
const SKILL = { name: 'Review', prompt: 'Review {key}: {summary}' };
const BOARD = { name: 'Payments', roots: ['PAY-120'], queries: [], interval: '1m' };

let saved: Record<string, string | undefined>;
let dir: string;
let file: string;
let fake: FakeJira;
let app: INestApplication;
let poller: JiraPollerService;

function configure(on: boolean): void {
  process.env.BM_JIRA_SITE = on ? 'acme.atlassian.net' : '';
  process.env.BM_JIRA_EMAIL = on ? EMAIL : '';
  process.env.BM_JIRA_TOKEN = on ? TOKEN : '';
}

/** A fresh fake and a fresh `jira.json` path per describe; `content` is written there first when given. */
function prepare(name: string, opts: { on?: boolean; content?: string } = {}): void {
  configure(opts.on ?? true);
  file = join(dir, `${name}.json`);
  process.env.BM_JIRA_FILE = file;
  if (opts.content !== undefined) writeFileSync(file, opts.content);
  fake = new FakeJira();
  fake.issues.set('PAY-120', makeRawIssue({ key: 'PAY-120', fields: { issuetype: { name: 'Epic', hierarchyLevel: 1, subtask: false } } }));
}

async function build(): Promise<void> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REGISTRY_FILE)
    .useValue(makeRegistry([]))
    .overrideProvider(JiraClient)
    .useValue(new JiraClient(fake.fetch))
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await listenLoopback(app);
  poller = app.get(JiraPollerService);
  await poller.tick();
}

beforeAll(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-write-'));
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  request(app.getHttpServer()).post(`/api/jira${path}`).set('content-type', 'application/json').send(JSON.stringify(body));
const status = async (): Promise<JiraStatusPayload> => (await request(app.getHttpServer()).get('/api/jira').expect(200)).body;
const searches = () => fake.calls.filter((c) => c.url.endsWith('/search/jql')).map((c) => (c.body as { jql: string }).jql);

describe('the guard, on all six config routes', () => {
  beforeAll(async () => {
    prepare('guard');
    await build();
  });
  afterAll(() => app.close());

  it.each([['/boards'], ['/boards/delete'], ['/repos'], ['/repo-defaults'], ['/skills'], ['/skills/delete']])(
    'POST %s with no content type is 403, and nothing is written',
    async (path) => {
      await request(app.getHttpServer()).post(`/api/jira${path}`).send('{}').expect(403);
      expect(existsSync(file)).toBe(false);
    }
  );

  it.each([['/boards'], ['/boards/delete'], ['/repos'], ['/repo-defaults'], ['/skills'], ['/skills/delete']])('POST %s from another origin is 403', async (path) => {
    await post(path, {}).set('origin', 'http://evil.test').expect(403);
    expect(existsSync(file)).toBe(false);
  });

  it.each([['/boards'], ['/boards/delete'], ['/repos'], ['/repo-defaults'], ['/skills'], ['/skills/delete']])(
    'POST %s to a Host the allowlist does not know is 403',
    async (path) => {
      await post(path, {}).set('host', 'evil.example:4322').expect(403);
      expect(existsSync(file)).toBe(false);
    }
  );
});

describe('unconfigured', () => {
  beforeAll(async () => {
    prepare('unconfigured', { on: false });
    await build();
  });
  afterAll(() => app.close());

  it.each([
    ['/boards', { name: '' }],
    ['/boards/delete', {}],
    ['/repos', { project: 'pay', paths: [] }],
    ['/repo-defaults', { path: '', base: null, namePattern: null }],
    ['/skills', { name: '', prompt: 'p' }],
    ['/skills/delete', {}]
  ])('answers a malformed POST %s with its 400 before the 503', async (path, body) => {
    await post(path, body).expect(400);
  });

  it.each([
    ['/boards', BOARD],
    ['/boards/delete', { id: 'b_0123abcd' }],
    ['/repos', { project: 'PAY', paths: ['/a/b'] }],
    ['/repo-defaults', { path: '/a/b', base: 'develop', namePattern: null }],
    ['/skills', SKILL],
    ['/skills/delete', { id: 's_0123abcd' }]
  ])('answers a valid POST %s with 503 Jira is not configured, and creates no file', async (path, body) => {
    expect((await post(path, body).expect(503)).body).toEqual({ error: 'Jira is not configured' });
    expect(existsSync(file)).toBe(false);
    expect(fake.calls).toEqual([]);
  });
});

describe('configured, against a healthy Jira', () => {
  beforeAll(async () => {
    prepare('healthy');
    await build();
  });
  afterAll(() => app.close());

  it('POST /boards creates a board: 200, a minted id, listed by GET /api/jira, and swept before the answer', async () => {
    expect(searches()).toEqual([]);
    const res = await post('/boards', BOARD).expect(200);
    expect(res.body).toEqual({ ...BOARD, id: expect.stringMatching(/^b_[0-9a-f]{8}$/) });
    expect(searches().some((jql) => jql.includes('PAY-120'))).toBe(true);
    const body = await status();
    expect(body.boards).toEqual([expect.objectContaining({ id: res.body.id, name: 'Payments', polledAt: expect.any(String) })]);
    expect(JSON.parse(readFileSync(file, 'utf8')).boards).toEqual([res.body]);
  });

  it('an interval of off still has a polledAt right after the 200', async () => {
    const res = await post('/boards', { ...BOARD, name: 'Quiet', interval: 'off' }).expect(200);
    const board = (await status()).boards.find((b) => b.id === res.body.id);
    expect(board).toMatchObject({ name: 'Quiet', interval: 'off', polledAt: expect.any(String) });
  });

  it('updates a board it holds, keeping its id', async () => {
    const created = (await post('/boards', { ...BOARD, name: 'Before' }).expect(200)).body;
    const updated = await post('/boards', { ...BOARD, id: created.id, name: 'After' }).expect(200);
    expect(updated.body).toEqual({ ...created, name: 'After' });
    expect((await status()).boards.filter((b) => b.id === created.id)).toHaveLength(1);
  });

  it.each([['b_0123abcd'], ['x']])('POST /boards updating the id %s is 404 unknown board', async (id) => {
    expect((await post('/boards', { ...BOARD, id }).expect(404)).body).toEqual({ error: 'unknown board' });
  });

  it('POST /boards with a non-string id is 400 naming id', async () => {
    const res = await post('/boards', { ...BOARD, id: 7 }).expect(400);
    expect(res.body.error).toContain('id');
  });

  it('POST /boards with name "" is 400 naming name', async () => {
    const res = await post('/boards', { ...BOARD, name: '' }).expect(400);
    expect(res.body.error).toContain('name');
  });

  it('POST /boards/delete removes a board, answers { ok: true }, and a second delete is 404', async () => {
    const created = (await post('/boards', { ...BOARD, name: 'Doomed' }).expect(200)).body;
    expect((await post('/boards/delete', { id: created.id }).expect(200)).body).toEqual({ ok: true });
    expect((await status()).boards.some((b) => b.id === created.id)).toBe(false);
    expect((await post('/boards/delete', { id: created.id }).expect(404)).body).toEqual({ error: 'unknown board' });
  });

  it('POST /boards/delete with {} is 400 naming id', async () => {
    const res = await post('/boards/delete', {}).expect(400);
    expect(res.body.error).toContain('id');
  });

  describe('skills', () => {
    const skillsOnDisk = (): unknown[] => JSON.parse(readFileSync(file, 'utf8')).skills;

    it('POST /skills creates a skill: 200, a minted s_ id, trimmed, read back by GET /api/jira, and the poller is not asked to sweep', async () => {
      const before = searches().length;
      const res = await post('/skills', { name: '  Review  ', prompt: '  Review {key}  ' }).expect(200);
      expect(res.body).toEqual({ id: expect.stringMatching(/^s_[0-9a-f]{8}$/), name: 'Review', prompt: 'Review {key}' });
      expect(skillsOnDisk()).toContainEqual(res.body);
      expect((await status()).skills).toContainEqual(res.body);
      expect(searches().length).toBe(before);
    });

    it('updates a skill it holds, keeping its id, and answers the stored skill', async () => {
      const created = (await post('/skills', SKILL).expect(200)).body;
      const updated = await post('/skills', { id: created.id, name: 'After', prompt: 'New' }).expect(200);
      expect(updated.body).toEqual({ id: created.id, name: 'After', prompt: 'New' });
      expect((await status()).skills.filter((s) => s.id === created.id)).toEqual([updated.body]);
    });

    it.each([['s_0123abcd'], ['x']])('POST /skills updating the id %s is 404 unknown skill', async (id) => {
      expect((await post('/skills', { ...SKILL, id }).expect(404)).body).toEqual({ error: 'unknown skill' });
    });

    it('POST /skills with a non-string id is 400 naming id', async () => {
      expect((await post('/skills', { ...SKILL, id: 7 }).expect(400)).body.error).toContain('id');
    });

    it.each([
      ['empty', ''],
      ['blank', '   '],
      ['61 characters', 'x'.repeat(61)]
    ])('POST /skills with a name that is %s is 400 naming name', async (_label, name) => {
      expect((await post('/skills', { ...SKILL, name }).expect(400)).body.error).toContain('name');
    });

    it.each([
      ['empty', ''],
      ['2 001 characters', 'x'.repeat(2001)]
    ])('POST /skills with a prompt that is %s is 400 naming prompt', async (_label, prompt) => {
      expect((await post('/skills', { ...SKILL, prompt }).expect(400)).body.error).toContain('prompt');
    });

    it('accepts a name of exactly 60 and a prompt of exactly 2 000', async () => {
      const res = await post('/skills', { name: 'x'.repeat(60), prompt: 'y'.repeat(2000) }).expect(200);
      expect(res.body.name).toHaveLength(60);
      expect(res.body.prompt).toHaveLength(2000);
    });

    it('POST /skills/delete removes a skill, answers { ok: true }, and a second delete is 404 unknown skill', async () => {
      const created = (await post('/skills', SKILL).expect(200)).body;
      expect((await post('/skills/delete', { id: created.id }).expect(200)).body).toEqual({ ok: true });
      expect((await status()).skills.some((s) => s.id === created.id)).toBe(false);
      expect((await post('/skills/delete', { id: created.id }).expect(404)).body).toEqual({ error: 'unknown skill' });
    });

    it('POST /skills/delete with {} is 400 naming id', async () => {
      expect((await post('/skills/delete', {}).expect(400)).body.error).toContain('id');
    });

    it('a board id sent to /skills/delete is 404 unknown skill, and the board survives', async () => {
      const board = (await post('/boards', BOARD).expect(200)).body;
      expect((await post('/skills/delete', { id: board.id }).expect(404)).body).toEqual({ error: 'unknown skill' });
      expect((await status()).boards.some((b) => b.id === board.id)).toBe(true);
    });
  });

  it('POST /repos stores one spelling, and an empty list removes the key', async () => {
    const res = await post('/repos', { project: 'PAY', paths: ['~/x/'] }).expect(200);
    expect(res.body).toEqual({ project: 'PAY', paths: [`${homedir()}/x`] });
    expect((await status()).repos).toEqual({ PAY: [`${homedir()}/x`] });
    expect((await post('/repos', { project: 'PAY', paths: [] }).expect(200)).body).toEqual({ project: 'PAY', paths: [] });
    expect((await status()).repos).not.toHaveProperty('PAY');
  });

  describe('POST /repo-defaults', () => {
    const MAPPED = '/work/pay';
    const defaults = (path: string, base: string | null, namePattern: string | null) => post('/repo-defaults', { path, base, namePattern });
    const stored = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

    beforeAll(async () => {
      await post('/repos', { project: 'PAY', paths: [MAPPED] }).expect(200);
    });

    it('echoes the path normalised and the values as stored, null for unset, and the status payload carries them', async () => {
      const res = await defaults(`${MAPPED}/`, 'develop', null).expect(200);
      expect(res.body).toEqual({ path: MAPPED, base: 'develop', namePattern: null });
      expect(stored().repoDefaults).toEqual({ [MAPPED]: { base: 'develop' } });
      expect((await status()).repoDefaults).toEqual({ [MAPPED]: { base: 'develop' } });
      const both = await defaults(MAPPED, 'release/1', 'feature/{key}-{slug}').expect(200);
      expect(both.body).toEqual({ path: MAPPED, base: 'release/1', namePattern: 'feature/{key}-{slug}' });
      expect((await status()).repoDefaults).toEqual({ [MAPPED]: { base: 'release/1', namePattern: 'feature/{key}-{slug}' } });
    });

    it('both null deletes the path\'s entry, and every other key of the file survives', async () => {
      await defaults(MAPPED, 'develop', null).expect(200);
      expect((await defaults(MAPPED, null, null).expect(200)).body).toEqual({ path: MAPPED, base: null, namePattern: null });
      expect((await status()).repoDefaults).toEqual({});
      expect((await status()).repos).toEqual({ PAY: [MAPPED] });
    });

    it.each([
      ['no path', { base: null, namePattern: null }, 'path is required'],
      ['a blank path', { path: ' ', base: null, namePattern: null }, 'path is required'],
      ['a base that is a number', { path: MAPPED, base: 7, namePattern: null }, 'base must be a string or null'],
      ['a pattern that is a number', { path: MAPPED, base: null, namePattern: 7 }, 'namePattern must be a string or null'],
      ['a base with a space', { path: MAPPED, base: 'a b', namePattern: null }, 'base may hold only A-Z a-z 0-9 . _ / -'],
      ['an empty base', { path: MAPPED, base: '', namePattern: null }, 'base is empty'],
      ['a pattern with no key', { path: MAPPED, base: null, namePattern: '{slug}' }, 'namePattern renders as sample-slug, which does not carry ABC-1']
    ])('400 for %s: %j', async (_label, body, error) => {
      expect((await post('/repo-defaults', body).expect(400)).body).toEqual({ error });
    });

    it('400 <path> is not mapped for a path in no project\'s list, and writes nothing', async () => {
      const before = readFileSync(file, 'utf8');
      expect((await defaults('/work/elsewhere', 'develop', null).expect(400)).body).toEqual({ error: '/work/elsewhere is not mapped' });
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('does not check that the base exists — it may live only on origin', async () => {
      await defaults(MAPPED, 'only-on-origin', null).expect(200);
    });
  });

  it('POST /repos with an unnormalised path is 400', async () => {
    const res = await post('/repos', { project: 'PAY', paths: ['/a/../b'] }).expect(400);
    expect(res.body.error).toContain('/a/../b');
  });
});

describe('configured, the boot unanswered (Review Focus 1)', () => {
  beforeAll(async () => {
    prepare('boot-down');
    fake.failNext = (call) => (call.url.endsWith('/myself') ? 'transport' : null);
    await build();
  });
  afterAll(() => app.close());

  it('a save answers 200 with the board, which reads polledAt: null, rather than hanging or answering 503', async () => {
    const res = await post('/boards', BOARD).expect(200);
    const board = (await status()).boards.find((b) => b.id === res.body.id);
    expect(board).toMatchObject({ name: 'Payments', polledAt: null });
  });
});

describe('configured, access unauthorized (§8)', () => {
  beforeAll(async () => {
    prepare('unauthorized');
    fake.unauthorized = true;
    await build();
  });
  afterAll(() => app.close());

  it('config writes stay open: a board create is still 200', async () => {
    const res = await post('/boards', BOARD).expect(200);
    expect(res.body.id).toMatch(/^b_[0-9a-f]{8}$/);
    expect((await status()).access).toBe('unauthorized');
  });

  it('and so is a skill create', async () => {
    const res = await post('/skills', SKILL).expect(200);
    expect(res.body.id).toMatch(/^s_[0-9a-f]{8}$/);
  });
});

describe('configured, a jira.json that does not parse (Review Focus 2)', () => {
  const BROKEN = '{ "boards": [';

  beforeAll(async () => {
    prepare('broken', { content: BROKEN });
    await build();
  });
  afterAll(() => app.close());

  it.each([
    ['/boards', BOARD],
    ['/boards/delete', { id: 'b_0123abcd' }],
    ['/repos', { project: 'PAY', paths: ['/a/b'] }],
    ['/repo-defaults', { path: '/a/b', base: 'develop', namePattern: null }],
    ['/skills', SKILL],
    ['/skills', { ...SKILL, id: 's_0123abcd' }],
    ['/skills/delete', { id: 's_0123abcd' }]
  ])('POST %s is 409, names jira.json and says nothing was written, and leaves the file byte-identical', async (path, body) => {
    const res = await post(path, body).expect(409);
    expect(res.body.error).toContain('jira.json');
    expect(res.body.error).toContain('nothing was written');
    expect(readFileSync(file, 'utf8')).toBe(BROKEN);
  });

  it('POST /repo-defaults for an unmapped path is 409 too, not 400 — the file cannot say what is mapped', async () => {
    const res = await post('/repo-defaults', { path: '/never/mapped', base: null, namePattern: null }).expect(409);
    expect(res.body.error).toMatch(/^settings\/jira\.json does not parse as JSON .* nothing was written$/);
    expect(readFileSync(file, 'utf8')).toBe(BROKEN);
  });
});
