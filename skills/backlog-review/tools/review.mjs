// backlog-review's CLI. `config` resolves the reviewer config the other subcommands and the skill read; `scope` turns a branch's diff into the manifest of
// file groups the reviewers are dispatched on. Later subcommands (`merge`) slot into COMMANDS. Exit codes match orchestrate.mjs, which has no exit 2:
// 0 success, 1 bad arguments, a git failure or an unknown subcommand.
//
// Self-contained by the same rule every skill's tools are: it imports nothing from another skill's `tools/`, from `server/` or from `shared/`. The reviewer
// config's validator and defaults are therefore a TWIN of `DEFAULT_REVIEW_CONFIG` / `parseReviewConfig` in `shared/agent.ts`; a change to one is a change to
// the other.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = [
  'usage: review.mjs config [--review-mode same|split] [--review-config <json>] [--review-model|--review-effort ...]',
  '       review.mjs scope --tree <dir> --base <ref> --out <manifest.json> [--item <path>] [--mode full|incremental] [--state <file>]',
  '                        [--previous <manifest.json>] [--review-config <json> | review flags]',
].join('\n');

// Closed lists. `null` (unset) means "the agent's own default" and is accepted everywhere a pair member is.
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SMALL_MAX_LINES_MIN = 1;
const SMALL_MAX_LINES_MAX = 10000;

// Twin of `DEFAULT_REVIEW_CONFIG` in `shared/agent.ts`. A function, not a constant, so no caller can mutate the shared defaults.
function defaultConfig() {
  return {
    mode: 'split',
    same: { model: null, effort: null },
    big: { model: null, effort: null },
    small: { model: 'sonnet', effort: null },
    smallMaxLines: 300,
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(object, keys, where) {
  const extra = Object.keys(object).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !Object.hasOwn(object, k));
  if (extra.length) throw new Error(`${where} has unknown key ${extra.join(', ')}`);
  if (missing.length) throw new Error(`${where} is missing ${missing.join(', ')}`);
}

// Twin of `parseReviewConfig` in `shared/agent.ts`. Returns the normalised config (all five keys, in a fixed order) or throws an Error
// whose message says what is wrong; the caller decides whether that is a warning (a file) or an exit 1 (an argument).
function validateConfig(value) {
  if (!isObject(value)) throw new Error('not an object');
  // Exactly the five keys, pairs exactly model/effort: the TS twin rejects anything else, so the CLI must not honour what the server would refuse.
  exactKeys(value, ['mode', 'same', 'big', 'small', 'smallMaxLines'], 'config');
  if (value.mode !== 'same' && value.mode !== 'split') throw new Error('mode must be "same" or "split"');
  const pair = (name) => {
    const p = value[name];
    if (!isObject(p)) throw new Error(`${name} must be an object with model and effort`);
    exactKeys(p, ['model', 'effort'], name);
    if (p.model !== null && !MODELS.includes(p.model)) throw new Error(`${name}.model must be null or one of ${MODELS.join(', ')}`);
    if (p.effort !== null && !EFFORTS.includes(p.effort)) throw new Error(`${name}.effort must be null or one of ${EFFORTS.join(', ')}`);
    return { model: p.model, effort: p.effort };
  };
  const n = value.smallMaxLines;
  if (!Number.isInteger(n) || n < SMALL_MAX_LINES_MIN || n > SMALL_MAX_LINES_MAX) {
    throw new Error(`smallMaxLines must be an integer ${SMALL_MAX_LINES_MIN}-${SMALL_MAX_LINES_MAX}`);
  }
  return { mode: value.mode, same: pair('same'), big: pair('big'), small: pair('small'), smallMaxLines: n };
}

// One flag per config member. `mode` says which reviewer mode the flag belongs to; `set` writes the already-validated value into the config.
const FLAGS = {
  '--review-model': { mode: 'same', kind: 'model', set: (c, v) => (c.same.model = v) },
  '--review-effort': { mode: 'same', kind: 'effort', set: (c, v) => (c.same.effort = v) },
  '--review-big-model': { mode: 'split', kind: 'model', set: (c, v) => (c.big.model = v) },
  '--review-big-effort': { mode: 'split', kind: 'effort', set: (c, v) => (c.big.effort = v) },
  '--review-small-model': { mode: 'split', kind: 'model', set: (c, v) => (c.small.model = v) },
  '--review-small-effort': { mode: 'split', kind: 'effort', set: (c, v) => (c.small.effort = v) },
  '--review-small-max-lines': { mode: 'split', kind: 'lines', set: (c, v) => (c.smallMaxLines = v) },
};

// `default` is how a flag says "unset": the agent's own model or effort.
function flagValue(flag, kind, raw) {
  if (kind === 'lines') {
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < SMALL_MAX_LINES_MIN || n > SMALL_MAX_LINES_MAX) {
      throw new Error(`${flag} must be an integer ${SMALL_MAX_LINES_MIN}-${SMALL_MAX_LINES_MAX}, got "${raw}"`);
    }
    return n;
  }
  if (raw === 'default') return null;
  const list = kind === 'model' ? MODELS : EFFORTS;
  if (!list.includes(raw)) throw new Error(`${flag} must be default or one of ${list.join(', ')}, got "${raw}"`);
  return raw;
}

// Parses `--flag value` and `--flag=value`; anything else is an error naming it. `optionNames` are the subcommand's own flags (`scope`'s `--tree`, …),
// kept apart from the review flags so `resolveConfig` only ever sees the latter. Returns { flags: Map, reviewConfigJson, options: Map }.
function parseArgs(args, optionNames = []) {
  const flags = new Map();
  const options = new Map();
  let reviewConfigJson;
  for (let i = 0; i < args.length; i++) {
    let name = args[i];
    let value;
    const eq = name.indexOf('=');
    if (name.startsWith('--') && eq > 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const isOption = optionNames.includes(name);
    if (!isOption && name !== '--review-mode' && name !== '--review-config' && !FLAGS[name]) throw new Error(`unknown argument: ${name}`);
    if (value === undefined) {
      value = args[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
    }
    if (isOption) options.set(name, value);
    else if (name === '--review-config') reviewConfigJson = value;
    else flags.set(name, value);
  }
  return { flags, reviewConfigJson, options };
}

function reviewFilePath(env = process.env) {
  return env.BM_REVIEW_FILE || path.join(os.homedir(), '.backlog-manager', 'settings', 'review.json');
}

// Reads `file`; a missing file is silent defaults, an unparseable or invalid one is ONE warning and defaults — a hand-edited file must never stop a review.
function readFileConfig(file, warn) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultConfig();
    warn(`review.json unreadable (${file}): ${error.message} — using the defaults`);
    return defaultConfig();
  }
  try {
    return validateConfig(JSON.parse(text));
  } catch (error) {
    warn(`review.json invalid (${file}): ${error.message} — using the defaults`);
    return defaultConfig();
  }
}

// `--review-config` JSON and flags are mutually exclusive; either one beats the file, which beats the defaults. Argument errors throw (exit 1); a bad
// FILE only warns. `file` is the review.json path.
export function resolveConfig({ flags = new Map(), reviewConfigJson, file, warn = () => {} }) {
  if (reviewConfigJson !== undefined && flags.size > 0) {
    throw new Error(`--review-config and ${[...flags.keys()].join(', ')} are mutually exclusive`);
  }
  if (reviewConfigJson !== undefined) {
    try {
      return validateConfig(JSON.parse(reviewConfigJson));
    } catch (error) {
      throw new Error(`--review-config is invalid: ${error.message}`);
    }
  }
  if (flags.size === 0) return readFileConfig(file, warn);
  const mode = flags.get('--review-mode');
  if (mode === undefined) throw new Error(`${[...flags.keys()][0]} requires --review-mode`);
  if (mode !== 'same' && mode !== 'split') throw new Error(`--review-mode must be same or split, got "${mode}"`);
  const config = defaultConfig();
  config.mode = mode;
  for (const [flag, raw] of flags) {
    if (flag === '--review-mode') continue;
    const spec = FLAGS[flag];
    if (spec.mode !== mode) throw new Error(`${flag} belongs to --review-mode ${spec.mode}, not ${mode}`);
    spec.set(config, flagValue(flag, spec.kind, raw));
  }
  return config;
}

function configCommand(args) {
  const { flags, reviewConfigJson } = parseArgs(args);
  const config = resolveConfig({ flags, reviewConfigJson, file: reviewFilePath(), warn: (line) => process.stderr.write(`${line}\n`) });
  process.stdout.write(`${JSON.stringify(config)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// scope
//
// What is reviewed is a pair of git objects, `from` and `to`, and every diff anyone takes afterwards — this tool, each reviewer — is `git diff <from> <to>`.
// `to` is a snapshot of the work tree as it is now (HEAD plus every uncommitted and untracked change, gitignored files excluded), so a review of a dirty
// checkout reviews what is on disk, not what was last committed. `from` in full mode is the merge base of the base and HEAD, which is exactly what
// `<base>...HEAD` diffs from; incremental mode takes it from the branch's state file instead (the `to` of the last complete review).

// Soft constants, one place each. Above either SPLIT_* the reviewable files are partitioned; each group is then capped at the GROUP_* pair — except one
// file, or one test/source pair, over it, which becomes a group of its own: the cap is exceeded rather than a file split or a pair broken.
const SPLIT_MAX_FILES = 12;
const SPLIT_MAX_LINES = 1200;
const GROUP_MAX_FILES = 10;
const GROUP_MAX_LINES = 800;

// The skip lists may grow; the REASONS may not (`item`, `deleted`, `binary`, `lockfile`, `generated` — a closed set the merged report and coverage read).
const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
]);
const GENERATED_DIRS = new Set(['dist', 'build', 'coverage', 'node_modules']);

// `scope`'s own flags.
const SCOPE_OPTIONS = ['--tree', '--base', '--item', '--mode', '--out', '--state', '--previous'];
const GITLINK_MODE = '160000';
// A large branch's `--numstat`/`--raw` output can pass execFileSync's 1 MB default, which would kill git mid-output and fail the scope.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// Every git call: argv, never a shell. `LC_ALL=C` because the snapshot reads one of git's error messages; `GIT_OPTIONAL_LOCKS=0` so no read here refreshes
// the real index's stat cache behind the user's back. The thrown message carries git's stderr, which is what a person needs to see on an exit 1.
function git(dir, args, env = {}) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', ...env },
    });
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim();
    const failure = new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`);
    failure.stderr = stderr;
    throw failure;
  }
}

// The work tree as a git tree object, written through a temporary index outside the repo: loose objects only — no ref, no change to the real index (staged
// content stays staged exactly as it was) and none to the work tree. `read-tree HEAD` then `add -A` rather than copying the real index, so what is staged
// cannot leak into the snapshot over what is on disk. `add -A` honours `.gitignore`. A nested checkout with a commit is picked up as a gitlink, which
// `listFiles` drops; one with NO commit makes `add` fail outright, so it is excluded by name and the add retried — any other failure still fails the scope.
function snapshot(top) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-index-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    git(top, ['read-tree', 'HEAD'], env);
    const excluded = [];
    for (;;) {
      try {
        git(top, ['add', '-A', '--', '.', ...excluded.map((p) => `:(exclude,literal)${p}`)], env);
        break;
      } catch (error) {
        const match = /^error: '(.+)' does not have a commit checked out$/m.exec(error.stderr ?? '');
        if (!match || excluded.includes(match[1])) throw error;
        excluded.push(match[1]);
      }
    }
    return git(top, ['write-tree'], env).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `-z` output split into fields; the trailing NUL leaves one empty string, dropped here.
const zFields = (text) => text.split('\0').slice(0, -1);

// `--raw` rather than `--name-status`: the same status and old/new paths, plus the modes, which is how a gitlink is recognised. Both listings come from
// the same diff queue with the same options, so they line up entry for entry; a mismatch means git changed under us and is an error, not a guess.
function listFiles(top, from, to, item) {
  // `--no-relative` and `--no-color` so neither a `diff.relative` nor a `color.ui=always` in the user's config can change what is parsed.
  const common = ['--no-relative', '--no-color', '-M', '-z', from, to];
  const raw = zFields(git(top, ['diff', '--raw', ...common]));
  const entries = [];
  for (let i = 0; i < raw.length; ) {
    const [oldMode, newMode, , , score] = raw[i++].slice(1).split(' ');
    const status = score[0];
    const first = raw[i++];
    const renamed = status === 'R' || status === 'C';
    entries.push({ oldMode, newMode, status, oldPath: renamed ? first : null, path: renamed ? raw[i++] : first });
  }
  const numstat = zFields(git(top, ['diff', '--numstat', ...common]));
  const files = [];
  let n = 0;
  for (let i = 0; i < numstat.length; n++) {
    const line = numstat[i++];
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    const added = line.slice(0, tab1);
    const deleted = line.slice(tab1 + 1, tab2);
    // A rename leaves the name empty and spells the old and new path as the next two fields.
    let name = line.slice(tab2 + 1);
    if (name === '') {
      i++;
      name = numstat[i++];
    }
    const entry = entries[n];
    if (!entry || entry.path !== name) throw new Error(`git diff --raw and --numstat disagree at ${name}`);
    // A gitlink is a nested checkout `add -A` picked up: no reviewer can cover it and no skip reason fits, so it is not a file of this review at all.
    if (entry.oldMode === GITLINK_MODE || entry.newMode === GITLINK_MODE) continue;
    const binary = added === '-';
    const file = {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
    };
    const reason = skipReason(file, binary, item);
    files.push({ ...file, decision: reason ? 'skip' : 'review', reason });
  }
  if (n !== entries.length) throw new Error('git diff --raw and --numstat disagree on the number of files');
  return files;
}

// First matching rule wins, in this order: the item is read as the contract, and a deleted file stays visible as context, whatever else it was. The item
// matches by its old path too: a groom or execute that moves `open/x.md` → `done/x.md` is still handed the path it started from.
function skipReason(file, binary, item) {
  if (item !== null && (file.path === item || file.oldPath === item)) return 'item';
  if (file.status === 'D') return 'deleted';
  if (binary) return 'binary';
  const segments = file.path.split('/');
  const base = segments[segments.length - 1];
  if (LOCKFILES.has(base)) return 'lockfile';
  if (segments.slice(0, -1).some((s) => GENERATED_DIRS.has(s)) || base.endsWith('.min.js') || base.endsWith('.map')) return 'generated';
  return null;
}

const TEST_FILE = /^(.+)\.(?:test|spec)\.([^.]+)$/;

// The bucket a path belongs to: one server module, one client area, one skill, else its first two directories (`./` for a file at the top).
function bucketKey(file) {
  const dirs = file.split('/').slice(0, -1);
  if ((dirs[0] === 'server' || dirs[0] === 'client') && dirs[1] === 'src' && dirs.length >= 3) return `${dirs.slice(0, 3).join('/')}/`;
  return dirs.length ? `${dirs.slice(0, 2).join('/')}/` : './';
}

// Pairs a test with its source so a reviewer sees both: `x.test.<ext>`/`x.spec.<ext>` with `x.<ext>` beside it, and a flat `test/<name>.test.ts(x)` with
// the ONE reviewable `<name>.ts(x)` anywhere in scope (none or several is ambiguous, so unpaired). Union-find, so a source with two tests is one unit of
// three. Returns the units in path order, each { files (sorted), lines, key } — `key` from a source member, so a `test/` pair lands in its source's bucket.
function pairUnits(reviewable) {
  const paths = reviewable.map((f) => f.path);
  const inScope = new Set(paths);
  const byName = new Map();
  for (const p of paths) {
    const name = path.posix.basename(p);
    byName.set(name, [...(byName.get(name) ?? []), p]);
  }
  const parent = new Map(paths.map((p) => [p, p]));
  const find = (p) => (parent.get(p) === p ? p : find(parent.get(p)));
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const p of paths) {
    const dir = path.posix.dirname(p);
    const match = TEST_FILE.exec(path.posix.basename(p));
    if (!match) continue;
    const sibling = `${dir === '.' ? '' : `${dir}/`}${match[1]}.${match[2]}`;
    if (inScope.has(sibling)) union(p, sibling);
    else if (dir === 'test' && (match[2] === 'ts' || match[2] === 'tsx')) {
      const candidates = [`${match[1]}.ts`, `${match[1]}.tsx`].flatMap((name) => byName.get(name) ?? []);
      if (candidates.length === 1) union(p, candidates[0]);
    }
  }
  const lines = new Map(reviewable.map((f) => [f.path, f.added + f.deleted]));
  const members = new Map();
  for (const p of paths) members.set(find(p), [...(members.get(find(p)) ?? []), p]);
  return [...members.values()]
    .map((files) => {
      files.sort(byPath);
      const source = files.find((f) => !TEST_FILE.test(path.posix.basename(f))) ?? files[0];
      return { files, lines: files.reduce((sum, f) => sum + lines.get(f), 0), key: bucketKey(source) };
    })
    .sort((a, b) => byPath(a.files[0], b.files[0]));
}

// Code-point order, never locale order: the same diff must give the same groups on every machine.
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fits = (group, files, lines) => group.files.length + files <= GROUP_MAX_FILES && group.lines + lines <= GROUP_MAX_LINES;

// Consecutive chunks in path order, never breaking a unit. A unit that cannot fit even an empty chunk takes one alone, and nothing joins it after.
function chunkUnits(units) {
  const chunks = [];
  let current = null;
  for (const unit of units) {
    if (current && fits(current, unit.files.length, unit.lines)) {
      current.files.push(...unit.files);
      current.lines += unit.lines;
    } else {
      current = { files: [...unit.files], lines: unit.lines };
      chunks.push(current);
    }
  }
  return chunks;
}

// The grouping algorithm, deterministic, in the plan's order: one group under both thresholds; else pair, bucket, split over the cap, fold one-file
// buckets into the nearest bucket (previous, else next) while the cap allows, order by first path. Returns [{ label, files, lines }] without n/model.
function partition(reviewable) {
  const sorted = [...reviewable].sort((a, b) => byPath(a.path, b.path));
  const total = sorted.reduce((sum, f) => sum + f.added + f.deleted, 0);
  if (sorted.length <= SPLIT_MAX_FILES && total <= SPLIT_MAX_LINES) return [{ label: 'all files', files: sorted.map((f) => f.path), lines: total }];
  const units = pairUnits(sorted);
  const keyOf = new Map();
  const byKey = new Map();
  for (const unit of units) {
    for (const f of unit.files) keyOf.set(f, unit.key);
    byKey.set(unit.key, [...(byKey.get(unit.key) ?? []), unit]);
  }
  const buckets = [...byKey.keys()].sort(byPath).map((key) => ({ key, chunks: chunkUnits(byKey.get(key)) }));
  for (let i = 0; i < buckets.length; i++) {
    const { chunks } = buckets[i];
    if (chunks.length !== 1 || chunks[0].files.length !== 1) continue;
    const [only] = chunks;
    const previous = buckets.slice(0, i).findLast((b) => b.chunks.length)?.chunks.at(-1);
    const next = buckets.slice(i + 1).find((b) => b.chunks.length)?.chunks[0];
    const target = [previous, next].find((g) => g && fits(g, 1, only.lines));
    if (!target) continue;
    target.files.push(only.files[0]);
    target.lines += only.lines;
    buckets[i].chunks = [];
  }
  return buckets
    .flatMap((b) => b.chunks)
    .map((chunk) => {
      const files = [...chunk.files].sort(byPath);
      return { label: keyOf.get(files[0]), files, lines: chunk.lines };
    })
    .sort((a, b) => byPath(a.files[0], b.files[0]));
}

// Groups with their reviewer pair. Group 1 carries the item checks (and, in a later task, earlier findings nobody else owns), so in split mode it is
// always `big`; the rest are `small` up to `smallMaxLines`. An empty diff is no groups (the caller says what that means); a diff where every file is
// skipped still dispatches an empty group 1 when there is an item to check against it.
function groupFiles(files, hasItem, config) {
  const reviewable = files.filter((f) => f.decision === 'review');
  let groups;
  if (files.length === 0) groups = [];
  else if (reviewable.length === 0) groups = hasItem ? [EMPTY_GROUP_1] : [];
  else groups = partition(reviewable);
  return groups.map((g, i) => dispatchGroup(g, i, config));
}

// Group 1 with no files of its own: dispatched for the item checks and for earlier findings no other group owns.
const EMPTY_GROUP_1 = { label: 'all files', files: [], lines: 0 };

function dispatchGroup(g, i, config) {
  const pair = config.mode === 'same' ? config.same : i === 0 || g.lines > config.smallMaxLines ? config.big : config.small;
  // `rerun` is true for every group of a fresh partition (only `--previous` sets one false); `earlier` is filled by `assignEarlier`.
  return { n: i + 1, label: g.label, files: [...g.files], lines: g.lines, model: pair.model, effort: pair.effort, rerun: true, earlier: [] };
}

// Hands each earlier finding to exactly one group, which marks it resolved or open in its report: the group holding the finding's file when that group
// may take it (`owns` — in a `--previous` re-review only a re-running group can), else group 1, which is always dispatched. Group files are `review`
// files only, so an unanchored finding, the item file and a deleted file all land in group 1 without a rule of their own. A finding with no group to go
// to creates an empty group 1 rather than being dropped — dropping it would let the next verdict approve a branch whose finding nobody looked at.
function assignEarlier(groups, findings, config, owns = () => true) {
  if (findings.length === 0) return groups;
  const out = groups.length ? groups : [dispatchGroup(EMPTY_GROUP_1, 0, config)];
  for (const f of findings) {
    const owner = (f.path !== null && out.find((grp) => owns(grp) && grp.files.includes(f.path))) || out[0];
    owner.earlier.push(f);
  }
  return out;
}

// realpath for a path that may not exist (an item moved or deleted in the work tree): the nearest existing ancestor is resolved and the rest re-joined, so
// a symlinked prefix — macOS's /var → /private/var above all — never makes an in-tree path look like an outside one.
function realpathLoose(p) {
  try {
    return fs.realpathSync(p);
  } catch (error) {
    const parent = path.dirname(p);
    if (error?.code !== 'ENOENT' || parent === p) throw error;
    return path.join(realpathLoose(parent), path.basename(p));
  }
}

// `--item` is relative to `--tree`, or absolute. Inside the repo it is stored relative to the repo top, the form every diff path has, so the `item` skip
// rule can match it. Outside — a tracker item's snapshot under the run-state dir or a temp file, which is where every tracker item lives — it is stored as
// an absolute path: it matches no diff file, but it is still the item group 1 checks the branch against.
function itemPath(top, tree, item) {
  const abs = realpathLoose(path.resolve(fs.realpathSync(tree), item));
  const rel = path.relative(fs.realpathSync(top), abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The branch's review state. `merge` writes it after every review whose coverage is complete; `scope` reads it here to pick the mode and to hand out the
// findings that review left open. It lives outside the repo, one file per repo and branch, so that no review ever writes the tree it reviews.

const HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FALLBACK = {
  missing: 'no earlier review',
  base: 'base changed',
  mergeBase: 'base moved — merged or rebased onto a newer base',
  head: 'history rewritten',
  snapshot: 'earlier snapshot gone'
};

// `--state` when given; else `<BM_REVIEW_HOME or ~/.backlog-manager/reviews>/<repo key>/<branch>.json`, or null on a detached HEAD, which has no branch to
// remember a review by. The repo key is the main checkout's directory name plus 8 hex of the sha1 of its absolute path: readable in a listing, and two
// clones with the same name never share a state. The main checkout, not `top`, so a linked worktree and the main tree see one state per branch — a
// branch is checked out in at most one of them at a time. `/` in a branch becomes `__`, so `feature/x` is a file name, not a directory.
export function statePath(top, explicit, env = process.env) {
  if (explicit !== undefined) return path.resolve(explicit);
  let branch;
  try {
    branch = git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  } catch {
    return null;
  }
  const main = path.dirname(git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const key = `${path.basename(main)}-${createHash('sha1').update(main).digest('hex').slice(0, 8)}`;
  const home = env.BM_REVIEW_HOME || path.join(os.homedir(), '.backlog-manager', 'reviews');
  return path.join(home, key, `${branch.replaceAll('/', '__')}.json`);
}

const isFinding = (f) => isObject(f) && (f.path === null || typeof f.path === 'string');

// The state as `merge` wrote it, or null when there is none to trust. Missing, half-written (a concurrent writer, a crash) or the wrong shape all read as
// "no earlier review": a damaged state can only ever cost a full review, never stop one. The object ids are checked as hex because they go to git as argv.
function readState(file) {
  if (file === null) return null;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(state) || typeof state.base !== 'string' || typeof state.report !== 'string' || typeof state.verdict !== 'string') return null;
  if (![state.head, state.mergeBase, state.to].every((oid) => typeof oid === 'string' && HEX_OID.test(oid))) return null;
  if (!Array.isArray(state.open) || !state.open.every(isFinding)) return null;
  return state;
}

const gitOk = (top, args) => {
  try {
    git(top, args);
    return true;
  } catch {
    return false;
  }
};

// Spec §3's checks, in its order; the first that fails names the fallback. The merge-base and ancestry checks are what keep a merge of the base, a rebase
// or a re-created branch of the same name from pouring other people's commits into the increment.
function selectMode(top, state, base, head, mergeBase) {
  if (state === null) return FALLBACK.missing;
  if (state.base !== base) return FALLBACK.base;
  if (state.mergeBase !== mergeBase) return FALLBACK.mergeBase;
  if (!gitOk(top, ['merge-base', '--is-ancestor', state.head, head])) return FALLBACK.head;
  if (!gitOk(top, ['cat-file', '-e', `${state.to}^{tree}`])) return FALLBACK.snapshot;
  return null;
}

// Where `merge` leaves a review's merged open findings, beside its manifest; `--previous` reads them from there.
export const findingsPath = (manifestPath) => `${manifestPath}.findings.json`;

// The previous round's manifest and its merged findings. Either one unreadable is exit 1: a re-review that silently lost the previous round's findings
// would approve an item whose findings nobody re-checked, and `merge` always writes the findings file, even as `[]`.
function readPrevious(file) {
  const read = (p, what) => {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (error) {
      throw new Error(`--previous: cannot read the ${what} ${p}: ${error.message}`);
    }
  };
  const manifest = read(file, 'manifest');
  const groupOk = (grp) => isObject(grp) && typeof grp.label === 'string' && Array.isArray(grp.files) && 'model' in grp && 'effort' in grp;
  const shaped = isObject(manifest) && typeof manifest.to === 'string' && HEX_OID.test(manifest.to);
  if (!shaped || !Array.isArray(manifest.groups) || !manifest.groups.every(groupOk)) {
    throw new Error(`--previous: ${file} is not a scope manifest`);
  }
  const findings = read(findingsPath(file), 'findings file');
  if (!Array.isArray(findings) || !findings.every(isFinding)) throw new Error(`--previous: ${findingsPath(file)} is not an array of findings`);
  return { manifest, findings };
}

// The fix-loop re-review. The partition, labels, model and effort are the previous round's, so a group's reports stay comparable round to round and a
// `--carried` report still maps to its group by number. Each group keeps only the files still reviewable in this diff (a file reverted to the base or
// deleted by the fix is nobody's to read); a file new to the diff joins group 1. A group re-runs when it is group 1, or when a file it held changed
// between the previous snapshot and this one — and still has a file to read. A previous round with no groups (nothing was reviewable) has no partition
// to keep, so this one is partitioned afresh.
function previousGroups(top, previous, to, files, hasItem, config) {
  if (previous.groups.length === 0) return groupFiles(files, hasItem, config);
  const reviewable = new Set(files.filter((f) => f.decision === 'review').map((f) => f.path));
  const linesOf = new Map(files.map((f) => [f.path, f.added + f.deleted]));
  // `--no-renames`: a renamed file is its old path gone and its new path added, so both count as changed.
  const changed = new Set(zFields(git(top, ['diff', '--name-only', '--no-relative', '--no-renames', '-z', previous.to, to])));
  const known = new Set(previous.groups.flatMap((grp) => grp.files));
  const groups = previous.groups.map((grp, i) => {
    const kept = grp.files.filter((p) => reviewable.has(p));
    const rerun = i === 0 || (kept.length > 0 && grp.files.some((p) => changed.has(p)));
    return { n: i + 1, label: grp.label, files: kept, lines: 0, model: grp.model, effort: grp.effort, rerun, earlier: [] };
  });
  groups[0].files.push(...[...reviewable].filter((p) => !known.has(p)).sort(byPath));
  for (const grp of groups) grp.lines = grp.files.reduce((sum, p) => sum + linesOf.get(p), 0);
  return groups;
}

// Temp file + rename in the same directory, so a reader never sees half a manifest.
function writeManifest(out, manifest) {
  const target = path.resolve(out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temp, target);
}

// `--mode full` is full with no reason. An omitted `--mode` and `--mode incremental` are the same request — incremental when the branch's state allows it,
// else full with the reason (spec §3). `--previous` is always full: a fix-loop gate re-reads each touched group's whole files, not the fix commit's lines.
function scopeCommand(args) {
  const { flags, reviewConfigJson, options } = parseArgs(args, SCOPE_OPTIONS);
  for (const name of ['--tree', '--base', '--out']) if (!options.has(name)) throw new Error(`scope needs ${name}`);
  const asked = options.get('--mode');
  if (asked !== undefined && asked !== 'full' && asked !== 'incremental') throw new Error(`--mode must be full or incremental, got "${asked}"`);
  if (options.has('--previous') && asked === 'incremental') throw new Error('--previous is a full-mode re-review; it cannot take --mode incremental');
  // Every argument error is raised here, before any git call, so a bad flag never leaves a manifest or a loose object behind.
  const config = resolveConfig({ flags, reviewConfigJson, file: reviewFilePath(), warn: (line) => process.stderr.write(`${line}\n`) });
  const previous = options.has('--previous') ? readPrevious(options.get('--previous')) : null;
  const tree = options.get('--tree');
  const base = options.get('--base');
  const top = git(tree, ['rev-parse', '--show-toplevel']).trim();
  const item = options.has('--item') ? itemPath(top, tree, options.get('--item')) : null;
  const head = git(top, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  let mergeBase;
  try {
    mergeBase = git(top, ['merge-base', base, head]).trim();
  } catch (error) {
    // `merge-base` exits 1 with no output when the histories share nothing; a bad ref says so on stderr itself.
    throw error.stderr ? error : new Error(`${base} and HEAD have no merge base`);
  }
  let state = null;
  let modeReason = null;
  if (previous === null && asked !== 'full') {
    state = readState(statePath(top, options.get('--state')));
    modeReason = selectMode(top, state, base, head, mergeBase);
  }
  const mode = state !== null && modeReason === null ? 'incremental' : 'full';
  const to = snapshot(top);
  const from = mode === 'incremental' ? state.to : mergeBase;
  const out = options.get('--out');
  const summary = (files, groups) => {
    const review = files.filter((f) => f.decision === 'review').length;
    return { mode, files: files.length, review, skip: files.length - review, groups: groups.length };
  };
  if (modeReason !== null) process.stderr.write(`full review: ${modeReason}\n`);
  if (mode === 'incremental' && from === to) {
    // Printed here, not by the three callers, so the sentence cannot be worded three ways.
    writeManifest(out, { tree: top, base, mode, modeReason, from, to, mergeBase, head, item, config, files: [], groups: [] });
    process.stderr.write(`no changes since the last review (${state.report}) — its verdict stands: ${state.verdict}\n`);
    process.stdout.write(`${JSON.stringify({ ...summary([], []), noChange: true })}\n`);
    return 0;
  }
  const files = listFiles(top, from, to, item);
  let groups;
  if (previous !== null) {
    groups = previousGroups(top, previous.manifest, to, files, item !== null, config);
    groups = assignEarlier(groups, previous.findings, config, (grp) => grp.rerun);
  } else {
    groups = groupFiles(files, item !== null, config);
    if (mode === 'incremental') groups = assignEarlier(groups, state.open, config);
  }
  writeManifest(out, { tree: top, base, mode, modeReason, from, to, mergeBase, head, item, config, files, groups });
  process.stdout.write(`${JSON.stringify(summary(files, groups))}\n`);
  return 0;
}

// Subcommand table: a later task adds a row, never a branch in `main`.
const COMMANDS = { config: configCommand, scope: scopeCommand };

export function main(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!handler) {
    process.stderr.write(`unknown command: ${command}\n${USAGE}\n`);
    return 1;
  }
  try {
    return handler(rest);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

// Twin of `isMain` in `skills/backlog/tools/backlog.mjs`, which carries the reasoning; `scripts/run-as-main.test.mjs` pins every copy.
function isMain(url) {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// `process.exitCode`, NOT `process.exit()`: writing to a pipe is asynchronous and `process.exit()` never drains it, so a large payload would be cut.
// retro.mjs's entry guard carries the full record. Nothing here holds a live handle, so returning from `main` lets the process end on its own.
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
