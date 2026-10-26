import {
  arrangeOrder,
  branchOptions,
  buildStartRequest,
  effectiveMergeMode,
  moveRow,
  orchestrateQueue,
  resolveSelection,
  toggleSelected,
  uncommittedFates,
  withoutIds,
  type StartInputs
} from '../client/src/lib/orchestrate-draft';
import type { BacklogItem } from '../shared/types';

/**
 * #306 — the Orchestrate sheet's derivations, out of its render body and into `lib/orchestrate-draft.ts`. Node env on purpose: the point of the move is that
 * none of these needs a DOM to be tested. The sheet-level behaviour they add up to stays pinned by `test/orchestrator-start-ui.test.tsx` and
 * `test/orchestrate-uncommitted.test.tsx`, unchanged.
 */

function item(over: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'task-1',
    title: 'a task',
    created: '2026-10-01',
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
    section: 'tasks',
    status: 'open',
    project: 'alpha',
    projectPath: '/abs/alpha',
    groomed: true,
    path: '/abs/alpha/backlog/tasks/open/task-1.md',
    source: 'files',
    url: null,
    assignee: null,
    untyped: false,
    ...over
  };
}

const ids = (s: Set<string>): string[] => [...s].sort();

describe('orchestrateQueue', () => {
  it('keeps open bugs and tasks only, each with its action, in input order', () => {
    const rows = orchestrateQueue([
      item({ id: 'idea-1', section: 'ideas', groomed: null, path: '/i1' }),
      item({ id: 'ref-1', section: 'refactors', groomed: null, path: '/r1' }),
      item({ id: 'task-9', section: 'tasks', status: 'done', path: '/t9' }),
      item({ id: 'bug-1', section: 'bugs', groomed: false, path: '/b1' }),
      item({ id: 'task-2', section: 'tasks', groomed: true, path: '/t2' })
    ]);
    expect(rows.map((r) => [r.item.id, r.action])).toEqual([
      ['bug-1', 'groom'],
      ['task-2', 'execute']
    ]);
  });
});

describe('resolveSelection', () => {
  it('reads null as the whole queue, not narrowed', () => {
    const s = resolveSelection(['a', 'b', 'c'], null);
    expect(s.selectedIds).toEqual(['a', 'b', 'c']);
    expect(s.narrowed).toBe(false);
    expect(s.emptySelection).toBe(false);
  });

  it('does not call a full explicit set narrowed — the strict-subset rule', () => {
    expect(resolveSelection(['a', 'b', 'c'], new Set(['a', 'b', 'c'])).narrowed).toBe(false);
  });

  it('calls an empty set over rows an empty selection, and an empty queue not one', () => {
    expect(resolveSelection(['a', 'b', 'c'], new Set()).emptySelection).toBe(true);
    expect(resolveSelection([], new Set()).emptySelection).toBe(false);
  });

  it('ignores an id that has left the queue', () => {
    expect(resolveSelection(['a', 'b'], new Set(['a', 'gone'])).selectedIds).toEqual(['a']);
  });
});

describe('arrangeOrder and moveRow', () => {
  it('reconciles a hand order against the live selection', () => {
    expect(arrangeOrder(null, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(arrangeOrder(['c', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
    expect(arrangeOrder(['c', 'gone', 'a'], ['a', 'c'])).toEqual(['c', 'a']);
  });

  it('moves one row and leaves its input alone', () => {
    const list = ['a', 'b', 'c'];
    expect(moveRow(list, 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveRow(list, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('the selection updaters', () => {
  it('turns "the whole queue" into an explicit set on the first toggle, and back', () => {
    const off = toggleSelected(null, ['a', 'b', 'c'], 'b');
    expect(ids(off)).toEqual(['a', 'c']);
    expect(ids(toggleSelected(off, ['a', 'b', 'c'], 'b'))).toEqual(['a', 'b', 'c']);
  });

  it('removes a list of ids from the whole queue', () => {
    expect(ids(withoutIds(null, ['a', 'b', 'c'], ['b', 'c']))).toEqual(['a']);
  });
});

describe('uncommittedFates', () => {
  const p1 = item({ id: 't1', path: '/p1' });
  const p2 = item({ id: 't2', path: '/p2' });
  const queue = orchestrateQueue([p1, p2]);

  it('flags nothing when the server could not make the read', () => {
    const f = uncommittedFates(queue, { paths: ['/p1', '/p2'], absent: ['/p2'], known: false });
    expect(f.uncommittedIds).toEqual([]);
    expect(f.fateOf('/p1')).toBeNull();
    expect(f.fateOf('/p2')).toBeNull();
  });

  it('splits the flagged rows by fate, ignoring an absent path that is not flagged', () => {
    const f = uncommittedFates(queue, { paths: ['/p1', '/p2'], absent: ['/p2', '/p9'], known: true });
    expect(f.fateOf('/p1')).toBe('stale');
    expect(f.fateOf('/p2')).toBe('absent');
    expect(f.absentCount).toBe(1);
    expect(f.staleCount).toBe(1);
    expect(f.absentCount + f.staleCount).toBe(f.uncommittedIds.length);
  });
});

describe('branchOptions', () => {
  it('unions main in front when the list lacks it, and keeps a list that has it', () => {
    expect(branchOptions({ status: 'ok', value: ['dev'] })).toEqual(['main', 'dev']);
    expect(branchOptions({ status: 'ok', value: ['dev', 'main'] })).toEqual(['dev', 'main']);
  });

  it('offers main alone for anything but an answer', () => {
    expect(branchOptions({ status: 'failed', value: null })).toEqual(['main']);
    expect(branchOptions({ status: 'pending', value: null })).toEqual(['main']);
  });
});

describe('effectiveMergeMode', () => {
  it('lets pr stand only on a github source', () => {
    expect(effectiveMergeMode('pr', 'github', false)).toBe('pr');
    expect(effectiveMergeMode('pr', 'files', false)).toBe('merge');
    expect(effectiveMergeMode('pr', null, false)).toBe('merge');
    expect(effectiveMergeMode('pr', 'unsupported', false)).toBe('merge');
    expect(effectiveMergeMode('branch', 'files', false)).toBe('branch');
  });

  it('forces pr under a remote machine’s lock, whatever was picked', () => {
    expect(effectiveMergeMode('branch', 'files', true)).toBe('pr');
  });
});

describe('buildStartRequest', () => {
  const inputs = (over: Partial<StartInputs> = {}): StartInputs => ({
    project: '/abs/alpha',
    model: '',
    effort: '',
    mergeMode: 'merge',
    machine: {},
    questionMode: 'park',
    base: 'main',
    narrowed: false,
    order: null,
    arranged: ['a', 'b'],
    mode: 'auto',
    ...over
  });

  it('sends no model/effort/ids/machine keys at their defaults, and the four always-sent fields', () => {
    const body = buildStartRequest(inputs());
    expect('model' in body).toBe(false);
    expect('effort' in body).toBe(false);
    expect('ids' in body).toBe(false);
    expect('machine' in body).toBe(false);
    expect(body).toEqual({ project: '/abs/alpha', mergeMode: 'merge', questionMode: 'park', base: 'main', permissionMode: 'auto' });
  });

  it('sends the arranged list once an order exists, even with nothing deselected', () => {
    expect(buildStartRequest(inputs({ order: ['b', 'a'], arranged: ['b', 'a'] })).ids).toEqual(['b', 'a']);
  });

  it('sends ids for a narrowed selection, and a remote machine’s name', () => {
    const body = buildStartRequest(inputs({ narrowed: true, arranged: ['a'], machine: { machine: 'Pro' } }));
    expect(body.ids).toEqual(['a']);
    expect(body.machine).toBe('Pro');
  });
});
