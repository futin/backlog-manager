import { isInProgress } from '../client/src/lib/item-progress';
import type { BacklogItem } from '../shared/types';

/**
 * Small local builder rather than importing board.test.tsx's fakeItem (not
 * exported): only the two fields this predicate reads actually vary per
 * case, so everything else is a fixed, plausible stand-in.
 */
function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1-a-bug.md',
    ...over,
  };
  return base;
}

/**
 * The rule is two conditions, not one: `move` never rewrites an item's
 * content, so an archived file keeps the `started` stamp it had the day it
 * was picked up, as history. Dropping the `status === 'open'` half would make
 * every item ever shipped read as in progress forever — the two cases below
 * that pin `status` to 'done' / 'terminal' are the regression guard for
 * exactly that.
 */
describe('isInProgress', () => {
  it('is true for an open item with a full timestamp', () => {
    expect(isInProgress(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z' }))).toBe(true);
  });

  it('is true for an open item with the permanent bare-date shape', () => {
    expect(isInProgress(fakeItem({ status: 'open', started: '2026-08-26' }))).toBe(true);
  });

  it('is false for an open item nobody has picked up', () => {
    expect(isInProgress(fakeItem({ status: 'open', started: '' }))).toBe(false);
  });

  it('is false for a done item, even though it kept its started stamp as history', () => {
    expect(isInProgress(fakeItem({ status: 'done', started: '2026-08-28T14:03:07Z' }))).toBe(false);
  });

  it('is false for a terminal (rejected) item, same reason', () => {
    expect(isInProgress(fakeItem({ status: 'terminal', started: '2026-08-28T14:03:07Z' }))).toBe(false);
  });
});
