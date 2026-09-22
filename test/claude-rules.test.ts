import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anchorsOf, compareTiers, freeProse, headlineOf, joinWrapped, splitBullets, tierOne, tierTwo, wordCount } from './helpers/rule-tiers';

/**
 * `.claude/rules/*.md` hold the MECHANISM tier of this repo's rules: each file is the one home of the full bullet — headline, how the rule is implemented,
 * its `Why:` link — for every rule scoped to the file's `paths:` glob, and is injected into a session the moment it reads a file under that glob. CLAUDE.md
 * keeps only the headline and the link (tier one, loaded by every session); `docs/subsystems/invariants.md` keeps the reasoning (tier three). The split is
 * docs/superpowers/specs/2026-09-22-claude-md-three-tiers-design.md; the parsers both tiers are read through are `test/helpers/rule-tiers.ts`.
 *
 * Every property this suite asserts fails silently in production if it breaks: a rule with no `paths:` is loaded into EVERY session at launch (a
 * context-floor increase for all of them, the one failure mode task-35 must never introduce); an anchor that no longer resolves lands the reader at the top
 * of a 3,000-line file; a glob that matches nothing never fires at all and nothing ever says so; mechanism that creeps back into CLAUDE.md is paid for by
 * every session, chat or headless, and nobody notices a file getting longer; a headline edited on one side only drifts the two tiers apart with no reader
 * positioned to see both. The three tier guards catch the last two: a rule file is bullets and nothing else, each anchored exactly once; tier one and tier
 * two are the same multiset of (anchor, headline) with one home per anchor; a linked CLAUDE.md bullet is a headline and a link and an unlinked one is short.
 *
 * The suite reads the files as SOURCE, the way `test/csp.test.ts` and `test/compose-env.test.ts` read config files — there is no YAML parser in the
 * dependency tree, and the frontmatter under test is one inline array a parser would hand back verbatim anyway.
 *
 * `ruleFilesIn` still answers `[]` for an absent directory, and one case pins that, but the suite as a whole is no longer vacuous on an empty
 * `.claude/rules/` ON PURPOSE: task-35's pointer design had to stay green in the world where probe P3 came back negative and zero rule files was the right
 * deliverable, whereas under the three tiers a CLAUDE.md that carries linked headlines with no rule file behind them is missing its mechanism, and the
 * tier guard says so by name.
 */
const REPO_ROOT = join(__dirname, '..');
const RULES_DIR = join(REPO_ROOT, '.claude', 'rules');
const INVARIANTS_REL = 'docs/subsystems/invariants.md';
const CLAUDE_MD = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');

/**
 * Tier one's line shape, exactly: the headline's bold span, one space, `Why:`, one space, the link, end of bullet. Anything after the link — a clause, a
 * second bold span, a sentence of mechanism — is what the split moved out of CLAUDE.md and what must not come back. Applied to the JOINED bullet, so a
 * headline that wraps at 160 columns compares like one that does not.
 */
const HEADLINE_ONLY = /^- \*\*(.+?)\*\* Why: \[invariants\.md\]\(docs\/subsystems\/invariants\.md#[\w-]+\)$/;

/** The most words a bold-led CLAUDE.md bullet may carry without a `Why:` link — the side door that would let mechanism back in by dropping the link. */
const UNLINKED_WORD_CAP = 80;

/**
 * Tier one's offenders, from the text of a CLAUDE.md: a linked bullet that is more than a headline and a link, or an unlinked bullet over the cap. A
 * function over text so the same predicate runs on the real file and on the fixture that proves it can see both shapes.
 */
function tierOneOffenders(claudeMd: string): string[] {
  const tiers = tierOne(claudeMd);
  return [
    ...tiers.linked.filter((b) => !HEADLINE_ONLY.test(b.joined)).map((b) => `${b.line}: ${b.joined.slice(0, 80)}`),
    ...tiers.unlinked.filter((b) => b.words > UNLINKED_WORD_CAP).map((b) => `${b.line}: ${b.words} words`)
  ];
}

type RuleFile = {
  name: string;
  text: string;
  lines: string[];
};

/**
 * Every `.md` under `.claude/rules/`, or `[]` when the directory is absent. The
 * absent case is the vacuous-pass path and is the reason this is a function over a
 * directory argument rather than a module-level constant: case 6 calls it against a
 * path that deliberately does not exist.
 */
function ruleFilesIn(dir: string): RuleFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8');
      return { name, text, lines: text.split('\n') };
    });
}

const RULES = ruleFilesIn(RULES_DIR);

/**
 * The frontmatter block, or `null` when the file does not open with one. `null` is
 * the failure case 1 exists for: no frontmatter means no `paths:`, which means the
 * file is loaded at `session_start` in every session.
 */
function frontmatter(file: RuleFile): string | null {
  if (file.lines[0] !== '---') return null;
  const close = file.lines.indexOf('---', 1);
  if (close === -1) return null;
  return file.lines.slice(1, close).join('\n');
}

/** Index of the line after the closing `---`, or 0 when there is no frontmatter. */
function bodyStart(file: RuleFile): number {
  if (file.lines[0] !== '---') return 0;
  const close = file.lines.indexOf('---', 1);
  return close === -1 ? 0 : close + 1;
}

/** The rule file's body — everything after its frontmatter — as one string, the shape the tier parsers take. */
function bodyOf(file: RuleFile): string {
  return file.lines.slice(bodyStart(file)).join('\n');
}

/**
 * The quoted entries of the `paths:` array. The shape written by task-35 is a single
 * inline array — `paths: ["a/**", "b.ts"]` — so this reads that and nothing else: a
 * multi-line YAML list would come back empty and fail case 1 loudly, which is the
 * right outcome for a shape nobody has proved the loader accepts.
 */
function pathsOf(file: RuleFile): string[] {
  const fm = frontmatter(file);
  if (fm === null) return [];
  const line = fm.split('\n').find((l) => l.trimStart().startsWith('paths:'));
  if (!line) return [];
  return [...line.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
}

/**
 * GitHub's heading → anchor rule: lowercase, drop everything that is not a word
 * character, space or hyphen, then spaces to hyphens. Backticks and `.` vanish
 * (`` `pnpm test` `` → `pnpm-test`), and an em dash surrounded by spaces leaves the
 * doubled hyphen the real anchors in CLAUDE.md carry.
 */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

/** Every `##`/`###` heading of `docs/subsystems/invariants.md`, as anchors. */
function invariantAnchors(): Set<string> {
  const text = readFileSync(join(REPO_ROOT, INVARIANTS_REL), 'utf8');
  const anchors = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) anchors.add(slugify(m[2]));
  }
  return anchors;
}

/**
 * A `paths:` glob as a regex over repo-relative paths. Hand-rolled because there is
 * no matcher in the dependency tree (`minimatch` is not a direct dependency and pnpm's
 * layout does not expose transitive ones), and because the three shapes task-35 writes
 * are the whole grammar: `dir/**`, `dir/*.ts`, and a literal path.
 *
 * `**` crosses directory separators, `*` does not — the same distinction the loader
 * itself documents. `dir/**` also matches `dir` itself, so a rule scoped to a
 * directory is not defeated by a glob that only matched its children.
 */
function globToRegExp(pattern: string): RegExp {
  // `dir/**` names the directory and everything under it, so the separator itself is
  // part of the optional tail — otherwise the pattern would fail to match `dir`.
  if (pattern.endsWith('/**')) {
    return new RegExp(`^${escapeLiteral(pattern.slice(0, -3))}(/.*)?$`);
  }
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeLiteral(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeLiteral(text: string): string {
  return text.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
}

/**
 * Every file git would carry, repo-relative — the universe case 3 matches globs
 * against.
 *
 * Tracked files PLUS untracked-but-not-ignored ones (`--others
 * --exclude-standard`), which is the honest universe for a repo mid-change:
 * this case asks "does this glob name anything that exists", and a rule added
 * in the same commit as the directory it scopes is the ordinary way a rule
 * arrives (task-45 added `.claude/rules/tracker.md` beside
 * `server/src/tracker/`). Tracked-only made that a red suite until the commit
 * landed — a false negative on the one workflow this guard is most likely to
 * meet, with no matching gain: a typo'd or renamed glob still matches nothing
 * under either universe, and `--exclude-standard` keeps `node_modules` and
 * every other ignored path out.
 */
function trackedFiles(): string[] {
  const args = [['ls-files'], ['ls-files', '--others', '--exclude-standard']];
  const seen = new Set<string>();
  for (const argv of args) {
    for (const line of execFileSync('git', argv, { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n')) {
      if (line !== '') seen.add(line);
    }
  }
  return [...seen];
}

/*
 * The guards below are only as good as the parsers they read the two tiers through, and a parser that produced nothing would match nothing against nothing
 * and pass every guard while asserting exactly zero. So the parsers are pinned first, on strings, with the shapes the real files carry: wrapped bullets,
 * a second bold span inside the mechanism, a `Why:` link on the continuation line.
 */
describe('rule-tiers helpers', () => {
  it('joinWrapped folds continuation lines into one line', () => {
    expect(joinWrapped('- **A\n  b** c\n  d')).toBe('- **A b** c d');
  });

  it('splitBullets starts a bullet at a column-0 dash and ends it at a blank, a heading or the next start', () => {
    const bullets = splitBullets('intro\n- one\n  cont\n- two\n\n- three\n# h\n- four');
    expect(bullets.map((b) => b.raw)).toEqual(['- one\n  cont', '- two', '- three', '- four']);
    expect(bullets.map((b) => b.line)).toEqual([2, 4, 6, 8]);
  });

  it('headlineOf takes the first bold span of a bold-led bullet and nothing else', () => {
    expect(headlineOf('- **A** rest')).toBe('A');
    expect(headlineOf('- **A** and **B**')).toBe('A');
    expect(headlineOf('- plain')).toBeNull();
    expect(headlineOf('- **open')).toBeNull();
    expect(headlineOf('- **`code` and text** x')).toBe('`code` and text');
  });

  it('anchorsOf lists every invariants.md anchor in order', () => {
    expect(anchorsOf('x docs/subsystems/invariants.md#a-b y docs/subsystems/invariants.md#c_d')).toEqual(['a-b', 'c_d']);
    expect(anchorsOf('none')).toEqual([]);
  });

  it('wordCount counts whitespace-separated tokens after the dash', () => {
    expect(wordCount('- **A b** c d')).toBe(4);
  });

  it('tierOne reads from ## Invariants to the end of the file and sorts bullets by shape', () => {
    const text = [
      '## Layout',
      '- **Layout** bullet docs/subsystems/invariants.md#x',
      '## Invariants',
      'intro sentence',
      '- **L** mechanism Why: [invariants.md](docs/subsystems/invariants.md#l)',
      '- **U** short',
      '- plain one',
      '## Conventions',
      '- **C** Why: [invariants.md](docs/subsystems/invariants.md#c)'
    ].join('\n');
    const tiers = tierOne(text);
    expect(tiers.linked.map((b) => b.headline)).toEqual(['L', 'C']);
    expect(tiers.unlinked.map((b) => b.headline)).toEqual(['U']);
    expect(tiers.plain.map((b) => b.raw)).toEqual(['- plain one']);
    expect(() => tierOne('no heading here')).toThrow(/no ## Invariants heading/);
  });

  it('freeProse reports a line that is neither heading, bullet start nor continuation', () => {
    expect(freeProse('# h\n\n- **A** x\n  cont\nStray sentence.\n- **B** y', 5)).toEqual([{ line: 9, text: 'Stray sentence.' }]);
  });

  it('compareTiers names what is missing on either side and an anchor homed twice', () => {
    const b = (anchor: string, headline: string) => ({ raw: '', joined: '', headline, anchors: [anchor], words: 0, line: 0 });
    expect(
      compareTiers([b('X', 'H1'), b('Y', 'H2'), b('Y', 'H2')], [{ file: 'a', bullets: [b('X', 'H1'), b('Y', 'H2')] }])
    ).toEqual({ missingInRules: ['Y\tH2'], missingInClaude: [], multiHomed: [] });
    expect(
      compareTiers([b('X', 'H1')], [
        { file: 'a', bullets: [b('X', 'H1')] },
        { file: 'b', bullets: [b('X', 'H1')] }
      ])
    ).toEqual({ missingInRules: [], missingInClaude: ['X\tH1'], multiHomed: ['X → a, b'] });
    expect(compareTiers([b('X', 'H1')], [{ file: 'a', bullets: [b('X', 'H1 ')] }])).toEqual({
      missingInRules: ['X\tH1'],
      missingInClaude: ['X\tH1 '],
      multiHomed: []
    });
  });
});

describe('.claude/rules', () => {
  it('every rule file declares a non-empty paths: list', () => {
    const offenders = RULES.filter((file) => pathsOf(file).length === 0).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('every invariants.md anchor a rule file cites resolves to a heading', () => {
    // Guard the guard: a slugifier that produced nothing would match nothing against
    // nothing and pass this case while asserting exactly zero.
    expect(slugify('Queue wait is not work')).toBe('queue-wait-is-not-work');

    const anchors = invariantAnchors();
    expect(anchors.size).toBeGreaterThan(0);

    const broken: string[] = [];
    for (const file of RULES) {
      const cited = [...file.text.matchAll(/docs\/subsystems\/invariants\.md#([\w-]+)/g)];
      for (const m of cited) {
        if (!anchors.has(m[1])) broken.push(`${file.name} → #${m[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every paths: glob matches at least one tracked file today', () => {
    if (RULES.length === 0) return;
    const files = trackedFiles();
    const dead: string[] = [];
    for (const file of RULES) {
      for (const pattern of pathsOf(file)) {
        const re = globToRegExp(pattern);
        if (!files.some((f) => re.test(f))) dead.push(`${file.name} → ${pattern}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('a rule file is bullets and nothing else, every one anchored into invariants.md exactly once', () => {
    // The three failure shapes — a stray paragraph, a bullet with no link, a bullet with two — are pinned on fixtures by the `freeProse` and `anchorsOf`
    // cases above; this case is the real tree.
    const offenders: string[] = [];
    for (const file of RULES) {
      const body = bodyOf(file);
      const first = bodyStart(file) + 1;
      for (const prose of freeProse(body, first)) offenders.push(`${file.name}:${prose.line}: ${prose.text.slice(0, 60)}`);
      for (const bullet of tierTwo(body, first)) {
        if (bullet.anchors.length !== 1) {
          offenders.push(`${file.name}: ${bullet.headline ?? bullet.joined.slice(0, 60)} cites ${bullet.anchors.length} anchors`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CLAUDE.md headlines and rule-file bullets are the same set, one home per anchor', () => {
    const one = tierOne(CLAUDE_MD).linked;
    const two = RULES.map((file) => ({
      file: file.name,
      bullets: tierTwo(bodyOf(file), bodyStart(file) + 1).filter((b) => b.headline !== null)
    }));
    expect(compareTiers(one, two)).toEqual({ missingInRules: [], missingInClaude: [], multiHomed: [] });
  });

  it('a linked CLAUDE.md bullet is a headline and a link, and an unlinked one is short', () => {
    expect(tierOneOffenders(CLAUDE_MD)).toEqual([]);
  });

  it('the tier-one predicate sees trailing mechanism and an over-cap unlinked bullet, and forgives a wrapped headline', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    const fixture = [
      '## Invariants',
      '- **H** Why: [invariants.md](docs/subsystems/invariants.md#a)',
      '- **H2** Why: [invariants.md](docs/subsystems/invariants.md#b) More.',
      '- **H3',
      '  tail** Why:',
      '  [invariants.md](docs/subsystems/invariants.md#c)',
      `- **${words(UNLINKED_WORD_CAP)}**`,
      `- **${words(UNLINKED_WORD_CAP + 1)}**`
    ].join('\n');
    expect(tierOneOffenders(fixture)).toEqual([
      '3: - **H2** Why: [invariants.md](docs/subsystems/invariants.md#b) More.',
      `8: ${UNLINKED_WORD_CAP + 1} words`
    ]);
  });

  it('ruleFilesIn answers an empty list for an absent directory', () => {
    expect(ruleFilesIn(join(REPO_ROOT, '.claude', 'rules-does-not-exist'))).toEqual([]);
  });
});
