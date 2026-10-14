import { isRemoteRun } from './remote-run';
import { isCrashed } from './run-watchdog';
import type { OrchestratorRun, StartingRun } from '../../../shared/types';

/**
 * run-pulse.ts — "is a run on this machine working right now", the one answer the rail's wordmark cursor blinks on (.claude/DESIGN.md §8.0).
 *
 * Its own file rather than a line in `run-watchdog.ts`, which is the nearest neighbour: that module is every sentence the client prints ABOUT the watchdog,
 * and this is not one — it is a presence reading over the whole payload, read by the shell rather than by any run surface. `isCrashed` is borrowed from
 * there rather than restated, which is the reason the two files are not one: the split between working and crashed is decided in one place.
 *
 * True when any of these holds, and false otherwise:
 *  - a `starting` entry exists — this server spawned a session that has not written its run file yet, so something on this machine IS booting. The server
 *    evicts the entry the moment a run file for that project lands (`StartingRunsService.expired()`), so no client-side collision filter belongs here.
 *  - a local run says `running` and is not crashed. `isCrashed` reads the server-computed `fresh`; a second freshness check written here would be a second
 *    answer to a question `GET /api/orchestrator/runs` already answers once per request.
 *
 * `paused` does not count: nothing is moving under it until a person or the watchdog resumes it. A remote run does not count either: it is another
 * machine's work, and this cursor speaks for this one. It never rides in `runs` on the wire, but the Runs page folds remote runs into its rows through
 * `remoteAsLive`, which keeps `remote: true` at run time — so this asks `isRemoteRun` instead of trusting which array a caller happened to pass.
 *
 * No clock parameter, deliberately: nothing here reads time. Freshness is the server's reading, and a starting entry's lifetime is the server's too.
 */
export function runsWorking(runs: ReadonlyArray<{ status: OrchestratorRun['status']; fresh: boolean }>, starting: readonly StartingRun[]): boolean {
  if (starting.length > 0) return true;
  return runs.some((run) => !isRemoteRun(run) && run.status === 'running' && !isCrashed(run));
}
