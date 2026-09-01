import { isStale, leavesBoard } from '../client/src/lib/item-stale';
import type { BacklogItem } from '../shared/types';

/**
 * Local builder, same reasoning item-progress.test.ts gives for having its
 * own: only the three fields this predicate reads (`updated`, `created`,
 * `started`, plus `status`/`section` for the board half) actually vary per
 * case, so everything else is a fixed, plausible stand-in.
 */
function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '', started: '', tags: [],
    updated: '', phase: '', groomElapsed: 0, executeElapsed: 0, kind: '',
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1-a-bug.md',
  };
  return { ...base, ...over };
}

const DAY = 24 * 60 * 60 * 1000;
/** A fixed instant, so every case below reads as an exact offset from it. */
const NOW = Date.parse('2026-09-01T12:00:00Z');
const WINDOW = 30;

/** A second-precision UTC stamp `ms` before NOW — the shape `start`/`stop` write. */
const stampAgo = (ms: number): string => `${new Date(NOW - ms).toISOString().slice(0, 19)}Z`;
/** A bare `YYYY-MM-DD` `days` before NOW — the shape older files carry. */
const dateAgo = (days: number): string => new Date(NOW - days * DAY).toISOString().slice(0, 10);

describe('isStale', () => {
  it('is false one second inside the window and true one second outside it', () => {
    const inside = fakeItem({ updated: stampAgo(WINDOW * DAY - 1000) });
    const outside = fakeItem({ updated: stampAgo(WINDOW * DAY + 1000) });
    expect(isStale(inside, WINDOW, NOW)).toBe(false);
    expect(isStale(outside, WINDOW, NOW)).toBe(true);
  });

  it('treats an age of exactly the window as inside it', () => {
    expect(isStale(fakeItem({ updated: stampAgo(WINDOW * DAY) }), WINDOW, NOW)).toBe(false);
  });

  it('falls back to created when there is no updated stamp', () => {
    expect(isStale(fakeItem({ created: dateAgo(90) }), WINDOW, NOW)).toBe(true);
    expect(isStale(fakeItem({ created: dateAgo(3) }), WINDOW, NOW)).toBe(false);
  });

  it('reads updated, not created, when both are present', () => {
    const item = fakeItem({ created: dateAgo(900), updated: stampAgo(2 * DAY) });
    expect(isStale(item, WINDOW, NOW)).toBe(false);
  });

  it('treats an item with neither stamp as fresh', () => {
    expect(isStale(fakeItem({}), WINDOW, NOW)).toBe(false);
  });

  it('treats an unparseable stamp as fresh', () => {
    expect(isStale(fakeItem({ updated: 'whenever' }), WINDOW, NOW)).toBe(false);
    expect(isStale(fakeItem({ created: 'whenever' }), WINDOW, NOW)).toBe(false);
  });

  it('ages a bare YYYY-MM-DD in whole days', () => {
    // Exactly `WINDOW` whole days old, plus the twelve hours since UTC
    // midnight. The ms age is past the window; the day-level age is not, and
    // the day-level answer is the one a bare date can actually support.
    expect(isStale(fakeItem({ updated: dateAgo(WINDOW) }), WINDOW, NOW)).toBe(false);
    expect(isStale(fakeItem({ updated: dateAgo(WINDOW + 1) }), WINDOW, NOW)).toBe(true);
  });

  it('is false for an in-progress item however old its stamp', () => {
    const item = fakeItem({ updated: stampAgo(900 * DAY), started: stampAgo(2 * 60 * 1000) });
    expect(isStale(item, WINDOW, NOW)).toBe(false);
  });

  it('is false for a done item, and for a rejected one', () => {
    const old = { updated: stampAgo(900 * DAY) };
    expect(isStale(fakeItem({ ...old, status: 'done' }), WINDOW, NOW)).toBe(false);
    expect(isStale(fakeItem({ ...old, status: 'terminal', section: 'out-of-scope' }), WINDOW, NOW))
      .toBe(false);
  });

  it('is false for a future stamp', () => {
    expect(isStale(fakeItem({ updated: stampAgo(-5 * DAY) }), WINDOW, NOW)).toBe(false);
  });
});

describe('leavesBoard', () => {
  const stale = { updated: stampAgo(90 * DAY) };

  it('evicts a stale refactor, idea and bug', () => {
    for (const section of ['refactors', 'ideas', 'bugs'] as const) {
      expect(leavesBoard(fakeItem({ ...stale, section }), WINDOW, NOW)).toBe(true);
    }
  });

  it('never evicts a task, however stale', () => {
    expect(leavesBoard(fakeItem({ ...stale, id: 'task-1', section: 'tasks' }), WINDOW, NOW))
      .toBe(false);
  });

  it('never evicts a fresh item', () => {
    expect(leavesBoard(fakeItem({ updated: stampAgo(2 * DAY), section: 'ideas' }), WINDOW, NOW))
      .toBe(false);
  });

  it('never evicts an in-progress item with a stale stamp', () => {
    const item = fakeItem({ ...stale, section: 'ideas', started: stampAgo(60 * 1000) });
    expect(leavesBoard(item, WINDOW, NOW)).toBe(false);
  });
});
