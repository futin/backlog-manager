// backlog-execute's low-risk diff classifier. After execute opens a PR with `--low-risk-auto-merge`, it runs `low-risk.mjs --base <base>` in its tree and only a
// verdict of `lowRisk: true` lets it arm GitHub auto-merge. The rules are the spec's "The classifier" (docs/superpowers/specs/2026-11-24-execute-low-risk-auto-
// merge-design.md) and must hold on ANY registered project, so nothing here reuses `scripts/ci-scope.mjs`, whose prefixes are this repo's. They are constants,
// not per-project configuration.
//
// Exit codes: 0 for either verdict (a git failure is a `lowRisk: false` verdict whose reason is git's error, never a crash), 2 for a usage error.
//
// Self-contained by the same rule every skill's tools are: it imports nothing from another skill's `tools/`, from `server/` or from `shared/`. It runs git
// only through `spawnSync` and only ever READS the tree (`git fetch` updates a remote-tracking ref, never the working tree or a branch).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: low-risk.mjs --base <base>';

const PATCH_MAX_FILES = 3;
const PATCH_MAX_LINES = 40;

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.rst', '.adoc']);
const DOC_BASENAME = /^(readme|license|changelog|notice|authors|contributing)(\.txt)?$/i;
// Markdown that is behaviour, never docs (still patch-eligible: not on the deny list).
const AGENT_INSTRUCTIONS = /^(claude|agents|gemini)\.md$/i;

// A test file is a test only when it is not a runner config: those change how every suite runs.
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec']);
const TEST_NAME = /\.(test|spec)\.|_test\.|^test_[^/]*\./;
const RUNNER_CONFIG = /^((jest|vitest|playwright)\.config\..*|pytest\.ini|conftest\.py)$/;

// Basenames denied at any depth: manifests, lockfiles, CI and container config.
const DENY_BASENAME = [
  /^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock)$/,
  /^requirements.*\.txt$/,
  /^Gemfile/,
  /^composer\./,
  /^\.gitlab-ci\.yml$/,
  /^Dockerfile/,
  /^docker-compose.*\.yml$/,
];
// Matched against any path segment, directory or file.
const DENY_SEGMENT = [/^migrations$/, /^migrate$/, /^\.env/];
// Matched against the first segment only: `docs/skills/x.md` is documentation, `skills/x` is a skill.
const DENY_TOP = new Set(['.github', '.claude', 'skills']);

const REGULAR = new Set(['100644', '100755']);

const verdict = (lowRisk, category, reason, files, lines) => ({ lowRisk, category, reason, files, lines });

function isDenied(file) {
  const segments = file.split('/');
  const base = segments[segments.length - 1];
  return (
    DENY_TOP.has(segments[0]) ||
    DENY_BASENAME.some((re) => re.test(base)) ||
    segments.some((segment) => DENY_SEGMENT.some((re) => re.test(segment)))
  );
}

function isDocs(file) {
  const segments = file.split('/');
  const base = segments[segments.length - 1];
  if (segments[0] === 'agents' && segments.length > 1) return false;
  if (AGENT_INSTRUCTIONS.test(base)) return false;
  return DOC_EXTENSIONS.has(path.extname(base).toLowerCase()) || DOC_BASENAME.test(base);
}

function isTest(file) {
  const segments = file.split('/');
  const base = segments[segments.length - 1];
  const inTestDir = segments.slice(0, -1).some((segment) => TEST_DIRS.has(segment));
  if (RUNNER_CONFIG.test(base)) return false;
  if (inTestDir && /^setup.*\.ts$/.test(base)) return false;
  return inTestDir || TEST_NAME.test(base);
}

// A rename out of `backlog/` into somewhere else is real work; only entries that live wholly under the top-level `backlog/` are the skill's bookkeeping.
const isBookkeeping = (entry) => entry.path.startsWith('backlog/') && (entry.oldPath === undefined || entry.oldPath.startsWith('backlog/'));

// Pure. `entries` is `{ status, path, oldPath?, oldMode, newMode, added, deleted }` with `added`/`deleted` null for a binary file. Checks run RULE-major, not
// file-major, in the spec's order, so the reason always names the first failing RULE: binary, status, mode kind, mode change, deny, then the category rules.
export function classify(entries) {
  const list = entries.filter((entry) => !isBookkeeping(entry));
  if (list.length === 0) return verdict(false, null, 'empty diff', 0, 0);
  const files = list.length;
  const lines = list.reduce((sum, entry) => sum + (entry.added ?? 0) + (entry.deleted ?? 0), 0);
  const no = (reason) => verdict(false, null, reason, files, lines);

  for (const entry of list) if (entry.added === null || entry.deleted === null) return no(`${entry.path} is binary`);

  for (const entry of list) {
    const { status } = entry;
    if (status === 'M' || status === 'A') continue;
    const from = entry.oldPath ?? entry.path;
    if (status === 'D') return no(`${entry.path} deleted`);
    if (status === 'R') return no(`${from} renamed`);
    if (status === 'C') return no(`${from} copied`);
    if (status === 'T') return no(`${entry.path} changed type`);
    if (status === 'U') return no(`${entry.path} unmerged`);
    return no(`${entry.path}: status ${status}`);
  }

  for (const entry of list) {
    for (const mode of [entry.oldMode, entry.newMode]) {
      if (mode === '160000') return no(`${entry.path} is a submodule`);
      if (mode === '120000') return no(`${entry.path} is a symlink`);
    }
  }
  // An add's `000000` old mode counts as regular; any other disagreement (or an unknown mode) is a mode change.
  for (const entry of list) {
    const oldOk = entry.status === 'A' ? entry.oldMode === '000000' || REGULAR.has(entry.oldMode) : REGULAR.has(entry.oldMode);
    const same = entry.status === 'A' || entry.oldMode === entry.newMode;
    if (!oldOk || !REGULAR.has(entry.newMode) || !same) return no(`${entry.path} mode changed`);
  }

  for (const entry of list) if (isDenied(entry.path)) return no(`${entry.path} is never low-risk`);

  if (list.every((entry) => isDocs(entry.path))) return verdict(true, 'docs', 'documentation only', files, lines);
  if (list.every((entry) => isDocs(entry.path) || isTest(entry.path))) return verdict(true, 'tests', 'tests only', files, lines);

  const added = list.find((entry) => entry.status === 'A');
  if (added) return no(`${added.path} added`);
  if (files > PATCH_MAX_FILES) return no(`${files} files, patch limit ${PATCH_MAX_FILES}`);
  if (lines > PATCH_MAX_LINES) return no(`${lines} lines, patch limit ${PATCH_MAX_LINES}`);
  return verdict(true, 'patch', `small patch: ${files} files, ${lines} lines`, files, lines);
}

// Runs git in the cwd; returns { ok, out } or { ok: false, error } carrying git's first stderr line.
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const text = (result.error ? result.error.message : result.stderr) || `exit ${result.status}`;
    return { ok: false, error: text.split('\n').find((line) => line.trim() !== '') ?? `exit ${result.status}` };
  }
  return { ok: true, out: result.stdout };
}

// `git diff --raw -z`: `:<oldmode> <newmode> <oldsha> <newsha> <status>[score]\0<path>\0` and, for R/C, `\0<old>\0<new>\0`.
function parseRaw(text) {
  const parts = text.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length && parts[i] !== ''; ) {
    const [oldMode, newMode, , , statusField] = parts[i].slice(1).split(' ');
    const status = statusField[0];
    if (status === 'R' || status === 'C') {
      entries.push({ status, oldPath: parts[i + 1], path: parts[i + 2], oldMode, newMode });
      i += 3;
    } else {
      entries.push({ status, path: parts[i + 1], oldMode, newMode });
      i += 2;
    }
  }
  return entries;
}

// `git diff --numstat -z`: `<added>\t<deleted>\t<path>\0`, and for a rename `<added>\t<deleted>\t\0<old>\0<new>\0`. `-` marks a binary file. Keyed by new path.
function parseNumstat(text) {
  const parts = text.split('\0');
  const stats = new Map();
  for (let i = 0; i < parts.length && parts[i] !== ''; ) {
    const [added, deleted, file] = parts[i].split('\t');
    const counts = { added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) };
    if (file === '') {
      stats.set(parts[i + 2], counts);
      i += 3;
    } else {
      stats.set(file, counts);
      i += 1;
    }
  }
  return stats;
}

function main(argv) {
  const at = argv.indexOf('--base');
  const base = at === -1 ? undefined : argv[at + 1];
  if (!base) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const fail = (error) => {
    process.stdout.write(`${JSON.stringify(verdict(false, null, `git: ${error}`, 0, 0))}\n`);
    return 0;
  };

  // Against `origin/<base>`, never local `<base>`: the tree was cut from a local base that may be ahead of origin, and those commits ride along in the push.
  const fetched = git(['fetch', 'origin', base]);
  if (!fetched.ok) return fail(fetched.error);
  const mergeBase = git(['merge-base', 'HEAD', `origin/${base}`]);
  if (!mergeBase.ok) return fail(mergeBase.error);
  const from = mergeBase.out.trim();
  const raw = git(['diff', '--raw', '-M', '-z', from, 'HEAD']);
  if (!raw.ok) return fail(raw.error);
  const numstat = git(['diff', '--numstat', '-M', '-z', from, 'HEAD']);
  if (!numstat.ok) return fail(numstat.error);

  const stats = parseNumstat(numstat.out);
  const entries = parseRaw(raw.out).map((entry) => {
    const counts = stats.get(entry.path) ?? { added: 0, deleted: 0 };
    return { ...entry, ...counts };
  });
  process.stdout.write(`${JSON.stringify(classify(entries))}\n`);
  return 0;
}

// Twin of `isMain` in `skills/backlog/tools/backlog.mjs`, which carries the reasoning; `scripts/run-as-main.test.mjs` pins every copy.
function isMain(url) {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// `process.exitCode`, NOT `process.exit()`: writing to a pipe is asynchronous and `process.exit()` never drains it. Nothing here holds a live handle (every
// child is `spawnSync`), so returning from `main` lets the process end on its own.
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
