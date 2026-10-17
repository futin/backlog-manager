import { useCallback, useState } from 'react';

import { fetchOrchestratorArchive } from '../lib/agents';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';
import type { OrchestratorArchiveRun } from '../../../shared/types';

/**
 * The orchestrator's full run history across every project — a browsing view
 * (RunsView, Task 6/7), not a live one. This is `useOrchestratorRuns`' sibling
 * with its one defining difference removed on purpose: no polling interval,
 * ever. That hook's whole reason to exist is to keep a QUEUE ticking while a
 * run is actively in progress — an interval that arms only while at least
 * one run is fresh, and tears down the moment none is. Run HISTORY does not
 * have an equivalent "actively changing" state to poll for: it moves at run
 * BOUNDARIES — a run starts, an item finishes, the next `init` archives the
 * previous `run.json` into `runs/<runId>.json` — not on every heartbeat tick
 * a live run's watch loop produces, so there is nothing for a poll on this
 * list to usefully catch mid-run that the next mount or window focus would
 * not already catch just as well the moment someone actually looks. Adding
 * one anyway would cost every idle Runs-tab viewer a request every few
 * seconds for a list that, most of the time, has not moved since the last
 * one. A currently-running run still gets its second-by-second liveness from
 * `useOrchestratorRuns`, which this hook does not replace or duplicate —
 * RunsView's live row is expected to read that hook's poll directly rather
 * than ask this one to grow a redundant interval of its own.
 *
 * Fetches on mount and on window focus (`useRefreshing`, the cadence every
 * board poller shares): most of what changes this list happens in a terminal
 * you have alt-tabbed away from, which is exactly when a focus event fires.
 *
 * `runs` starts `[]` for the same reason `useOrchestratorRuns`' does: it is
 * exactly what `GET /api/orchestrator/archive` itself answers for a project
 * (or a whole machine) that has never run the orchestrator, so "haven't
 * heard back from the very first fetch yet" and "genuinely nothing to
 * report" render identically — the right default for a view that has to
 * show an empty state outright rather than flash a loading spinner nobody
 * asked for.
 */
export function useOrchestratorArchive(): { runs: OrchestratorArchiveRun[]; refresh: () => void } {
  const [runs, setRuns] = useState<OrchestratorArchiveRun[]>([]);

  // Checked before every setRuns: the mount-time fetch itself can land after unmount, polling or not — see `useMountedRef`.
  const mountedRef = useMountedRef();

  const load = useCallback(
    () =>
      fetchOrchestratorArchive()
        .then((payload) => {
          if (mountedRef.current) setRuns(payload.runs);
        })
        // A failed fetch (the API hiccups, the box is mid-restart) keeps
        // whatever is already in state — the same fallback
        // `useOrchestratorRuns`' own refresh makes, for the same reason: there
        // is no error field on this hook's return value for a caller to render
        // one from, so the only sane behaviour is to leave the last good list
        // on screen and let the next mount, focus, or manual `refresh()` try
        // again rather than blank out history that is still perfectly valid.
        .catch(() => {}),
    [mountedRef]
  );

  // No `armed`: this hook never polls (above). #285: a focus or `refresh()` that lands mid-flight folds into one follow-up rather than starting a second
  // request.
  const request = useRefreshing(load);
  const refresh = useCallback(() => {
    void request();
  }, [request]);

  return { runs, refresh };
}
