// Cases for `pr-resolve.mjs` and its lib — target parsing, the per-PR lock and the outcome file. Every case works in a throwaway directory used as
// `BM_PR_RESOLVE_HOME`, so nothing here touches a real `~/.backlog-manager/pr-resolve`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimStale, fileKey, parseTarget, paths, prResolveHome, releaseLock, takeLock, writeOutcome } from './pr-resolve-lib.mjs';

const CLI = fileURLToPath(new URL('./pr-resolve.mjs', import.meta.url));
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const H = 3 * 60 * 60 * 1000;

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-pr-resolve-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lockAt(dir, sessionId, atMs) {
  const file = path.join(dir, 'locks', 'x.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionId, at: new Date(atMs).toISOString() }));
  return file;
}

function cli(home, args, env = {}) {
  const e = { ...process.env, BM_PR_RESOLVE_HOME: home, ...env };
  if (env.CLAUDE_CODE_SESSION_ID === undefined) delete e.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: e, cwd: home });
}

test('parseTarget accepts owner/repo#N and nothing else', () => {
  assert.deepEqual(parseTarget('acme/web#12'), { owner: 'acme', name: 'web', repo: 'acme/web', number: 12 });
  assert.equal(parseTarget('acme/web.js#3').name, 'web.js');
  assert.equal(parseTarget('acme/my__lib#12').repo, 'acme/my__lib');
  for (const bad of ['acme/web', 'acme/web#0', 'acme/web#-1', 'acme/web#1x', 'acme_x/web#1', '', 'acme/web#12 ']) assert.equal(parseTarget(bad), null, JSON.stringify(bad));
});

test('prResolveHome reads the env per call', () => {
  assert.equal(prResolveHome({ BM_PR_RESOLVE_HOME: '/x' }), '/x');
  assert.equal(prResolveHome({}), path.join(os.homedir(), '.backlog-manager', 'pr-resolve'));
});

test('fileKey and paths', () => {
  assert.equal(fileKey('acme/my__lib', 12), 'acme__my__lib__12');
  assert.deepEqual(paths('/r', '/h', parseTarget('acme/web#12')), {
    tree: '/r/.worktrees/pr-resolve-12',
    baseTree: '/r/.worktrees/pr-resolve-12-base',
    lockFile: '/h/locks/acme__web__12.lock',
    outcomeFile: '/h/acme__web__12.json',
  });
});

test('takeLock: fresh take, then a second claimer is refused', (t) => {
  const file = path.join(tmp(t), 'locks', 'k.lock');
  assert.deepEqual(takeLock(file, { sessionId: 's1', now: NOW, reclaim: null }), { taken: true, recovered: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { sessionId: 's1', at: new Date(NOW).toISOString() });
  assert.deepEqual(takeLock(file, { sessionId: 's2', now: NOW, reclaim: null }), { taken: false });
});

test('takeLock: stale by age at the 3 h boundary', (t) => {
  const dir = tmp(t);
  const file = lockAt(dir, 's1', NOW - H - 1000);
  assert.deepEqual(takeLock(file, { sessionId: 's2', now: NOW, reclaim: null }), { taken: true, recovered: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessionId, 's2');
  fs.rmSync(file);
  lockAt(dir, 's1', NOW - H + 1000);
  assert.deepEqual(takeLock(file, { sessionId: 's2', now: NOW, reclaim: null }), { taken: false });
});

test('takeLock: reclaim matches the recorded session; a null never matches', (t) => {
  const dir = tmp(t);
  const file = lockAt(dir, 's1', NOW);
  assert.deepEqual(takeLock(file, { sessionId: 's2', now: NOW, reclaim: 's9' }), { taken: false });
  assert.deepEqual(takeLock(file, { sessionId: 's2', now: NOW, reclaim: 's1' }), { taken: true, recovered: true });
  fs.rmSync(file);
  lockAt(dir, null, NOW);
  assert.deepEqual(takeLock(file, { sessionId: 's2', now: NOW, reclaim: null }), { taken: false });
});

test('takeLock: an unparseable lock is judged by mtime', (t) => {
  const file = path.join(tmp(t), 'locks', 'k.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'garbage');
  assert.deepEqual(takeLock(file, { sessionId: 's2', now: Date.now(), reclaim: null }), { taken: false });
  assert.deepEqual(takeLock(file, { sessionId: 's2', now: Date.now() + H + 60_000, reclaim: null }), { taken: true, recovered: true });
});

test('claimStale: two claimers — the first wins, the second gets null', (t) => {
  const file = lockAt(tmp(t), 's1', NOW - 2 * H);
  const raw = fs.readFileSync(file, 'utf8');
  const claimed = claimStale(file, raw);
  assert.match(path.basename(claimed), /^x\.lock\.recover-\d+-[0-9a-f]{8}$/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(claimStale(file, raw), null);
});

test('claimStale: a newer lock written after the judge is restored, not claimed', (t) => {
  const file = lockAt(tmp(t), 's1', NOW - 2 * H);
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify({ sessionId: 's3', at: new Date(NOW).toISOString() }));
  const fresh = fs.readFileSync(file, 'utf8');
  assert.equal(claimStale(file, raw), null);
  assert.equal(fs.readFileSync(file, 'utf8'), fresh);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.lock']);
});

test('releaseLock removes only the matching session (null matches null)', (t) => {
  const dir = tmp(t);
  const file = lockAt(dir, 's1', NOW);
  releaseLock(file, 's2');
  assert.equal(fs.existsSync(file), true);
  releaseLock(file, 's1');
  assert.equal(fs.existsSync(file), false);
  lockAt(dir, null, NOW);
  releaseLock(file, null);
  assert.equal(fs.existsSync(file), false);
});

test('writeOutcome writes the exact shape and leaves no temp file', (t) => {
  const file = path.join(tmp(t), 'deep', 'k.json');
  writeOutcome(file, { sessionId: 's1', outcome: 'pushed', reason: 'ok', fromSha: 'aaa', headSha: 'bbb', now: NOW });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    sessionId: 's1', outcome: 'pushed', reason: 'ok', fromSha: 'aaa', headSha: 'bbb', at: new Date(NOW).toISOString(),
  });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['k.json']);
});

test('CLI parse', (t) => {
  const home = tmp(t);
  const r = cli(home, ['parse', 'acme/web#12']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.reclaim, null);
  assert.equal(out.repo, 'acme/web');
  assert.equal(out.number, 12);
  assert.equal(out.lockFile, path.join(home, 'locks', 'acme__web__12.lock'));
  assert.equal(out.outcomeFile, path.join(home, 'acme__web__12.json'));
  assert.equal(out.tree, path.join(home, '.worktrees', 'pr-resolve-12'));
  assert.equal(JSON.parse(cli(home, ['parse', 'acme/web#12', '--reclaim', 's1']).stdout).reclaim, 's1');
  assert.equal(cli(home, ['parse', 'acme/web#12', '--reclaim']).status, 2);
  const bad = cli(home, ['parse', 'acme/web']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not owner\/repo#N: acme\/web/);
});

test('CLI lock take twice, then release', (t) => {
  const home = tmp(t);
  const env = { CLAUDE_CODE_SESSION_ID: 's1' };
  const a = cli(home, ['lock', 'take', 'acme/web#12'], env);
  assert.equal(a.status, 0);
  assert.deepEqual(JSON.parse(a.stdout), { taken: true, recovered: false });
  const b = cli(home, ['lock', 'take', 'acme/web#12'], { CLAUDE_CODE_SESSION_ID: 's2' });
  assert.equal(b.status, 3);
  assert.deepEqual(JSON.parse(b.stdout), { taken: false, reason: 'another resolve of #12 is running' });
  assert.deepEqual(JSON.parse(cli(home, ['lock', 'release', 'acme/web#12'], { CLAUDE_CODE_SESSION_ID: 's2' }).stdout), { released: false });
  assert.deepEqual(JSON.parse(cli(home, ['lock', 'release', 'acme/web#12'], env).stdout), { released: true });
});

test('CLI outcome: shape, null session, and the head rules', (t) => {
  const home = tmp(t);
  const ok = cli(home, ['outcome', 'acme/web#12', '--outcome', 'pushed', '--reason', 'done', '--from', 'aaa', '--head', 'bbb']);
  assert.equal(ok.status, 0);
  const file = JSON.parse(ok.stdout).written;
  assert.equal(file, path.join(home, 'acme__web__12.json'));
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.sessionId, null);
  assert.equal(rec.headSha, 'bbb');
  const stopped = cli(home, ['outcome', 'acme/web#12', '--outcome', 'stopped', '--reason', 'r', '--from', 'aaa']);
  assert.equal(stopped.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).headSha, 'aaa');
  assert.equal(cli(home, ['outcome', 'acme/web#12', '--outcome', 'stopped', '--reason', 'r', '--from', 'aaa', '--head', 'bbb']).status, 2);
  assert.equal(cli(home, ['outcome', 'acme/web#12', '--outcome', 'pushed', '--reason', 'r', '--from', 'aaa']).status, 2);
});
