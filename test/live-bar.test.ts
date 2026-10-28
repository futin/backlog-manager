import { liveRank } from '../client/src/lib/board-sort';
import { isLiveWork } from '../client/src/lib/item-progress';
import { liveBarFor, liveKind } from '../client/src/lib/live-bar';
import { CLAIM_STALE_MS } from '../shared/types';
import type { BacklogItem, RunStage } from '../shared/types';

/*
 * #376: `liveKind` is the one classification the card's live bar and the column rank both read. Before it, `liveBarFor` (then in ItemCard.tsx) and
 * `liveRank` each tested the stage lists and the item's progress by hand, and `liveRank`'s doc comment claimed the two drew the same set of cards — untrue
 * since #227 drew a bar for a stale claim that ranks 2. The table at the foot pins the relationship as it actually is.
 */

const NOW = Date.parse('2026-10-16T12:00:00Z');

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
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

const staleClaim = (): BacklogItem =>
  fakeItem({
    source: 'github',
    started: '2026-10-15T09:00:00Z',
    holder: { session: 's1', heartbeat: new Date(NOW - CLAIM_STALE_MS - 1000).toISOString() }
  });

const liveClaim = (): BacklogItem =>
  fakeItem({ source: 'github', started: '2026-10-16T11:00:00Z', holder: { session: 's1', heartbeat: new Date(NOW - 1000).toISOString() } });

describe('liveKind', () => {
  it('reads attention for a blocked run, even over a hand stamp', () => {
    expect(liveKind(fakeItem({ started: '2026-10-15T09:00:00Z' }), 'parked', NOW)).toBe('attention');
  });

  it('reads run for a stage the orchestrator is working', () => {
    expect(liveKind(fakeItem(), 'reviewing', NOW)).toBe('run');
  });

  it('reads null for a pending stage on an item nobody has started', () => {
    expect(liveKind(fakeItem(), 'pending', NOW)).toBeNull();
  });

  it('reads stale for a tracker claim past CLAIM_STALE_MS with a clock, and hand without one', () => {
    expect(liveKind(staleClaim(), undefined, NOW)).toBe('stale');
    expect(liveKind(staleClaim(), undefined, null)).toBe('hand');
  });

  it('reads hand for a started files item and for a live tracker claim', () => {
    expect(liveKind(fakeItem({ started: '2026-10-15T09:00:00Z' }), undefined, NOW)).toBe('hand');
    expect(liveKind(liveClaim(), undefined, NOW)).toBe('hand');
  });

  it('reads null for a started item that is already done', () => {
    expect(liveKind(fakeItem({ started: '2026-10-15T09:00:00Z', status: 'done' }), undefined, NOW)).toBeNull();
  });
});

describe('liveRank against liveBarFor', () => {
  const stageAt = { dispatched: '2026-10-16T11:30:00Z' };
  const cases: [string, BacklogItem, RunStage | undefined][] = [
    ['attention', fakeItem({ started: '2026-10-15T09:00:00Z' }), 'needs-answers'],
    ['run', fakeItem(), 'fixing'],
    ['stale', staleClaim(), undefined],
    ['hand (files)', fakeItem({ started: '2026-10-15T09:00:00Z' }), undefined],
    ['hand (live claim)', liveClaim(), undefined],
    ['null (pending)', fakeItem(), 'pending'],
    ['null (done)', fakeItem({ started: '2026-10-15T09:00:00Z', status: 'done' }), undefined],
    ['null (nothing)', fakeItem(), undefined]
  ];

  it('covers every liveKind outcome', () => {
    expect(new Set(cases.map(([, item, stage]) => liveKind(item, stage, NOW)))).toEqual(new Set(['attention', 'run', 'stale', 'hand', null]));
  });

  it.each(cases)('ranks %s live exactly when it draws a bar that is not stale', (_label, item, stage) => {
    const bar = liveBarFor(item, stage === undefined ? undefined : { stage, stageAt }, NOW);
    expect(liveRank(item, stage, NOW) < 2).toBe(bar !== null && bar.tone !== 'stale');
  });
});

/* The item modal reads `isLiveWork`; the board reads `liveKind`. Both answer "is somebody working this" for an item with no run stage, so they must agree
   on every claim — a live one, a stale one, a files stamp — or the modal and the card would describe the same claim two ways. */
describe('isLiveWork against liveKind', () => {
  it.each([
    ['a live tracker claim', liveClaim()],
    ['a stale tracker claim', staleClaim()],
    ['a started files item', fakeItem({ started: '2026-10-15T09:00:00Z' })]
  ])('agrees on %s', (_label, item) => {
    expect(isLiveWork(item, NOW)).toBe(liveKind(item, undefined, NOW) === 'hand');
  });
});
