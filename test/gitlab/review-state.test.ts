import { REVIEW_REREAD_MS, REVIEW_STUCK_MS, reviewHalf, reviewStaleKind, reviewState, type ReviewState } from '../../shared/review';
import { jiraActionParam, parseJiraAction, parseJiraActionParam, type GitlabReview } from '../../shared/types';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const MIN = 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

/** A review with every count at zero and nothing triggered or landed; each case overrides only what it is about. */
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
    readAt: ago(0),
    failed: false,
    ...over
  };
}

describe('reviewState (spec 4.2 table)', () => {
  it('exports the two windows', () => {
    expect(REVIEW_STUCK_MS).toBe(30 * MIN);
    expect(REVIEW_REREAD_MS).toBe(10 * MIN);
  });

  it('rule 0: capped with nothing open is unknown; capped with open findings is open', () => {
    expect(reviewState(review({ capped: true }), NOW)).toBe('unknown');
    expect(reviewState(review({ capped: true, open: 3 }), NOW)).toBe('open');
  });

  it('rule 1: a young unlanded trigger is reviewing, and beats open findings', () => {
    expect(reviewState(review({ triggeredAt: ago(4 * MIN) }), NOW)).toBe('reviewing');
    expect(reviewState(review({ triggeredAt: ago(4 * MIN), landedAt: ago(60 * MIN), open: 2 }), NOW)).toBe('reviewing');
  });

  it('rule 2: open findings beat none and stale', () => {
    expect(reviewState(review({ open: 2 }), NOW)).toBe('open');
    expect(reviewState(review({ triggeredAt: ago(45 * MIN), open: 1 }), NOW)).toBe('open');
    expect(reviewState(review({ triggeredAt: ago(90 * MIN), landedAt: ago(80 * MIN), commitsSince: 3, open: 1 }), NOW)).toBe('open');
  });

  it('rule 3: no landing at all is none, and only strictly under 30 min is reviewing', () => {
    expect(reviewState(review(), NOW)).toBe('none');
    expect(reviewState(review({ triggeredAt: ago(31 * MIN) }), NOW)).toBe('none');
    expect(reviewState(review({ triggeredAt: ago(REVIEW_STUCK_MS) }), NOW)).toBe('none');
    expect(reviewState(review({ triggeredAt: ago(REVIEW_STUCK_MS - 1000) }), NOW)).toBe('reviewing');
  });

  it('rule 4: commits since the landing make it stale', () => {
    const r = review({ landedAt: ago(60 * MIN), triggeredAt: ago(61 * MIN), commitsSince: 3 });
    expect(reviewState(r, NOW)).toBe('stale');
    expect(reviewStaleKind(r, NOW)).toBe('commits');
  });

  it('rule 5: a later round that never landed is stale, kind unlanded', () => {
    const r = review({ landedAt: ago(120 * MIN), triggeredAt: ago(40 * MIN) });
    expect(reviewState(r, NOW)).toBe('stale');
    expect(reviewStaleKind(r, NOW)).toBe('unlanded');
  });

  it('rule 6: landed, nothing open, no commits is clean', () => {
    expect(reviewState(review({ landedAt: ago(60 * MIN), triggeredAt: ago(61 * MIN), resolved: 25 }), NOW)).toBe('clean');
  });

  it('an unparseable stamp reads as absent', () => {
    expect(reviewState(review({ triggeredAt: 'garbage' }), NOW)).toBe('none');
    expect(reviewState(review({ triggeredAt: ago(60 * MIN), landedAt: 'garbage' }), NOW)).toBe('none');
  });

  it('reviewStaleKind is null whenever the state is not stale', () => {
    expect(reviewStaleKind(review(), NOW)).toBeNull();
    expect(reviewStaleKind(review({ open: 2, landedAt: ago(60 * MIN), commitsSince: 2 }), NOW)).toBeNull();
    expect(reviewStaleKind(review({ landedAt: ago(60 * MIN) }), NOW)).toBeNull();
  });
});

describe('reviewHalf', () => {
  it('maps open to fix, none and stale to request, the rest to null', () => {
    const table: Record<ReviewState, 'request' | 'fix' | null> = { open: 'fix', none: 'request', stale: 'request', reviewing: null, clean: null, unknown: null };
    for (const [state, half] of Object.entries(table)) expect(reviewHalf(state as ReviewState)).toBe(half);
  });
});

describe('the review action', () => {
  it('parses and emits review, and rejects other spellings', () => {
    expect(parseJiraAction('review')).toBe('review');
    expect(parseJiraActionParam('review')).toBe('review');
    expect(jiraActionParam('review')).toBe('review');
    expect(parseJiraAction('Review')).toBeNull();
    expect(parseJiraAction({ review: true })).toBeNull();
    expect(parseJiraActionParam('Review')).toBeNull();
  });
});
