// Cases for `review.mjs config`, each run as the real CLI in a child process. Every case points BM_REVIEW_HOME and BM_REVIEW_FILE into a temp dir, so none
// reads or writes a real `~/.backlog-manager`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
