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
});
