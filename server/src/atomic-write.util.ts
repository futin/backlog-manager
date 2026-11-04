import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * atomic-write.util.ts — the one way this server replaces a JSON file it owns (#445).
 *
 * The temp-file-then-rename write used to be typed out by hand, once per file, and the part that is easy to forget was forgotten: of the seven copies #423
 * counted, only two removed their temp file when the write failed, so a full disk stranded a `*.tmp` beside the other five for good. A fix repeated by hand is
 * a fix missed somewhere, so the write has one home now and `test/atomic-write.test.ts` greps `server/src` for a `renameSync` anywhere else.
 *
 * What a caller still owns is everything around the write: the refusal of a file it could not read, the merge, the return value. This module knows nothing
 * about any file's shape, and it never reads the target.
 */

/**
 * Writes `value` as two-space JSON plus one trailing newline to `file`, creating its directory when missing. A reader, this server's or another process's,
 * sees the old complete file or the new complete one and never half of either.
 *
 * The temp file sits in the target's OWN directory, because a rename is atomic only within one filesystem. Its name does not embed the target's: a pause
 * request's file is `encodeURIComponent(<project path>)`, which can come close to the 255-byte limit on its own, and a longer temp name would turn a working
 * write into `ENAMETOOLONG`. A temp file stranded by a killed process still sits beside the file it belonged to, and nothing reads these names.
 *
 * A failed write or rename removes the temp file and rethrows the ORIGINAL error. The removal has its own `catch` because `rmSync`'s `force` ignores only
 * `ENOENT`: an `EACCES` from the cleanup would otherwise replace the failure the caller needs to see.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.atomic-write.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the write's own failure is the one worth reporting
    }
    throw e;
  }
}
