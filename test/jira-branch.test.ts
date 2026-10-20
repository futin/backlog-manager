import {
  BRANCH_NAME_MAX,
  DEFAULT_NAME_PATTERN,
  PATTERN_SAMPLE,
  SLUG_MAX,
  branchCarriesKey,
  branchNameProblem,
  defaultBaseProblem,
  patternProblem,
  renderBranchPattern,
  shellQuote,
  slugOf,
  worktreePathFor
} from '../shared/jira-branch';

/**
 * jira-branch.test.ts — one case per row of the plan's Tables A–E, plus the worktree path and the shell quoting. The tables are the contract: the server
 * (routes, prompt) and the client (launch sheet) import this module, so a row changed here is a rule changed for both.
 */

const CHARSET = 'may hold only A-Z a-z 0-9 . _ / -';

describe('constants', () => {
  it('pins the limits and the default pattern', () => {
    expect(BRANCH_NAME_MAX).toBe(200);
    expect(SLUG_MAX).toBe(40);
    expect(DEFAULT_NAME_PATTERN).toBe('{key}-{slug}');
    expect(PATTERN_SAMPLE).toEqual({ key: 'ABC-1', slug: 'sample-slug' });
  });
});

describe('branchNameProblem (Table A)', () => {
  it.each(['feature/timify-123-x', 'TIMIFY-123', 'release/1.2', 'a_b.c'])('accepts %s', (name) => {
    expect(branchNameProblem(name)).toBeNull();
  });

  it('refuses an empty name', () => {
    expect(branchNameProblem('')).toBe('is empty');
  });

  it('refuses 201 characters, and accepts exactly 200', () => {
    expect(branchNameProblem('a'.repeat(201))).toBe('is longer than 200 characters');
    expect(branchNameProblem('a'.repeat(200))).toBeNull();
  });

  it.each(['feat ure', 'feat~1', 'a:b', 'a@b', 'ä'])('refuses %s for a character outside the allowlist', (name) => {
    expect(branchNameProblem(name)).toBe(CHARSET);
  });

  it('refuses a leading -', () => {
    expect(branchNameProblem('-x')).toBe('may not start with -');
  });

  it('refuses ..', () => {
    expect(branchNameProblem('a..b')).toBe('may not contain ..');
  });

  it.each(['/a', 'a/', 'a//b'])('refuses %s for a misplaced /', (name) => {
    expect(branchNameProblem(name)).toBe('may not start or end with /, or contain //');
  });

  it.each(['a/.b', '.a'])('refuses %s for a part starting with .', (name) => {
    expect(branchNameProblem(name)).toBe('may not have a part starting with .');
  });

  it.each(['a.lock', 'a.lock/b'])('refuses %s for a part ending in .lock', (name) => {
    expect(branchNameProblem(name)).toBe('may not have a part ending in .lock');
  });

  it('refuses a trailing .', () => {
    expect(branchNameProblem('a.')).toBe('may not end with .');
  });
});

describe('branchCarriesKey (Table B)', () => {
  it.each(['TIMIFY-123-fix-login', 'feature/timify-123-x', 'hotfix/timify-123', 'TIMIFY-123', 'feature/timify-123_x'])('carries the key: %s', (branch) => {
    expect(branchCarriesKey(branch, 'TIMIFY-123')).toBe(true);
  });

  it.each(['timify-1234-x', 'xtimify-123', '1timify-123', 'feature/timify-12-x', 'develop'])('does not carry the key: %s', (branch) => {
    expect(branchCarriesKey(branch, 'TIMIFY-123')).toBe(false);
  });

  it('finds a later occurrence when an earlier one is unbounded', () => {
    expect(branchCarriesKey('timify-1234/timify-123', 'TIMIFY-123')).toBe(true);
  });
});

describe('slugOf (Table C)', () => {
  it.each([
    ['Export contacts to CSV', 'export-contacts-to-csv'],
    ['Ünïcödé — Fix: Löğin!!', 'unicode-fix-login'],
    ['--Fix--', 'fix'],
    ['   ', ''],
    ['日本語', ''],
    ['Implement the new contact export pipeline for enterprise customers', 'implement-the-new-contact-export'],
    ['a'.repeat(45), 'a'.repeat(40)]
  ])('%j -> %j', (summary, slug) => {
    expect(slugOf(summary)).toBe(slug);
  });

  it('cuts at 40 when the 41st character is the -', () => {
    const s = `${'a'.repeat(40)}-bbb`;
    expect(slugOf(s)).toBe('a'.repeat(40));
  });
});

describe('renderBranchPattern (Table D)', () => {
  it.each([
    ['{key}-{slug}', 'export-contacts', 'timify-123-export-contacts'],
    ['feature/{key}-{slug}', 'x', 'feature/timify-123-x'],
    ['{KEY}_{slug}', 'x', 'TIMIFY-123_x'],
    ['{key}-{slug}', '', 'timify-123'],
    ['feature/{key}_{slug}', '', 'feature/timify-123'],
    ['{slug}-{key}', '', 'timify-123'],
    ['feature/{slug}-{key}', '', 'feature/timify-123'],
    ['{key}/{slug}', '', 'timify-123']
  ])('%j + %j -> %j', (pattern, slug, expected) => {
    expect(renderBranchPattern(pattern, 'TIMIFY-123', slug)).toBe(expected);
  });
});

// M1 (final review): a stored base is what `git worktree add` is cut from, and the tool resolves it locally or as `origin/<base>` itself — so a saved
// `origin/develop` is asked for as `origin/origin/develop` and every Start exits 4. Table A first, then the prefix.
describe('defaultBaseProblem', () => {
  it('passes a plain branch name, and one that merely contains origin', () => {
    for (const base of ['develop', 'release/1.2', 'origin', 'feature/origin/x', 'origins/x']) expect(defaultBaseProblem(base)).toBeNull();
  });

  it('refuses an origin/ prefix in its own words, and Table A before it', () => {
    expect(defaultBaseProblem('origin/develop')).toBe('is a branch name, without origin/');
    expect(defaultBaseProblem('origin/HEAD')).toBe('is a branch name, without origin/');
    expect(defaultBaseProblem('origin/a b')).toBe('may hold only A-Z a-z 0-9 . _ / -');
    expect(defaultBaseProblem('')).toBe('is empty');
  });
});

describe('patternProblem (Table E)', () => {
  it.each(['{key}-{slug}', 'feature/{key}-{slug}', '{KEY}-{slug}'])('accepts %s', (pattern) => {
    expect(patternProblem(pattern)).toBeNull();
  });

  it.each([
    ['{slug}', 'renders as sample-slug, which does not carry ABC-1'],
    ['x{key}', 'renders as xabc-1, which does not carry ABC-1'],
    ['{key}1', 'renders as abc-11, which does not carry ABC-1'],
    ['-{key}', 'renders as -abc-1, which may not start with -'],
    ['{key} {slug}', `renders as abc-1 sample-slug, which ${CHARSET}`],
    ['{foo}-{key}', `renders as {foo}-abc-1, which ${CHARSET}`]
  ])('%s -> %s', (pattern, problem) => {
    expect(patternProblem(pattern)).toBe(problem);
  });
});

describe('worktreePathFor', () => {
  it('puts the tree under .worktrees with every / turned into -', () => {
    expect(worktreePathFor('/r', 'feature/timify-123-x')).toBe('/r/.worktrees/feature-timify-123-x');
  });
});

describe('shellQuote', () => {
  it.each([
    ['/a b', "'/a b'"],
    ["/it's", "'/it'\\''s'"],
    ['/plain', "'/plain'"]
  ])('%j -> %s', (value, quoted) => {
    expect(shellQuote(value)).toBe(quoted);
  });
});
