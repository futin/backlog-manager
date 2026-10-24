#!/usr/bin/env node
// `node scripts/ci-scope.mjs` — CI's one check command (`.github/workflows/ci.yml`, docs/workflows/ci.md §Scoped checks). It reads which files the PR
// changes and runs only what those files can break: a docs-only PR runs the few suites that read the changed docs, a skills-only PR runs the node skills
// suite plus the jest suites that read or import skills, and anything else runs `pnpm typecheck`, `pnpm build` and `pnpm test` exactly as before.
//
// Why: the full gate is ~6 min on CI (366 s on 2026-10-24), and 9 of the 30 PRs merged before this landed touched only docs or only skills — files
// typecheck and build never see (tsconfig covers server/ shared/ client/ test/ only) and most suites never read.
//
// The decision is taken INSIDE the `checks` job, never by skipping it. release-kit's ci-node.yml says why: a skipped job reports success for the same head
// sha, so a title edit after a red run would turn the PR green. Here the scope is a function of the PR's diff alone, so the `edited` re-run reaches the same
// verdict the first run did.
//
// Every doubt resolves to the full run: a push to main (the post-merge backstop), a missing or odd merge commit, a failed fetch, an empty diff, and any path
// the rules below do not name. Drift in this file therefore costs CI time, never a false green.
//
// Local `pnpm test` and an orchestrated item's verification are untouched — they still run everything. `--dry-run` prints the plan without running it, and
// `--files <paths…>` replaces the PR diff, so a scope can be checked by hand: `node scripts/ci-scope.mjs --dry-run --files docs/overview.md`.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Checked first, and they win over the extension: these change how the suites run (test-all.mjs, test-tmpdir.mjs, this file, jest's own tree, the
// workflow), so no subset of the suites can vouch for them. `.github/pull_request_template.md` is a .md file and still lands here.
const FULL_PREFIXES = ['scripts/', 'test/', '.github/'];
const SKILLS_PREFIXES = ['skills/', 'agents/'];

// 'docs' | 'skills' | 'full' for one repo-relative path.
export function classify(file) {
  if (FULL_PREFIXES.some((p) => file.startsWith(p))) return 'full';
  if (SKILLS_PREFIXES.some((p) => file.startsWith(p))) return 'skills';
  if (file.startsWith('docs/') || file.endsWith('.md')) return 'docs';
  return 'full';
}

// The scope of a whole change: the widest of its files'. No file list at all (not a PR, or the diff could not be read) and an empty one are both `full` —
// an empty diff is not a reason to run nothing, it is a sign the diff was read wrong.
export function scopeOf(files) {
  if (!files || files.length === 0) return 'full';
  const kinds = new Set(files.map(classify));
  if (kinds.has('full')) return 'full';
  return kinds.has('skills') ? 'skills' : 'docs';
}

// The names a suite could reach a changed file by. `rooted` are paths from the repo root: under `wide`, every leading directory (`skills`,
// `skills/backlog`, …) — a skills change is run broadly, since the whole node suite runs beside it anyway; otherwise only the parent directory and the
// file itself, because a docs PR is where the saving is, and `docs` alone names every doc (it picked orchestrate.test.mjs for any docs/ edit).
// `base` is the basename. `parent` is the parent directory's own name, narrow mode only — what a suite reading a whole directory spells
// (`join(ROOT, '.claude', 'rules')`, then a readdir); under `wide` it would be a skill's name like `backlog`, which half the suites use as a fixture dir.
export function pathTokens(file, { wide = false } = {}) {
  const parts = file.split('/');
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  return {
    rooted: wide ? prefixes : prefixes.slice(-2),
    base: parts[parts.length - 1],
    parent: !wide && parts.length > 1 ? parts[parts.length - 2] : null
  };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whether a suite's source names a changed file as a path piece. A rooted token must START at a quote or `../` — `'skills'`, `'../skills/x.mjs'`,
// `'docs/a.md'` — so `'../server/src/agents/x'` is not a reference to the root `agents/` (it was: an agents/ change selected 65 suites before this). The
// parent name must start at a quote too (a `join` segment); the basename may also follow a slash, as in `'../../../CLAUDE.md'`. All must END at a quote or
// a slash, so `mydocs` and `docsy` do not count. Comment lines are
// dropped first — fifty-odd client suites cite `.claude/DESIGN.md` in a header comment and read nothing. A heuristic, deliberately generous: a suite picked
// wrongly costs seconds, and one missed is caught by the push run on main.
export function mentions(source, files, options) {
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const end = `(?=['"\`/])`;
  return files.some((file) => {
    const { rooted, base, parent } = pathTokens(file, options);
    return (
      rooted.some((t) => new RegExp(`(['"\`]|\\.\\./)${escape(t)}${end}`).test(code)) ||
      new RegExp(`['"\`/]${escape(base)}${end}`).test(code) ||
      (parent !== null && new RegExp(`['"\`]${escape(parent)}${end}`).test(code))
    );
  });
}

// The suites (`{ file, source }`) that name any changed file.
export function selectSuites(changed, suites, options) {
  return suites.filter((s) => mentions(s.source, changed, options)).map((s) => s.file);
}

// The commands to run, each `{ label, cmd, args }`. `full` is the three checks the workflow used to list — the same three an orchestrated item's
// verification resolves to off package.json.
export function makePlan(files, { jest, node }) {
  const scope = scopeOf(files);
  if (scope === 'full') {
    return { scope, steps: ['typecheck', 'build', 'test'].map((s) => ({ label: `pnpm ${s}`, cmd: 'pnpm', args: [s] })) };
  }
  const steps = [];
  const jestFiles = selectSuites(files, jest, { wide: scope === 'skills' });
  if (jestFiles.length > 0) {
    steps.push({ label: `jest (${jestFiles.length} suites)`, cmd: 'pnpm', args: ['exec', 'jest', '--runInBand', '--runTestsByPath', ...jestFiles] });
  }
  if (scope === 'skills') {
    steps.push({ label: 'pnpm run test:skills', cmd: 'pnpm', args: ['run', 'test:skills'] });
  } else {
    const nodeFiles = selectSuites(files, node);
    if (nodeFiles.length > 0) {
      steps.push({ label: `node --test (${nodeFiles.length} suites)`, cmd: 'node', args: ['scripts/test-tmpdir.mjs', ...nodeFiles] });
    }
  }
  return { scope, steps };
}

// The node suites, expanded from `test:skills`'s own glob pair in package.json rather than spelled again here — test-all.mjs keeps that pair a single copy
// for the same reason. Only `*` segments occur in it, so a readdir per segment is the whole glob.
export function nodeSuitePaths(root = REPO_ROOT) {
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['test:skills'];
  const patterns = script.split(/\s+/).filter((w) => w.endsWith('.test.mjs'));
  const expand = (dir, segments) => {
    if (segments.length === 0) return [dir];
    const [head, ...rest] = segments;
    if (!head.includes('*')) return expand(dir ? `${dir}/${head}` : head, rest);
    const re = new RegExp(`^${head.split('*').map(escape).join('.*')}$`);
    let names;
    try {
      names = readdirSync(join(root, dir));
    } catch {
      return [];
    }
    return names.filter((n) => re.test(n)).flatMap((n) => expand(dir ? `${dir}/${n}` : n, rest));
  };
  return patterns.flatMap((p) => expand('', p.split('/'))).sort();
}

// jest's testMatch is `test/**/*.test.ts(x)`; the tree is flat today, but a walk costs nothing and keeps a nested suite from going unselected.
export function jestSuitePaths(root = REPO_ROOT) {
  return readdirSync(join(root, 'test'), { recursive: true })
    .map((p) => `test/${p.split('\\').join('/')}`)
    .filter((p) => /\.test\.tsx?$/.test(p))
    .sort();
}

export function readSuites(root = REPO_ROOT) {
  const read = (file) => ({ file, source: readFileSync(join(root, file), 'utf8') });
  return { jest: jestSuitePaths(root).map(read), node: nodeSuitePaths(root).map(read) };
}

// The PR's changed files, or `{ files: null, why }` for every case that must run in full. A pull_request checkout is the merge ref at depth 1, so HEAD is
// the merge commit and its first parent is the base tip it was merged onto: diffing the two is exactly what the merge would change on main. The shallow
// clone hides parents from rev-list, but the raw commit object still names them, and fetching that one parent is all the diff needs. `--no-renames`
// matters: with rename detection a file moved from server/ to docs/ would list only its new, docs-looking path.
export function prFiles(git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return { files: null, why: 'not a pull request — the full suite always runs' };
  try {
    const parents = git(['cat-file', '-p', 'HEAD'])
      .split('\n')
      .filter((l) => l.startsWith('parent '))
      .map((l) => l.slice('parent '.length).trim());
    if (parents.length !== 2) return { files: null, why: `HEAD has ${parents.length} parent(s), not a PR merge commit` };
    git(['fetch', '--no-tags', '--depth=1', 'origin', parents[0]]);
    const files = git(['diff', '--name-only', '--no-renames', parents[0], 'HEAD'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return { files, why: `${files.length} changed file(s)` };
  } catch (error) {
    return { files: null, why: `could not read the PR diff (${String(error.message).split('\n')[0]})` };
  }
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const at = argv.indexOf('--files');
  const { files, why } = at >= 0 ? { files: argv.slice(at + 1), why: 'files given by hand' } : prFiles();
  const { scope, steps } = makePlan(files, readSuites());

  const summary =
    scope === 'full'
      ? `full — ${why}`
      : `${scope}-only — ${why}; running ${steps.map((s) => s.label).join(' + ') || 'nothing (no suite reads these files)'}; typecheck and build skipped`;
  console.log(`ci-scope: ${summary}`);
  if (files && scope !== 'full') for (const f of files) console.log(`  ${f}`);
  // An annotation, so the scope is on the run's summary page and nobody has to open the log to learn a PR was not given the full suite.
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=ci scope::${summary}`);

  if (dryRun) {
    for (const s of steps) console.log(`would run: ${s.cmd} ${s.args.join(' ')}`);
    return 0;
  }
  for (const s of steps) {
    console.log(`\n▶ ${s.label}`);
    const run = spawnSync(s.cmd, s.args, { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (run.error || run.status !== 0) {
      console.log(`::error::check failed: ${s.label}`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
