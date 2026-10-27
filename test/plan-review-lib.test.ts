import { planApprovePrompt, planReviewReading, planReviewTally, planReviewTitle } from '../client/src/lib/plan-review';
import type { PlanReviewTally } from '../client/src/lib/plan-review';
import type { BacklogItem, TickProject } from '../shared/types';

/**
 * #367 — `lib/plan-review.ts`, the band chip's arithmetic and the files item's approval prompt. Three projects: a-proj at its cap (blocked), b-proj under
 * it, c-proj with no tick record (no cap known).
 */
function item(projectPath: string, project: string, id: string, over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id,
    title: id,
    created: '2026-10-01',
    tags: [],
    updated: '',
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    section: 'tasks',
    status: 'open',
    project,
    projectPath,
    groomed: true,
    started: '',
    path: `${projectPath}/backlog/tasks/open/${id}.md`,
    source: 'files',
    url: null,
    assignee: null,
    untyped: false,
    planReview: true,
    ...over
  };
}
function tick(root: string, name: string, maxPlans: number): TickProject {
  return {
    root,
    name,
    lock: null,
    recent: [],
    lastDecide: { at: '2026-10-27T09:00:00.000Z', verdict: 'idle', caps: { openPrs: 1, maxPrs: 3, planReview: 0, maxPlans } }
  };
}

const A = '/abs/a-proj';
const B = '/abs/b-proj';
const C = '/abs/c-proj';
const ITEMS: BacklogItem[] = [
  item(B, 'b-proj', 'task-1'),
  item(A, 'a-proj', 'task-1'),
  item(A, 'a-proj', 'task-2'),
  item(C, 'c-proj', 'task-1'),
  // Never counted: no mark, a mark on a closed item, an unmarked item in a project with marks.
  item(A, 'a-proj', 'task-3', { planReview: undefined }),
  item(A, 'a-proj', 'task-4', { status: 'done' }),
  item(B, 'b-proj', 'task-5', { status: 'terminal' })
];
const TICKS: TickProject[] = [tick(A, 'a-proj', 2), tick(B, 'b-proj', 3)];

describe('planReviewTally', () => {
  it('counts open marked items per project, caps from the tick row of the same root, sorted by name', () => {
    expect(planReviewTally(ITEMS, TICKS)).toEqual([
      { projectPath: A, name: 'a-proj', count: 2, cap: 2, blocked: true },
      { projectPath: B, name: 'b-proj', count: 1, cap: 3, blocked: false },
      { projectPath: C, name: 'c-proj', count: 1, cap: null, blocked: false }
    ]);
  });

  it('draws no entry for a project with nothing marked, whatever its tick recorded', () => {
    expect(planReviewTally([item(B, 'b-proj', 'task-1')], TICKS).map((t) => t.projectPath)).toEqual([B]);
  });

  it('matches a tick by root, never by name', () => {
    expect(planReviewTally([item(A, 'a-proj', 'task-1')], [tick('/elsewhere/a-proj', 'a-proj', 1)])[0]).toMatchObject({ cap: null, blocked: false });
  });

  it('reads a tick with no lastDecide as no cap', () => {
    expect(planReviewTally([item(A, 'a-proj', 'task-1')], [{ root: A, name: 'a-proj', lock: null, recent: [] }])[0].cap).toBeNull();
  });

  it('is empty for no items', () => {
    expect(planReviewTally([], TICKS)).toEqual([]);
  });
});

describe('planReviewReading', () => {
  const tallies = planReviewTally(ITEMS, TICKS);

  it('one project at its cap: count/cap and tick blocked', () => {
    expect(planReviewReading(tallies, A)).toBe('2/2 plans awaiting review · tick blocked');
  });
  it('one project under its cap: count/cap, singular at one', () => {
    expect(planReviewReading(tallies, B)).toBe('1/3 plan awaiting review');
  });
  it('one project with no cap known: the bare count', () => {
    expect(planReviewReading(tallies, C)).toBe('1 plan awaiting review');
  });
  it('one project with nothing marked: null', () => {
    expect(planReviewReading(tallies, '/abs/d-proj')).toBeNull();
  });
  it('all projects: the summed count and the blocked names', () => {
    expect(planReviewReading(tallies, null)).toBe('4 plans awaiting review · tick blocked in a-proj');
  });
  it('all projects, none blocked: the count alone', () => {
    expect(planReviewReading(tallies.filter((t) => !t.blocked), null)).toBe('2 plans awaiting review');
  });
  it('all projects, every blocked one named in order', () => {
    const both: PlanReviewTally[] = tallies.map((t) => ({ ...t, blocked: t.projectPath !== C }));
    expect(planReviewReading(both, null)).toBe('4 plans awaiting review · tick blocked in a-proj, b-proj');
  });
  it('all projects, no tallies: null', () => {
    expect(planReviewReading([], null)).toBeNull();
  });
});

describe('planReviewTitle', () => {
  it('one line per project, count/cap or the bare count', () => {
    expect(planReviewTitle(planReviewTally(ITEMS, TICKS))).toBe('a-proj: 2/2\nb-proj: 1/3\nc-proj: 1');
  });
});

describe('planApprovePrompt', () => {
  it('names the item, the project and the item file relative to the project', () => {
    expect(planApprovePrompt(item(A, 'a-proj', 'task-2'))).toBe(
      "Approve the unattended plan on task-2 in /abs/a-proj: delete the plan-review: true line from backlog/tasks/open/task-2.md's frontmatter, then commit it."
    );
  });
  it('keeps an absolute path that is not under the project', () => {
    expect(planApprovePrompt(item(A, 'a-proj', 'task-2', { path: '/other/task-2.md' }))).toMatch(/from \/other\/task-2\.md's frontmatter/);
  });
});
