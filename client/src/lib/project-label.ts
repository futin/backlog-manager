/**
 * The readable tail of a registry path — "/Users/dev/code/example-app"
 * becomes "example-app". The one project-identifying field a `run` payload
 * (`OrchestratorRun.project`, shared/types.ts) actually carries is the
 * registry's absolute path, not its display name, and a bare path is exactly
 * the wrong thing to put next to short project pills everywhere else on the
 * board — so both the run strip and the run drawer print this tail instead.
 *
 * Lifted here in Task 12's fix round 1: RunStrip.tsx and RunDrawer.tsx each
 * started with their own copy, RunDrawer's noting at the time that one line
 * of stdlib string-splitting felt like nothing worth keeping in sync. Two
 * real consumers needing the exact same read is precisely the trigger
 * ACTIVE_RUN_STAGES (ItemCard.tsx) and POLL_MS (useOrchestratorRuns.ts) were
 * already promoted to a shared export on, in this same file pair, for the
 * same reason — so this follows that established move rather than staying
 * duplicated past the point where a second consumer made it one.
 */
export function projectLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}
