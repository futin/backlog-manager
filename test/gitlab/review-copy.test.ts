import { reviewButtonLabel, reviewRowText, reviewStepTitleSuffix, reviewStepWord } from '../../client/src/lib/review-copy';
import type { GitlabReview } from '../../shared/types';

/**
 * Every row of the CodeRabbit copy table (spec §5.5), exact strings. `.ts` suite: `now` is passed in, so the instants are fixed.
 */

const NOW = Date.parse('2026-11-12T12:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

function review(over: Partial<GitlabReview> = {}): GitlabReview {
  return {
    open: 0,
    resolved: 0,
    worst: null,
    bySeverity: { critical: 0, major: 0, minor: 0, trivial: 0, other: 0 },
    triggeredAt: minutesAgo(600),
    landedAt: minutesAgo(120),
    commitsSince: 0,
    capped: false,
    readAt: minutesAgo(60),
    failed: false,
    ...over
  };
}

const none = review({ triggeredAt: null, landedAt: null });
const reviewing = review({ triggeredAt: minutesAgo(4), landedAt: null });
const open4 = review({ open: 4, worst: 'major', bySeverity: { critical: 0, major: 1, minor: 1, trivial: 0, other: 2 } });
const open1 = review({ open: 1, worst: 'critical', landedAt: null, triggeredAt: null, bySeverity: { critical: 1, major: 0, minor: 0, trivial: 0, other: 0 } });

describe('reviewStepWord', () => {
  it.each<[string, GitlabReview, string]>([
    ['none', none, 'not reviewed'],
    ['reviewing', reviewing, 'reviewing… 4m'],
    ['open with a worst', review({ open: 2, worst: 'major', bySeverity: { critical: 0, major: 1, minor: 1, trivial: 0, other: 0 } }), '2 open · 1 major'],
    ['open, worst null', review({ open: 1 }), '1 open'],
    ['open, capped', review({ open: 5, capped: true, worst: 'minor', bySeverity: { critical: 0, major: 0, minor: 5, trivial: 0, other: 0 } }), '5+ open'],
    ['stale, commits', review({ commitsSince: 3 }), '3 commits since review'],
    ['stale, one commit', review({ commitsSince: 1 }), '1 commit since review'],
    ['stale, unlanded', review({ triggeredAt: minutesAgo(90), landedAt: minutesAgo(120) }), "last review didn't land"],
    ['clean', review({ resolved: 25 }), '0 open · 25 resolved'],
    ['unknown', review({ capped: true }), 'too long to read']
  ])('%s', (_n, r, word) => {
    expect(reviewStepWord(r, NOW)).toBe(word);
  });

  it('draws no word without a review', () => {
    expect(reviewStepWord(null, NOW)).toBeNull();
  });
});

describe('reviewRowText', () => {
  it('open: count, breakdown in severity order, the age from landedAt', () => {
    expect(reviewRowText(open4, NOW)).toBe('CodeRabbit · 4 open findings · 1 major, 1 minor, 2 other · reviewed 2h ago');
  });
  it('open, singular, no landing: no age part', () => {
    expect(reviewRowText(open1, NOW)).toBe('CodeRabbit · 1 open finding · 1 critical');
  });
  it('open, capped: n+', () => {
    expect(reviewRowText({ ...open4, capped: true }, NOW)).toBe('CodeRabbit · 4+ open findings · 1 major, 1 minor, 2 other · reviewed 2h ago');
  });
  it('none, stale commits (singular too), stale unlanded', () => {
    expect(reviewRowText(none, NOW)).toBe('CodeRabbit · not reviewed yet');
    expect(reviewRowText(review({ commitsSince: 3 }), NOW)).toBe('CodeRabbit · 3 commits since the last review');
    expect(reviewRowText(review({ commitsSince: 1 }), NOW)).toBe('CodeRabbit · 1 commit since the last review');
    expect(reviewRowText(review({ triggeredAt: minutesAgo(90), landedAt: minutesAgo(120) }), NOW)).toBe("CodeRabbit · the last review didn't land");
  });
  it('under a minute reads "just now", never "now ago"', () => {
    const fresh = { ...open4, landedAt: minutesAgo(0), readAt: minutesAgo(0), failed: true };
    expect(reviewRowText(fresh, NOW)).toBe('CodeRabbit · 4 open findings · 1 major, 1 minor, 2 other · reviewed just now · not refreshed since just now');
    expect(reviewStepTitleSuffix(fresh, NOW)).toBe(' · not refreshed since just now');
  });
  it('a failed read adds the not-refreshed suffix, aged from readAt', () => {
    expect(reviewRowText({ ...open4, failed: true }, NOW)).toBe(
      'CodeRabbit · 4 open findings · 1 major, 1 minor, 2 other · reviewed 2h ago · not refreshed since 1h'
    );
    expect(reviewStepTitleSuffix({ ...open4, failed: true }, NOW)).toBe(' · not refreshed since 1h');
    expect(reviewStepTitleSuffix(open4, NOW)).toBe('');
    expect(reviewStepTitleSuffix(null, NOW)).toBe('');
  });
  it('is null for reviewing, clean, unknown and no review', () => {
    expect(reviewRowText(reviewing, NOW)).toBeNull();
    expect(reviewRowText(review({ resolved: 2 }), NOW)).toBeNull();
    expect(reviewRowText(review({ capped: true }), NOW)).toBeNull();
    expect(reviewRowText(null, NOW)).toBeNull();
  });
});

describe('reviewButtonLabel', () => {
  it.each<[Parameters<typeof reviewButtonLabel>[0], string | null]>([
    ['open', 'Fix review'],
    ['none', 'Request review'],
    ['stale', 'Request review'],
    ['reviewing', null],
    ['clean', null],
    ['unknown', null]
  ])('%s', (state, label) => {
    expect(reviewButtonLabel(state)).toBe(label);
  });
});
