import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { TickFileUnreadable, readTickFile, streakOf, tickFile, tickHome, writeTickFile } from '../server/src/tick/tick-breaker.util';
import { TICK_CAP_LIMITS, TICK_HALT_LIMITS } from '../shared/types';

// The streak table and the file cases below are the SAME rows and expectations `skills/backlog-tick/tools/tick-breaker.test.mjs` pins for the skill's copy of
// the rule. Two copies, one table: a change to the rule on one side fails the other side's suite rather than letting `tick.mjs decide` stop a project the
// board shows as healthy (or the reverse). Keep the rows byte-for-byte in step with that file.

// Times are strictly increasing minutes of one hour unless a case says otherwise.
const T = (n: number): string => `2026-10-22T10:${String(n).padStart(2, '0')}:00.000Z`;
const f = (n: number, extra: Record<string, unknown> = {}) => ({ at: T(n), id: `bug-${n}`, kind: 'execute', outcome: 'failed', reason: 'x', ...extra });
const o = (n: number, extra: Record<string, unknown> = {}) => ({ at: T(n), id: `bug-${n}`, kind: 'execute', outcome: 'ok', reason: '', ...extra });

describe('streakOf — the pinned table', () => {
  const cases: Array<[string, unknown, unknown, number, string | null]> = [
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
  it.each(cases)('%s', (_name, recent, resetAt, streak, since) => {
    expect(streakOf(recent as never, resetAt as never)).toEqual({ streak, since });
  });

  it('malformed input never throws and is read as the oldest thing there is', () => {
    expect(streakOf(undefined as never, undefined)).toEqual({ streak: 0, since: null });
    expect(streakOf([f(1), null, f(3)] as never, undefined)).toEqual({ streak: 1, since: T(3) });
    expect(streakOf([f(1), f(2, { at: 7 }), f(3)] as never, undefined)).toEqual({ streak: 1, since: T(3) });
  });
});

describe('tickFile / tickHome — env read per call', () => {
  it('default to ~/.backlog-manager and honour BM_TICK_FILE / BM_TICK_HOME', () => {
    expect(tickFile({})).toBe(join(homedir(), '.backlog-manager', 'settings', 'tick.json'));
    expect(tickHome({})).toBe(join(homedir(), '.backlog-manager', 'tick'));
    expect(tickFile({ BM_TICK_FILE: '/x/tick.json' })).toBe('/x/tick.json');
    expect(tickHome({ BM_TICK_HOME: '/x/tick' })).toBe('/x/tick');
    // an empty string is "unset", like every other BM_* path override
    expect(tickFile({ BM_TICK_FILE: '' })).toBe(join(homedir(), '.backlog-manager', 'settings', 'tick.json'));
  });

  it('read process.env on every call, never cached', () => {
    const prev = { file: process.env.BM_TICK_FILE, home: process.env.BM_TICK_HOME };
    try {
      process.env.BM_TICK_FILE = '/a/tick.json';
      process.env.BM_TICK_HOME = '/a/tick';
      expect(tickFile()).toBe('/a/tick.json');
      expect(tickHome()).toBe('/a/tick');
      process.env.BM_TICK_FILE = '/b/tick.json';
      process.env.BM_TICK_HOME = '/b/tick';
      expect(tickFile()).toBe('/b/tick.json');
      expect(tickHome()).toBe('/b/tick');
    } finally {
      for (const [k, v] of [['BM_TICK_FILE', prev.file], ['BM_TICK_HOME', prev.home]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('TICK_HALT_LIMITS', () => {
  it('is 1–10, default 3', () => {
    expect(TICK_HALT_LIMITS).toEqual({ min: 1, max: 10, default: 3 });
  });
});

describe('TICK_CAP_LIMITS', () => {
  it('is 1–10 for both caps, default 3 plans and 2 PRs — the numbers tick-breaker.mjs hand-copies', () => {
    expect(TICK_CAP_LIMITS).toEqual({ maxPlans: { min: 1, max: 10, default: 3 }, maxPrs: { min: 1, max: 10, default: 2 } });
  });
});

describe('readTickFile / writeTickFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bm-tick-breaker-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withFile = (content: unknown): string => {
    const file = join(dir, 'tick.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const onDisk = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

  describe('readTickFile', () => {
    it('an absent file is the default', () => {
      expect(readTickFile(join(dir, 'nope.json'))).toEqual({ ok: true, haltAfter: 3, maxPlans: 3, maxPrs: 2, resetAt: {}, source: 'default' });
    });

    it('a file is read, haltAfter clamped and non-integers read as 3', () => {
      expect(readTickFile(withFile({ haltAfter: 5 }))).toEqual({ ok: true, haltAfter: 5, maxPlans: 3, maxPrs: 2, resetAt: {}, source: 'file' });
      expect(readTickFile(withFile({ haltAfter: 0 }))).toMatchObject({ haltAfter: 1 });
      expect(readTickFile(withFile({ haltAfter: 42 }))).toMatchObject({ haltAfter: 10 });
      expect(readTickFile(withFile({ haltAfter: '7' }))).toMatchObject({ haltAfter: 3 });
      expect(readTickFile(withFile({ haltAfter: 2.5 }))).toMatchObject({ haltAfter: 3 });
      // a file with no haltAfter at all is still a file
      expect(readTickFile(withFile({}))).toEqual({ ok: true, haltAfter: 3, maxPlans: 3, maxPrs: 2, resetAt: {}, source: 'file' });
    });

    // PINNED: the same rows as `CAP_CLAMP` in `tick-breaker.test.mjs`, so the board and `tick.mjs decide` read a hand-edited cap the same way.
    const CAP_CLAMP: Array<[unknown, number | 'default']> = [
      [0, 1],
      [11, 10],
      [99, 10],
      [-3, 1],
      [5, 5],
      ['5', 'default'],
      [2.5, 'default'],
      [null, 'default']
    ];
    it.each(CAP_CLAMP)('the caps clamp %j → %s', (raw, want) => {
      expect(readTickFile(withFile({ maxPlans: raw, maxPrs: raw }))).toMatchObject({
        maxPlans: want === 'default' ? 3 : want,
        maxPrs: want === 'default' ? 2 : want
      });
    });

    it('reads both caps from the file, each defaulting on its own', () => {
      expect(readTickFile(withFile({ maxPlans: 5, maxPrs: 4 }))).toMatchObject({ haltAfter: 3, maxPlans: 5, maxPrs: 4 });
      expect(readTickFile(withFile({ haltAfter: 4 }))).toMatchObject({ haltAfter: 4, maxPlans: 3, maxPrs: 2 });
      expect(readTickFile(withFile({ maxPlans: 7 }))).toMatchObject({ maxPlans: 7, maxPrs: 2 });
    });

    it('a resetAt entry that is not a parseable string is dropped', () => {
      const r = readTickFile(withFile({ haltAfter: 3, resetAt: { '/a': T(5), '/b': 42, '/c': 'garbage', '/d': null } }));
      expect(r).toMatchObject({ ok: true, resetAt: { '/a': T(5) } });
      // a resetAt that is not an object is no resets
      expect(readTickFile(withFile({ resetAt: [T(1)] }))).toMatchObject({ ok: true, resetAt: {} });
      expect(readTickFile(withFile({ resetAt: 'x' }))).toMatchObject({ ok: true, resetAt: {} });
    });

    it('an unreadable file is ok:false, names itself, and nothing throws', () => {
      const notJson = withFile('{ nope');
      const r = readTickFile(notJson);
      expect(Object.keys(r).sort()).toEqual(['error', 'file', 'ok']);
      expect(r).toMatchObject({ ok: false, file: notJson });
      expect(typeof (r as { error: unknown }).error).toBe('string');
      expect(readTickFile(withFile('[1,2]')).ok).toBe(false);
      expect(readTickFile(withFile('null')).ok).toBe(false);
      // a directory at the path is EISDIR, not "absent"
      expect(readTickFile(dir)).toMatchObject({ ok: false, file: dir });
    });

    it('defaults its file to tickFile(), read per call', () => {
      const file = withFile({ haltAfter: 4 });
      const prev = process.env.BM_TICK_FILE;
      try {
        process.env.BM_TICK_FILE = file;
        expect(readTickFile()).toMatchObject({ ok: true, haltAfter: 4 });
      } finally {
        if (prev === undefined) delete process.env.BM_TICK_FILE;
        else process.env.BM_TICK_FILE = prev;
      }
    });
  });

  describe('writeTickFile', () => {
    it('from absent, a resetAt-only patch creates the file with haltAfter 3', () => {
      const file = join(dir, 'settings', 'tick.json');
      writeTickFile({ resetAt: { '/p': T(1) } }, file);
      expect(onDisk(file)).toEqual({ haltAfter: 3, maxPlans: 3, maxPrs: 2, resetAt: { '/p': T(1) } });
    });

    it('from absent, a haltAfter-only patch writes an empty resetAt', () => {
      const file = join(dir, 'tick.json');
      writeTickFile({ haltAfter: 5 }, file);
      expect(onDisk(file)).toEqual({ haltAfter: 5, maxPlans: 3, maxPrs: 2, resetAt: {} });
    });

    it('patching haltAfter keeps an existing resetAt', () => {
      const file = withFile({ haltAfter: 3, resetAt: { '/p': T(1), '/q': T(2) } });
      writeTickFile({ haltAfter: 7 }, file);
      expect(onDisk(file)).toEqual({ haltAfter: 7, maxPlans: 3, maxPrs: 2, resetAt: { '/p': T(1), '/q': T(2) } });
    });

    it('patching one resetAt key keeps the others, and the file’s haltAfter', () => {
      const file = withFile({ haltAfter: 6, resetAt: { '/p': T(1), '/q': T(2) } });
      writeTickFile({ resetAt: { '/p': T(9) } }, file);
      expect(onDisk(file)).toEqual({ haltAfter: 6, maxPlans: 3, maxPrs: 2, resetAt: { '/p': T(9), '/q': T(2) } });
    });

    it('patching one cap keeps haltAfter, resetAt and the other cap', () => {
      const file = withFile({ haltAfter: 6, maxPrs: 4, resetAt: { '/p': T(1) } });
      writeTickFile({ maxPlans: 4 }, file);
      expect(onDisk(file)).toEqual({ haltAfter: 6, maxPlans: 4, maxPrs: 4, resetAt: { '/p': T(1) } });
      writeTickFile({ maxPrs: 1 }, file);
      expect(onDisk(file)).toEqual({ haltAfter: 6, maxPlans: 4, maxPrs: 1, resetAt: { '/p': T(1) } });
    });

    it('clamps an out-of-range cap to the nearest bound', () => {
      const file = join(dir, 'tick.json');
      writeTickFile({ maxPrs: 50, maxPlans: 0 }, file);
      expect(onDisk(file)).toMatchObject({ maxPrs: 10, maxPlans: 1 });
    });

    it('clamps an out-of-range haltAfter to the nearest bound', () => {
      const file = join(dir, 'tick.json');
      writeTickFile({ haltAfter: 99 }, file);
      expect(onDisk(file)).toMatchObject({ haltAfter: 10 });
      writeTickFile({ haltAfter: -3 }, file);
      expect(onDisk(file)).toMatchObject({ haltAfter: 1 });
    });

    it('refuses an unreadable file with TickFileUnreadable and leaves its bytes untouched', () => {
      for (const bad of ['{ nope', '[1,2]', 'null', '"text"']) {
        const file = withFile(bad);
        expect(() => writeTickFile({ haltAfter: 5 }, file)).toThrow(TickFileUnreadable);
        expect(() => writeTickFile({ maxPlans: 4 }, file)).toThrow(TickFileUnreadable);
        expect(() => writeTickFile({ resetAt: { '/p': T(1) } }, file)).toThrow(TickFileUnreadable);
        expect(readFileSync(file, 'utf8')).toBe(bad);
        expect(readdirSync(dir)).toEqual(['tick.json']);
      }
    });

    it('names the file on the thrown error', () => {
      const file = withFile('{ nope');
      try {
        writeTickFile({ haltAfter: 5 }, file);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TickFileUnreadable);
        expect((e as TickFileUnreadable).file).toBe(file);
        expect((e as Error).message).toContain(file);
      }
    });

    it('leaves no .tmp file in the directory after any write', () => {
      const file = join(dir, 'tick.json');
      writeTickFile({ haltAfter: 4 }, file);
      writeTickFile({ resetAt: { '/p': T(1) } }, file);
      writeTickFile({ haltAfter: 5, resetAt: { '/q': T(2) } }, file);
      expect(readdirSync(dir)).toEqual(['tick.json']);
      expect(existsSync(file)).toBe(true);
    });

    it('writes a trailing newline and 2-space JSON, like the other settings files', () => {
      const file = join(dir, 'tick.json');
      writeTickFile({ haltAfter: 4 }, file);
      expect(readFileSync(file, 'utf8')).toBe('{\n  "haltAfter": 4,\n  "maxPlans": 3,\n  "maxPrs": 2,\n  "resetAt": {}\n}\n');
    });
  });
});
