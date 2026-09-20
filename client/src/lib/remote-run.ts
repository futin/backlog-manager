import type { OrchestratorArchiveRun, OrchestratorRunsPayload, ProjectSummary, RemoteRun } from '../../../shared/types';

/**
 * remote-run.ts — the Runs page's readings of a run another machine drove
 * (task-48), one home for each, so no component re-derives any of them.
 *
 * A remote run arrives in `OrchestratorRunsPayload.remote`, assembled by the
 * server from a tracker repo's claim comments, and is never a member of `runs`
 * (see that field's comment for why). The page draws it with the same rows and
 * the same detail sheet as a local run, which is what the two adapters below
 * are for, and asks `isRemoteRun` wherever the two must differ: a remote run
 * has no file here to fetch and no controls here that would do anything.
 */

/** The live payload's own entry shape — what `MergedRun.live` holds. */
type LiveRun = OrchestratorRunsPayload['runs'][number];

/**
 * Is this run another machine's? Read off the `remote: true` literal the
 * server stamps on every entry of the `remote` array, and on nothing else.
 * Takes any object so a caller holding a `LiveRun` built by `remoteAsLive`
 * (which keeps the field at run time) can ask without a cast.
 */
export function isRemoteRun(run: object | null | undefined): boolean {
  return run !== null && run !== undefined && (run as { remote?: unknown }).remote === true;
}

/**
 * A remote run as the live entry the rows and the sheet read. `pastRuns` is
 * `0` because this machine holds no run files for it, and `pauseRequested` is
 * `false` because pause is a local file on the other machine. No `watchdog`:
 * this machine's watchdog never watches another machine's run. The `remote`
 * field survives the spread, which is what `isRemoteRun` reads.
 */
export function remoteAsLive(run: RemoteRun): LiveRun {
  return { ...run, pastRuns: 0, pauseRequested: false };
}

/**
 * A remote run as the archive record every row is keyed on — the same
 * tail-stripping `toArchiveEntry` does on the server, so the two tiers keep
 * their declared shapes. `current: false`: there is no `run.json` here for it
 * to be the current one of.
 */
export function remoteAsArchive(run: RemoteRun): OrchestratorArchiveRun {
  return {
    ...run,
    queue: run.queue.map((item) => ({ ...item, verification: item.verification.map(({ cmd, ok }) => ({ cmd, ok })) })),
    current: false
  };
}

/**
 * Is this LOCAL run invisible from other machines? True for a run of a
 * TRACKER project in which no queue item carries a claim yet: another machine
 * finds a run only through its claim comments, and a run that has claimed
 * nothing has posted none. Always `false` for a files project, where no
 * machine but this one could ever see the run anyway, and for a remote run.
 *
 * `source` is the project's `ProjectSummary.source`, or `undefined` while the
 * projects read has not landed — which reads as "do not know", so no line.
 */
export function runInvisibleElsewhere(run: { queue: ReadonlyArray<{ claim?: unknown }> }, source: ProjectSummary['source'] | undefined): boolean {
  if (isRemoteRun(run)) return false;
  if (source !== 'github') return false;
  return run.queue.every((item) => item.claim === undefined);
}
