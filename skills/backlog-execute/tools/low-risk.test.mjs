// Cases for `low-risk.mjs`: a table over the pure `classify`, then the real CLI in a child process against a temp git repo with an `origin` remote.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './low-risk.mjs';

const SCRIPT = fileURLToPath(new URL('./low-risk.mjs', import.meta.url));

// Entry builders. `m` is a plain modification, `a` an addition; `x` overrides any field.
const m = (p, added = 1, deleted = 0, x = {}) => ({ status: 'M', path: p, oldMode: '100644', newMode: '100644', added, deleted, ...x });
const a = (p, added = 1, deleted = 0, x = {}) => ({ status: 'A', path: p, oldMode: '000000', newMode: '100644', added, deleted, ...x });
const other = (status, p, x = {}) => ({ status, path: p, oldMode: '100644', newMode: '100644', added: 1, deleted: 0, ...x });

const CASES = [
  ['empty list', [], false, null, 'empty diff'],
  ['only backlog/ rename', [other('R', 'backlog/bugs/done/x.md', { oldPath: 'backlog/bugs/open/x.md', added: 0 })], false, null, 'empty diff'],
  ['backlog/ ignored next to docs', [other('R', 'backlog/bugs/done/x.md', { oldPath: 'backlog/bugs/open/x.md', added: 0 }), m('README.md', 3, 1)], true, 'docs'],
  ['docs no size limit', [m('docs/guide.md', 500, 200)], true, 'docs'],
  ['docs/conf.py is patch', [m('docs/conf.py', 1, 1)], true, 'patch'],
  ['CMakeLists.txt is patch', [m('CMakeLists.txt', 1, 0)], true, 'patch'],
  ['LICENSE.txt docs', [m('LICENSE.txt', 900, 0)], true, 'docs'],
  ['license docs', [m('license', 900, 0)], true, 'docs'],
  ['CLAUDE.md patch', [m('CLAUDE.md', 1, 0)], true, 'patch'],
  ['nested AGENTS.md too big for patch', [m('sub/AGENTS.md', 80, 0)], false, null, '80 lines, patch limit 40'],
  ['agents/x.md patch', [m('agents/x.md', 2, 0)], true, 'patch'],
  ['tests with README', [m('test/a.test.ts', 300, 10), m('README.md', 5, 0)], true, 'tests'],
  ['spec file added', [a('src/foo.spec.ts', 50, 0)], true, 'tests'],
  ['tests/test_x.py added', [a('tests/test_x.py', 5, 0)], true, 'tests'],
  ['jest.config is patch', [m('test/jest.config.ts', 1, 0)], true, 'patch'],
  ['setup-env.ts is patch', [m('test/setup-env.ts', 1, 0)], true, 'patch'],
  ['conftest.py is patch', [m('conftest.py', 1, 0)], true, 'patch'],
  ['worked patch example', [m('src/a.ts', 12, 3), m('src/b.ts', 4, 1), m('README.md', 10, 0)], true, 'patch'],
  ['patch plus added test', [m('src/a.ts', 12, 3), m('src/b.ts', 4, 1), m('README.md', 10, 0), a('test/a.test.ts', 5, 0)], false, null, 'test/a.test.ts added'],
  ['four files', [1, 2, 3, 4].map((n) => m(`src/${n}.ts`, 1, 0)), false, null, '4 files, patch limit 3'],
  ['41 lines', [m('src/a.ts', 30, 11)], false, null, '41 lines, patch limit 40'],
  ['40 lines', [m('src/a.ts', 30, 10)], true, 'patch'],
  ['binary', [m('assets/logo.png', null, null)], false, null, 'assets/logo.png is binary'],
  ['deleted', [other('D', 'src/a.ts')], false, null, 'src/a.ts deleted'],
  ['renamed', [other('R', 'src/b.ts', { oldPath: 'src/a.ts' })], false, null, 'src/a.ts renamed'],
  ['copied', [other('C', 'src/b.ts', { oldPath: 'src/a.ts' })], false, null, 'src/a.ts copied'],
  ['type change', [other('T', 'src/a.ts')], false, null, 'src/a.ts changed type'],
  ['unmerged', [other('U', 'src/a.ts')], false, null, 'src/a.ts unmerged'],
  ['status X', [other('X', 'src/a.ts')], false, null, 'src/a.ts: status X'],
  ['submodule', [m('vendor/lib', 1, 1, { oldMode: '160000', newMode: '160000' })], false, null, 'vendor/lib is a submodule'],
  ['symlink', [a('link', 1, 0, { newMode: '120000' })], false, null, 'link is a symlink'],
  ['mode change', [m('run.sh', 0, 0, { newMode: '100755' })], false, null, 'run.sh mode changed'],
  ['add with 000000 old mode', [a('new.md', 1, 0)], true, 'docs'],
  ...[
    'package.json', 'packages/x/package.json', 'pnpm-lock.yaml', 'requirements-dev.txt', 'Gemfile.lock', 'composer.json', '.github/workflows/ci.yml',
    '.gitlab-ci.yml', 'Dockerfile.prod', 'docker-compose.dev.yml', 'db/migrations/001.sql', 'src/migrate/x.ts', '.env.local', 'config/.env',
    '.claude/rules/x.md', 'skills/foo/SKILL.md',
  ].map((p) => [`deny ${p}`, [m(p, 1, 0)], false, null, `${p} is never low-risk`]),
  ['docs/skills not denied', [m('docs/skills/x.md', 1, 0)], true, 'docs'],
  ['nested .github not denied', [m('a/.github/x.md', 1, 0)], true, 'docs'],
  ['binary beats deny', [m('package.json', null, null)], false, null, 'package.json is binary'],
  ['deny beats docs', [m('.github/x.md', 1, 0)], false, null, '.github/x.md is never low-risk'],
  ['rule-major: binary beats earlier deleted', [other('D', 'src/a.ts'), m('b.png', null, null)], false, null, 'b.png is binary'],
  ['deleted manifest says deleted', [other('D', 'package.json')], false, null, 'package.json deleted'],
  ['mode change beats deny', [m('package.json', 0, 0, { newMode: '100755' })], false, null, 'package.json mode changed'],
  ['only top-level backlog/ ignored', [m('src/backlog/x.ts', 50, 0)], false, null, '50 lines, patch limit 40'],
];

for (const [name, entries, lowRisk, category, reason] of CASES) {
  test(`classify: ${name}`, () => {
    const result = classify(entries);
    assert.equal(result.lowRisk, lowRisk);
    assert.equal(result.category, category);
    if (reason !== undefined) assert.equal(result.reason, reason);
  });
}

test('classify: counts exclude ignored backlog/ entries', () => {
  const result = classify([other('R', 'backlog/bugs/done/x.md', { oldPath: 'backlog/bugs/open/x.md', added: 0 }), m('README.md', 3, 1)]);
  assert.equal(result.files, 1);
  assert.equal(result.lines, 4);
});

test('classify: worked patch example counts 3 files, 30 lines', () => {
  const result = classify([m('src/a.ts', 12, 3), m('src/b.ts', 4, 1), m('README.md', 10, 0)]);
  assert.equal(result.files, 3);
  assert.equal(result.lines, 30);
});

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'low-risk-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const run = (cwd, args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(work, 'case-'));
  const origin = path.join(dir, 'origin.git');
  const tree = path.join(dir, 'tree');
  git(dir, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-b', 'main', tree);
  fs.writeFileSync(path.join(tree, 'README.md'), 'hello\n');
  git(tree, 'add', 'README.md');
  git(tree, 'commit', '-m', 'init');
  git(tree, 'remote', 'add', 'origin', origin);
  git(tree, 'push', 'origin', 'main');
  return tree;
}

test('cli: judges against origin/<base>, not local <base>', () => {
  const tree = makeRepo();
  fs.mkdirSync(path.join(tree, 'src'));
  fs.writeFileSync(path.join(tree, 'src/x.ts'), 'x\n'.repeat(50));
  git(tree, 'add', 'src/x.ts');
  git(tree, 'commit', '-m', 'unpushed base work');
  git(tree, 'switch', '-c', 'feature');
  fs.writeFileSync(path.join(tree, 'README.md'), 'hello\nmore\n');
  git(tree, 'commit', '-am', 'docs');
  const r = run(tree, ['--base', 'main']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.lowRisk, false);
  assert.equal(out.reason, 'src/x.ts added');
  assert.equal(out.files, 2);
});

test('cli: a docs-only branch is low-risk docs', () => {
  const tree = makeRepo();
  git(tree, 'switch', '-c', 'feature');
  fs.writeFileSync(path.join(tree, 'README.md'), 'hello\nmore\n');
  git(tree, 'commit', '-am', 'docs');
  const out = JSON.parse(run(tree, ['--base', 'main']).stdout);
  assert.deepEqual(out, { lowRisk: true, category: 'docs', reason: out.reason, files: 1, lines: 1 });
});

test('classify: a missing line count is unknown, never zero', () => {
  const result = classify([{ status: 'M', path: 'src/a.ts', oldMode: '100644', newMode: '100644' }]);
  assert.equal(result.lowRisk, false);
  assert.equal(result.reason, 'src/a.ts is binary');
});

test('cli: a rename with an edit and spaced paths is refused with the old path verbatim', () => {
  const tree = makeRepo();
  fs.mkdirSync(path.join(tree, 'old dir'));
  fs.writeFileSync(path.join(tree, 'old dir/my file.ts'), Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(''));
  git(tree, 'add', 'old dir/my file.ts');
  git(tree, 'commit', '-m', 'add');
  git(tree, 'push', 'origin', 'main');
  git(tree, 'switch', '-c', 'feature');
  fs.mkdirSync(path.join(tree, 'new dir'));
  git(tree, 'mv', 'old dir/my file.ts', 'new dir/your file.ts');
  fs.appendFileSync(path.join(tree, 'new dir/your file.ts'), 'extra\n');
  git(tree, 'add', '-A');
  git(tree, 'commit', '-m', 'rename');
  const out = JSON.parse(run(tree, ['--base', 'main']).stdout);
  assert.equal(out.lowRisk, false);
  assert.equal(out.reason, 'old dir/my file.ts renamed');
});

test('cli: a binary file is refused as binary', () => {
  const tree = makeRepo();
  git(tree, 'switch', '-c', 'feature');
  fs.writeFileSync(path.join(tree, 'logo.png'), Buffer.from([0, 1, 2, 0, 255, 0]));
  git(tree, 'add', 'logo.png');
  git(tree, 'commit', '-m', 'bin');
  const out = JSON.parse(run(tree, ['--base', 'main']).stdout);
  assert.equal(out.lowRisk, false);
  assert.equal(out.reason, 'logo.png is binary');
});

test('cli: a --base starting with a dash is a usage error', () => {
  const r = run(makeRepo(), ['--base', '--upload-pack=x']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('usage: low-risk.mjs --base <base>'), r.stderr);
});

test('cli: an unknown base is a lowRisk:false verdict, exit 0', () => {
  const tree = makeRepo();
  const r = run(tree, ['--base', 'nope']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.lowRisk, false);
  assert.equal(out.category, null);
  assert.ok(out.reason.startsWith('git: '), out.reason);
});

test('cli: missing --base is a usage error', () => {
  const r = run(makeRepo(), []);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('usage: low-risk.mjs --base <base>'), r.stderr);
});
