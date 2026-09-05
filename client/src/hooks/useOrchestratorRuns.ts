import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchOrchestratorRuns } from '../lib/agents';
import type { OrchestratorRunsPayload } from '../../../shared/types';

/**
 * How often to poll while at least one run is fresh. Five seconds is fast
 * enough that the run strip (Task 11) reads as live without feeling laggy,
 * and slow enough that leaving the board open all afternoon costs a trickle
 * of same-origin GETs rather than a flood of them.
 *
 * Exported (fix round 1) because RunStrip.tsx imports it directly for its
 * own "how young does a heartbeat have to be to read as 'live'" threshold —
 * this poller is the only reason that number can ever be current, so the
 * strip's reading and this interval have to move together, not just start
 * out equal by coincidence.
 */
export const POLL_MS = 5_000;

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
  //
  // The `true` has to be set HERE, in the effect body, not only in
  // `useRef(true)`'s initializer — `useRef`'s initial value is computed
  // exactly once for the lifetime of the fiber, never again on a later
  // effect run, whereas this effect body runs every time the effect
  // (re-)fires. That distinction is invisible on a plain mount, where both
  // ever happen exactly once each, but StrictMode's dev-only mount → cleanup
  // → remount sequence (client/src/main.tsx wraps <App> in <StrictMode>)
  // runs the cleanup below once *before* the lasting mount: with only the
  // initializer setting `true`, that first cleanup flips the ref to `false`
  // and nothing ever flips it back, so the guard reads "unmounted" for the
  // rest of the component's real, on-screen lifetime — every `refresh()`
  // silently skips its `setRuns`, and the hook reports zero data and never
  // polls from the very first real mount onward. Re-asserting `true` in the
  // effect body means the remount's own run re-arms it correctly.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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
  //
  // Renamed from `anyFresh` (orchestrator-watchdog design §6.3) to
  // `anyLive`, and widened from `runs.some((run) => run.fresh)` to also
  // count a run that is `status === 'running'` but no longer `fresh` — a
  // CRASHED run, in `RunStrip.tsx`'s own vocabulary (`isCrashed`,
  // lib/run-watchdog.ts). A crashed strip rendered once and then left to
  // sit is a screenshot, not a live view: the attempt counter, the error
  // text, and the moment the watchdog's own spawn brings the run back to
  // life would all otherwise wait for a window-focus event that might not
  // come for hours — the exact shape of the four-hour gap
  // `run-20260903-112622` left the FIRST time (see run-watchdog.ts's own
  // header for the incident this whole feature traces back to), just moved
  // from "the strip is blank" to "the strip is stale and doesn't say so".
  const anyLive = runs.some((run) => run.fresh || run.status === 'running');

  /**
   * The point of this hook: an interval that exists only while it has
   * something to report on. `useNow` (client/src/hooks/useNow.ts) already
   * makes this exact trade for its own per-minute tick — installing no timer
   * at all while its `enabled` flag is false — and the reasoning here is the
   * same, with a sharper cost. That hook's timer merely re-renders a label
   * whose props have not changed; this one fires a real network request
   * every tick. A board left open and unattended for hours — a spare
   * monitor, a forgotten tab — must not spend that whole stretch polling an
   * API for a run that finished (or never started) long ago: with nothing
   * live, `anyLive` is false, this effect's guard clause returns before
   * ever calling `setInterval`, and the cleanup from the last time it WAS
   * true (if ever) has already cleared that interval on the render where
   * `anyLive` flipped. A quiet board therefore costs exactly the two
   * requests mount and focus already cost it, forever, and not one more.
   * The moment a run goes live — fresh, or newly crashed — the next mount,
   * focus, or a launch elsewhere in the app that this same focus effect
   * will pick up — this effect reruns, installs the interval, and polling
   * resumes; the moment the last live run finishes (truly `done`,
   * `aborted`, or `failed` — not merely gone stale) this effect reruns
   * again and tears the interval back down on that very render. Mount and
   * window focus (both effects above) are untouched by any of this and
   * keep refreshing in both worlds — which is what lets a quiet board still
   * notice a brand new run the instant you switch back to the tab, instead
   * of waiting up to 5s for a poll that, by definition, was not running yet.
   */
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [anyLive, refresh]);

  return { runs, refresh };
}
