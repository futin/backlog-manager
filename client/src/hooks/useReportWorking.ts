import { useEffect } from 'react';

import { runsWorking } from '../lib/run-pulse';
import type { OrchestratorRunsPayload } from '../../../shared/types';

/**
 * useReportWorking — how a view that already polls the run payload tells the shell whether a run is working, for the rail's wordmark cursor
 * (.claude/DESIGN.md §8.0).
 *
 * The shell does not poll for itself, and that is the whole reason this exists: every `useOrchestratorRuns()` call is its own 5 s poller, and Board, Runs
 * and Archive each run one already. A fourth in `App` would double the requests on every one of those pages to learn something the page on screen already
 * knows. So each of the three hands its `runs` and `starting` here, and the answer — `runsWorking`, lib/run-pulse.ts, the one derivation — goes up through
 * `onWorking`.
 *
 * The effect is keyed on the BOOLEAN, not on the arrays: the arrays are new on every poll, and re-reporting an unchanged answer every five seconds would
 * re-render the shell for nothing. Nothing is reported on unmount — `App` drops the value itself on a view change, which is the only way a view leaves.
 * `onWorking` is optional so every existing render of these views (their own suites) needs no change.
 */
export function useReportWorking(
  runs: OrchestratorRunsPayload['runs'],
  starting: OrchestratorRunsPayload['starting'],
  onWorking: ((working: boolean) => void) | undefined
): void {
  const working = runsWorking(runs, starting);
  useEffect(() => {
    onWorking?.(working);
  }, [working, onWorking]);
}
