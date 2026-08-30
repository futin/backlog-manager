import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ItemsModule } from '../server/src/items/items.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';
import type { BacklogItem, ItemsIndex, ProjectSummary } from '../shared/types';

describe('GET /api/items and /api/projects', () => {
  let app: INestApplication;

  const alpha = makeProject('alpha', [
    { leaf: 'bugs/open', filename: 'bug-1-it-breaks.md',
      content: item('bug-1', 'it breaks', '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n') },
    { leaf: 'bugs/open', filename: 'bug-2-groomed.md',
      content: item('bug-2', 'groomed bug', '## Symptom\n\nx\n\n## Cause\n\noff by one\n\n## Fix\n\nuse <=\n') },
    { leaf: 'tasks/open', filename: 'task-1-build-it.md',
      content: item('task-1', 'build it', '## Goal\n\ng\n\n## Plan\n\n1. step\n', 'tags: ui, board\n') },
    { leaf: 'bugs/open', filename: 'bug-3-in-progress.md',
      content: item('bug-3', 'someone is on it', '## Symptom\n\nx\n\n## Cause\n\nc\n\n## Fix\n\nf\n', 'started: 2026-08-28T14:03:07Z\n') },
    // The shape `start` wrote before it stamped a time. Nothing rewrites an
    // existing item's frontmatter, so this is on disk permanently and the
    // scanner has to keep surfacing it — the client is what knows a bare date
    // can only be aged in days.
    { leaf: 'bugs/open', filename: 'bug-4-legacy-start.md',
      content: item('bug-4', 'started the old way', '## Symptom\n\nx\n\n## Cause\n\nc\n\n## Fix\n\nf\n', 'started: 2026-08-24\n') },
    // Task 4 fixtures: every new key present at once — proves the scan still
    // parses, still derives section/status from the directory, and doesn't
    // add itself to errors[].
    { leaf: 'bugs/open', filename: 'bug-5-live-groom.md',
      content: item('bug-5', 'mid groom', '## Symptom\n\nx\n\n## Cause\n\nc\n\n## Fix\n\nf\n',
        'phase: groom\nupdated: 2026-08-30T12:00:00Z\ngroom-elapsed: 90\nexecute-elapsed: 7\n') },
    // execute-elapsed present without groom-elapsed: the two buckets are
    // independent counters, not a shared one that both keys feed.
    { leaf: 'bugs/open', filename: 'bug-6-live-execute.md',
      content: item('bug-6', 'mid execute', '## Symptom\n\nx\n\n## Cause\n\nc\n\n## Fix\n\nf\n',
        'phase: execute\nexecute-elapsed: 7\n') },
    // An unrecognised phase and a negative elapsed value, both only reachable
    // by hand-editing the file — the CLI never writes either.
    { leaf: 'bugs/open', filename: 'bug-7-bad-values.md',
      content: item('bug-7', 'hand-edited', '## Symptom\n\nx\n\n## Cause\n\nc\n\n## Fix\n\nf\n',
        'phase: wat\ngroom-elapsed: -5\n') },
    { leaf: 'tasks/done', filename: 'task-2-shipped.md',
      content: item('task-2', 'shipped', '## Goal\n\ng\n\n## Plan\n\ndone\n') },
    { leaf: 'out-of-scope', filename: 'oos-1-nope.md',
      content: item('oos-1', 'nope', '## What was proposed\n\nx\n\n## Why rejected\n\ny\n') },
    { leaf: 'ideas/open', filename: 'idea-1-broken.md', content: 'no frontmatter at all\n' }
  ]);
  const beta = makeProject('beta', [
    { leaf: 'ideas/open', filename: 'idea-1-someday.md',
      content: item('idea-1', 'someday', '## Problem\n\np\n') }
  ]);

  beforeAll(async () => {
    const registry = makeRegistry([
      { name: 'alpha', path: alpha },
      { name: 'beta', path: beta },
      { name: 'ghost', path: '/nowhere/ghost' }
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(registry)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('indexes every readable item across projects with derived fields', async () => {
    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    const index = res.body as ItemsIndex;
    const byId = new Map(index.items.map((i) => [`${i.project}/${i.id}`, i]));

    expect(byId.size).toBe(11);
    const bug1 = byId.get('alpha/bug-1') as BacklogItem;
    expect(bug1.section).toBe('bugs');
    expect(bug1.status).toBe('open');
    expect(bug1.groomed).toBe(false);
    expect((byId.get('alpha/bug-2') as BacklogItem).groomed).toBe(true);
    const task1 = byId.get('alpha/task-1') as BacklogItem;
    expect(task1.tags).toEqual(['ui', 'board']);
    expect(task1.groomed).toBe(true);
    expect((byId.get('alpha/task-2') as BacklogItem).status).toBe('done');
    const oos = byId.get('alpha/oos-1') as BacklogItem;
    expect(oos.status).toBe('terminal');
    expect(oos.groomed).toBeNull();
    expect((byId.get('beta/idea-1') as BacklogItem).projectPath).toBe(beta);
  });

  it('reports the malformed file in errors[] and still returns the rest', async () => {
    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    const index = res.body as ItemsIndex;
    expect(index.errors).toHaveLength(1);
    expect(index.errors[0]).toContain('idea-1-broken.md');
  });

  it('summarises projects with open counts and flags missing ones', async () => {
    const res = await request(app.getHttpServer()).get('/api/projects').expect(200);
    const projects = res.body as ProjectSummary[];
    const byName = new Map(projects.map((p) => [p.name, p]));

    expect(byName.size).toBe(3);
    const a = byName.get('alpha') as ProjectSummary;
    expect(a.missing).toBe(false);
    // done task-2 is not counted; the malformed idea is not an item
    expect(a.counts).toEqual({ bugs: 7, ideas: 0, tasks: 1, 'out-of-scope': 1 });
    const ghost = byName.get('ghost') as ProjectSummary;
    expect(ghost.missing).toBe(true);
    expect(ghost.counts).toEqual({ bugs: 0, ideas: 0, tasks: 0, 'out-of-scope': 0 });
  });

  // `started` is stored, not derived — the scanner's job is only to surface it
  // verbatim, leaving "is this actually in progress" (which also depends on the
  // item still being open) to the client. Absent means '', matching how a
  // missing `created` is reported, so no consumer has to handle undefined.
  it('surfaces started verbatim in either shape, and empty for an item nobody has picked up', async () => {
    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    const byId = new Map((res.body as ItemsIndex).items.map((i) => [`${i.project}/${i.id}`, i]));

    // Verbatim means the timestamp arrives with its seconds intact: the client
    // reads this down to the minute, so anything truncated here is information
    // it cannot get back.
    expect((byId.get('alpha/bug-3') as BacklogItem).started).toBe('2026-08-28T14:03:07Z');
    expect((byId.get('alpha/bug-4') as BacklogItem).started).toBe('2026-08-24');
    expect((byId.get('alpha/bug-1') as BacklogItem).started).toBe('');
  });

  // phase, updated, and the two elapsed buckets, wired end to end from
  // kebab-case frontmatter through the scan to the API response. Exhaustive
  // clamping behaviour (what "-5", "1.5", "abc", or "wat" become) is
  // unit-tested directly against clampPhase/parseElapsed in parse.test.ts;
  // this is the proof the scan actually reads the right kebab keys into the
  // right camelCase fields, and that a bad value clamps instead of 500ing
  // the whole index or dropping the item.
  it('surfaces phase, updated, and the elapsed buckets, clamping bad values instead of erroring', async () => {
    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    const index = res.body as ItemsIndex;
    const byId = new Map(index.items.map((i) => [`${i.project}/${i.id}`, i]));

    // Nobody has touched bug-1: every new field sits at its absent-default.
    const bug1 = byId.get('alpha/bug-1') as BacklogItem;
    expect(bug1.phase).toBe('');
    expect(bug1.updated).toBe('');
    expect(bug1.groomElapsed).toBe(0);
    expect(bug1.executeElapsed).toBe(0);

    // Every new key present at once: still parses, still bugs/open, groomed
    // still derives from the body — none of it lands in errors[] (asserted
    // below).
    const bug5 = byId.get('alpha/bug-5') as BacklogItem;
    expect(bug5.phase).toBe('groom');
    expect(bug5.updated).toBe('2026-08-30T12:00:00Z');
    expect(bug5.groomElapsed).toBe(90);
    expect(bug5.executeElapsed).toBe(7);
    expect(bug5.section).toBe('bugs');
    expect(bug5.status).toBe('open');
    expect(bug5.groomed).toBe(true);

    // execute-elapsed present without groom-elapsed: the buckets don't share
    // a counter — the absent one still reads 0, not the other's value.
    const bug6 = byId.get('alpha/bug-6') as BacklogItem;
    expect(bug6.phase).toBe('execute');
    expect(bug6.executeElapsed).toBe(7);
    expect(bug6.groomElapsed).toBe(0);

    // An unrecognised phase and a negative elapsed value both clamp to their
    // empty/zero default rather than erroring the whole index.
    const bug7 = byId.get('alpha/bug-7') as BacklogItem;
    expect(bug7.phase).toBe('');
    expect(bug7.groomElapsed).toBe(0);

    // Still only the one pre-existing malformed file (idea-1-broken.md) —
    // none of the new fixtures above added themselves to errors[].
    expect(index.errors).toHaveLength(1);
  });

  it('serves an item body as text/plain with the frontmatter stripped', async () => {
    const items = (await request(app.getHttpServer()).get('/api/items').expect(200)).body as ItemsIndex;
    const bug = items.items.find((i) => i.id === 'bug-2' && i.project === 'alpha') as BacklogItem;
    const res = await request(app.getHttpServer())
      .get('/api/items/body')
      .query({ path: bug.path })
      .expect(200)
      .expect('content-type', /text\/plain/);
    expect(res.text).toContain('## Cause');
    expect(res.text).not.toContain('id: bug-2');
  });

  it('404s a path outside every registered store, and a missing param', async () => {
    await request(app.getHttpServer()).get('/api/items/body').query({ path: '/etc/hosts' }).expect(404);
    await request(app.getHttpServer()).get('/api/items/body').expect(404);
  });
});

describe('malformed registry entries and unreadable item paths', () => {
  let app: INestApplication;

  // A directory whose name ends in .md, sitting inside a registered store.
  // It clears the allowlist and the .md check, and readFileSync then throws
  // EISDIR — which used to escape ItemsService.body() as a 500 with a stack
  // trace, telling the caller the path IS inside an allowlisted store.
  const gamma = makeProject('gamma', [
    { leaf: 'bugs/open', filename: 'bug-1-real.md',
      content: item('bug-1', 'real', '## Symptom\n\nx\n') }
  ]);
  const dirNamedMd = join(gamma, 'backlog', 'bugs', 'open', 'not-a-file.md');

  beforeAll(async () => {
    mkdirSync(dirNamedMd, { recursive: true });

    // Hand-edited registry: backlog.mjs never writes this, but the file is
    // plain JSON in $HOME and the board's contract is an empty board, not a
    // 500, for anything it cannot make sense of.
    const dir = mkdtempSync(join(tmpdir(), 'bm-badreg-'));
    const registry = join(dir, 'registry.json');
    writeFileSync(registry, JSON.stringify({
      projects: [
        { name: 1, path: 2 },
        { name: 'gamma', path: gamma, createdAt: '2026-08-26T00:00:00.000Z' }
      ]
    }));

    const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(registry)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the well-formed projects and drops the mis-shaped entry — never a 500', async () => {
    const items = (await request(app.getHttpServer()).get('/api/items').expect(200)).body as ItemsIndex;
    expect(items.items.map((i) => i.id)).toEqual(['bug-1']);
    const projects = (await request(app.getHttpServer()).get('/api/projects').expect(200)).body as ProjectSummary[];
    expect(projects.map((p) => p.name)).toEqual(['gamma']);
  });

  it('404s a directory named *.md inside a registered store, not a 500', async () => {
    await request(app.getHttpServer()).get('/api/items/body').query({ path: dirNamedMd }).expect(404);
  });
});
