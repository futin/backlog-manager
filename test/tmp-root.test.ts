import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { makeProject } from './helpers/store';
import { claimTmpRoot, releaseTmpRoot, sweepDeadRoots } from './helpers/tmp-root';

// #243: the suite used to leak every fixture into `/tmp` until the tmpfs ran out of inodes. The fix is `TMPDIR` pointed at one per-run root by
// `globalSetup` and removed by `globalTeardown` (`test/helpers/tmp-root.ts`). The first case is the guard that the redirect actually reaches a suite — if
// `globalSetup` stopped claiming the root, or claimed it somewhere `os.tmpdir()` does not read, every fixture would silently go back to `/tmp`.
describe('per-run temp root (#243)', () => {
  it('points every suite at a bm-jest-<pid>- root, and the shared fixture helpers create inside it', () => {
    const root = tmpdir();
    expect(basename(root)).toMatch(/^bm-jest-\d+-/);
    expect(process.env.BM_JEST_TMP_ROOT).toBe(root);
    expect(makeProject('tmp-root-guard', []).startsWith(root + '/')).toBe(true);
  });

  it('sweeps a root whose pid is dead and keeps one whose pid is alive', () => {
    const base = mkdtempSync(join(tmpdir(), 'sweep-'));
    // A pid that certainly existed and has certainly exited by the time spawnSync returns.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    mkdirSync(join(base, `bm-jest-${dead}-abc`));
    mkdirSync(join(base, `bm-jest-${process.pid}-def`));
    mkdirSync(join(base, 'bm-alpha-xyz'));
    expect(sweepDeadRoots(base)).toEqual([`bm-jest-${dead}-abc`]);
    expect(existsSync(join(base, `bm-jest-${process.pid}-def`))).toBe(true);
    expect(existsSync(join(base, 'bm-alpha-xyz'))).toBe(true);
  });

  it('claim creates the root and exports it as TMPDIR; release removes it with its contents', () => {
    const base = mkdtempSync(join(tmpdir(), 'claim-'));
    const before = process.env.TMPDIR;
    try {
      const root = claimTmpRoot(base);
      expect(basename(root)).toMatch(new RegExp(`^bm-jest-${process.pid}-`));
      expect(process.env.TMPDIR).toBe(root);
      mkdirSync(join(root, 'fixture', 'nested'), { recursive: true });
      releaseTmpRoot(root);
      expect(existsSync(root)).toBe(false);
    } finally {
      process.env.TMPDIR = before;
    }
  });
});
