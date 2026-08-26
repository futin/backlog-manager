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

    expect(byId.size).toBe(6);
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
    expect(a.counts).toEqual({ bugs: 2, ideas: 0, tasks: 1, 'out-of-scope': 1 });
    const ghost = byName.get('ghost') as ProjectSummary;
    expect(ghost.missing).toBe(true);
    expect(ghost.counts).toEqual({ bugs: 0, ideas: 0, tasks: 0, 'out-of-scope': 0 });
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
