import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { liveRunCount, runsWorking } from '../lib/run-pulse';
import { useOrchestratorRuns } from './useOrchestratorRuns';

type RunsState = ReturnType<typeof useOrchestratorRuns>;

/**
 * What every reader of the run payload gets: the hook's own return, plus the two readings the shell draws from it.
 *
 * `working` is whether a run on this machine is working, for the rail's wordmark cursor (.claude/DESIGN.md §8.0) — `runsWorking`, lib/run-pulse.ts, the one
 * derivation. `undefined` is "the server has not answered yet" (`answered` false), which the rail reads as not working: `runs` is `[]` both before and after
 * an empty first answer, so only `answered` can tell "nobody knows" from "nothing is working". Settings, which used to report nothing, now reads the same
 * answer as every other page.
 *
 * `liveCount` is the number of rows in the Runs page's Live sheet (`liveRunCount`), for the rail's Runs badge.
 */
export interface RunsContextValue extends RunsState {
  working: boolean | undefined;
  liveCount: number;
}

const OrchestratorRunsContext = createContext<RunsContextValue | null>(null);

/**
 * The shell's one `useOrchestratorRuns()` (spec §4.9a). Every call of that hook is its own 5 s poller, and the four views that read the payload (Board,
 * Archive, GitHub › PRs, Runs) used to run one each while a report effect in each carried the cursor's reading up to `App` — so a view switch dropped
 * the reading and re-polled from `[]`. One poll per tab, held above the views, means the cursor, the Runs badge and every view read one answer on one
 * clock, and a view switch loses nothing.
 */
export function OrchestratorRunsProvider({ children }: { children: ReactNode }) {
  const runs = useOrchestratorRuns();
  const { runs: live, starting, remote, answered } = runs;
  const working = answered ? runsWorking(live, starting) : undefined;
  const liveCount = liveRunCount(live, remote);
  // `runs` is a fresh object on every render of the hook, so the memo keys on its parts: a poll that changed nothing the readers use must not re-render them.
  const value = useMemo<RunsContextValue>(
    () => ({ ...runs, working, liveCount }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `runs` is spread from exactly these parts
    [runs.runs, runs.starting, runs.remote, runs.remoteStarting, runs.refresh, runs.noteResume, runs.resuming, runs.answered, working, liveCount]
  );
  return <OrchestratorRunsContext.Provider value={value}>{children}</OrchestratorRunsContext.Provider>;
}

/** Throws outside the provider: a bare render must fail loudly rather than draw an empty runs list that looks like "nothing is running". */
export function useOrchestratorRunsContext(): RunsContextValue {
  const value = useContext(OrchestratorRunsContext);
  if (value === null) throw new Error('useOrchestratorRunsContext must be used inside <OrchestratorRunsProvider>');
  return value;
}
