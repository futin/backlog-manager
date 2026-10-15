import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * git-run.util.ts — the one way this server runs git (#277).
 *
 * Every git read in a request path used to be a SYNCHRONOUS spawn. On
 * 2026-10-15 Docker's bind-mount I/O slowed down, `git status` took 5–38 s
 * in-container, and because a synchronous spawn blocks the Node event loop the
 * WHOLE process stalled with it: `/api/health` — which does no I/O at all —
 * took 23 s, `/api/projects` 16 s, `/api/agents/status` 20 s. An async spawn
 * lets a slow git make the routes that need git slow, and leaves every other
 * route answering normally. That is the entire reason this module exists, so
 * nothing here may ever block: no `*Sync` spawn, ever, anywhere
 * under `server/src` (`test/git-run.test.ts` greps for it).
 *
 * Failure is a VALUE, not an exception, because every call site already had
 * exactly one failure branch and each degrades rather than 500s: a timeout, a
 * non-zero exit, a spawn error (`ENOENT` for no git, a `cwd` that is not a
 * directory) and an oversized output all `reject` out of `execFile` and all
 * land here in the same `null`. A caller that wants to tell them apart is a
 * caller that has a reason a timeout should behave differently from a missing
 * repo, and none of the six does.
 */

const execFileAsync = promisify(execFile);

/**
 * Upper bound on any one git process, in milliseconds. Ten seconds rather than
 * the 5 the synchronous callers carried: a synchronous 5 s timeout was a cap on
 * how long the whole server could be frozen, and a long cap was dangerous for
 * that reason. Async removes the danger, so the bound now only says how long a
 * single request is willing to wait on a repository before giving up with the
 * degraded answer — and the incident's 5–38 s spread says 5 s would have
 * degraded healthy-but-slow repos too eagerly.
 */
export const GIT_TIMEOUT_MS = 10_000;

let timeoutMs = GIT_TIMEOUT_MS;

/**
 * Test-only: the timeout cases need a bound a fake slow `git` can exceed in
 * tens of milliseconds rather than ten seconds. Same shape as
 * `__resetGitDateMemo` in `git-dates.util.ts`; pass `null` to restore.
 */
export function __setGitTimeoutMs(ms: number | null): void {
  timeoutMs = ms ?? GIT_TIMEOUT_MS;
}

export interface RunGitOptions {
  /** Spawn cwd. Omitted for the one caller whose command names no repository
   *  (`check-ref-format` validates a string, not a ref in any repo). */
  cwd?: string;
  /** Output ceiling in bytes; `execFile`'s own default (1 MiB) when omitted. */
  maxBuffer?: number;
}

/**
 * Runs `git <args>` and answers its stdout (utf8), or `null` for every failure
 * alike — timeout, non-zero exit, spawn error, oversized output. A successful
 * command that prints nothing answers `''`, which is NOT null: callers that
 * only care whether git exited 0 (`show-ref --quiet`) test for `!== null`.
 *
 * stdin is closed straight away, the closest `execFile` gets to the
 * `stdio: ['ignore', …]` the synchronous call sites passed: none of these
 * commands reads it, but an open pipe would hang a git that ever prompted.
 * stderr is captured and dropped rather than inherited, so a repo that is not
 * a repo never writes `fatal: not a git repository` into the server's log.
 */
export async function runGit(args: string[], options: RunGitOptions = {}): Promise<string | null> {
  try {
    const pending = execFileAsync('git', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      // Passed explicitly rather than left to `execFile`'s default of the
      // runtime's real environment. In production they are the same object;
      // under jest `process` is a sandboxed copy whose `env` the child would
      // never see, which would make a test's fake `git` on PATH invisible.
      env: process.env,
      // Conditionally spread: an explicit `maxBuffer: undefined` overrides
      // `execFile`'s default rather than falling back to it, which would make
      // the output unbounded.
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer })
    });
    pending.child.stdin?.end();
    return (await pending).stdout;
  } catch {
    return null;
  }
}
