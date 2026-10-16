import { COMPARATORS, NATURAL_DIR, liveRank, resolveSortKey, sortItems } from '../client/src/lib/board-sort';
import { ACTIVE_RUN_STAGES } from '../client/src/lib/run-stage';
import { CLAIM_STALE_MS } from '../shared/types';
import type { BacklogItem, RunStage } from '../shared/types';

/**
 * The Board's sort pipeline, pinned directly (#258). The render tests in board.test.tsx pin the wiring — stored key, resolved key, track label, order —
 * but a render cannot tell two comparators apart on the few cards a fixture draws, so every piece is called here by name. No jsdom and no clock: every
 * clock-dependent call is handed `NOW`.
 */

const NOW = Date.parse('2026-10-16T12:00:00Z');

function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1',
    title: 'a bug',
    created: '',
    started: '',
    tags: [],
    updated: '',
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    section: 'bugs',
    status: 'open',
    project: 'alpha',
    projectPath: '/abs/alpha',
    groomed: false,
    path: '/abs/alpha/backlog/bugs/open/bug-1-a-bug.md',
    source: 'files',
    url: null,
    assignee: null,
    untyped: false
  };
  return { ...base, ...over };
}

const noStage = (): RunStage | undefined => undefined;
const titles = (items: BacklogItem[]): string[] => items.map((i) => i.title);

describe('resolveSortKey', () => {
  it.each(['created', 'name', 'project'])('keeps the known key %s', (k) => {
    expect(resolveSortKey(k)).toBe(k);
  });

  it('degrades a key a later build might write to created', () => {
    expect(resolveSortKey('newest')).toBe('created');
  });

  // Inherited properties of the record: `COMPARATORS['constructor']` is not undefined, which is why the guard is an own-property test and not `??`.
  it.each(['constructor', 'toString'])('degrades the inherited name %s to created', (k) => {
    expect(resolveSortKey(k)).toBe('created');
  });

  it.each([[42], [{}], [null], [undefined]])('degrades the non-string %p to created', (v) => {
    expect(resolveSortKey(v)).toBe('created');
  });
});

describe('NATURAL_DIR', () => {
  it('is newest first for created and A–Z for the other two', () => {
    expect(NATURAL_DIR).toEqual({ created: 'desc', name: 'asc', project: 'asc' });
  });
});

describe('COMPARATORS', () => {
  it('name orders by title, and the sign turns it over', () => {
    const apple = fakeItem({ title: 'apple' });
    const banana = fakeItem({ title: 'banana' });
    expect(COMPARATORS.name(apple, banana, 1)).toBeLessThan(0);
    expect(COMPARATORS.name(apple, banana, -1)).toBeGreaterThan(0);
  });

  it('created orders by the stamp ascending under sign 1', () => {
    expect(COMPARATORS.created(fakeItem({ created: '2026-10-01' }), fakeItem({ created: '2026-10-02' }), 1)).toBeLessThan(0);
  });

  it('created sorts a timestamp after the bare date of its own day', () => {
    expect(COMPARATORS.created(fakeItem({ created: '2026-10-01T08:00:00Z' }), fakeItem({ created: '2026-10-01' }), 1)).toBeGreaterThan(0);
  });

  // The sign reaches the project key only: a negated result would flip the tie-break with it, and `Project (desc)` would read oldest first per project.
  it.each([1, -1] as const)('project breaks ties newest first whatever the sign (%p)', (sign) => {
    const p1 = fakeItem({ project: '/a', created: '2026-10-01' });
    const p2 = fakeItem({ project: '/a', created: '2026-10-05' });
    expect(COMPARATORS.project(p2, p1, sign)).toBeLessThan(0);
  });

  it('project under sign -1 puts /b before /a', () => {
    expect(COMPARATORS.project(fakeItem({ project: '/b', created: '2026-10-01' }), fakeItem({ project: '/a', created: '2026-10-09' }), -1)).toBeLessThan(0);
  });
});

describe('liveRank', () => {
  it.each(['needs-answers', 'parked'] as const)('ranks a run blocked at %s first', (stage) => {
    expect(liveRank(fakeItem({}), stage, NOW)).toBe(0);
  });

  it('ranks attention above live when the item is also started', () => {
    expect(liveRank(fakeItem({ started: '2026-10-15' }), 'parked', NOW)).toBe(0);
  });

  it.each(ACTIVE_RUN_STAGES.map((s) => [s]))('ranks a run working it at %s as live', (stage) => {
    expect(liveRank(fakeItem({}), stage, NOW)).toBe(1);
  });

  it.each(['pending', 'preflight', 'merged', undefined] as const)('ranks stage %p on an idle item last', (stage) => {
    expect(liveRank(fakeItem({}), stage, NOW)).toBe(2);
  });

  it('ranks a started open files item as live, aged or not', () => {
    const item = fakeItem({ source: 'files', status: 'open', started: '2026-10-15' });
    expect(liveRank(item, undefined, NOW)).toBe(1);
    expect(liveRank(item, undefined, null)).toBe(1);
  });

  it('ranks a done files item that keeps started: as history last', () => {
    expect(liveRank(fakeItem({ source: 'files', status: 'done', started: '2026-10-15' }), undefined, NOW)).toBe(2);
  });

  it('ranks a stale tracker claim last when aged, live when unaged', () => {
    const heartbeat = new Date(NOW - CLAIM_STALE_MS - 1000).toISOString();
    const item = fakeItem({ source: 'github', status: 'open', started: '2026-10-15', holder: { session: 's1', heartbeat } });
    expect(liveRank(item, undefined, NOW)).toBe(2);
    expect(liveRank(item, undefined, null)).toBe(1);
  });

  it('ranks a fresh tracker claim as live', () => {
    const heartbeat = new Date(NOW - 1000).toISOString();
    const item = fakeItem({ source: 'github', status: 'open', started: '2026-10-15', holder: { session: 's1', heartbeat } });
    expect(liveRank(item, undefined, NOW)).toBe(1);
  });
});

describe('sortItems', () => {
  it('sorts onto a copy and leaves its input alone', () => {
    const input = [fakeItem({ title: 'b' }), fakeItem({ title: 'a' })];
    const before = [...input];
    const out = sortItems(input, 'name', 'asc', noStage, NOW);
    expect(input).toEqual(before);
    input.forEach((item, i) => expect(item).toBe(before[i]));
    expect(out).not.toBe(input);
    expect(titles(out)).toEqual(['a', 'b']);
  });

  it.each(['asc', 'desc'] as const)('keeps live work first under name/%s', (dir) => {
    const items = [fakeItem({ title: 'apple' }), fakeItem({ title: 'zebra', started: '2026-10-15' })];
    expect(titles(sortItems(items, 'name', dir, noStage, NOW))).toEqual(['zebra', 'apple']);
  });

  it('orders by the selected comparator within each rank', () => {
    const items = [
      fakeItem({ title: 'beta', started: '2026-10-15' }),
      fakeItem({ title: 'alpha', started: '2026-10-15' }),
      fakeItem({ title: 'delta' }),
      fakeItem({ title: 'charlie' })
    ];
    expect(titles(sortItems(items, 'name', 'asc', noStage, NOW))).toEqual(['alpha', 'beta', 'charlie', 'delta']);
    expect(titles(sortItems(items, 'name', 'desc', noStage, NOW))).toEqual(['beta', 'alpha', 'delta', 'charlie']);
  });

  it('consults stageFor, so an attention item outranks hand-run work', () => {
    const blocked = fakeItem({ id: 'bug-2', title: 'blocked' });
    const working = fakeItem({ id: 'bug-3', title: 'working', started: '2026-10-15' });
    const stageFor = (i: BacklogItem): RunStage | undefined => (i.id === 'bug-2' ? 'needs-answers' : undefined);
    expect(titles(sortItems([working, blocked], 'name', 'asc', stageFor, NOW))).toEqual(['blocked', 'working']);
  });

  it('orders created/desc newest first', () => {
    const items = ['2026-10-01', '2026-10-10', '2026-10-05'].map((created) => fakeItem({ title: created, created }));
    expect(titles(sortItems(items, 'created', 'desc', noStage, NOW))).toEqual(['2026-10-10', '2026-10-05', '2026-10-01']);
  });

  it('orders project/desc Z→A with each project still newest first', () => {
    const items = [
      fakeItem({ title: 'a-01', project: '/a', created: '2026-10-01' }),
      fakeItem({ title: 'b-01', project: '/b', created: '2026-10-01' }),
      fakeItem({ title: 'a-05', project: '/a', created: '2026-10-05' })
    ];
    expect(titles(sortItems(items, 'project', 'desc', noStage, NOW))).toEqual(['b-01', 'a-05', 'a-01']);
  });
});
