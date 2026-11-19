import { ignoreHolds, ignoreKey, pruneIgnored, readIgnoredSteps } from '../../client/src/lib/ignored-steps';
import type { IgnoredSteps } from '../../client/src/lib/ignored-steps';
import type { GitlabMr, GitlabReview } from '../../shared/types';

/**
 * The ignore store's pure half (Jira detail tabs spec §4.5.1, T29 and T30): the key, the repairing guard, when an entry still holds, and the prune. The store
 * round trip through `persistedStore`-shaped listeners is Task 3's. `.ts` suite: `now` is passed in, so the instants are fixed literals.
 */

const NOW = Date.parse('2026-11-12T12:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

function review(over: Partial<GitlabReview> = {}): GitlabReview {
  return {
    open: 0,
    resolved: 0,
    worst: null,
    bySeverity: { critical: 0, major: 0, minor: 0, trivial: 0, other: 0 },
    triggeredAt: null,
    landedAt: null,
    commitsSince: 0,
    capped: false,
    readAt: minutesAgo(1),
    failed: false,
    ...over
  };
}

function mr(over: Partial<GitlabMr> = {}): GitlabMr {
  return {
    project: 'acme/pay-api',
    iid: 41,
    title: 'PAY-7 | change',
    webUrl: 'https://gitlab.example.test/acme/pay-api/-/merge_requests/41',
    state: 'opened',
    draft: false,
    sourceBranch: 'pay-7-change',
    targetBranch: 'develop',
    createdAt: minutesAgo(3000),
    updatedAt: minutesAgo(120),
    mergedAt: null,
    pipeline: 'failed',
    keys: ['PAY-7'],
    review: null,
    ...over
  };
}

describe('ignoreKey', () => {
  it('is project!iid, so two projects never share an iid', () => {
    expect(ignoreKey(mr())).toBe('acme/pay-api!41');
    expect(ignoreKey(mr({ project: 'acme/pay-web', iid: 7 }))).toBe('acme/pay-web!7');
  });
});

describe('readIgnoredSteps (spec T29)', () => {
  it('keeps a well-formed entry of either half, or both', () => {
    const v = {
      'a!1': { review: { state: 'none', landedAt: null } },
      'a!2': { review: { state: 'unread', landedAt: null } },
      'a!3': { pipeline: { status: 'failed', updatedAt: '2026-11-12T10:00:00Z' } },
      'a!4': { review: { state: 'open', landedAt: '2026-11-12T09:00:00Z' }, pipeline: { status: 'canceled', updatedAt: '2026-11-12T10:00:00Z' } }
    };
    expect(readIgnoredSteps(v)).toEqual(v);
  });

  it('drops an entry whose only half has a bad review.state', () => {
    expect(readIgnoredSteps({ 'a!1': { review: { state: 'bogus', landedAt: null } } })).toEqual({});
  });

  it('drops a numeric stamp: review.landedAt and pipeline.updatedAt', () => {
    expect(readIgnoredSteps({ 'a!1': { review: { state: 'none', landedAt: 5 } }, 'a!2': { pipeline: { status: 'failed', updatedAt: 5 } } })).toEqual({});
  });

  it('drops a missing landedAt: null is a stamp, undefined is not', () => {
    expect(readIgnoredSteps({ 'a!1': { review: { state: 'none' } } })).toEqual({});
  });

  it('drops a bad pipeline.status', () => {
    expect(readIgnoredSteps({ 'a!1': { pipeline: { status: 'passed', updatedAt: 'x' } } })).toEqual({});
  });

  it('keeps the good pipeline half of an entry whose review half is bad, and the good review half of one whose pipeline half is bad', () => {
    const pipeline = { status: 'failed', updatedAt: '2026-11-12T10:00:00Z' };
    const review = { state: 'stale', landedAt: '2026-11-12T09:00:00Z' };
    expect(readIgnoredSteps({ 'a!1': { review: { state: 'bogus', landedAt: null }, pipeline }, 'a!2': { review, pipeline: { status: 'bogus', updatedAt: 'x' } } })).toEqual({
      'a!1': { pipeline },
      'a!2': { review }
    });
  });

  it('keeps one good entry beside a bad one (per key, not all or nothing)', () => {
    expect(readIgnoredSteps({ 'a!1': { review: { state: 'bogus', landedAt: null } }, 'a!2': { review: { state: 'none', landedAt: null } } })).toEqual({
      'a!2': { review: { state: 'none', landedAt: null } }
    });
  });

  it.each<[string, unknown]>([
    ['a non-JSON string (the store passes the raw text when JSON.parse fails)', '{'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
    ['an array', [{ review: { state: 'none', landedAt: null } }]],
    ['an entry that is not an object', { 'a!1': 'x', 'a!2': null, 'a!3': 4, 'a!4': ['y'] }]
  ])('reads %s as {}', (_name, v) => {
    expect(readIgnoredSteps(v)).toEqual({});
  });

  it('treats __proto__ and constructor as data: an own key, never the prototype', () => {
    const raw = JSON.parse('{"__proto__":{"review":{"state":"none","landedAt":null}},"constructor":{"review":{"state":"open","landedAt":null}}}');
    const read = readIgnoredSteps(raw);
    expect(Object.keys(read).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(read, '__proto__')?.value).toEqual({ review: { state: 'none', landedAt: null } });
    expect(({} as Record<string, unknown>).review).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'review')).toBe(false);
  });
});

describe('ignoreHolds', () => {
  const landed = minutesAgo(90);
  it('is false on both halves for no entry', () => {
    expect(ignoreHolds(undefined, mr({ review: review() }), NOW)).toEqual({ review: false, pipeline: false });
  });

  it('holds the review while the state and the landing are both unchanged', () => {
    const m = mr({ review: review({ landedAt: landed, commitsSince: 2 }) });
    expect(ignoreHolds({ review: { state: 'stale', landedAt: landed } }, m, NOW)).toEqual({ review: true, pipeline: false });
  });

  it('drops the review ignore when the state moved, though the landing did not', () => {
    const m = mr({ review: review({ landedAt: landed, open: 1 }) });
    expect(ignoreHolds({ review: { state: 'stale', landedAt: landed } }, m, NOW).review).toBe(false);
  });

  it('drops the review ignore when a new round landed, though the state is the same', () => {
    const m = mr({ review: review({ landedAt: minutesAgo(10), open: 1 }) });
    expect(ignoreHolds({ review: { state: 'open', landedAt: landed } }, m, NOW).review).toBe(false);
  });

  it('reads a null review as unread, and holds only an unread entry with a null landing', () => {
    const m = mr({ review: null });
    expect(ignoreHolds({ review: { state: 'unread', landedAt: null } }, m, NOW).review).toBe(true);
    expect(ignoreHolds({ review: { state: 'none', landedAt: null } }, m, NOW).review).toBe(false);
  });

  it('holds a none review with a null landing, and stops when the review is read as open', () => {
    const entry = { review: { state: 'none', landedAt: null } } as const;
    expect(ignoreHolds(entry, mr({ review: review() }), NOW).review).toBe(true);
    expect(ignoreHolds(entry, mr({ review: review({ open: 2 }) }), NOW).review).toBe(false);
  });

  it('holds the pipeline while status and updatedAt both match, and drops it on either change', () => {
    const m = mr({ pipeline: 'failed', updatedAt: '2026-11-12T10:00:00.000Z' });
    expect(ignoreHolds({ pipeline: { status: 'failed', updatedAt: '2026-11-12T10:00:00.000Z' } }, m, NOW).pipeline).toBe(true);
    expect(ignoreHolds({ pipeline: { status: 'failed', updatedAt: '2026-11-12T09:00:00.000Z' } }, m, NOW).pipeline).toBe(false);
    expect(ignoreHolds({ pipeline: { status: 'canceled', updatedAt: '2026-11-12T10:00:00.000Z' } }, m, NOW).pipeline).toBe(false);
  });

  it('judges each half on its own', () => {
    const m = mr({ pipeline: 'failed', updatedAt: '2026-11-12T10:00:00.000Z', review: review({ landedAt: landed, open: 1 }) });
    const entry = { review: { state: 'stale', landedAt: landed }, pipeline: { status: 'failed', updatedAt: '2026-11-12T10:00:00.000Z' } } as const;
    expect(ignoreHolds(entry, m, NOW)).toEqual({ review: false, pipeline: true });
  });
});

describe('pruneIgnored (spec T30)', () => {
  const entry = { review: { state: 'none', landedAt: null } } as const;
  const all: IgnoredSteps = { 'acme/pay-api!41': entry, 'acme/pay-web!7': entry };
  const a41 = (state: GitlabMr['state']): GitlabMr => mr({ project: 'acme/pay-api', iid: 41, state });

  it('keeps both keys while the ticket MR is still open', () => {
    expect(pruneIgnored(all, [a41('opened')])).toEqual(all);
  });

  it("drops the ticket's own merged MR and touches another ticket's key", () => {
    expect(pruneIgnored(all, [a41('merged')])).toEqual({ 'acme/pay-web!7': entry });
  });

  it('drops a closed MR too', () => {
    expect(pruneIgnored(all, [a41('closed')])).toEqual({ 'acme/pay-web!7': entry });
  });

  it("never touches a key the ticket's delivery does not hold, however its MR is doing elsewhere", () => {
    expect(pruneIgnored(all, [mr({ project: 'acme/pay-api', iid: 99, state: 'merged' })])).toEqual(all);
  });

  it('does not mutate the store it was handed', () => {
    const snapshot = JSON.parse(JSON.stringify(all));
    pruneIgnored(all, [a41('merged')]);
    expect(all).toEqual(snapshot);
  });

  it('returns the same reference for a null ticket list (payload null or delivery not mrs)', () => {
    expect(pruneIgnored(all, null)).toBe(all);
  });
});
