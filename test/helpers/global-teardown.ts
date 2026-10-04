import { releaseTmpRoot } from './tmp-root';

/**
 * Removes the run's temp root `global-setup.ts` claimed, and with it every fixture directory any suite created (#243 — see `tmp-root.ts`). Reads the root
 * back from `BM_JEST_TMP_ROOT` rather than `TMPDIR`, because a suite may legitimately repoint `TMPDIR` and this must still remove the directory setup made.
 */
export default async function globalTeardown(): Promise<void> {
  const root = process.env.BM_JEST_TMP_ROOT;
  if (root) releaseTmpRoot(root);
}
