import { checkWidgets } from 'lookout-widgets/testkit';

import { createBacklogHub, openTotal, projectRows, projectSubtitle, runStatus } from '../server/src/hub/hub-widgets';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun, OrchestratorRunsPayload, ProjectSummary, RunStage, SectionCounts } from '../shared/types';

/**
 * The three Lookout hub tiles (#249), fed by fixture getters — no Nest, no disk. The reductions are hit directly; `checkWidgets` from the package's own
 * testkit proves the served shapes satisfy contract v1, and its import is also the proof that `server/src/hub/lookout-widgets.d.ts` resolves under ts-jest.
 */

const fixture = rawFixture as OrchestratorRun;
type LocalRun = OrchestratorRunsPayload['runs'][number];

function project(name: string, counts: Partial<SectionCounts> = {}, over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    name,
    path: `/home/dev/${name}`,
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: false,
    counts: { bugs: 0, tasks: 0, ideas: 0, refactors: 0, 'out-of-scope': 0, ...counts },
    source: 'files',
    repo: null,
    polledAt: null,
    ...over
  } as ProjectSummary;
}

function run(projectPath: string, status: OrchestratorRun['status'], fresh: boolean, stages: RunStage[] = ['merged']): LocalRun {
  return {
    ...fixture,
    project: projectPath,
    status,
    queue: stages.map((stage, i) => ({ ...fixture.queue[0], id: `item-${i}`, stage })),
    fresh,
    pastRuns: 0,
    pauseRequested: false,
    stopRequested: false
  };
}

const payload = (...runs: LocalRun[]): OrchestratorRunsPayload => ({ runs, starting: [] }) as unknown as OrchestratorRunsPayload;

const hub = (projects: ProjectSummary[], runs: OrchestratorRunsPayload) => createBacklogHub({ projects: async () => projects, runs: () => runs });

describe('hub widgets', () => {
  describe('checkWidgets (contract v1, from the package testkit)', () => {
    it('finds nothing wrong with zero projects and no runs', async () => {
      expect(await checkWidgets(hub([], payload()))).toEqual([]);
    });

    it('finds nothing wrong with a mixed fixture and a crashed run', async () => {
      const projects = [
        project('app', { bugs: 2 }),
        project('gone', {}, { missing: true, source: null }),
        project('odd', {}, { source: 'unsupported' })
      ];
      expect(await checkWidgets(hub(projects, payload(run('/home/dev/app', 'running', false))))).toEqual([]);
    });
  });

  it('serves a contract-1 catalog naming backlog-manager, the three widgets in order, and no icon', async () => {
    const reply = await hub([], payload()).handle({ method: 'GET', path: '/api/hub/widgets', query: new URLSearchParams() });
    expect(reply?.status).toBe(200);
    const catalog = reply?.json as { contract: number; app: Record<string, unknown>; widgets: { id: string }[] };
    expect(catalog.contract).toBe(1);
    expect(catalog.app.name).toBe('backlog-manager');
    expect(catalog.app).not.toHaveProperty('icon');
    expect(catalog.widgets.map((w) => w.id)).toEqual(['open-total', 'projects', 'run']);
  });

  describe('open-total', () => {
    it('sums bugs and tasks across projects, ignoring ideas and refactors, and warns on any bug', () => {
      const projects = [project('a', { bugs: 2, tasks: 3, ideas: 4, refactors: 1 }), project('b', { tasks: 1, ideas: 5 })];
      expect(openTotal(projects)).toEqual({ value: 6, caption: '2 bugs · 4 tasks', tone: 'warn' });
    });

    it('is ok with one task and no bugs, singular noun', () => {
      expect(openTotal([project('a', { tasks: 1 })])).toEqual({ value: 1, caption: '0 bugs · 1 task', tone: 'ok' });
    });

    it('is 0 and ok with zero projects', () => {
      expect(openTotal([])).toMatchObject({ value: 0, tone: 'ok' });
    });
  });

  describe('projects', () => {
    it('lists the non-zero open sections in board order', () => {
      expect(projectSubtitle(project('a', { bugs: 2, tasks: 1, ideas: 3, refactors: 0 }))).toBe('2 bugs · 1 task · 3 ideas');
    });

    it('says nothing open when every section is zero', () => {
      expect(projectSubtitle(project('a', { 'out-of-scope': 7 }))).toBe('nothing open');
    });

    it('names a lone refactor in the singular', () => {
      expect(projectSubtitle(project('a', { refactors: 1 }))).toBe('1 refactor');
    });

    it('marks a missing project error and an unsupported one warn, each with its own subtitle', () => {
      const { rows } = projectRows([project('gone', {}, { missing: true, source: null }), project('odd', { bugs: 3 }, { source: 'unsupported' })]);
      expect(rows.map((r) => [r.status, r.subtitle])).toEqual([
        ['error', 'no backlog/ directory'],
        ['warn', 'unsupported source']
      ]);
    });

    it('keys rows by path, so two projects sharing a name stay two rows, and totals the project count', () => {
      const list = projectRows([project('app', {}, { path: '/a/app' }), project('app', {}, { path: '/b/app' }), project('c')]);
      expect(list.rows.map((r) => [r.id, r.title, r.status])).toEqual([
        ['/a/app', 'app', 'ok'],
        ['/b/app', 'app', 'ok'],
        ['/home/dev/c', 'c', 'ok']
      ]);
      expect(list.total).toBe(3);
    });
  });

  describe('run', () => {
    it('is idle / no run with no runs, and carries no detail', () => {
      expect(runStatus(payload())).toEqual({ state: 'idle', label: 'no run' });
    });

    it('treats finished runs as history: done + failed is idle', () => {
      expect(runStatus(payload(run('/p/a', 'done', true), run('/p/b', 'failed', false)))).toEqual({ state: 'idle', label: 'no run' });
    });

    it('is ok / running for a fresh run whose items are all dispatched or merged', () => {
      expect(runStatus(payload(run('/p/a', 'running', true, ['dispatched', 'merged'])))).toEqual({ state: 'ok', label: 'running', detail: 'a' });
    });

    it('is warn / needs a person for a fresh run holding a parked item', () => {
      expect(runStatus(payload(run('/p/a', 'running', true, ['merged', 'parked'])))).toEqual({ state: 'warn', label: 'needs a person', detail: 'a' });
    });

    it('is warn / paused for a paused run', () => {
      expect(runStatus(payload(run('/p/a', 'paused', true)))).toEqual({ state: 'warn', label: 'paused', detail: 'a' });
    });

    it('is error / crashed for a stale running run', () => {
      expect(runStatus(payload(run('/p/a', 'running', false)))).toEqual({ state: 'error', label: 'crashed', detail: 'a' });
    });

    it('lets a crash outrank a pause, and names only the crashed project', () => {
      expect(runStatus(payload(run('/p/a', 'running', false), run('/p/b', 'paused', true)))).toEqual({ state: 'error', label: 'crashed', detail: 'a' });
    });

    it('names both projects when a pause and a parked item tie at warn', () => {
      const r = runStatus(payload(run('/p/a', 'paused', true), run('/p/b', 'running', true, ['needs-answers'])));
      expect(r).toMatchObject({ state: 'warn', detail: 'a, b' });
    });

    it('ignores remote runs: only this machine\'s run files count', () => {
      const p = { ...payload(), remote: [{ project: '/p/far', status: 'running' }] } as unknown as OrchestratorRunsPayload;
      expect(runStatus(p)).toEqual({ state: 'idle', label: 'no run' });
    });
  });
});
