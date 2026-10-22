// Cases for `tick-state.mjs` — the lock, the per-item outcome record and the content hash. Every case works in its own throwaway directory, so nothing here
// touches a real `~/.backlog-manager/tick`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentHash, forgetItem, isSkipped, lockState, readState, recordOutcome, releaseLock, removeLock, writeLock } from './tick-state.mjs';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-tick-state-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // a project directory that does not exist yet, as it will not on a first tick
  return path.join(dir, 'project');
}

const AT = '2026-10-22T10:00:00.000Z';
const lock = (id, extra = {}) => ({ host: 'h1', verdict: { kind: 'execute', id }, base: 'abc123', at: AT, ...extra });

test('writeLock is exclusive', (t) => {
  const dir = fixture(t);
  assert.equal(writeLock(dir, lock('bug-1')), true);
  assert.equal(writeLock(dir, lock('bug-2')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'lock'), 'utf8')), lock('bug-1'));
  // no tmp file is left behind by either call
  assert.deepEqual(fs.readdirSync(dir), ['lock']);
});

test('lockState: free, held inside the ttl, stale past it, stale when unreadable', (t) => {
  const dir = fixture(t);
  const ttl = 60_000;
  const at = Date.parse(AT);
  assert.deepEqual(lockState(dir, at, ttl), { state: 'free' });
  writeLock(dir, lock('bug-1'));
  assert.deepEqual(lockState(dir, at + ttl - 1, ttl), { state: 'held', lock: lock('bug-1') });
  assert.deepEqual(lockState(dir, at + ttl + 1, ttl), { state: 'stale', lock: lock('bug-1') });
  fs.writeFileSync(path.join(dir, 'lock'), 'not json');
  assert.equal(lockState(dir, at, ttl).state, 'stale');
  // valid JSON that is not a lock is stale too, never free
  fs.writeFileSync(path.join(dir, 'lock'), '{"host":"h1"}');
  assert.equal(lockState(dir, at, ttl).state, 'stale');
  fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify(lock('bug-1', { at: 'yesterday' })));
  assert.equal(lockState(dir, at, ttl).state, 'stale');
});

test('releaseLock only releases its own id', (t) => {
  const dir = fixture(t);
  assert.equal(releaseLock(dir, 'bug-3'), false);
  writeLock(dir, lock('bug-3'));
  assert.equal(releaseLock(dir, 'bug-4'), false);
  assert.ok(fs.existsSync(path.join(dir, 'lock')));
  assert.equal(releaseLock(dir, 'bug-3'), true);
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
});

test('removeLock is unconditional and tolerates an absent lock', (t) => {
  const dir = fixture(t);
  removeLock(dir);
  writeLock(dir, lock('bug-3'));
  removeLock(dir);
  assert.deepEqual(lockState(dir, Date.parse(AT), 1000), { state: 'free' });
});

const ITEM = ['---', 'title: A thing', 'created: 2026-10-01', 'updated: 2026-10-02', 'started: 2026-10-03T00:00:00Z', 'phase: groom', 'groomed-at: abc', 'groom-elapsed: 10', 'execute-tokens: 5', '---', '## Plan', 'Do it.', ''].join('\n');

test('bookkeeping keys never move the hash', () => {
  const base = contentHash(ITEM);
  const swap = (from, to) => ITEM.replace(from, to);
  assert.equal(contentHash(swap('updated: 2026-10-02', 'updated: 2027-01-01')), base);
  assert.equal(contentHash(swap('started: 2026-10-03T00:00:00Z', 'started: 2027-01-01T00:00:00Z')), base);
  assert.equal(contentHash(swap('phase: groom', 'phase: execute')), base);
  assert.equal(contentHash(swap('groomed-at: abc', 'groomed-at: def')), base);
  assert.equal(contentHash(swap('groom-elapsed: 10', 'groom-elapsed: 999')), base);
  assert.equal(contentHash(swap('execute-tokens: 5', 'execute-tokens: 6')), base);
  // the lines may also vanish altogether (a stop removes phase: and started:)
  assert.equal(contentHash(ITEM.replace('phase: groom\n', '').replace(/started: .*\n/, '')), base);
  assert.notEqual(contentHash(swap('Do it.', 'Do it!')), base);
  assert.notEqual(contentHash(swap('title: A thing', 'title: A thin')), base);
  assert.notEqual(contentHash(swap('created: 2026-10-01', 'created: 2026-10-09')), base);
  assert.match(base, /^[0-9a-f]{64}$/);
});

test('contentHash: a key that merely ends the same way is not bookkeeping, and no frontmatter hashes the body', () => {
  const base = contentHash(ITEM);
  // `-elapsed` / `-tokens` are suffix rules; a key that only CONTAINS them mid-name still counts
  assert.notEqual(contentHash(ITEM.replace('title: A thing', 'title: A thing\nelapsed-by: x')), base);
  assert.equal(contentHash('## Plan\nDo it.\n'), contentHash('## Plan\nDo it.\n'));
  assert.notEqual(contentHash('## Plan\nDo it.\n'), contentHash('## Plan\nDo it!\n'));
});

test('recordOutcome keeps the last 50', (t) => {
  const dir = fixture(t);
  for (let n = 1; n <= 55; n++) {
    recordOutcome(dir, `bug-${n}`, { outcome: 'ok', kind: 'groom', reason: `r${n}`, at: `2026-10-22T10:00:${String(n).padStart(2, '0')}.000Z` });
  }
  recordOutcome(dir, 'bug-55', { outcome: 'failed', kind: 'execute', reason: 'again', at: '2026-10-22T11:00:00.000Z', hash: 'h' });
  const { items, recent } = readState(dir);
  assert.equal(recent.length, 50);
  // 56 records written, the oldest kept is the 7th
  assert.equal(recent[0].id, 'bug-7');
  assert.deepEqual(recent[49], { at: '2026-10-22T11:00:00.000Z', id: 'bug-55', kind: 'execute', outcome: 'failed', reason: 'again' });
  assert.equal(Object.keys(items).length, 55);
  assert.deepEqual(items['bug-55'], { outcome: 'failed', kind: 'execute', reason: 'again', at: '2026-10-22T11:00:00.000Z', hash: 'h' });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('recordOutcome with exactly 55 records keeps the 6th written as the oldest', (t) => {
  const dir = fixture(t);
  for (let n = 1; n <= 55; n++) recordOutcome(dir, `bug-${n}`, { outcome: 'ok', kind: 'groom', reason: 'r', at: AT });
  assert.equal(readState(dir).recent[0].id, 'bug-6');
});

test('forgetItem removes the record, not the history', (t) => {
  const dir = fixture(t);
  assert.equal(forgetItem(dir, 'bug-1'), false);
  recordOutcome(dir, 'bug-1', { outcome: 'failed', kind: 'execute', reason: 'x', at: AT, hash: 'h' });
  assert.equal(forgetItem(dir, 'bug-1'), true);
  const state = readState(dir);
  assert.deepEqual(state.items, {});
  assert.equal(state.recent.length, 1);
});

test('readState: missing file is empty, a malformed one throws and is left untouched', (t) => {
  const dir = fixture(t);
  assert.deepEqual(readState(dir), { items: {}, recent: [] });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readState(dir), /state\.json/);
  assert.throws(() => recordOutcome(dir, 'bug-1', { outcome: 'ok', kind: 'groom', reason: 'r', at: AT }), /state\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  // well-formed JSON of the wrong shape is malformed too
  fs.writeFileSync(file, '{"items":[],"recent":{}}');
  assert.throws(() => readState(dir), /state\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"items":[],"recent":{}}');
});

test('isSkipped is true only for a failed record whose hash still matches', () => {
  const failed = { outcome: 'failed', kind: 'execute', reason: 'x', at: AT, hash: 'h1' };
  assert.equal(isSkipped(failed, 'h1'), true);
  assert.equal(isSkipped(failed, 'h2'), false);
  assert.equal(isSkipped({ ...failed, outcome: 'ok' }, 'h1'), false);
  assert.equal(isSkipped(undefined, 'h1'), false);
  assert.equal(isSkipped({ ...failed, hash: undefined }, 'h1'), false);
});
