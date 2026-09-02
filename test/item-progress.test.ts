import { isInProgress, progressLabel } from '../client/src/lib/item-progress';
import type { BacklogItem } from '../shared/types';

/**
 * Small local builder rather than importing board.test.tsx's fakeItem (not
 * exported): only the two fields this predicate reads actually vary per
 * case, so everything else is a fixed, plausible stand-in.
 */
function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
    updated: '', lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, kind: '',
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

/**
 * The live bar's words. `phase` names which skill currently holds the item
 * ('groom' or 'execute'); an empty phase is not an error case to special-case
 * away, it is the legitimate reading for an item started before Task 4 added
 * the key at all, so it falls back to the old generic wording rather than
 * rendering nothing.
 *
 * The fourth case is the one worth arguing about and the brief settles it on
 * purpose: a done item can still carry `phase: 'groom'` on disk (`move` never
 * rewrites content, so the key some groom session left behind just sits
 * there as history), and this function does not get to assume its caller
 * always gates on `isInProgress` first. It doesn't here — every caller in
 * this codebase renders the label only behind that gate — but the function's
 * OWN answer for a done item has to be the inert one regardless, because the
 * day a second caller forgets the gate, "in progress" is a fib and
 * "grooming" is a fib that also claims a live session that does not exist.
 */
describe('progressLabel', () => {
  it('reads "grooming" for an open item a groom session currently holds', () => {
    expect(progressLabel(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z', phase: 'groom' })))
      .toBe('grooming');
  });

  it('reads "executing" for an open item an execute session currently holds', () => {
    expect(progressLabel(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z', phase: 'execute' })))
      .toBe('executing');
  });

  it('falls back to "in progress" for an open, started item with no phase recorded', () => {
    expect(progressLabel(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z', phase: '' })))
      .toBe('in progress');
  });

  it('reads "in progress" for a done item, even though it still carries phase: groom as history', () => {
    expect(progressLabel(fakeItem({ status: 'done', started: '2026-08-28T14:03:07Z', phase: 'groom' })))
      .toBe('in progress');
  });
});
