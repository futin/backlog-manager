// orchestrate-headless.test.mjs — `orchestrate.mjs headless-settings <id>`, the verb that writes the settings file a per-item session is launched with.
//
// Every case runs the real CLI as a child, with a stub `claude` first on PATH printing a fixed `plugin list --json`, `BM_HEADLESS_FILE` and
// `BM_ORCH_HOME` in temp directories, and a temp git repo as the project root — so no case reads this machine's real plugins, allowlist or run state.
// The fixture inventory has one plugin of each kind the verb distinguishes: allowlisted by name (`superpowers`), the always-kept `backlog-manager`, a
// user plugin, an `@inline` and an `@synced` one, an `@builtin` one, and one already disabled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SCRIPT, orchFixture, addWorktree } from './orchestrate-test-lib.mjs';

const INVENTORY = [
  { id: 'backlog-manager@bm', scope: 'user', enabled: true },
  { id: 'superpowers@official', scope: 'user', enabled: true },
  { id: 'caveman@caveman', scope: 'user', enabled: true },
  { id: 'timify-jira@inline', scope: 'session', enabled: true },
  { id: 'timify-core@synced', scope: 'synced', enabled: true },
  { id: 'cc-plugin-sec-default@builtin', scope: 'builtin', enabled: true },
  { id: 'old@bm', scope: 'user', enabled: false }
];

// A stub `claude` that answers `plugin list --json` with `stdout` and exits `status`, or sleeps first when `sleep` is set. Any other argv is a failure,
// so a verb that called the CLI some other way would show up as one.
function stubClaude(t, { stdout = JSON.stringify(INVENTORY), status = 0, sleep = 0 } = {}) {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-headless-bin-')));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const out = path.join(bin, 'out.txt');
  fs.writeFileSync(out, stdout);
  const script = [
    '#!/bin/sh',
    '[ "$1 $2 $3" = "plugin list --json" ] || { echo "unexpected argv: $*" >&2; exit 64; }',
    sleep ? `sleep ${sleep}` : '',
    `cat "${out}"`,
    `exit ${status}`
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'claude'), `${script}\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  return bin;
}

function fixture(t, claude = {}) {
  const { home, project } = orchFixture(t);
  const bin = stubClaude(t, claude);
  const headless = path.join(home, 'headless.json');
  return { home, project, bin, headless };
}

function runVerb({ home, project, bin, headless }, { cwd = project, id = 'task-7', env = {} } = {}) {
  return spawnSync('node', [SCRIPT, 'headless-settings', id], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BM_ORCH_HOME: home, BM_HEADLESS_FILE: headless, ...env }
  });
}

const expectedPath = (home, project, id = 'task-7') => path.join(home, encodeURIComponent(project), 'headless', `${id}.json`);
const stderrLines = (r) => r.stderr.split('\n').filter((l) => l.trim() !== '');

function writeLocal(project, value) {
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

test('1. no headless.json and no local file: the default list, every other enabled non-builtin plugin denied', (t) => {
  const f = fixture(t);
  const r = runVerb(f);
  assert.equal(r.status, 0, r.stderr);
  const printed = r.stdout.trim();
  assert.equal(printed, expectedPath(f.home, f.project));
  const written = JSON.parse(fs.readFileSync(printed, 'utf8'));
  assert.deepEqual(written, {
    enabledPlugins: { 'caveman@caveman': false, 'timify-jira@inline': false, 'timify-core@synced': false }
  });
  // A copy of settings.local.json can carry secrets, so the file is the owner's alone.
  assert.equal(fs.statSync(printed).mode & 0o777, 0o600);
  assert.equal(r.stderr, '');
});

test('2. the local file is merged: its other keys kept, a deny wins, its word on an allowlisted plugin kept', (t) => {
  const f = fixture(t);
  writeLocal(f.project, {
    permissions: { allow: ['Bash(x:*)'] },
    enabledPlugins: { 'caveman@caveman': true, 'superpowers@official': false }
  });
  const r = runVerb(f);
  assert.equal(r.status, 0, r.stderr);
  const written = JSON.parse(fs.readFileSync(r.stdout.trim(), 'utf8'));
  assert.deepEqual(written.permissions, { allow: ['Bash(x:*)'] });
  assert.equal(written.enabledPlugins['caveman@caveman'], false);
  assert.equal(written.enabledPlugins['superpowers@official'], false);
});

test('3. an allowlist entry matches by bare name or full id, never by another marketplace', (t) => {
  for (const [plugins, kept] of [
    [['caveman'], true],
    [['caveman@caveman'], true],
    [['caveman@other'], false]
  ]) {
    const f = fixture(t);
    fs.writeFileSync(f.headless, JSON.stringify({ enabled: true, plugins }));
    const r = runVerb(f);
    assert.equal(r.status, 0, r.stderr);
    const deny = JSON.parse(fs.readFileSync(r.stdout.trim(), 'utf8')).enabledPlugins;
    assert.equal('caveman@caveman' in deny, !kept, `plugins ${JSON.stringify(plugins)}: ${JSON.stringify(deny)}`);
  }
});

test('4. an empty list still keeps backlog-manager and trims superpowers', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.headless, JSON.stringify({ enabled: true, plugins: [] }));
  const r = runVerb(f);
  assert.equal(r.status, 0, r.stderr);
  const deny = JSON.parse(fs.readFileSync(r.stdout.trim(), 'utf8')).enabledPlugins;
  assert.ok(!('backlog-manager@bm' in deny), JSON.stringify(deny));
  assert.equal(deny['superpowers@official'], false);
});

test('5. a builtin plugin is never denied, whatever the list says', (t) => {
  for (const plugins of [['cc-plugin-sec-default@nope'], [], ['superpowers']]) {
    const f = fixture(t);
    fs.writeFileSync(f.headless, JSON.stringify({ enabled: true, plugins }));
    const r = runVerb(f);
    assert.equal(r.status, 0, r.stderr);
    const deny = JSON.parse(fs.readFileSync(r.stdout.trim(), 'utf8')).enabledPlugins;
    assert.ok(!('cc-plugin-sec-default@builtin' in deny), JSON.stringify(deny));
  }
});

test('6. the setting switched off prints nothing and writes nothing', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.headless, JSON.stringify({ enabled: false, plugins: ['superpowers'] }));
  const r = runVerb(f);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.ok(!fs.existsSync(path.dirname(expectedPath(f.home, f.project))), 'a headless/ directory was created for a disabled setting');
});

test('7. a malformed headless.json prints nothing and leaves one stderr line naming the file', (t) => {
  for (const text of ['{not json', JSON.stringify({ enabled: true, plugins: 'superpowers' }), JSON.stringify({ enabled: true, plugins: ['a b'] })]) {
    const f = fixture(t);
    fs.writeFileSync(f.headless, text);
    const r = runVerb(f);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', `printed a path for ${text}`);
    const lines = stderrLines(r);
    assert.equal(lines.length, 1, r.stderr);
    assert.ok(lines[0].includes(f.headless), lines[0]);
    assert.ok(!fs.existsSync(expectedPath(f.home, f.project)));
  }
});

test('8. a failing, garbled or hung plugin list prints nothing and leaves one stderr line', (t) => {
  for (const [claude, env] of [
    [{ status: 1 }, {}],
    [{ stdout: 'not json' }, {}],
    [{ stdout: '{"id":"x"}' }, {}],
    [{ sleep: 5 }, { BM_HEADLESS_LIST_TIMEOUT_MS: '300' }]
  ]) {
    const f = fixture(t, claude);
    const started = Date.now();
    const r = runVerb(f, { env });
    assert.equal(r.status, 0, JSON.stringify(claude));
    assert.equal(r.stdout, '', JSON.stringify(claude));
    assert.equal(stderrLines(r).length, 1, `${JSON.stringify(claude)}: ${r.stderr}`);
    if (claude.sleep) assert.ok(Date.now() - started < 4000, 'the timeout did not bound the plugin list');
  }
});

test('9. nothing to disable prints nothing', (t) => {
  const f = fixture(t, {
    stdout: JSON.stringify([
      { id: 'backlog-manager@bm', enabled: true },
      { id: 'superpowers@official', enabled: true },
      { id: 'cc-plugin-privacy@builtin', enabled: true },
      { id: 'caveman@caveman', enabled: false }
    ])
  });
  const r = runVerb(f);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('10. run from a linked worktree it refuses, like every verb but init', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, 'README.md'), 'seed\n'); // git worktree add needs a commit, and an empty repo has nothing to commit
  const wt = addWorktree(f.project, 'task-7', 'backlog/task-7');
  const r = runVerb(f, { cwd: wt });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /linked git worktree/);
});

test('11. an unparseable settings.local.json still gets the deny map, with one stderr line', (t) => {
  const f = fixture(t);
  writeLocal(f.project, '{oops');
  const r = runVerb(f);
  assert.equal(r.status, 0);
  const written = JSON.parse(fs.readFileSync(r.stdout.trim(), 'utf8'));
  assert.deepEqual(Object.keys(written), ['enabledPlugins']);
  assert.equal(written.enabledPlugins['caveman@caveman'], false);
  assert.equal(stderrLines(r).length, 1, r.stderr);
});

test('a malformed item id is a usage error, nothing written', (t) => {
  const f = fixture(t);
  for (const id of ['../x', '-x', 'a/b']) {
    const r = runVerb(f, { id });
    assert.equal(r.status, 1, id);
    assert.equal(r.stdout, '');
  }
  assert.ok(!fs.existsSync(path.join(f.home, encodeURIComponent(f.project), 'headless')));
});
