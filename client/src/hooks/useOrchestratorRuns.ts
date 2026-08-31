import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchOrchestratorRuns } from '../lib/agents';
import type { OrchestratorRunsPayload } from '../../../shared/types';

/**
 * How often to poll while at least one run is fresh. Five seconds is fast
 * enough that the run strip (Task 11) reads as live without feeling laggy,
 * and slow enough that leaving the board open all afternoon costs a trickle
 * of same-origin GETs rather than a flood of them.
 */
const POLL_MS = 5_000;

/**
 * The orchestrator run list, kept live while — and only while — there is
 * anything live to keep it for.
 *
 * Fetches on mount and on window focus, the same cadence `useAgents` and
 * `useBoard` use and for the same reason: most of what changes this list (a
 * run starting, an item finishing, a whole run going stale) happens in a
 * terminal you have alt-tabbed away from, which is exactly when a focus
 * event fires. On top of that cadence this hook adds the one thing neither
 * of those two needs: a run already in progress keeps changing on its own,
 * with nobody touching this tab at all, so mount+focus alone would leave the
 * queue frozen at whatever it looked like when you last clicked in. See the
 * polling effect below for how that interval is scoped to exactly the
 * stretch where it is useful, and torn down the moment it stops being so.
 *
 * `runs` starts `[]` — the same shape `GET /api/orchestrator/runs` (Task 8)
 * itself answers with for a project that has never run the orchestrator —
 * so "haven't heard back from the very first fetch yet" and "genuinely
 * nothing to report" render identically. That is the right default for a
 * control (the run strip) that has to disappear outright rather than flash
 * empty while nothing is known.
 */
export function useOrchestratorRuns(): { runs: OrchestratorRunsPayload['runs']; refresh: () => void } {
  const [runs, setRuns] = useState<OrchestratorRunsPayload['runs']>([]);

  // Flipped false on unmount, checked before every setRuns below. Unlike
  // useAgents/useBoard — each has at most one in-flight fetch at a time,
  // always triggered by a human action (mount, a click back into the tab) —
  // this hook can have a poll in flight the moment the component goes away,
  // so that response would otherwise land on a hook nobody is reading any
  // more. A plain ref is cheaper here than threading an AbortController
  // through fetchOrchestratorRuns for a cancellation that would buy nothing
  // beyond what this already gets: the in-flight request still completes
  // either way, only what happens with its answer changes.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(() => {
    fetchOrchestratorRuns()
      .then((payload) => {
        if (mountedRef.current) setRuns(payload.runs);
      })
      // A failed poll (the API hiccups, the box is mid-restart) keeps
      // whatever is already in state, the same fallback `useBoard`'s own
      // refetch makes. There is no error field on this hook's return value
      // for a caller to render one from, so the only sane behaviour is to
      // leave the last good queue on screen and let the next mount, focus,
      // or interval tick try again — not blank out a run that is still
      // actually running because one request dropped.
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

  // Server-computed per run (`fresh` = status running AND heartbeated within
  // RUN_STALE_MS, shared/types.ts) — true exactly when at least one
  // registered project has a run actually worth watching live right now.
  const anyFresh = runs.some((run) => run.fresh);

  /**
   * The point of this hook: an interval that exists only while it has
   * something to report on. `useNow` (client/src/hooks/useNow.ts) already
   * makes this exact trade for its own per-minute tick — installing no timer
   * at all while its `enabled` flag is false — and the reasoning here is the
   * same, with a sharper cost. That hook's timer merely re-renders a label
   * whose props have not changed; this one fires a real network request
   * every tick. A board left open and unattended for hours — a spare
   * monitor, a forgotten tab — must not spend that whole stretch polling an
   * API for a run that finished (or never started) long ago: with no run
   * fresh, `anyFresh` is false, this effect's guard clause returns before
   * ever calling `setInterval`, and the cleanup from the last time it WAS
   * true (if ever) has already cleared that interval on the render where
   * `anyFresh` flipped. A quiet board therefore costs exactly the two
   * requests mount and focus already cost it, forever, and not one more.
   * The moment a run goes fresh — the next mount, focus, or a launch
   * elsewhere in the app that this same focus effect will pick up — this
   * effect reruns, installs the interval, and polling resumes; the moment
   * the last fresh run finishes or goes stale, this effect reruns again and
   * tears the interval back down on that very render. Mount and window
   * focus (both effects above) are untouched by any of this and keep
   * refreshing in both worlds — which is what lets a quiet board still
   * notice a brand new run the instant you switch back to the tab, instead
   * of waiting up to 5s for a poll that, by definition, was not running yet.
   */
  useEffect(() => {
    if (!anyFresh) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [anyFresh, refresh]);

  return { runs, refresh };
}
