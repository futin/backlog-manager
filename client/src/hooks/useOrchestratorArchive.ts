import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchOrchestratorArchive } from '../lib/agents';
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
 * Fetches on mount and on window focus, the exact cadence `useAgents` and
 * `useOrchestratorRuns` both use for the same reason: most of what changes
 * this list happens in a terminal you have alt-tabbed away from, which is
 * exactly when a focus event fires.
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

  // Flipped false on unmount, checked before every setRuns below — same
  // guard, same StrictMode rationale as `useOrchestratorRuns`' own
  // `mountedRef` (see that hook's comment for the full mechanics). Briefly
  // restated here because it is easy to "simplify" away on a read that only
  // sees a hook with no polling effect and assumes there is nothing left
  // that could land a `setState` after unmount: there is — the mount-time
  // fetch itself, exactly as for the live hook. client/src/main.tsx wraps
  // the whole app in `<StrictMode>`, which in development mounts every
  // component TWICE on purpose (mount, run every effect's cleanup, mount
  // again) specifically to surface effects that misbehave across that
  // cycle. `useRef`'s initial value is computed exactly once for the life of
  // the fiber, never again on a later effect run — so if this ref were only
  // ever set `true` by `useRef(true)`'s initializer, StrictMode's first
  // (throwaway) cleanup would flip it `false` and nothing would ever flip it
  // back, leaving every future `refresh()` silently skipping its `setRuns`
  // for the rest of the component's real, on-screen life. Re-asserting
  // `true` here, in the effect body, means the remount that actually stays
  // on screen re-arms the guard correctly.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(() => {
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
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = (): void => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return { runs, refresh };
}
