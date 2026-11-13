import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_REVIEW_CONFIG } from '../../shared/agent';
import { readReview, reviewFile, writeReview } from '../../server/src/settings/review-config.util';

describe('review-config.util', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bm-review-config-'));
    file = join(dir, 'settings', 'review.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the defaults, without fileError, when the file is missing', () => {
    const r = readReview(file);
    expect(r).toEqual(DEFAULT_REVIEW_CONFIG);
    expect(r).not.toHaveProperty('fileError');
  });

  it('flags a file that does not parse', () => {
    writeFileSync(join(dir, 'bad.json'), '{nope');
    expect(readReview(join(dir, 'bad.json'))).toEqual({ ...DEFAULT_REVIEW_CONFIG, fileError: true });
  });

  it('flags a file that parses to an invalid config', () => {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...DEFAULT_REVIEW_CONFIG, smallMaxLines: '300' }));
    expect(readReview(join(dir, 'bad.json'))).toEqual({ ...DEFAULT_REVIEW_CONFIG, fileError: true });
  });

  it('round-trips a write, creating the directory', () => {
    const c = { ...DEFAULT_REVIEW_CONFIG, mode: 'same' as const, same: { model: 'opus' as const, effort: 'high' as const } };
    writeReview(c, file);
    expect(readReview(file)).toEqual(c);
  });

  it('does not hand out the shared defaults to be mutated', () => {
    readReview(file).small.model = 'haiku';
    expect(readReview(file).small.model).toBe('sonnet');
  });

  it('names BM_REVIEW_FILE, else review.json under settings/', () => {
    expect(reviewFile({ BM_REVIEW_FILE: '/x/r.json' })).toBe('/x/r.json');
    expect(reviewFile({}).endsWith(join('.backlog-manager', 'settings', 'review.json'))).toBe(true);
  });
});
