import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.claude/rules/*.md` are pointers into `docs/subsystems/invariants.md`, injected
 * into a session the moment it touches a file under the rule's `paths:` glob. Every
 * property this suite asserts fails silently in production if it breaks: a rule with
 * no `paths:` is loaded into EVERY session at launch (a context-floor increase for
 * all of them, the one failure mode task-35 must never introduce); an anchor that no
 * longer resolves lands the reader at the top of a 3,000-line file; a glob that
 * matches nothing never fires at all and nothing ever says so.
 *
 * The suite reads the files as SOURCE, the way `test/csp.test.ts` and
 * `test/compose-env.test.ts` read config files — there is no YAML parser in the
 * dependency tree, and the frontmatter under test is one inline array a parser would
 * hand back verbatim anyway.
 *
 * It passes vacuously on an absent or empty directory ON PURPOSE. task-35's gate had
 * a real negative outcome — probe P3 could have come back saying path-scoped rules
 * never reach a linked worktree, in which case the correct deliverable was zero rule
 * files. This suite has to stay green in that world, so "no files" is a pass that
 * reports zero, never a failure.
 */
const REPO_ROOT = join(__dirname, '..');
const RULES_DIR = join(REPO_ROOT, '.claude', 'rules');
const INVARIANTS_REL = 'docs/subsystems/invariants.md';

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

/** Every tracked file, repo-relative — the universe case 3 matches globs against. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

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

  it('rule files are pointers only — no second copy of the reasoning', () => {
    const prose: string[] = [];
    for (const file of RULES) {
      const body = file.lines.slice(bodyStart(file));
      body.forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        if (trimmed.includes(INVARIANTS_REL) || trimmed.includes('CLAUDE.md')) return;
        prose.push(`${file.name}:${bodyStart(file) + i + 1}: ${trimmed.slice(0, 60)}`);
      });
    }
    expect(prose).toEqual([]);
  });

  it('no rule file exceeds 25 lines', () => {
    const long = RULES.filter((f) => f.lines.length > 25).map((f) => `${f.name} (${f.lines.length})`);
    expect(long).toEqual([]);
  });

  it('passes vacuously when there is no rules directory', () => {
    expect(ruleFilesIn(join(REPO_ROOT, '.claude', 'rules-does-not-exist'))).toEqual([]);
  });
});
