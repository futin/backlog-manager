import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { writeJsonAtomic } from '../../server/src/atomic-write.util';

// `writeFileSync`, `renameSync` and `rmSync` are swapped for switchable wrappers (default: the real ones) so a case can force a failure at one exact step, the
// wrapper shape `test/dashboards/dashboards-file.test.ts` uses for its rename. `failWrite` leaves a partial file before it throws, as a full disk does: a mock that threw
// first would leave nothing to clean up, and that case would pass with no cleanup at all. `renamedFrom` records the rename's source, the one place a successful
// write's temp name can be seen after the fact.
let failWrite = false;
let failRename = false;
let failRm = false;
let renamedFrom: string | null = null;
jest.mock('node:fs', () => {
  const real = jest.requireActual('node:fs');
  return {
    ...real,
    writeFileSync: (...args: unknown[]) => {
      if (failWrite) {
        real.writeFileSync(args[0], '{ partial');
        throw new Error('boom');
      }
      return real.writeFileSync(...args);
    },
    renameSync: (...args: unknown[]) => {
      if (failRename) throw new Error('boom');
      renamedFrom = args[0] as string;
      return real.renameSync(...args);
    },
    rmSync: (...args: unknown[]) => {
      if (failRm) throw new Error('cleanup');
      return real.rmSync(...args);
    }
  };
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bm-atomic-write-'));
  file = join(dir, 'target.json');
  failWrite = false;
  failRename = false;
  failRm = false;
  renamedFrom = null;
});
afterEach(() => {
  failWrite = false;
  failRename = false;
  failRm = false;
  rmSync(dir, { recursive: true, force: true });
});

const tempFiles = (where: string = dir): string[] => readdirSync(where).filter((n) => n.endsWith('.tmp'));

describe('writeJsonAtomic', () => {
  it('writes two-space JSON plus one trailing newline', () => {
    writeJsonAtomic(file, { a: 1 });
    expect(readFileSync(file, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });

  it('creates a target directory that does not exist', () => {
    const nested = join(dir, 'a', 'b', 'target.json');
    writeJsonAtomic(nested, { a: 1 });
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ a: 1 });
    expect(existsSync(join(dir, 'a', 'b'))).toBe(true);
  });

  it('replaces the target rather than appending to it', () => {
    writeFileSync(file, '{"old":true}');
    writeJsonAtomic(file, { new: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ new: true });
  });

  it('leaves the target as the only entry after a successful write', () => {
    writeJsonAtomic(file, { a: 1 });
    expect(tempFiles()).toEqual([]);
    expect(readdirSync(dir)).toEqual(['target.json']);
  });

  it('renames from a dot-named sibling of the target, because a rename is atomic only within one filesystem', () => {
    writeJsonAtomic(file, { a: 1 });
    expect(renamedFrom).not.toBeNull();
    expect(dirname(renamedFrom as string)).toBe(dirname(file));
    expect(basename(renamedFrom as string)).toMatch(/^\..*\.tmp$/);
  });

  it('removes the temp file, keeps the target and rethrows when the rename fails', () => {
    writeFileSync(file, 'known bytes');
    failRename = true;
    expect(() => writeJsonAtomic(file, { a: 1 })).toThrow('boom');
    expect(tempFiles()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('known bytes');
  });

  it('removes the partial temp file, keeps the target and rethrows when the temp write fails', () => {
    writeFileSync(file, 'known bytes');
    failWrite = true;
    expect(() => writeJsonAtomic(file, { a: 1 })).toThrow('boom');
    expect(tempFiles()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('known bytes');
  });

  it('throws the write failure, never the cleanup failure, when both happen', () => {
    failRename = true;
    failRm = true;
    expect(() => writeJsonAtomic(file, { a: 1 })).toThrow('boom');
  });

  // A pause request's file is `encodeURIComponent(<project path>)` plus `.json`, so its length is not ours to bound, and a filesystem caps a name at 255 bytes.
  // A temp name that embedded the target's basename would fail right here.
  it('writes a target whose own name is close to the 255-byte limit', () => {
    const long = join(dir, `${'x'.repeat(245)}.json`);
    writeJsonAtomic(long, { a: 1 });
    expect(JSON.parse(readFileSync(long, 'utf8'))).toEqual({ a: 1 });
    expect(tempFiles()).toEqual([]);
  });
});

describe('the atomic write has one home under server/src', () => {
  const src = join(__dirname, '..', '..', 'server', 'src');

  // The one `renameSync` that is not this write: `saveLinks` sets a file it could not parse aside as `.bad-<ISO>`. It moves the existing file and writes nothing,
  // so there is no temp file to strand and nothing to share. The match is on the call rather than the file, so a hand copy added to that same file still fails.
  const isSetAside = (rel: string, line: string): boolean =>
    rel === join('jira', 'links.store.ts') && (line.startsWith('import ') || line.includes('renameSync(file, `${file}.bad-'));

  it('finds renameSync in atomic-write.util.ts and nowhere else', () => {
    const offenders: string[] = [];
    let found = false;
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const full = join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const rel = relative(src, full);
          for (const line of readFileSync(full, 'utf8').split('\n')) {
            if (!/\brenameSync\b/.test(line)) continue;
            if (rel === 'atomic-write.util.ts') found = true;
            else if (!isSetAside(rel, line)) offenders.push(rel);
          }
        }
      }
    };
    walk(src);
    expect(found).toBe(true);
    expect([...new Set(offenders)]).toEqual([]);
  });
});
