/**
 * jira-branch.ts — the naming rules a Jira Run's branch obeys, written once for both sides.
 *
 * The server validates the branch, base, target and name pattern on the prompt and dispatch routes; the launch sheet pre-fills and refuses the same values
 * before Start. Two copies of these rules would drift, so — like `shared/agent.ts` — this lives in `shared/` and both import it. Everything here is pure:
 * no I/O, no git, no clock.
 *
 * The character allowlist (`[A-Za-z0-9._/-]`) is deliberately NARROWER than what `git check-ref-format --branch` accepts. A branch name is pasted into a
 * shell command inside the spawn prompt (the `jira.mjs worktree` line), so the server must not rely on the session to quote it: with this allowlist a name
 * cannot carry a space, quote, `$`, backtick, `;` or newline in the first place, and `shellQuote` below is the second line of defence rather than the
 * only one. Names git would allow but this refuses (non-ASCII, `~`, `^`, `:`, `@`) are a price worth paying for a prompt nothing can escape.
 *
 * `skills/jira/tools/jira.mjs` carries its own copy of the git-name checks, because no skill tool imports `shared/`; a rule changed here has to be changed
 * there by hand, and the tool's tests pin the same Table A rows.
 */

/** Longest branch, base or target name the board accepts. */
export const BRANCH_NAME_MAX = 200;

/** The pattern a repo with no `repoDefaults` entry uses for a new branch's name. */
export const DEFAULT_NAME_PATTERN = '{key}-{slug}';

/** Longest slug `slugOf` returns. */
export const SLUG_MAX = 40;

/** What `patternProblem` renders a pattern with: a pattern is judged by the name it would produce. */
export const PATTERN_SAMPLE = { key: 'ABC-1', slug: 'sample-slug' } as const;

/** The characters between a placeholder and its neighbour that go with it when the slug is empty. */
const SEPARATORS = '-_/.';

const CHARSET = /^[A-Za-z0-9._/-]+$/;

/**
 * Why `name` cannot be a branch, or `null` when it can. Checked in a fixed order — the first hit wins — so a caller shows one sentence and a test pins
 * which. The sentences read after "Branch name" / "renders as X, which": `may not start with -`.
 */
export function branchNameProblem(name: string): string | null {
  if (name === '') return 'is empty';
  if (name.length > BRANCH_NAME_MAX) return `is longer than ${BRANCH_NAME_MAX} characters`;
  if (!CHARSET.test(name)) return 'may hold only A-Z a-z 0-9 . _ / -';
  if (name.startsWith('-')) return 'may not start with -';
  if (name.includes('..')) return 'may not contain ..';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'may not start or end with /, or contain //';
  const parts = name.split('/');
  if (parts.some((p) => p.startsWith('.'))) return 'may not have a part starting with .';
  if (parts.some((p) => p.endsWith('.lock'))) return 'may not have a part ending in .lock';
  if (name.endsWith('.')) return 'may not end with .';
  return null;
}

const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);

/**
 * Does `branch` belong to the ticket `key`? The key is compared case-insensitively and must be bounded on both sides by a non-alphanumeric character or
 * the string's end — so `feature/timify-123-x` and `hotfix/timify-123` match, `timify-1234-x` and `xtimify-123` do not. Every occurrence is tried: an
 * unbounded hit earlier in the name must not hide a bounded one later.
 */
export function branchCarriesKey(branch: string, key: string): boolean {
  if (key === '') return false;
  const hay = branch.toLowerCase();
  const needle = key.toLowerCase();
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (!isAlnum(hay[at - 1]) && !isAlnum(hay[at + needle.length])) return true;
  }
  return false;
}

/**
 * A branch-name-safe slug from a ticket summary, in five steps: lower-case and strip diacritics (NFKD, then drop the combining marks), collapse every run
 * outside `[a-z0-9]` into one `-`, trim `-` from both ends, cut at the last `-` at or before character `SLUG_MAX` (a hard cut at `SLUG_MAX` when there is
 * none), trim `-` again. A summary with nothing in `[a-z0-9]` after step 1 — `日本語`, whitespace — gives `''`.
 */
export function slugOf(summary: string): string {
  const ascii = summary.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  let slug = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > SLUG_MAX) {
    const cut = slug.lastIndexOf('-', SLUG_MAX);
    slug = slug.slice(0, cut > 0 ? cut : SLUG_MAX);
  }
  return slug.replace(/^-+|-+$/g, '');
}

/**
 * Render a name pattern for a ticket. `{key}` is the key lower-cased, `{KEY}` as Jira writes it, `{slug}` the slug. An empty slug takes `{slug}` and one
 * separator with it, so no name is left with a dangling one — `{key}-{slug}` gives `timify-123`, never `timify-123-`. The separator in FRONT of `{slug}`
 * goes, except when it is a `/` or when nothing precedes `{slug}`: then the one AFTER it goes instead (`{slug}-{key}` gives `timify-123`,
 * `feature/{slug}-{key}` gives `feature/timify-123`). A `/` is a namespace boundary the person chose, so it is kept whenever the other side offers a
 * separator to drop; only when `/` is the sole one (`{key}/{slug}`) does it go, because the alternative is a trailing `/`. The separators are `-`, `_`, `/`
 * and `.`.
 */
export function renderBranchPattern(pattern: string, key: string, slug: string): string {
  let out = pattern;
  if (slug === '') {
    const token = '{slug}';
    for (let at = out.indexOf(token); at !== -1; at = out.indexOf(token)) {
      const prev = at > 0 ? out[at - 1] : '';
      const next = out[at + token.length] ?? '';
      const prevIsSep = prev !== '' && SEPARATORS.includes(prev);
      const nextIsSep = next !== '' && SEPARATORS.includes(next);
      let from = at;
      let to = at + token.length;
      if (prevIsSep && prev !== '/') from = at - 1;
      else if (nextIsSep && (at === 0 || prev === '/')) to += 1;
      else if (prev === '/') from = at - 1;
      out = out.slice(0, from) + out.slice(to);
    }
  }
  return out.replaceAll('{key}', key.toLowerCase()).replaceAll('{KEY}', key).replaceAll('{slug}', slug);
}

/**
 * Why `base` cannot be a path's stored default base, or `null` (final review, M1). Table A first, then one rule of its own: no `origin/` prefix. The base is a
 * BRANCH name — `jira.mjs worktree` resolves it locally or as `origin/<base>` itself — so a stored `origin/develop` is looked up as `origin/origin/develop`
 * and every Start exits 4. Only the stored default gets this rule: a base or target typed at Start goes through Table A alone, as the tool judges it.
 */
export function defaultBaseProblem(base: string): string | null {
  return branchNameProblem(base) ?? (base.startsWith('origin/') ? 'is a branch name, without origin/' : null);
}

/**
 * Why `pattern` cannot name a branch, or `null`. A pattern is judged by what it produces: it renders the sample, runs `branchNameProblem` on that, then
 * `branchCarriesKey` for the sample key — a pattern whose names the board would never find again is refused at Setup, not at Start.
 */
export function patternProblem(pattern: string): string | null {
  const rendered = renderBranchPattern(pattern, PATTERN_SAMPLE.key, PATTERN_SAMPLE.slug);
  const problem = branchNameProblem(rendered);
  if (problem) return `renders as ${rendered}, which ${problem}`;
  if (!branchCarriesKey(rendered, PATTERN_SAMPLE.key)) return `renders as ${rendered}, which does not carry ${PATTERN_SAMPLE.key}`;
  return null;
}

/** Where a branch's worktree lives: `<repo>/.worktrees/<branch with every / replaced by ->`. */
export function worktreePathFor(repo: string, branch: string): string {
  return `${repo}/.worktrees/${branch.replaceAll('/', '-')}`;
}

/** Single-quote a value for a POSIX shell: always quoted, and an embedded `'` closes the quote, escapes itself and reopens (`it's` → `'it'\''s'`). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
