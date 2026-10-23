import { useCallback, useState } from 'react';

import { fetchOrchestratorRuns } from '../lib/agents';
import { useRefreshing } from './useRefreshing';
import { useMountedRef } from './useMountedRef';
import type { OrchestratorRunsPayload } from '../../../shared/types';

/**
 * How long after one poll's answer settles the next poll starts, while at
 * least one run is fresh (#277: after the answer, not on the wall clock — see
 * `useCoalescedFetch`, which this hook's fetch is wrapped in). Five seconds is
 * fast enough that a live run (Task 11) reads as live without feeling laggy, and
 * slow enough that leaving the board open all afternoon costs a trickle of
 * same-origin GETs rather than a flood of them.
 *
 * Exported (fix round 1) for the surface that reads it as its own "how young
 * does a heartbeat have to be to read as 'live'" threshold — this poller is
 * the only reason that number can ever be current, so a heartbeat reading and
 * this interval have to move together rather than start out equal by
 * coincidence. That reader was `RunStrip.tsx` until task-37 took it off the
 * Board; the Runs section's own live rows are the next (task 3).
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
 * polling section below for how that poll is scoped to exactly the stretch
 * where it is useful, and torn down the moment it stops being so.
 *
 * #277: this hook never has two of its own requests in flight. A mount, a
 * focus, a resume click or a poll tick that arrives while one is outstanding
 * starts nothing; it queues exactly ONE follow-up that runs the moment the
 * outstanding one settles (`useCoalescedFetch`). The poll used to be a
 * wall-clock interval timer, which kept firing into a server that had stopped answering
 * and stacked a pending request per tick.
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
  remote: OrchestratorRunsPayload['remote'];
  remoteStarting: OrchestratorRunsPayload['remoteStarting'];
  refresh: () => void;
  noteResume: (project: string) => void;
  resuming: ReadonlySet<string>;
} {
  const [runs, setRuns] = useState<OrchestratorRunsPayload['runs']>([]);
  const [starting, setStarting] = useState<OrchestratorRunsPayload['starting']>([]);
  // Other machines' runs on a tracker project (task-48). Their own state,
  // never folded into `runs`: every reader of `runs` here and on the board
  // assumes one run file per project on THIS machine.
  const [remote, setRemote] = useState<OrchestratorRunsPayload['remote']>([]);
  // Launches sent to a REMOTE dashboard that have not shown up in its claims yet (multi-dashboard task 10). Their own state for bug-57's reason: `starting`
  // feeds `runClaimBlock` and the local expiry, and a launch on another machine blocks neither.
  const [remoteStarting, setRemoteStarting] = useState<OrchestratorRunsPayload['remoteStarting']>([]);
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

  // Flipped false on unmount, checked before every setRuns below. A poll can
  // be in flight the moment the component goes away (see `useMountedRef` for
  // why a ref rather than an abort, and for the StrictMode trap in how it is
  // set).
  const mountedRef = useMountedRef();

  // The ONE way a request leaves this hook: the mount fetch, the focus
  // refetch, the poll tick and `refresh`/`noteResume` below all go through it,
  // so no two of them can be in flight together. The `armed` condition and
  // the cadence are the polling section's, declared after `anyLive` exists.
  const load = useCallback(
    () =>
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
          // Same fallback, same reason, for task-48's array.
          setRemote(payload.remote ?? []);
          // And again for `remoteStarting`: an older server omits it, and `.length` below would throw on undefined.
          setRemoteStarting(payload.remoteStarting ?? []);
          // task-17: drop marks this payload has answered or that have simply
          // run out. Purely housekeeping — `resuming` below re-applies both
          // rules on every render, so an unpruned map never lies, it only
          // grows. Same pure/mutating split `StartingRunsService` keeps for
          // the same reason: correctness never depends on the sweep.
          setResumeMarks((prev) => {
            const now = Date.now();
            const next = new Map([...prev].filter(([project, expiresAt]) => now < expiresAt && !hasResumed(payload.runs, project)));
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
        // or poll tick try again — not blank out a run that is still
        // actually running because one request dropped.
        .catch(() => {}),
    [mountedRef]
  );

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
    [...resumeMarks].filter(([project, expiresAt]) => Date.now() < expiresAt && !hasResumed(runs, project)).map(([project]) => project)
  );

  // task-48 ORs a remote `running` run in too: this machine cannot see it
  // progress any other way than by asking again, and a run another machine is
  // draining is live in exactly the sense this poll exists for.
  //
  // Multi-dashboard task 10 ORs `remoteStarting` in as well: the server sweeps those entries only when this payload is read, so a board that stopped asking
  // would show `Starting on Pro` until something else woke it. It arms the same single coalesced poll — never a second request in flight.
  const anyLive =
    runs.some((run) => run.fresh || run.status === 'running') ||
    remote.some((run) => run.status === 'running') ||
    starting.length > 0 ||
    remoteStarting.length > 0 ||
    resuming.size > 0;

  /**
   * The point of this hook: a poll that exists only while it has something to
   * report on. `useNow` (client/src/hooks/useNow.ts) already makes this exact
   * trade for its own per-minute tick — installing no timer at all while its
   * `enabled` flag is false — and the reasoning here is the same, with a
   * sharper cost. That hook's timer merely re-renders a label whose props have
   * not changed; this one fires a real network request every tick. A board
   * left open and unattended for hours — a spare monitor, a forgotten tab —
   * must not spend that whole stretch polling an API for a run that finished
   * (or never started) long ago: with nothing live, `anyLive` is false, no
   * timer is armed, and the pending one from the last time it WAS true was
   * cleared on the render where `anyLive` flipped. A quiet board therefore
   * costs exactly the two requests mount and focus already cost it, forever,
   * and not one more. The moment a run goes live — fresh, or newly crashed —
   * the next mount, focus, or a launch elsewhere in the app that this same
   * focus handler will pick up — the landed payload arms the timer, and
   * polling resumes; the moment the last live run finishes (truly `done`,
   * `aborted`, or `failed` — not merely gone stale) the render that shows it
   * clears the timer again. A poll that was already in flight at that moment
   * still lands and updates state, and nothing re-arms after it. Mount and
   * window focus (`useRefreshing`'s two triggers) are untouched by any of this and keep
   * refreshing in both worlds — which is what lets a quiet board still notice
   * a brand new run the instant you switch back to the tab, instead of
   * waiting up to 5s for a poll that, by definition, was not running yet.
   *
   * #277: the cadence is "`POLL_MS` after the last answer settled", not "every
   * `POLL_MS`" — see `useCoalescedFetch`. `refresh` is the same single door
   * the tick uses, so a focus or a resume click that lands mid-flight queues
   * one follow-up behind the request already out instead of racing it. It
   * returns nothing: callers fire a refresh, they never wait on one.
   */
  const request = useRefreshing(load, { armed: anyLive, intervalMs: POLL_MS });
  const refresh = useCallback(() => {
    void request();
  }, [request]);

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
  const noteResume = useCallback(
    (project: string) => {
      setResumeMarks((prev) => {
        const next = new Map(prev);
        next.set(project, Date.now() + RESUME_POLL_GRACE_MS);
        return next;
      });
      refresh();
    },
    [refresh]
  );

  return { runs, starting, remote, remoteStarting, refresh, noteResume, resuming };
}
