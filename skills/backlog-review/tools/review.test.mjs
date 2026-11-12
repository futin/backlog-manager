// Cases for `review.mjs config` and `review.mjs scope`, each run as the real CLI in a child process. Every case points BM_REVIEW_HOME and BM_REVIEW_FILE
// into a temp dir, so none reads or writes a real `~/.backlog-manager`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./review.mjs', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const DEFAULTS = {
  mode: 'split',
  same: { model: null, effort: null },
  big: { model: null, effort: null },
  small: { model: 'sonnet', effort: null },
  smallMaxLines: 300,
};

let counter = 0;
function run(args, fileContent) {
  const dir = fs.mkdtempSync(path.join(root, `c${counter++}-`));
  const file = path.join(dir, 'review.json');
  if (fileContent !== undefined) fs.writeFileSync(file, typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent));
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BM_REVIEW_HOME: dir, BM_REVIEW_FILE: file },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('config with no flags and no file prints the default config', () => {
  const r = run(['config']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${JSON.stringify(DEFAULTS)}\n`);
  assert.equal(r.stderr, '');
});

test('config reads review.json', () => {
  const written = {
    mode: 'same',
    same: { model: 'fable', effort: 'high' },
    big: { model: 'opus', effort: 'max' },
    small: { model: 'haiku', effort: 'low' },
    smallMaxLines: 50,
  };
  const r = run(['config'], written);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), written);
});

test('config flags override the file', () => {
  const file = { ...DEFAULTS, mode: 'same', same: { model: 'opus', effort: null } };
  const r = run(['config', '--review-mode', 'split', '--review-big-model', 'fable', '--review-small-max-lines', '120'], file);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ...DEFAULTS, big: { model: 'fable', effort: null }, smallMaxLines: 120 });
});

test('config accepts the default keyword and --flag=value', () => {
  const r = run(['config', '--review-mode=split', '--review-small-model=default', '--review-big-effort', 'xhigh']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ...DEFAULTS, small: { model: null, effort: null }, big: { model: null, effort: 'xhigh' } });
});

test('config with an unparseable file warns once and prints defaults', () => {
  const r = run(['config'], '{not json');
  assert.equal(r.status, 0);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 1, r.stderr);
  assert.ok(lines[0].includes('review.json'), lines[0]);
  assert.deepEqual(JSON.parse(r.stdout), DEFAULTS);
});

test('config with an invalid file value warns once and prints defaults', () => {
  for (const bad of [
    { ...DEFAULTS, smallMaxLines: '300' },
    { ...DEFAULTS, smallMaxLines: 300.5 },
    { ...DEFAULTS, same: { model: 'gpt', effort: null } },
  ]) {
    const r = run(['config'], bad);
    assert.equal(r.status, 0);
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 1, r.stderr);
    assert.ok(lines[0].includes('review.json'), lines[0]);
    assert.deepEqual(JSON.parse(r.stdout), DEFAULTS);
  }
});

test('an invalid flag exits 1 naming it', () => {
  const cases = [
    [['--review-model', 'gpt'], '--review-model'],
    [['--review-mode', 'same', '--review-model', 'gpt'], '--review-model'],
    [['--review-mode', 'split', '--review-small-max-lines', '0'], '--review-small-max-lines'],
    [['--review-mode', 'split', '--review-small-max-lines', '10001'], '--review-small-max-lines'],
    [['--review-mode', 'split', '--review-small-max-lines', '3.5'], '--review-small-max-lines'],
    [['--review-model', 'opus'], '--review-mode'],
    [['--review-mode', 'same', '--review-big-model', 'opus'], '--review-big-model'],
    [['--review-mode', 'split', '--review-model', 'opus'], '--review-model'],
    [['--review-mode', 'bogus'], '--review-mode'],
    [['--review-nope', 'x'], '--review-nope'],
  ];
  for (const [flags, name] of cases) {
    const r = run(['config', ...flags]);
    assert.equal(r.status, 1, flags.join(' '));
    assert.ok(r.stderr.includes(name), `${flags.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
  }
});

test('--review-config and flags together are an error', () => {
  const r = run(['config', '--review-config', JSON.stringify(DEFAULTS), '--review-mode', 'same']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--review-config') && r.stderr.includes('--review-mode'), r.stderr);
  assert.equal(r.stdout, '');
});

test('a valid --review-config is used as given and beats the file', () => {
  const given = { ...DEFAULTS, mode: 'same', same: { model: 'haiku', effort: 'low' } };
  const r = run(['config', '--review-config', JSON.stringify(given)], { ...DEFAULTS, smallMaxLines: 9 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), given);
});

test('an invalid --review-config exits 1 naming it', () => {
  for (const bad of ['{bad', '[]', '{"mode":"split"}']) {
    const r = run(['config', '--review-config', bad]);
    assert.equal(r.status, 1, bad);
    assert.ok(r.stderr.includes('--review-config'), r.stderr);
    assert.equal(r.stdout, '');
  }
});

test('an unknown subcommand exits 1', () => {
  const r = run(['zzz-nope']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('unknown command: zzz-nope'), r.stderr);
});

// The TS twin rejects extra keys and a pair without both members, so the CLI must too — in the file (warn + defaults) and in --review-config (exit 1).
const SHAPE_BAD = {
  'an extra top-level key': { ...DEFAULTS, extra: 1 },
  'an extra pair key': { ...DEFAULTS, big: { model: null, effort: null, extra: 1 } },
  'a pair missing effort': { ...DEFAULTS, big: { model: null } },
};

test('review.json with extra or missing keys warns once and prints defaults', () => {
  for (const [name, bad] of Object.entries(SHAPE_BAD)) {
    const r = run(['config'], bad);
    assert.equal(r.status, 0, name);
    assert.equal(r.stderr.trim().split('\n').length, 1, `${name}: ${r.stderr}`);
    assert.ok(r.stderr.includes('review.json'), name);
    assert.deepEqual(JSON.parse(r.stdout), DEFAULTS, name);
  }
});

test('--review-config with extra or missing keys exits 1 naming it', () => {
  for (const [name, bad] of Object.entries(SHAPE_BAD)) {
    const r = run(['config', '--review-config', JSON.stringify(bad)]);
    assert.equal(r.status, 1, name);
    assert.ok(r.stderr.includes('--review-config'), `${name}: ${r.stderr}`);
    assert.equal(r.stdout, '', name);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// `review.mjs scope`. Each case builds a throwaway repo under the temp root with a `main` and a feature branch, then runs the real CLI against it.

// Every git call the fixtures make: argv, no shell, an identity on the command line (CI has none globally), and GIT_OPTIONAL_LOCKS=0 so a fixture's own
// `git status` cannot refresh the index the dirty-tree case compares byte for byte.
function g(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function write(repo, rel, content) {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const lines = (n, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join('');

function commitAll(repo, message) {
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '--allow-empty', '-m', message);
}

// A repo whose `main` holds `base` (path → content), checked out on `feat` with `feat` (path → content, null deletes) committed on top.
function repoWith(base = {}, feat = {}) {
  const repo = fs.mkdtempSync(path.join(root, `repo${counter++}-`));
  g(repo, 'init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries({ 'README.md': 'readme\n', ...base })) write(repo, rel, content);
  commitAll(repo, 'base');
  g(repo, 'checkout', '-q', '-b', 'feat');
  for (const [rel, content] of Object.entries(feat)) {
    if (content === null) fs.rmSync(path.join(repo, rel));
    else write(repo, rel, content);
  }
  commitAll(repo, 'feat');
  return repo;
}

// Runs `scope` on `repo` against `main` (unless args name a --base); returns the exit, the output and the parsed manifest (null when none was written).
function scope(repo, args = [], fileContent) {
  const dir = fs.mkdtempSync(path.join(root, `s${counter++}-`));
  const out = path.join(dir, 'manifest.json');
  const file = path.join(dir, 'review.json');
  if (fileContent !== undefined) fs.writeFileSync(file, typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent));
  const base = args.includes('--base') ? [] : ['--base', 'main'];
  const r = spawnSync(process.execPath, [SCRIPT, 'scope', '--tree', repo, ...base, '--out', out, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BM_REVIEW_HOME: dir, BM_REVIEW_FILE: file },
  });
  const manifest = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, manifest, out };
}

const fileOf = (manifest, p) => manifest.files.find((f) => f.path === p);
const groupOf = (manifest, p) => manifest.groups.find((grp) => grp.files.includes(p));

test('scope gives each skip reason, and reviews a plain file', () => {
  const repo = repoWith(
    { 'old.mjs': 'old\n', 'keep.mjs': 'keep\n' },
    {
      'pnpm-lock.yaml': 'lock\n',
      'dist/a.js': 'built\n',
      'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
      'old.mjs': null,
      'backlog/open/task-1.md': '# item\n',
      'keep.mjs': 'keep\nmore\n',
    },
  );
  const r = scope(repo, ['--item', 'backlog/open/task-1.md']);
  assert.equal(r.status, 0, r.stderr);
  const expected = {
    'pnpm-lock.yaml': 'lockfile',
    'dist/a.js': 'generated',
    'img.png': 'binary',
    'old.mjs': 'deleted',
    'backlog/open/task-1.md': 'item',
  };
  for (const [p, reason] of Object.entries(expected)) {
    assert.deepEqual([fileOf(r.manifest, p)?.decision, fileOf(r.manifest, p)?.reason], ['skip', reason], p);
  }
  assert.deepEqual(fileOf(r.manifest, 'keep.mjs'), {
    path: 'keep.mjs',
    oldPath: null,
    status: 'M',
    added: 1,
    deleted: 0,
    decision: 'review',
    reason: null,
  });
  assert.equal(r.manifest.item, 'backlog/open/task-1.md');
  assert.equal(r.stdout, `${JSON.stringify({ mode: 'full', files: 6, review: 1, skip: 5, groups: 1 })}\n`);
  assert.deepEqual(r.manifest.groups.map((grp) => grp.files), [['keep.mjs']]);
});

// Every work-tree file (outside .git) with its bytes, for a before/after comparison.
function treeBytes(repo) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(repo, full)] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(repo);
  return out;
}

test('scope snapshots a dirty tree without touching the index or the work tree', () => {
  const repo = repoWith({ '.gitignore': '*.log\n', 'a.mjs': 'a\n' }, { 'a.mjs': 'a\nfeat\n' });
  write(repo, 'a.mjs', 'a\nfeat\ndirty\n');
  write(repo, 'new.mjs', 'untracked\n');
  write(repo, 'debug.log', 'ignored\n');
  // The index bytes first, before the fixture's own status call could touch anything.
  const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'));
  const statusBefore = g(repo, 'status', '--porcelain');
  const filesBefore = treeBytes(repo);
  const r = scope(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.manifest.files.map((f) => f.path).sort(), ['a.mjs', 'new.mjs']);
  assert.equal(fileOf(r.manifest, 'a.mjs').added, 2);
  assert.equal(fileOf(r.manifest, 'new.mjs').status, 'A');
  assert.ok(fs.readFileSync(path.join(repo, '.git', 'index')).equals(indexBefore), 'the real index is byte-identical');
  assert.equal(g(repo, 'status', '--porcelain'), statusBefore);
  assert.deepEqual(treeBytes(repo), filesBefore);
});

test('scope snapshots the work tree, and the real index keeps its staged content', () => {
  const repo = repoWith({ 's.mjs': 'base\n' }, {});
  write(repo, 's.mjs', 'staged A\n');
  g(repo, 'add', 's.mjs');
  write(repo, 's.mjs', 'work tree B\n');
  const r = scope(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(g(repo, 'cat-file', '-p', `${r.manifest.to}:s.mjs`), 'work tree B\n');
  assert.match(g(repo, 'diff', r.manifest.from, r.manifest.to, '--', 's.mjs'), /^\+work tree B$/m);
  assert.match(g(repo, 'diff', '--cached'), /^\+staged A$/m);
});

test('scope lists a rename into a path with a space, and a work-tree deletion as deleted', () => {
  const repo = repoWith({ 'a.mjs': lines(20), 'gone.mjs': 'gone\n' }, {});
  g(repo, 'mv', 'a.mjs', 'b c.mjs');
  fs.rmSync(path.join(repo, 'gone.mjs'));
  const r = scope(repo);
  assert.equal(r.status, 0, r.stderr);
  const renamed = fileOf(r.manifest, 'b c.mjs');
  assert.deepEqual([renamed.oldPath, renamed.status, renamed.decision], ['a.mjs', 'R', 'review']);
  assert.equal(fileOf(r.manifest, 'a.mjs'), undefined);
  assert.deepEqual([fileOf(r.manifest, 'gone.mjs').decision, fileOf(r.manifest, 'gone.mjs').reason], ['skip', 'deleted']);
});

test("scope on a clean tree takes HEAD's tree as to", () => {
  const repo = repoWith({}, { 'x.mjs': 'x\n' });
  const r = scope(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.manifest.to, g(repo, 'rev-parse', 'HEAD^{tree}').trim());
  assert.equal(r.manifest.head, g(repo, 'rev-parse', 'HEAD').trim());
  assert.equal(r.manifest.tree, g(repo, 'rev-parse', '--show-toplevel').trim());
  assert.deepEqual([r.manifest.mode, r.manifest.modeReason, r.manifest.base], ['full', null, 'main']);
});

test('scope does not list a nested checkout, with or without a commit', () => {
  const repo = repoWith({}, { 'x.mjs': 'x\n' });
  write(repo, 'nested/inner.txt', 'inner\n');
  g(path.join(repo, 'nested'), 'init', '-q');
  commitAll(path.join(repo, 'nested'), 'inner');
  write(repo, 'empty/inner.txt', 'inner\n');
  g(path.join(repo, 'empty'), 'init', '-q');
  write(repo, 'beside.mjs', 'beside\n');
  const r = scope(repo);
  assert.equal(r.status, 0, r.stderr);
  const listed = r.manifest.files.map((f) => f.path);
  assert.ok(!listed.some((p) => p.startsWith('nested') || p.startsWith('empty')), listed.join(', '));
  assert.ok(listed.includes('beside.mjs') && listed.includes('x.mjs'), listed.join(', '));
});

test('scope in full mode diffs from the merge base with the given base', () => {
  const repo = repoWith({}, {});
  g(repo, 'checkout', '-q', 'main');
  g(repo, 'checkout', '-q', '-b', 'develop');
  write(repo, 'dev.mjs', 'dev\n');
  commitAll(repo, 'develop');
  g(repo, 'checkout', '-q', '-b', 'feat2');
  write(repo, 'feat.mjs', 'feat\n');
  commitAll(repo, 'feat2');
  const r = scope(repo, ['--base', 'develop']);
  assert.equal(r.status, 0, r.stderr);
  const developBase = g(repo, 'merge-base', 'develop', 'HEAD').trim();
  assert.notEqual(developBase, g(repo, 'merge-base', 'main', 'HEAD').trim());
  assert.deepEqual([r.manifest.from, r.manifest.mergeBase], [developBase, developBase]);
  assert.deepEqual(r.manifest.files.map((f) => f.path), ['feat.mjs']);
});

// `count` files under `dir`, each `each` lines long (a single number, or one per file).
function many(dir, count, each, prefix = 'f') {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${dir}/${prefix}${String(i + 1).padStart(2, '0')}.mjs`, lines(Array.isArray(each) ? each[i] : each)]),
  );
}

test('scope does not group at both thresholds', () => {
  const r = scope(repoWith({}, many('src', 12, 100)));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.manifest.groups.length, 1);
  assert.deepEqual([r.manifest.groups[0].label, r.manifest.groups[0].files.length, r.manifest.groups[0].lines], ['all files', 12, 1200]);
});

test('scope groups above either threshold', () => {
  const byCount = scope(repoWith({}, many('src', 13, 1)));
  assert.equal(byCount.status, 0, byCount.stderr);
  assert.ok(byCount.manifest.groups.length > 1, JSON.stringify(byCount.manifest.groups));
  const byLines = scope(repoWith({}, { 'a/x.mjs': lines(700), 'b/y.mjs': lines(501) }));
  assert.equal(byLines.status, 0, byLines.stderr);
  assert.deepEqual(byLines.manifest.groups.map((grp) => grp.files), [['a/x.mjs'], ['b/y.mjs']]);
});

test('scope never splits a test/source pair', () => {
  const feat = { ...many('lib', 9, 1, 'a'), 'lib/x.mjs': 'x\n', 'lib/x.test.mjs': 'test\n', ...many('lib', 3, 1, 'z') };
  const r = scope(repoWith({}, feat));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.manifest.files.length, 14);
  assert.ok(r.manifest.groups.length > 1);
  assert.equal(groupOf(r.manifest, 'lib/x.mjs'), groupOf(r.manifest, 'lib/x.test.mjs'));
});

test('scope pairs a flat test/ suite with its one source anywhere in scope', () => {
  // Nine other files in the module, so without the pairing `test/` would be a one-file bucket that cannot fold into the full module group.
  const feat = { ...many('server/src/items', 9, 1), 'server/src/items/thing.service.ts': 'x\n', 'test/thing.service.test.ts': 't\n', ...many('docs', 4, 1) };
  const r = scope(repoWith({}, feat));
  assert.equal(r.status, 0, r.stderr);
  const grp = groupOf(r.manifest, 'test/thing.service.test.ts');
  assert.ok(grp.files.includes('server/src/items/thing.service.ts'), JSON.stringify(r.manifest.groups));
  assert.equal(grp.label, 'server/src/items/');
});

test('scope folds a one-file bucket into the previous bucket, else the next', () => {
  const previous = scope(repoWith({}, { ...many('a', 6, 1), 'b/one.mjs': 'one\n', ...many('c', 6, 1) }));
  assert.equal(previous.status, 0, previous.stderr);
  assert.deepEqual(
    previous.manifest.groups.map((grp) => [grp.label, grp.files.length]),
    [['a/', 7], ['c/', 6]],
  );
  assert.ok(groupOf(previous.manifest, 'b/one.mjs').files.includes('a/f01.mjs'));
  // a/ is full at 10 files, so b/ goes forward into c/ and that group is labelled by its first file's bucket.
  const next = scope(repoWith({}, { ...many('a', 10, 1), 'b/one.mjs': 'one\n', ...many('c', 2, 1) }));
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(
    next.manifest.groups.map((grp) => [grp.label, grp.files]),
    [['a/', Object.keys(many('a', 10, 1))], ['b/', ['b/one.mjs', 'c/f01.mjs', 'c/f02.mjs']]],
  );
});

test('scope gives the same groups for the same input', () => {
  const repo = repoWith({}, { ...many('server/src/items', 14, 3), ...many('client/src/views', 5, 40), 'docs/one.md': 'one\n' });
  const first = scope(repo);
  const second = scope(repo);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(second.manifest.groups, first.manifest.groups);
});

test('scope splits a bucket over the cap', () => {
  const r = scope(repoWith({}, many('server/src/items', 25, 2)));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.manifest.groups.length >= 3, JSON.stringify(r.manifest.groups));
  for (const grp of r.manifest.groups) {
    assert.ok(grp.files.length <= 10, JSON.stringify(grp));
    assert.equal(grp.label, 'server/src/items/');
  }
  assert.deepEqual(r.manifest.groups.map((grp) => grp.n), r.manifest.groups.map((_, i) => i + 1));
  assert.deepEqual(r.manifest.groups.flatMap((grp) => grp.files), Object.keys(many('server/src/items', 25, 2)));
});

test('scope gives one file, or one pair, over the cap a group of its own', () => {
  const file = scope(repoWith({}, { 'big/huge.mjs': lines(900), ...many('lib', 13, 1) }));
  assert.equal(file.status, 0, file.stderr);
  assert.deepEqual(groupOf(file.manifest, 'big/huge.mjs').files, ['big/huge.mjs']);
  const pair = scope(repoWith({}, { 'lib/p.mjs': lines(450), 'lib/p.test.mjs': lines(450), ...many('lib', 13, 1, 's') }));
  assert.equal(pair.status, 0, pair.stderr);
  assert.deepEqual(groupOf(pair.manifest, 'lib/p.mjs').files, ['lib/p.mjs', 'lib/p.test.mjs']);
});

test('scope on an empty diff lists nothing and dispatches nothing', () => {
  const r = scope(repoWith({}, {}), ['--item', 'backlog/open/task-1.md']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${JSON.stringify({ mode: 'full', files: 0, review: 0, skip: 0, groups: 0 })}\n`);
  assert.deepEqual([r.manifest.files, r.manifest.groups], [[], []]);
});

test('scope with every file skipped keeps an empty group 1 only for an item', () => {
  const repo = repoWith({}, { 'pnpm-lock.yaml': 'lock\n' });
  const withItem = scope(repo, ['--item', 'backlog/open/task-1.md']);
  assert.equal(withItem.status, 0, withItem.stderr);
  assert.equal(withItem.manifest.groups.length, 1);
  assert.deepEqual([withItem.manifest.groups[0].n, withItem.manifest.groups[0].files], [1, []]);
  const without = scope(repo);
  assert.equal(without.status, 0, without.stderr);
  assert.deepEqual(without.manifest.groups, []);
  assert.equal(without.stdout, `${JSON.stringify({ mode: 'full', files: 1, review: 0, skip: 1, groups: 0 })}\n`);
});

test('scope accepts an item outside the tree as an absolute path', () => {
  const repo = repoWith({}, { 'pnpm-lock.yaml': 'lock\n' });
  const outside = fs.mkdtempSync(path.join(root, `item${counter++}-`));
  write(outside, 'item.md', '# tracker item\n');
  const r = scope(repo, ['--item', path.join(outside, 'item.md')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.manifest.item, path.join(fs.realpathSync(outside), 'item.md'));
  assert.ok(!r.manifest.files.some((f) => f.reason === 'item'), JSON.stringify(r.manifest.files));
  assert.deepEqual(r.manifest.groups.map((grp) => [grp.n, grp.files]), [[1, []]]);
});

test('scope takes an in-tree item through a symlinked absolute path as in the tree', () => {
  const repo = repoWith({}, { 'backlog/open/task-1.md': '# item\n', 'x.mjs': 'x\n' });
  const link = path.join(root, `link${counter++}`);
  fs.symlinkSync(repo, link);
  const r = scope(repo, ['--item', path.join(link, 'backlog/open/task-1.md')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.manifest.item, 'backlog/open/task-1.md');
  assert.equal(fileOf(r.manifest, 'backlog/open/task-1.md').reason, 'item');
});

test('scope skips a renamed item passed by its old path', () => {
  const repo = repoWith({ 'backlog/open/task-1.md': lines(10, 'item') }, { 'x.mjs': 'x\n' });
  fs.mkdirSync(path.join(repo, 'backlog/done'));
  g(repo, 'mv', 'backlog/open/task-1.md', 'backlog/done/task-1.md');
  const r = scope(repo, ['--item', 'backlog/open/task-1.md']);
  assert.equal(r.status, 0, r.stderr);
  const moved = fileOf(r.manifest, 'backlog/done/task-1.md');
  assert.deepEqual([moved.oldPath, moved.status, moved.decision, moved.reason], ['backlog/open/task-1.md', 'R', 'skip', 'item']);
});

test('scope gives each group its model and effort', () => {
  // Three buckets, none foldable: a/ (10 files, 10 lines), b/ (3 files, 30 lines), c/ (3 files, 60 lines) — 16 files, so partitioned.
  const repo = repoWith({}, { ...many('a', 10, 1), ...many('b', 3, 10), ...many('c', 3, 20) });
  const pairs = (m) => m.groups.map((grp) => [grp.label, grp.lines, grp.model, grp.effort, grp.rerun, grp.earlier.length]);

  const same = scope(repo, ['--review-mode', 'same', '--review-model', 'fable', '--review-effort', 'high']);
  assert.equal(same.status, 0, same.stderr);
  assert.deepEqual(pairs(same.manifest), [
    ['a/', 10, 'fable', 'high', true, 0],
    ['b/', 30, 'fable', 'high', true, 0],
    ['c/', 60, 'fable', 'high', true, 0],
  ]);

  const split = scope(repo, ['--review-mode', 'split', '--review-small-max-lines', '50', '--review-big-model', 'opus', '--review-small-effort', 'low']);
  assert.equal(split.status, 0, split.stderr);
  assert.deepEqual(pairs(split.manifest), [
    ['a/', 10, 'opus', null, true, 0],
    ['b/', 30, 'sonnet', 'low', true, 0],
    ['c/', 60, 'opus', null, true, 0],
  ]);

  const given = { ...DEFAULTS, mode: 'same', same: { model: 'haiku', effort: 'max' } };
  const json = scope(repo, ['--review-config', JSON.stringify(given)], { ...DEFAULTS, mode: 'same', same: { model: 'opus', effort: null } });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(json.manifest.config, given);
  assert.ok(json.manifest.groups.every((grp) => grp.model === 'haiku' && grp.effort === 'max'));

  const flagsWin = scope(repo, ['--review-mode', 'split'], { ...DEFAULTS, mode: 'same', same: { model: 'opus', effort: null } });
  assert.equal(flagsWin.status, 0, flagsWin.stderr);
  assert.deepEqual(flagsWin.manifest.config, DEFAULTS);

  const fromFile = scope(repo, [], { ...DEFAULTS, mode: 'same', same: { model: 'opus', effort: null } });
  assert.ok(fromFile.manifest.groups.every((grp) => grp.model === 'opus'));

  const broken = scope(repo, [], '{not json');
  assert.equal(broken.status, 0);
  assert.equal(broken.stderr.trim().split('\n').length, 1, broken.stderr);
  assert.deepEqual(broken.manifest.config, DEFAULTS);
  assert.deepEqual(broken.manifest.groups.map((grp) => grp.model), [null, 'sonnet', 'sonnet']);
});

test('an invalid scope flag exits 1 naming it and writes no manifest', () => {
  const repo = repoWith({}, { 'x.mjs': 'x\n' });
  const cases = [
    [['--review-mode', 'same', '--review-effort', 'extreme'], '--review-effort'],
    [['--review-config', '{bad'], '--review-config'],
    [['--mode', 'sideways'], '--mode'],
    [['--nope', '1'], '--nope'],
  ];
  for (const [args, name] of cases) {
    const r = scope(repo, args);
    assert.equal(r.status, 1, args.join(' '));
    assert.ok(r.stderr.includes(name), `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.manifest, null, args.join(' '));
    assert.equal(r.stdout, '');
  }
  const noOut = spawnSync(process.execPath, [SCRIPT, 'scope', '--tree', repo, '--base', 'main'], {
    encoding: 'utf8',
    env: { ...process.env, BM_REVIEW_HOME: root, BM_REVIEW_FILE: path.join(root, 'none.json') },
  });
  assert.equal(noOut.status, 1);
  assert.ok(noOut.stderr.includes('--out'), noOut.stderr);
  const badBase = scope(repo, ['--base', 'no-such-branch']);
  assert.equal(badBase.status, 1);
  assert.ok(badBase.stderr.includes('merge-base'), badBase.stderr);
  assert.equal(badBase.manifest, null);
});
