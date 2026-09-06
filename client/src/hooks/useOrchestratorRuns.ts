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
 * How long a `noteResume` mark keeps this hook polling a run that is neither
 * fresh nor running — three minutes (task-17).
 *
 * The number is the watchdog's own worst case for the same event, borrowed
 * rather than re-derived: `WATCHDOG_LIMITS`' `graceMs` floor is five minutes
 * precisely because a resumed session's measured time to its FIRST heartbeat
 * is around ninety seconds on a good day, and can be several minutes when
 * the machine is loaded (which it usually is, since an overload is what
 * paused or crashed the run in the first place). Three minutes covers the
 * ordinary case with slack and still bounds the polling.
 *
 * It expires on its own rather than waiting for the run to come back,
 * because a resume that never starts at all — a dashboard that went down
 * between the click and the spawn — must not pin an open tab to a 5s poll
 * for the rest of the afternoon. When it expires with the run still paused,
 * the board simply goes back to mount+focus, which is the correct cadence
 * for a run nothing is happening to.
 */
export const RESUME_POLL_GRACE_MS = 180_000;

/**
 * "The resume this board asked for has landed" — the one end condition both
 * the prune and the `resuming` derivation read, so the two can never answer
 * it differently.
 *
 * `running` AND `fresh`, and the second half is bug-19's whole fix here. The
 * condition used to be `running` alone, which is exactly right for a PAUSED
 * run — the resumed session's `unpause` is its first write, minutes before it
 * produces anything else — and silently useless for a CRASHED one, because a
 * crashed run IS `status: 'running'` (with a stale heartbeat; that pair is
 * `isCrashed`, lib/run-watchdog.ts). So on the one surface where the mark had
 * to hold — the crashed strip, whose Resume control it disables — it was
 * already satisfied the instant it was written: the very next payload dropped
 * it, the button came back ~90s before the resumed session could possibly
 * have heartbeated, and a person looking at an unchanged strip clicked again.
 * That is occurrence 1 of bug-19, three spawns inside ten seconds.
 *
 * Freshness costs the paused case nothing: `unpause` writes `status`,
 * `unpausedAt` and `updatedAt` from ONE clock reading (orchestrate.mjs's own
 * `cmdUnpause`), so a run that has just unpaused is fresh by construction.
 * It is also the honest reading of what the mark means — not "the file
 * changed" but "something is heartbeating in there again" — and it reuses the
 * app's one freshness number rather than introducing a second rule about how
 * long to wait.
 */
function hasResumed(runs: OrchestratorRunsPayload['runs'], project: string): boolean {
  return runs.some((run) => run.project === project && run.status === 'running' && run.fresh);
}

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
 *
 * `starting` (task-14) rides alongside it under exactly the same default and
 * the same reasoning: an empty array both before the first fetch lands and
 * whenever this server has no pending spawn, so the placeholder strip can
 * never flash on a board that simply hasn't heard back yet.
 */
export function useOrchestratorRuns(): {
  runs: OrchestratorRunsPayload['runs'];
  starting: OrchestratorRunsPayload['starting'];
  refresh: () => void;
  noteResume: (project: string) => void;
  resuming: ReadonlySet<string>;
} {
  const [runs, setRuns] = useState<OrchestratorRunsPayload['runs']>([]);
  const [starting, setStarting] = useState<OrchestratorRunsPayload['starting']>([]);
  /**
   * project → the moment its resume mark expires (task-17).
   *
   * `useState`, not `useRef`: `resuming` below is derived from this and is
   * READ BY COMPONENTS — the paused strip renders `Resuming…` instead of a
   * button off it — so a change has to re-render. A ref would keep the poll
   * alive correctly and leave the button unchanged on screen, which is the
   * half of the feedback the click was for.
   *
   * A deadline per project rather than a single one, because two projects
   * can be resumed independently, and a shared clock would let the second
   * click extend the first project's polling (or the first expiry end the
   * second's).
   */
  const [resumeMarks, setResumeMarks] = useState<Map<string, number>>(() => new Map());

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
        if (!mountedRef.current) return;
        setRuns(payload.runs);
        // `payload.starting ?? []`, not `payload.starting`: this hook is the
        // one place a response from an OLDER server (one built before
        // task-14, which a dev box can absolutely be serving while a newer
        // client bundle is open) reaches React state, and `starting` is
        // typed non-optional. Without the fallback, `.some()` below and the
        // board's own `.find()` would throw on undefined and take the whole
        // board down over a field that only ever adds a card.
        setStarting(payload.starting ?? []);
        // task-17: drop marks this payload has answered or that have simply
        // run out. Purely housekeeping — `resuming` below re-applies both
        // rules on every render, so an unpruned map never lies, it only
        // grows. Same pure/mutating split `StartingRunsService` keeps for
        // the same reason: correctness never depends on the sweep.
        setResumeMarks((prev) => {
          const now = Date.now();
          const next = new Map(
            [...prev].filter(([project, expiresAt]) => now < expiresAt && !hasResumed(payload.runs, project))
          );
          // Same Map when nothing was dropped, so a landed payload that
          // changed nothing here does not force an extra render.
          return next.size === prev.size ? prev : next;
        });
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
  //
  // task-14 ORs the starting placeholder into this SAME predicate rather
  // than adding a second one beside it: a board-started run that has not
  // written its run file yet is live in exactly the sense this poll exists
  // for — something is happening that this tab has to learn about without a
  // human touching it. Without it the placeholder would sit on screen until
  // the next focus event even after the real run landed, which is the same
  // "screenshot, not a live view" failure the crashed-run widening above
  // fixed, just at the other end of a run's life.
  /**
   * task-17: a project whose resume mark has not expired AND whose latest
   * payload does not yet show it `running`.
   *
   * Both halves are re-evaluated on every render — on every landed payload
   * and on every tick — rather than being pruned once and trusted. That is
   * the same posture `StartingRunsService.list()` takes on the server, and
   * for the same reason: a derivation that re-applies its own rules cannot
   * lie, where a stored verdict swept on some other schedule can.
   *
   * The end condition itself is `hasResumed` below — see that function for
   * why it is `running` AND `fresh` rather than `running` alone.
   */
  const resuming: ReadonlySet<string> = new Set(
    [...resumeMarks]
      .filter(([project, expiresAt]) => Date.now() < expiresAt && !hasResumed(runs, project))
      .map(([project]) => project)
  );

  const anyLive =
    runs.some((run) => run.fresh || run.status === 'running') || starting.length > 0 || resuming.size > 0;

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

  /**
   * "A resume was just asked for on this project" (task-17) — records a
   * deadline and refreshes at once.
   *
   * The immediate `refresh()` is not merely eager: the click that calls this
   * has already changed something server-side (a spawn is on its way), and a
   * board that shows nothing until the next 5s tick reads as a swallowed
   * click — the same feedback problem `StartingRunsService` exists to solve
   * one layer down.
   *
   * Overwrites any existing deadline rather than keeping the earlier one: a
   * second click is a second attempt, and it deserves its own full window.
   */
  const noteResume = useCallback((project: string) => {
    setResumeMarks((prev) => {
      const next = new Map(prev);
      next.set(project, Date.now() + RESUME_POLL_GRACE_MS);
      return next;
    });
    refresh();
  }, [refresh]);

  return { runs, starting, refresh, noteResume, resuming };
}
