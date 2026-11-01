import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { classify, jestSuitePaths, makePlan, mentions, nodeSuitePaths, pathTokens, prFiles, readSuites, scopeOf, selectSuites } from './ci-scope.mjs';

// scripts/ci-scope.mjs decides how much of the gate a PR gets. The failure worth a suite is the quiet one: a rule that sorts a code change into a narrower
// bucket, or a token match that stops picking a doc guard, turns a red PR green and leaves the break for the push run on main. So the pure rules are pinned
// case by case, and the last block runs the selection against this repo's REAL suites — the guards named there are the ones that read docs and skills today.
// Nothing here runs a suite: the CLI cases are `--dry-run`, because this file is itself inside `test:skills`.
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'ci-scope.mjs');
const REPO_ROOT = join(dirname(CLI), '..');

test('classify sorts docs, skills and everything else', () => {
  const cases = {
    'docs/subsystems/invariants.md': 'docs',
    'docs/img/board.png': 'docs',
    'CLAUDE.md': 'docs',
    '.claude/rules/board.md': 'docs',
    'backlog/README.md': 'docs',
    'skills/backlog/SKILL.md': 'skills',
    'skills/backlog-orchestrate/tools/orchestrate.mjs': 'skills',
    'agents/backlog-reviewer.md': 'skills',
    'server/src/main.ts': 'full',
    'client/src/App.tsx': 'full',
    'shared/types.ts': 'full',
    'package.json': 'full',
    'pnpm-lock.yaml': 'full',
    'backlog/source.json': 'full',
    '.claude-plugin/plugin.json': 'full'
  };
  for (const [file, kind] of Object.entries(cases)) assert.equal(classify(file), kind, file);
});

test('classify sends tooling to full even when it is markdown', () => {
  // These change how the suites run, so no subset can vouch for them.
  for (const file of ['scripts/test-all.mjs', 'scripts/ci-scope.mjs', 'test/README.md', 'test/helpers/app.ts', '.github/workflows/ci.yml', '.github/pull_request_template.md']) {
    assert.equal(classify(file), 'full', file);
  }
});

test('scopeOf takes the widest bucket, and no list or an empty one is full', () => {
  assert.equal(scopeOf(null), 'full');
  assert.equal(scopeOf([]), 'full');
  assert.equal(scopeOf(['docs/a.md', 'CLAUDE.md']), 'docs');
  assert.equal(scopeOf(['docs/a.md', 'skills/backlog/SKILL.md']), 'skills');
  assert.equal(scopeOf(['docs/a.md', 'skills/backlog/SKILL.md', 'server/src/main.ts']), 'full');
});

test('pathTokens: narrow keeps the parent and the file, wide keeps every leading path and drops the parent name', () => {
  assert.deepEqual(pathTokens('docs/subsystems/invariants.md'), {
    rooted: ['docs/subsystems', 'docs/subsystems/invariants.md'],
    base: 'invariants.md',
    parent: 'subsystems'
  });
  assert.deepEqual(pathTokens('skills/backlog/SKILL.md', { wide: true }), {
    rooted: ['skills', 'skills/backlog', 'skills/backlog/SKILL.md'],
    base: 'SKILL.md',
    parent: null
  });
  assert.deepEqual(pathTokens('CLAUDE.md'), { rooted: ['CLAUDE.md'], base: 'CLAUDE.md', parent: null });
});

test('mentions needs a bounded path piece outside a comment line, and a rooted one must start at a quote or ../', () => {
  assert.equal(mentions(`const x = readFileSync(join(ROOT, 'docs', 'subsystems', 'a.md'));`, ['docs/subsystems/b.md']), true);
  assert.equal(mentions(`const x = readFileSync(join(ROOT, 'docs', 'subsystems', 'a.md'));`, ['docs/workflows/ci.md']), false);
  assert.equal(mentions(`const x = readFileSync(join(ROOT, 'docs', 'subsystems', 'a.md'));`, ['docs/workflows/ci.md'], { wide: true }), true);
  assert.equal(mentions(`import { t } from '../skills/backlog-tick/tools/tick.mjs';`, ['skills/backlog/SKILL.md'], { wide: true }), true);
  assert.equal(mentions(`const md = new URL('../../../CLAUDE.md', import.meta.url);`, ['CLAUDE.md']), true);
  assert.equal(mentions('const p = `CLAUDE.md`;', ['CLAUDE.md']), true);
  assert.equal(mentions(`const f = join(dir, 'skills', 'x', 'SKILL.md');`, ['skills/y/SKILL.md'], { wide: true }), true);
  assert.equal(mentions(`import { s } from '../server/src/agents/agents.service';`, ['agents/backlog-reviewer.md'], { wide: true }), false);
  assert.equal(mentions(`const mydocs = 'mydocs';`, ['docs/a.md']), false);
  assert.equal(mentions(`const rules = join(ROOT, '.claude', 'rules');`, ['.claude/rules/board.md']), true);
  assert.equal(mentions(`import x from '../server/src/rules/x';`, ['.claude/rules/board.md']), false);
  assert.equal(mentions(`// reads 'docs' only in prose`, ['docs/a.md']), false);
  assert.equal(mentions(` * cites '.claude/DESIGN.md' §8`, ['.claude/DESIGN.md']), false);
});

test('makePlan: full is the three checks the workflow used to list', () => {
  const { scope, steps } = makePlan(['server/src/main.ts'], { jest: [], node: [] });
  assert.equal(scope, 'full');
  assert.deepEqual(
    steps.map((s) => [s.cmd, ...s.args].join(' ')),
    ['pnpm typecheck', 'pnpm build', 'pnpm test']
  );
});

test('makePlan: skills runs the whole node suite and the jest suites that name skills, never typecheck or build', () => {
  const jest = [
    { file: 'test/a.test.ts', source: `import x from '../skills/backlog/tools/backlog.mjs';` },
    { file: 'test/b.test.ts', source: `const y = 1;` }
  ];
  const { scope, steps } = makePlan(['skills/backlog/tools/backlog.mjs'], { jest, node: [] });
  assert.equal(scope, 'skills');
  assert.deepEqual(
    steps.map((s) => [s.cmd, ...s.args].join(' ')),
    ['pnpm exec jest --runTestsByPath test/a.test.ts', 'pnpm run test:skills']
  );
});

test('makePlan: docs runs only the suites of either runner that name the changed docs, and may run nothing', () => {
  const jest = [{ file: 'test/rules.test.ts', source: `readFileSync(join(ROOT, 'CLAUDE.md'))` }];
  const node = [{ file: 'skills/x/tools/x.test.mjs', source: `readFileSync('docs/overview.md')` }];
  const both = makePlan(['CLAUDE.md', 'docs/overview.md'], { jest, node });
  assert.equal(both.scope, 'docs');
  assert.deepEqual(
    both.steps.map((s) => [s.cmd, ...s.args].join(' ')),
    ['pnpm exec jest --runTestsByPath test/rules.test.ts', 'node scripts/test-tmpdir.mjs skills/x/tools/x.test.mjs']
  );
  assert.deepEqual(makePlan(['README.md'], { jest, node }).steps, []);
});

test('prFiles is null — so full — off a pull_request event, without touching git', () => {
  const saved = process.env.GITHUB_EVENT_NAME;
  process.env.GITHUB_EVENT_NAME = 'push';
  try {
    const result = prFiles(() => assert.fail('git must not run off a pull_request'));
    assert.equal(result.files, null);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = saved;
  }
});

test('prFiles diffs the merge commit against its first parent, renames split, and any odd shape is full', () => {
  const saved = process.env.GITHUB_EVENT_NAME;
  process.env.GITHUB_EVENT_NAME = 'pull_request';
  try {
    const calls = [];
    const git = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'cat-file') return 'tree t\nparent base1\nparent head2\nauthor a\n\nmsg\n';
      if (args[0] === 'diff') return 'docs/a.md\nserver/old.ts\n';
      return '';
    };
    assert.deepEqual(prFiles(git).files, ['docs/a.md', 'server/old.ts']);
    assert.deepEqual(calls, ['cat-file -p HEAD', 'fetch --no-tags --depth=1 origin base1', 'diff --name-only --no-renames base1 HEAD']);

    assert.equal(prFiles(() => 'tree t\nparent only\n').files, null);
    assert.equal(
      prFiles(() => {
        throw new Error('fetch refused');
      }).files,
      null
    );
  } finally {
    if (saved === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = saved;
  }
});

test('the suite lists come from the real tree: jest from test/, node from test:skills in package.json', () => {
  const jest = jestSuitePaths();
  assert.ok(jest.includes('test/claude-rules.test.ts'));
  assert.ok(jest.every((f) => /^test\/.+\.test\.tsx?$/.test(f)));
  const node = nodeSuitePaths();
  assert.ok(node.includes('scripts/ci-scope.test.mjs'));
  assert.ok(node.includes('skills/backlog/tools/backlog.test.mjs'));
});

test("this repo's doc and skill guards are selected by the files they read", () => {
  const { jest, node } = readSuites();
  const picks = (file) => selectSuites([file], jest, { wide: file.startsWith('skills/') || file.startsWith('agents/') });
  const expect = {
    'CLAUDE.md': ['test/claude-rules.test.ts', 'test/dialog-count-docs.test.ts'],
    '.claude/rules/board.md': ['test/claude-rules.test.ts', 'test/dialog-count-docs.test.ts'],
    'docs/subsystems/invariants.md': ['test/dialog-count-docs.test.ts'],
    'skills/backlog-orchestrate/SKILL.md': ['test/default-model.test.ts', 'test/skills-plugin-root.test.ts', 'test/skill-plugin-root.test.ts'],
    'skills/backlog-execute/SKILL.md': ['test/agents-shared.test.ts'],
    'skills/backlog-orchestrate/tools/orchestrate.mjs': ['test/remote-runs.test.ts', 'test/uncommitted.test.ts'],
    'skills/backlog/tools/backlog.mjs': ['test/tracker-labels.test.ts'],
    'agents/backlog-reviewer.md': ['test/default-model.test.ts']
  };
  for (const [file, guards] of Object.entries(expect)) {
    const picked = picks(file);
    for (const g of guards) assert.ok(picked.includes(g), `${file} should select ${g}`);
  }

  // The node half: a docs-only PR runs these through test-tmpdir.mjs by path, so a selected suite that is not on disk would fail the PR for nothing (#428).
  const docs = ['CLAUDE.md', 'docs/subsystems/invariants.md'];
  const nodePicked = selectSuites(docs, node);
  for (const g of ['skills/backlog/tools/backlog.test.mjs', 'skills/backlog-orchestrate/tools/orchestrate-prompts.test.mjs']) {
    assert.ok(nodePicked.includes(g), `the docs list should select ${g}`);
  }
  for (const f of nodePicked) assert.ok(existsSync(join(REPO_ROOT, f)), `${f} is not on disk`);
  assert.deepEqual(makePlan(docs, { jest, node }).steps.at(-1).args, ['scripts/test-tmpdir.mjs', ...nodePicked]);
});

// A `pnpm` first on PATH that logs its first argument and exits `code`, so the CLI runs its real plan with nothing behind it. `main` answers through the
// process's exit status, so that status is what these read.
function fakePnpm(t, code) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'pnpm'), `#!/bin/sh\necho "$1" >> "${log}"\nexit ${code}\n`, { mode: 0o755 });
  return { PATH: `${dir}${delimiter}${process.env.PATH}`, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

test('main returns 1 when a step exits non-zero, and runs no step after it', (t) => {
  const pnpm = fakePnpm(t, 1);
  const out = spawnSync(process.execPath, [CLI, '--files', 'server/src/main.ts'], { encoding: 'utf8', env: { ...process.env, PATH: pnpm.PATH } });
  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stdout, /::error::check failed: pnpm typecheck/);
  assert.deepEqual(pnpm.calls(), ['typecheck']);
});

test('main returns 0 when every step exits 0, and runs them all', (t) => {
  const pnpm = fakePnpm(t, 0);
  const out = spawnSync(process.execPath, [CLI, '--files', 'server/src/main.ts'], { encoding: 'utf8', env: { ...process.env, PATH: pnpm.PATH } });
  assert.equal(out.status, 0, out.stdout);
  assert.doesNotMatch(out.stdout, /::error::/);
  assert.deepEqual(pnpm.calls(), ['typecheck', 'build', 'test']);
});

test('the CLI prints the plan under --dry-run and runs nothing', () => {
  const env = { ...process.env };
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_ACTIONS;
  const docs = spawnSync(process.execPath, [CLI, '--dry-run', '--files', 'CLAUDE.md'], { encoding: 'utf8', env });
  assert.equal(docs.status, 0, docs.stderr);
  assert.match(docs.stdout, /ci-scope: docs-only/);
  assert.match(docs.stdout, /would run: pnpm exec jest --runTestsByPath .*test\/claude-rules\.test\.ts/);
  assert.doesNotMatch(docs.stdout, /pnpm typecheck/);

  const full = spawnSync(process.execPath, [CLI, '--dry-run'], { encoding: 'utf8', env });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /ci-scope: full — not a pull request/);
  assert.match(full.stdout, /would run: pnpm typecheck\nwould run: pnpm build\nwould run: pnpm test/);
});
