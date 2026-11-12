import { DEFAULT_REVIEW_CONFIG, REVIEW_FLAG, parseReviewConfig, reviewFlags, reviewerLabel } from '../shared/agent';

/** The reviewer config's shared helpers. `skills/backlog-review/tools/review.test.mjs` pins the twin in `review.mjs` against the same source. */
describe('parseReviewConfig', () => {
  const same = { ...DEFAULT_REVIEW_CONFIG, mode: 'same', same: { model: 'fable', effort: 'xhigh' } };

  it('accepts the default and a same config', () => {
    expect(parseReviewConfig(DEFAULT_REVIEW_CONFIG)).toEqual({ ok: true, config: DEFAULT_REVIEW_CONFIG });
    expect(parseReviewConfig(same)).toEqual({ ok: true, config: same });
  });

  it.each(['300', 300.5, 0, 10001, null])('rejects smallMaxLines %j', (n) => {
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, smallMaxLines: n })).toEqual({ ok: false, member: 'smallMaxLines' });
  });

  it('accepts both ends of the range', () => {
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, smallMaxLines: 1 }).ok).toBe(true);
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, smallMaxLines: 10000 }).ok).toBe(true);
  });

  it('names the failing member', () => {
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, big: { model: 'gpt', effort: null } })).toEqual({ ok: false, member: 'big.model' });
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, small: { model: null, effort: 'ultra' } })).toEqual({ ok: false, member: 'small.effort' });
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, mode: 'both' })).toEqual({ ok: false, member: 'mode' });
  });

  it('names a pair that is not an object, or has an extra or missing key', () => {
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, big: 'opus' })).toEqual({ ok: false, member: 'big' });
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, big: { model: null, effort: null, x: 1 } })).toEqual({ ok: false, member: 'big' });
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, same: { model: null } })).toEqual({ ok: false, member: 'same' });
  });

  it('names review itself for a non-object, an extra key or a missing pair', () => {
    expect(parseReviewConfig(null)).toEqual({ ok: false, member: 'review' });
    expect(parseReviewConfig([])).toEqual({ ok: false, member: 'review' });
    expect(parseReviewConfig({ ...DEFAULT_REVIEW_CONFIG, extra: 1 })).toEqual({ ok: false, member: 'review' });
    const { big: _big, ...missing } = DEFAULT_REVIEW_CONFIG;
    expect(parseReviewConfig(missing)).toEqual({ ok: false, member: 'review' });
  });
});

describe('reviewFlags', () => {
  it('spells the default config as split flags', () => {
    expect(reviewFlags(DEFAULT_REVIEW_CONFIG)).toEqual([
      '--review-mode', 'split', '--review-big-model', 'default', '--review-big-effort', 'default',
      '--review-small-model', 'sonnet', '--review-small-effort', 'default', '--review-small-max-lines', '300'
    ]);
  });

  it('spells a same config as mode, model and effort', () => {
    expect(reviewFlags({ ...DEFAULT_REVIEW_CONFIG, mode: 'same', same: { model: 'opus', effort: 'max' } })).toEqual([
      '--review-mode', 'same', '--review-model', 'opus', '--review-effort', 'max'
    ]);
  });

  it('spells null as default', () => {
    expect(reviewFlags(null)).toEqual(['default']);
  });
});

describe('reviewerLabel', () => {
  it('reads the default', () => {
    expect(reviewerLabel(DEFAULT_REVIEW_CONFIG)).toBe('Reviewer: big Agent default · Default, small Sonnet · Default up to 300 lines');
  });

  it('reads a same config', () => {
    expect(reviewerLabel({ ...DEFAULT_REVIEW_CONFIG, mode: 'same', same: { model: 'fable', effort: 'xhigh' } })).toBe('Reviewer: Fable · XHigh');
  });

  it('reads an unset config', () => {
    expect(reviewerLabel(undefined)).toBe('Reviewer: default');
    expect(reviewerLabel(null)).toBe('Reviewer: default');
  });
});

describe('REVIEW_FLAG', () => {
  it('matches a review flag in a prompt', () => {
    expect(REVIEW_FLAG.test('run --review-model x')).toBe(true);
    expect(REVIEW_FLAG.test('`--review-mode`')).toBe(true);
  });

  it('does not match look-alikes', () => {
    expect(REVIEW_FLAG.test('--reviewed')).toBe(false);
    expect(REVIEW_FLAG.test('--preview-x')).toBe(false);
  });
});
