// Cases for `tick-breaker.mjs` — the streak rule and the `tick.json` reader. The streak table below is PINNED: the server's copy of the rule
// (`server/src/tick/tick-breaker.util.ts`, suite `test/tick-breaker.test.ts`) carries the same table in its own suite, so a drift on either side fails a suite
// rather than letting `decide` and the board disagree about whether a project is halted. Every file case works in its own throwaway directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAP_MAX,
  CAP_MIN,
  HALT_DEFAULT,
  HALT_MAX,
  HALT_MIN,
  MAX_PLANS_DEFAULT,
  MAX_PRS_DEFAULT,
  clampHaltAfter,
  readTickSettings,
  streakOf,
  tickSettingsFile
} from './tick-breaker.mjs';

// Times are strictly increasing minutes of one hour unless a case says otherwise.
const T = (n) => `2026-10-22T10:${String(n).padStart(2, '0')}:00.000Z`;
const f = (n, extra = {}) => ({ at: T(n), id: `bug-${n}`, kind: 'execute', outcome: 'failed', reason: 'x', ...extra });
const o = (n, extra = {}) => ({ at: T(n), id: `bug-${n}`, kind: 'execute', outcome: 'ok', reason: '', ...extra });

test('streakOf — the pinned table', () => {
  const cases = [
    ['empty', [], undefined, 0, null],
    ['one failure', [f(1)], undefined, 1, T(1)],
    ['a success newest resets', [f(1), f(2), o(3)], undefined, 0, null],
    ['failures after a success', [o(1), f(2), f(3)], undefined, 2, T(2)],
    ['resetAt between the 1st and 2nd', [f(1), f(2), f(3)], T(1) /* at-or-before stops */, 2, T(2)],
    ['resetAt equal to the 2nd stops AT it', [f(1), f(2), f(3)], T(2), 1, T(3)],
    ['resetAt after everything', [f(1), f(2)], T(30), 0, null],
    ['an unparseable at stops the walk', [f(1), f(2, { at: 'garbage' }), f(3)], undefined, 1, T(3)],
    ['an outcome that is neither ok nor failed neither counts nor stops', [f(1), f(2, { outcome: 'skipped' }), f(3)], undefined, 2, T(1)],
    ['an unparseable at stops whatever the outcome', [f(1), { outcome: 'skipped', at: 'garbage' }, f(3)], undefined, 1, T(3)],
    ['groom and execute count together', [f(1, { kind: 'groom' }), f(2, { kind: 'execute' }), f(3, { kind: 'groom' })], undefined, 3, T(1)],
    ['an unparseable resetAt is absent', [f(1), f(2)], 'garbage', 2, T(1)]
  ];
  for (const [name, recent, resetAt, streak, since] of cases) {
    assert.deepEqual(streakOf(recent, resetAt), { streak, since }, name);
  }
});

test('streakOf — malformed input never throws and is read as the oldest thing there is', () => {
  assert.deepEqual(streakOf(undefined, undefined), { streak: 0, since: null });
  assert.deepEqual(streakOf([f(1), null, f(3)], undefined), { streak: 1, since: T(3) });
  assert.deepEqual(streakOf([f(1), f(2, { at: 7 }), f(3)], undefined), { streak: 1, since: T(3) });
});

test('clampHaltAfter', () => {
  assert.equal(HALT_DEFAULT, 3);
  assert.equal(HALT_MIN, 1);
  assert.equal(HALT_MAX, 10);
  assert.equal(clampHaltAfter(5), 5);
  assert.equal(clampHaltAfter(0), 1);
  assert.equal(clampHaltAfter(-4), 1);
  assert.equal(clampHaltAfter(42), 10);
  for (const bad of ['7', 2.5, null, undefined, NaN, Infinity, [], {}, true]) assert.equal(clampHaltAfter(bad), 3, String(bad));
});

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-tick-breaker-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function withFile(t, text) {
  const file = path.join(fixture(t), 'tick.json');
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
  return file;
}

test('readTickSettings — an absent file is the default', (t) => {
  const file = path.join(fixture(t), 'nope.json');
  assert.deepEqual(readTickSettings(file), { ok: true, haltAfter: 3, maxPlans: 3, maxPrs: 2, resetAt: {}, source: 'default' });
});

test('readTickSettings — a file is read, haltAfter clamped and non-integers read as 3', (t) => {
  assert.deepEqual(readTickSettings(withFile(t, { haltAfter: 5 })), { ok: true, haltAfter: 5, maxPlans: 3, maxPrs: 2, resetAt: {}, source: 'file' });
  assert.equal(readTickSettings(withFile(t, { haltAfter: 0 })).haltAfter, 1);
  assert.equal(readTickSettings(withFile(t, { haltAfter: 42 })).haltAfter, 10);
  assert.equal(readTickSettings(withFile(t, { haltAfter: '7' })).haltAfter, 3);
  assert.equal(readTickSettings(withFile(t, { haltAfter: 2.5 })).haltAfter, 3);
  // a file with no haltAfter at all is still a file
  assert.deepEqual(readTickSettings(withFile(t, {})), { ok: true, haltAfter: 3, maxPlans: 3, maxPrs: 2, resetAt: {}, source: 'file' });
});

// PINNED: `test/tick-breaker.test.ts` carries the same rows for the server's `readTickFile`, so the two readers cannot disagree about a hand-edited cap.
const CAP_CLAMP = [
  [0, 1],
  [11, 10],
  [99, 10],
  [-3, 1],
  [5, 5],
  ['5', 'default'],
  [2.5, 'default'],
  [null, 'default']
];

test('readTickSettings — the two caps: defaults, file values and the pinned clamp table', (t) => {
  assert.equal(MAX_PLANS_DEFAULT, 3);
  assert.equal(MAX_PRS_DEFAULT, 2);
  assert.equal(CAP_MIN, 1);
  assert.equal(CAP_MAX, 10);
  const both = readTickSettings(withFile(t, { maxPlans: 5, maxPrs: 4 }));
  assert.equal(both.maxPlans, 5);
  assert.equal(both.maxPrs, 4);
  // only haltAfter on file → the caps are the defaults, haltAfter is the file's
  const halt = readTickSettings(withFile(t, { haltAfter: 4 }));
  assert.deepEqual([halt.haltAfter, halt.maxPlans, halt.maxPrs], [4, 3, 2]);
  for (const [raw, want] of CAP_CLAMP) {
    const r = readTickSettings(withFile(t, { maxPlans: raw, maxPrs: raw }));
    assert.equal(r.maxPlans, want === 'default' ? 3 : want, `maxPlans ${JSON.stringify(raw)}`);
    assert.equal(r.maxPrs, want === 'default' ? 2 : want, `maxPrs ${JSON.stringify(raw)}`);
  }
  // a missing key is the default too, independently per cap
  assert.equal(readTickSettings(withFile(t, { maxPlans: 7 })).maxPrs, 2);
});

test('readTickSettings — a resetAt entry that is not a parseable string is dropped', (t) => {
  const r = readTickSettings(withFile(t, { haltAfter: 3, resetAt: { '/a': T(5), '/b': 42, '/c': 'garbage', '/d': null } }));
  assert.deepEqual(r.resetAt, { '/a': T(5) });
  // a resetAt that is not an object is no resets
  assert.deepEqual(readTickSettings(withFile(t, { resetAt: [T(1)] })).resetAt, {});
  assert.deepEqual(readTickSettings(withFile(t, { resetAt: 'x' })).resetAt, {});
});

test('readTickSettings — an unreadable file is ok:false and names itself, and nothing throws', (t) => {
  const notJson = withFile(t, '{ nope');
  assert.deepEqual(Object.keys(readTickSettings(notJson)).sort(), ['error', 'file', 'ok']);
  const r = readTickSettings(notJson);
  assert.equal(r.ok, false);
  assert.equal(r.file, notJson);
  assert.equal(typeof r.error, 'string');
  assert.equal(readTickSettings(withFile(t, '[1,2]')).ok, false);
  assert.equal(readTickSettings(withFile(t, 'null')).ok, false);
  // a directory at the path is EISDIR, not "absent"
  const dir = fixture(t);
  const d = readTickSettings(dir);
  assert.equal(d.ok, false);
  assert.equal(d.file, dir);
});

test('tickSettingsFile honours BM_TICK_FILE, read per call', (t) => {
  const prev = process.env.BM_TICK_FILE;
  t.after(() => {
    if (prev === undefined) delete process.env.BM_TICK_FILE;
    else process.env.BM_TICK_FILE = prev;
  });
  delete process.env.BM_TICK_FILE;
  assert.equal(tickSettingsFile(), path.join(os.homedir(), '.backlog-manager', 'settings', 'tick.json'));
  process.env.BM_TICK_FILE = '/x/tick.json';
  assert.equal(tickSettingsFile(), '/x/tick.json');
  process.env.BM_TICK_FILE = '/y/tick.json';
  assert.equal(tickSettingsFile(), '/y/tick.json');
});

test('readTickSettings defaults its file to tickSettingsFile()', (t) => {
  const file = withFile(t, { haltAfter: 4 });
  const prev = process.env.BM_TICK_FILE;
  t.after(() => {
    if (prev === undefined) delete process.env.BM_TICK_FILE;
    else process.env.BM_TICK_FILE = prev;
  });
  process.env.BM_TICK_FILE = file;
  assert.equal(readTickSettings().haltAfter, 4);
});
