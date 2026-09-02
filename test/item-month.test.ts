import { UNDATED, groupByMonth, monthKey, monthLabel } from '../client/src/lib/item-month';
import type { BacklogItem } from '../shared/types';

/**
 * Literal dates throughout, unlike the component suites' clock-relative
 * fixtures: nothing here compares against `now`. `monthKey` reads a stamp and
 * `groupByMonth` orders stamps against each other, so a fixed August is still
 * August next year and a relative one would only make the expectations harder
 * to read.
 */
function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'bug-1', title: 'a bug', created: '2026-03-01', started: '', updated: '',
    lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, kind: '', tags: [],
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1.md',
    ...over
  };
}

describe('monthKey', () => {
  it('prefers updated over created — the same precedence isStale reads', () => {
    // The two must agree: an item is in Archive BECAUSE of `updated`, so
    // grouping it by `created` would order a column on a number nobody used to
    // decide the column's contents.
    expect(monthKey(fakeItem({ created: '2026-03-01', updated: '2026-08-15T09:12:00Z' })))
      .toBe('2026-08');
  });

  it('falls back to created when updated is empty', () => {
    expect(monthKey(fakeItem({ created: '2026-03-01', updated: '' }))).toBe('2026-03');
  });

  it('groups by lastCommit when updated is absent', () => {
    // Same precedence as isStale, so a column ordered by month matches the
    // dates that decided which items are in it.
    expect(monthKey(fakeItem({ created: '2026-03-01', lastCommit: '2026-08-28T17:02:39+02:00' })))
      .toBe('2026-08');
  });

  it('reads a bare YYYY-MM-DD updated as well as a timestamp', () => {
    // The permanent two-shape fork: files stamped before `start`/`stop` wrote
    // timestamps carry a bare date forever.
    expect(monthKey(fakeItem({ updated: '2026-11-02' }))).toBe('2026-11');
    expect(monthKey(fakeItem({ updated: '2026-11-02T23:59:59Z' }))).toBe('2026-11');
  });

  it('pins a bare date to UTC, so a month boundary reads the same everywhere', () => {
    // Without the T00:00:00Z suffix this is parsed in local time, and west of
    // Greenwich `2026-09-01` becomes 31 August — the item groups under the
    // previous month on one machine and the correct one on another.
    expect(monthKey(fakeItem({ updated: '2026-09-01' }))).toBe('2026-09');
  });

  it('is UNDATED when neither stamp is usable', () => {
    expect(monthKey(fakeItem({ created: '', updated: '' }))).toBe(UNDATED);
    expect(monthKey(fakeItem({ created: '', updated: 'not-a-date' }))).toBe(UNDATED);
  });
});

describe('monthLabel', () => {
  it('names the month and always the year', () => {
    expect(monthLabel('2026-08')).toBe('aug 2026');
    expect(monthLabel('2026-01')).toBe('jan 2026');
    expect(monthLabel('2026-12')).toBe('dec 2026');
  });

  it('keeps the year even for the current one, so two Augusts read as two groups', () => {
    // formatCreated drops a current-year date's year as noise; a heading cannot
    // afford to, because separating adjacent groups is its entire job.
    expect(monthLabel('2026-08')).not.toBe(monthLabel('2025-08'));
  });

  it('labels the undated group', () => {
    expect(monthLabel(UNDATED)).toBe('undated');
  });
});

describe('groupByMonth', () => {
  it('orders groups newest month first', () => {
    const groups = groupByMonth([
      fakeItem({ id: 'bug-1', updated: '2026-06-10' }),
      fakeItem({ id: 'bug-2', updated: '2026-08-10' }),
      fakeItem({ id: 'bug-3', updated: '2026-07-10' })
    ]);
    expect(groups.map((g) => g.key)).toEqual(['2026-08', '2026-07', '2026-06']);
    expect(groups.map((g) => g.label)).toEqual(['aug 2026', 'jul 2026', 'jun 2026']);
  });

  it('puts the undated group last, though its key sorts first as a string', () => {
    // '' < '2026-06' lexicographically, so a plain descending sort would put the
    // items nobody can date above everything anyone can.
    const groups = groupByMonth([
      fakeItem({ id: 'bug-9', created: '', updated: '' }),
      fakeItem({ id: 'bug-1', updated: '2026-06-10' })
    ]);
    expect(groups.map((g) => g.key)).toEqual(['2026-06', UNDATED]);
  });

  it('orders a group newest-touched first', () => {
    const groups = groupByMonth([
      fakeItem({ id: 'bug-1', updated: '2026-08-02T10:00:00Z' }),
      fakeItem({ id: 'bug-2', updated: '2026-08-20T10:00:00Z' }),
      fakeItem({ id: 'bug-3', updated: '2026-08-11T10:00:00Z' })
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(['bug-2', 'bug-3', 'bug-1']);
  });

  it('breaks a stamp tie on id, so an undated group has a defined order', () => {
    // Every member of the undated group ties by construction. Without the
    // tie-break its order is whatever the fetch happened to return, which
    // changes under the reader for no visible reason.
    const groups = groupByMonth([
      fakeItem({ id: 'bug-3', created: '', updated: '' }),
      fakeItem({ id: 'bug-1', created: '', updated: '' }),
      fakeItem({ id: 'bug-2', created: '', updated: '' })
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(['bug-1', 'bug-2', 'bug-3']);
  });

  it('groups two Augusts a year apart separately', () => {
    const groups = groupByMonth([
      fakeItem({ id: 'bug-1', updated: '2025-08-10' }),
      fakeItem({ id: 'bug-2', updated: '2026-08-10' })
    ]);
    expect(groups.map((g) => g.label)).toEqual(['aug 2026', 'aug 2025']);
  });

  it('returns nothing for nothing', () => {
    expect(groupByMonth([])).toEqual([]);
  });

  it('never mutates the array it was handed', () => {
    // The array belongs to the fetched index — the same discipline sortItems
    // keeps in BoardView.
    const items = [
      fakeItem({ id: 'bug-1', updated: '2026-06-10' }),
      fakeItem({ id: 'bug-2', updated: '2026-08-10' })
    ];
    groupByMonth(items);
    expect(items.map((i) => i.id)).toEqual(['bug-1', 'bug-2']);
  });
});
