// Cases for `tick-lib.mjs` — the pure twins and read-only helpers `tick.mjs` builds on. Nothing here spawns a process; the one filesystem case
// (`projectSource`) works in its own throwaway directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNKNOWN, apiBase, deriveGroomed, isMarked, itemNumber, orchHome, orderExecute, orderGroom, projectDir, projectSource, readFrontmatter, tickHome } from './tick-lib.mjs';

const PARSE_UTIL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'server', 'src', 'items', 'parse.util.ts');

test('deriveGroomed matches the server', () => {
  const bug = (cause, fix) => `## Cause\n${cause}\n\n## Fix\n${fix}\n`;
  assert.equal(deriveGroomed('bugs', bug('The loop never exits.', 'Break out of it.')), true);
  assert.equal(deriveGroomed('bugs', bug('The loop never exits.', 'unknown')), false);
  assert.equal(deriveGroomed('bugs', bug('The loop never exits.', '**Unknown.** maybe X')), false);
  assert.equal(deriveGroomed('bugs', bug('', 'Break out of it.')), false);
  assert.equal(deriveGroomed('tasks', '## Plan\n1. do it\n'), true);
  assert.equal(deriveGroomed('tasks', '## Plan\n\n## Notes\nx\n'), false);
  assert.equal(deriveGroomed('tasks', 'no plan heading at all'), false);
  assert.equal(deriveGroomed('ideas', '## Plan\nx'), null);
  assert.equal(deriveGroomed('refactors', '## Plan\nx'), null);
});

test('deriveGroomed is a byte copy of parse.util.ts', () => {
  const server = fs.readFileSync(PARSE_UTIL, 'utf8');
  assert.ok(server.includes(UNKNOWN.source), 'the twin UNKNOWN regex source must appear verbatim in server/src/items/parse.util.ts');
  assert.ok(UNKNOWN.flags === 'i');
});

test('isMarked reads presence, and only false opts out', () => {
  assert.equal(isMarked(undefined), false);
  assert.equal(isMarked('false'), false);
  assert.equal(isMarked(' FALSE '), false);
  assert.equal(isMarked('true'), true);
  assert.equal(isMarked('yes'), true);
  assert.equal(isMarked(''), true);
});

test('itemNumber reads the trailing number of either id shape', () => {
  assert.equal(itemNumber('bug-7'), 7);
  assert.equal(itemNumber('#12'), 12);
  assert.equal(itemNumber('task-100'), 100);
});

test('orderExecute: runner-fix first, then bugs, then tasks, each by number', () => {
  const ids = (items) => items.map((i) => i.id);
  const input = [
    { id: 'task-2', section: 'tasks', runnerFix: false },
    { id: 'bug-9', section: 'bugs', runnerFix: false },
    { id: 'task-1', section: 'tasks', runnerFix: true },
    { id: 'bug-3', section: 'bugs', runnerFix: false }
  ];
  assert.deepEqual(ids(orderExecute(input)), ['task-1', 'bug-3', 'bug-9', 'task-2']);
  // the input is not mutated
  assert.deepEqual(ids(input), ['task-2', 'bug-9', 'task-1', 'bug-3']);
  // tracker ids order numerically, not as strings
  assert.deepEqual(
    ids(
      orderExecute([
        { id: '#10', section: 'tasks', runnerFix: false },
        { id: '#2', section: 'tasks', runnerFix: false }
      ])
    ),
    ['#2', '#10']
  );
});

test('orderExecute is stable among runner-fix items of equal rank', () => {
  const out = orderExecute([
    { id: 'bug-5', section: 'bugs', runnerFix: true },
    { id: 'bug-5', section: 'bugs', runnerFix: true, tag: 'second' }
  ]);
  assert.equal(out[1].tag, 'second');
});

test('orderGroom: bugs by number, then refactors by number', () => {
  const input = ['ref-5:refactors', 'bug-4:bugs', 'ref-1:refactors', 'bug-2:bugs'].map((s) => {
    const [id, section] = s.split(':');
    return { id, section };
  });
  assert.deepEqual(
    orderGroom(input).map((i) => i.id),
    ['bug-2', 'bug-4', 'ref-1', 'ref-5']
  );
});

test('readFrontmatter splits key: value lines and returns the body', () => {
  const { fields, body } = readFrontmatter('---\ntitle: A: B\nrunner-fix:\nplan-review: true\nno colon here\n---\n## Plan\nx\n');
  assert.deepEqual(fields, { title: 'A: B', 'runner-fix': '', 'plan-review': 'true' });
  assert.equal(body, '## Plan\nx\n');
});

test('readFrontmatter on text with no frontmatter returns it all as body', () => {
  assert.deepEqual(readFrontmatter('## Plan\nx'), { fields: {}, body: '## Plan\nx' });
});

test('projectSource reads backlog/source.json, absent meaning files', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-tick-lib-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(projectSource(root), 'files');
  fs.mkdirSync(path.join(root, 'backlog'));
  assert.equal(projectSource(root), 'files');
  const marker = path.join(root, 'backlog', 'source.json');
  fs.writeFileSync(marker, JSON.stringify({ kind: 'github', repo: 'a/b' }));
  assert.equal(projectSource(root), 'github');
  fs.writeFileSync(marker, JSON.stringify({ kind: 'files' }));
  assert.equal(projectSource(root), 'files');
  fs.writeFileSync(marker, JSON.stringify({ kind: 'gitlab' }));
  assert.equal(projectSource(root), 'unsupported');
  // a github marker with no usable repo, an unparseable file and a non-object are never read as files
  fs.writeFileSync(marker, JSON.stringify({ kind: 'github', repo: 'not a repo' }));
  assert.equal(projectSource(root), 'unsupported');
  fs.writeFileSync(marker, 'not json');
  assert.equal(projectSource(root), 'unsupported');
  fs.writeFileSync(marker, '[]');
  assert.equal(projectSource(root), 'unsupported');
});

test('homes and base url honour their environment overrides', (t) => {
  const saved = { tick: process.env.BM_TICK_HOME, orch: process.env.BM_ORCH_HOME, port: process.env.BM_API_PORT };
  t.after(() => {
    for (const [key, value] of [['BM_TICK_HOME', saved.tick], ['BM_ORCH_HOME', saved.orch], ['BM_API_PORT', saved.port]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BM_TICK_HOME = '/x/tick';
  process.env.BM_ORCH_HOME = '/x/orch';
  process.env.BM_API_PORT = '9999';
  assert.equal(tickHome(), '/x/tick');
  assert.equal(orchHome(), '/x/orch');
  assert.equal(apiBase(), 'http://127.0.0.1:9999');
  delete process.env.BM_TICK_HOME;
  delete process.env.BM_ORCH_HOME;
  delete process.env.BM_API_PORT;
  assert.equal(tickHome(), path.join(os.homedir(), '.backlog-manager', 'tick'));
  assert.equal(orchHome(), path.join(os.homedir(), '.backlog-manager', 'orchestrator'));
  assert.equal(apiBase(), 'http://127.0.0.1:4322');
  assert.equal(projectDir('/r', '/a/b c'), path.join('/r', encodeURIComponent('/a/b c')));
});
