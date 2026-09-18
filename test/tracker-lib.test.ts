import { accessReason, hasTracker, pollAge, trackerLine } from '../client/src/lib/tracker';
import type { ProjectSummary } from '../shared/types';

/**
 * The board's tracker derivations (task-45). Pure functions with the clock
 * passed in, so every case here is a table row rather than a render — the same
 * shape `item-age.test.ts` and `item-stale.test.ts` have, and the reason
 * `lib/` exists at all.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z');

function project(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    name: 'tracker',
    path: '/abs/tracker',
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
    source: 'github',
    repo: 'futin/x',
    polledAt: '2026-09-18T11:59:48Z',
    access: 'ok',
    detail: null,
    ...over
  };
}

describe('pollAge', () => {
  it('reads seconds under a minute and delegates above it', () => {
    // The seconds rung is this function's own: the server polls every fifteen
    // seconds, so a minutes-only ladder would print one word for four cycles.
    expect(pollAge('2026-09-18T11:59:48Z', NOW)).toBe('12 s');
    expect(pollAge('2026-09-18T11:56:00Z', NOW)).toBe('4m');
    expect(pollAge('2026-09-18T09:00:00Z', NOW)).toBe('3h');
  });

  it('answers null for no poll and for an unparseable stamp', () => {
    // `null` and "0 s" are opposite claims: one says nothing has been read,
    // the other says it was read just now.
    expect(pollAge(null, NOW)).toBeNull();
    expect(pollAge('', NOW)).toBeNull();
    expect(pollAge('not a date', NOW)).toBeNull();
  });

  it('clamps a stamp from the future rather than going negative', () => {
    expect(pollAge('2026-09-18T12:00:30Z', NOW)).toBe('0 s');
  });
});

describe('accessReason', () => {
  it('names the fix for the one state an operator can clear', () => {
    expect(accessReason({ access: 'no-token', detail: null })).toContain('BM_GITHUB_TOKEN');
  });

  it('carries the detail where it adds something and drops it where it does not', () => {
    expect(accessReason({ access: 'rate-limited', detail: 'resets 14:32' })).toBe('resets 14:32');
    // GitHub's own message for these two is usually "Not Found", which says
    // less than the state does.
    expect(accessReason({ access: 'not-found', detail: 'Not Found' })).toContain('not visible to this token');
    expect(accessReason({ access: 'forbidden', detail: 'Not Found' })).toContain('cannot read that repo');
  });

  it('is null for a healthy connection and for a project that has none', () => {
    expect(accessReason({ access: 'ok', detail: null })).toBeNull();
    expect(accessReason({ access: null, detail: null })).toBeNull();
  });
});

describe('trackerLine', () => {
  it('prints the repo and the age while access is ok', () => {
    expect(trackerLine(project(), NOW)).toBe('futin/x · polled 12 s ago');
  });

  it('replaces the age with the access reason, never printing both', () => {
    const line = trackerLine(project({ access: 'rate-limited', detail: 'resets 14:32' }), NOW);
    expect(line).toBe('futin/x · resets 14:32');
    expect(line).not.toContain('polled');
  });

  it('says connecting before the first successful poll', () => {
    // Not `polled 0 s ago`, which would claim a read that has not happened.
    expect(trackerLine(project({ polledAt: null }), NOW)).toBe('futin/x · connecting…');
  });

  it('is null for every non-tracker project, which is what the caller filters on', () => {
    expect(trackerLine(project({ source: 'files', repo: null, access: null, polledAt: null }), NOW)).toBeNull();
    expect(trackerLine(project({ source: null }), NOW)).toBeNull();
    expect(trackerLine(project({ source: 'unsupported' }), NOW)).toBeNull();
  });
});

describe('hasTracker', () => {
  it('answers the board’s “should I keep re-reading this” question', () => {
    expect(hasTracker(null)).toBe(false);
    expect(hasTracker([])).toBe(false);
    expect(hasTracker([project({ source: 'files' })])).toBe(false);
    expect(hasTracker([project({ source: 'files' }), project()])).toBe(true);
  });
});
