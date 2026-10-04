import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * tmp-root.ts — one temp directory per jest run, and every fixture any suite makes lands inside it (#243).
 *
 * Forty-odd suites and both shared helpers (`store.ts`, `env.ts`) call `mkdtempSync(join(tmpdir(), ...))` and almost none of them remove what they made. On
 * 2026-10-03 that had filled `/tmp` — a tmpfs with a fixed inode budget — to 100% inode use with ~69k of this repo's fixture directories, and from then on
 * every `Bash` call in every Claude Code session on the machine failed with `ENOSPC`. Orchestrator runs are what compounded it: execute, review and every fix
 * loop each run the whole suite, so one item can run it half a dozen times.
 *
 * Retrofitting a cleanup into each `mkdtempSync` site would fix today's forty and leave the forty-first to leak again. Redirecting `TMPDIR` fixes the class:
 * `os.tmpdir()` re-reads it on every call, so every existing site — and every future one that follows the same idiom — creates its fixture under this root
 * without being edited, and the teardown removes the root, and with it everything, in one `rmSync`.
 *
 * The root is named `bm-jest-<pid>-…` so a run that never reached its teardown — killed by an orchestrator verify timeout, a Ctrl-C, an OOM — is still
 * recoverable: the next run's `claimTmpRoot` removes every root whose pid is no longer alive. A root whose pid IS alive is left alone even if it is ancient,
 * because two worktrees running the suite at once is normal here and the other run's fixtures are in use. A reused pid only means a leftover survives one
 * more sweep; it can never mean a live run's root is removed, since a live run's own pid is by definition alive.
 *
 * The node runner has the same mechanism in `scripts/test-tmpdir.mjs` (prefix `bm-nodetest-`). It is a second copy rather than a shared module because jest
 * loads this file through ts-jest as CommonJS and the node runner loads that one through `--import` as ESM; keep the two in step.
 */
export const JEST_TMP_PREFIX = 'bm-jest-';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to somebody else — alive, so not ours to sweep.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes every `<prefix><pid>-…` directory directly under `base` whose pid is dead. Returns the names removed. */
export function sweepDeadRoots(base: string, prefix: string = JEST_TMP_PREFIX): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length).split('-')[0]);
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    rmSync(join(base, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Sweeps dead roots under `base`, creates this process's root there and points `TMPDIR` at it. Must run in jest's own process (`globalSetup`) so the
 * assignment lands on the REAL `process.env` that `os.tmpdir()` reads — a `setupFiles` entry only sees jest's per-file copy (see `global-setup.ts`).
 */
export function claimTmpRoot(base: string = tmpdir(), prefix: string = JEST_TMP_PREFIX): string {
  sweepDeadRoots(base, prefix);
  const root = mkdtempSync(join(base, `${prefix}${process.pid}-`));
  process.env.TMPDIR = root;
  return root;
}

export function releaseTmpRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
