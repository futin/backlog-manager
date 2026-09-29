import { isInProgress, isLiveWork, progressBlock, progressLabel } from '../client/src/lib/item-progress';
import { CLAIM_STALE_MS } from '../shared/types';
import type { BacklogItem, ItemHolder } from '../shared/types';

const NOW = Date.parse('2026-08-28T15:00:00Z');

/**
 * Small local builder rather than importing board.test.tsx's fakeItem (not
 * exported): only the two fields this predicate reads actually vary per
 * case, so everything else is a fixed, plausible stand-in.
 */
function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1',
    title: 'a bug',
    created: '2026-08-20',
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
    untyped: false,
    ...over
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
    expect(progressLabel(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z', phase: 'groom' }))).toBe('grooming');
  });

  it('reads "executing" for an open item an execute session currently holds', () => {
    expect(progressLabel(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z', phase: 'execute' }))).toBe('executing');
  });

  it('falls back to "in progress" for an open, started item with no phase recorded', () => {
    expect(progressLabel(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z', phase: '' }))).toBe('in progress');
  });

  it('reads "in progress" for a done item, even though it still carries phase: groom as history', () => {
    expect(progressLabel(fakeItem({ status: 'done', started: '2026-08-28T14:03:07Z', phase: 'groom' }))).toBe('in progress');
  });
});

/**
 * The dispatch block, bug-12: the board used to render the amber in-progress
 * bar and an enabled dispatch button on the same card — one saying a session
 * holds this item, the other offering to start a second one against it.
 *
 * It lives beside `isInProgress`/`progressLabel` rather than in
 * `shared/agent.ts` beside `runClaimBlock`, which it otherwise mirrors: both
 * of the predicates it is built from are here, `shared/` may not import from
 * `client/`, and hoisting the pair into `shared/` would be a move made for a
 * block the server has no use for — its dispatch route re-scans the item file
 * itself and is unchanged by this.
 *
 * The parenthetical is what varies, exactly as `runClaimBlock` varies its
 * stage: that keeps one sentence grammatical for all three `progressLabel`
 * answers, the bare `in progress` fallback included. The stamp is printed
 * verbatim rather than humanised because it is what is literally on disk —
 * the string someone greps the item file for when they want to know whose
 * marker this is.
 *
 * The done case is the same regression guard `isInProgress` carries: `move`
 * never rewrites content, so an archived item keeps its `started` stamp as
 * history, and blocking dispatch on a stamp that old would be blocking on a
 * session that ended weeks ago. (Nothing renders a dispatch control for a
 * done item anyway — `deriveAction` returns null first — but this function's
 * own answer has to be the inert one regardless of who calls it.)
 */
describe('progressBlock', () => {
  it('is null for an open item nobody has picked up', () => {
    expect(progressBlock(fakeItem({ status: 'open', started: '' }), NOW)).toBeNull();
  });

  it('names the activity and the stamp for an item an execute session holds', () => {
    const reason = progressBlock(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z', phase: 'execute' }), NOW);
    expect(reason).toContain('executing');
    expect(reason).toContain('2026-08-28T14:03:07Z');
  });

  it('names grooming for an item a groom session holds', () => {
    expect(progressBlock(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z', phase: 'groom' }), NOW)).toContain('grooming');
  });

  it('stays grammatical with no phase recorded, falling back to the generic wording', () => {
    expect(progressBlock(fakeItem({ status: 'open', started: '2026-08-28T14:03:07Z', phase: '' }), NOW)).toContain('in progress');
  });

  it('is null for a done item, whose started stamp is history rather than a claim', () => {
    expect(progressBlock(fakeItem({ status: 'done', started: '2026-08-28T14:03:07Z', phase: 'execute' }), NOW)).toBeNull();
  });
});

/**
 * #227 — a TRACKER item's claim adds the second question the protocol asks: is it live. The files rule above is untouched (a files item has no `holder`, and
 * ANY stamp blocks); what changes is a stale tracker claim, which the protocol lets any `start` retire — so dispatch may go ahead over one, and the spawned
 * session's own `start` retires it. Except where the board or a run still owns the holder: a stale run claim is a crashed run, and a board-dispatched
 * `claude -p` waiting on a reply sends no heartbeat at all.
 */
describe('progressBlock over a tracker claim', () => {
  const beat = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
  const claimed = (holder: ItemHolder): BacklogItem =>
    fakeItem({ id: '#31', source: 'github', path: 'gh:futin/x#31', started: '2026-08-28T14:03:07Z', phase: 'execute', holder });
  const STALE = beat(CLAIM_STALE_MS);

  it('is null for a stale hand claim, so dispatch may take it over', () => {
    expect(progressBlock(claimed({ session: 's', host: 'laptop', heartbeat: STALE }), NOW)).toBeNull();
    expect(progressBlock(claimed({ session: 's', heartbeat: 'not a date' }), NOW)).toBeNull();
  });

  it('names Stop & release for a stale claim the board dispatched', () => {
    expect(progressBlock(claimed({ session: 'sess-1', heartbeat: STALE, dispatched: true }), NOW)).toBe(
      "the board's own session sess-1 holds this item — Stop & release it first"
    );
  });

  it('still blocks a stale run-held claim', () => {
    expect(progressBlock(claimed({ session: 's', heartbeat: STALE, run: 'run-9' }), NOW)).toContain('executing');
  });

  it('still blocks a live claim, hand or dispatched, with the unchanged sentence', () => {
    const live = beat(CLAIM_STALE_MS - 1);
    expect(progressBlock(claimed({ session: 's', heartbeat: live }), NOW)).toBe(
      'a session is already working this item (executing since 2026-08-28T14:03:07Z)'
    );
    expect(progressBlock(claimed({ session: 's', heartbeat: live, dispatched: true }), NOW)).toBe(
      'a session is already working this item (executing since 2026-08-28T14:03:07Z)'
    );
  });

  it('still blocks a files item on any stamp, however old', () => {
    expect(progressBlock(fakeItem({ started: '2020-01-01T00:00:00Z', phase: 'execute' }), NOW)).toContain('executing');
  });
});

/* #227 — the rank, the "In progress" filter and the card's live bar read this: in progress, and not on a claim that has gone stale. */
describe('isLiveWork', () => {
  const beat = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
  const claimed = (heartbeat: string): BacklogItem =>
    fakeItem({ source: 'github', started: '2026-08-28T14:03:07Z', phase: 'execute', holder: { session: 's', heartbeat } });

  it('is true for a live claim and false for a stale one, which stays isInProgress', () => {
    expect(isLiveWork(claimed(beat(CLAIM_STALE_MS - 1)), NOW)).toBe(true);
    expect(isLiveWork(claimed(beat(CLAIM_STALE_MS)), NOW)).toBe(false);
    expect(isInProgress(claimed(beat(CLAIM_STALE_MS)))).toBe(true);
  });

  it('follows isInProgress for a files item, however old its stamp', () => {
    expect(isLiveWork(fakeItem({ started: '2020-01-01T00:00:00Z' }), NOW)).toBe(true);
    expect(isLiveWork(fakeItem({ started: '' }), NOW)).toBe(false);
  });
});
