import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchWatchdog, updateWatchdogConfig } from '../lib/agents';
import type { WatchdogConfig, WatchdogStatus } from '../../../shared/types';

/**
 * How often to poll `GET /api/agents/watchdog` while the sweeper reports
 * `armed` AND the caller asked to be live — `WatchdogMonitor`'s state line
 * ("next check in 42s") and its per-row heartbeat ages both have to move on
 * their own for either to be worth showing at all. 5s, the identical cadence
 * `useOrchestratorRuns`' own `POLL_MS` uses for the live run strip, and for
 * the same balancing act: fast enough that the card reads as live rather
 * than stale, slow enough that leaving Runs › Watchdog open all afternoon
 * costs a trickle of same-origin GETs rather than a flood.
 *
 * task-18: this number used to be justified by a Settings row. It no longer
 * is — Settings passes `live: false` and prints nothing that moves — and the
 * monitor mounts only in watchdog mode, so the poll now exists exactly while
 * someone is looking at it.
 */
export const WATCHDOG_POLL_MS = 5_000;

/**
 * How often to poll while the sweeper is NOT armed — `idle` or `off` — and the caller asked to be live (#270). It used to be never: the poll existed
 * only while the last reading was `armed`, so a monitor opened on an idle sweeper sat on "idle" through a run starting, because the sweeper arms off a
 * run.json the server reads and nothing on this page fires the focus event that was the only other way back in. A slow cadence rather than the armed
 * one because nothing on screen ticks while idle — the reading only has to notice the phase CHANGE, and the fast poll takes over on the render that
 * lands `armed`. 15 s, the same number `BOARD_TRACKER_POLL_MS` (useBoard.ts) uses for the app's other "something may move without an event here"
 * poll — a few GETs a minute for a tab left open all afternoon, and a run that starts is on screen within one cycle of its run file.
 */
export const WATCHDOG_IDLE_POLL_MS = 15_000;

/**
 * A refused `POST /api/agents/watchdog/config`, carrying the field it was
 * refused for (bug-24).
 *
 * A second state field rather than a second meaning for `error`, because the
 * two failures need two PLACES on screen and one field can only be rendered
 * in one of them. A failed GET is a group-level fact — there is no config to
 * bind a control to, so the whole group is replaced by a notice. A failed
 * POST is the opposite: `status` is intact and every control still reads a
 * real server value, so the only thing missing is a line saying THIS change
 * was refused, and that line belongs beside the control that was changed.
 * `field` is what buys that placement: without it a consumer can only render
 * a group-level banner, which is the shape that made the original defect
 * possible (the message rendered in the one branch a successful GET had
 * already made unreachable).
 *
 * `field` is `null` for a patch with no keys — an unattributable failure
 * still carries its message, because a `saveError` that renders nowhere is
 * exactly the bug this type exists to end.
 */
export type WatchdogSaveError = { field: keyof WatchdogConfig | null; message: string };

/**
 * The watchdog's own status (design §4.2, §6.4) — the one hook both
 * `WatchdogMonitor` (Runs › Watchdog) and `WatchdogGroup` (Settings) read,
 * mount + focus like `useAgents`, plus a live poll — fast while `armed`, slow
 * (`WATCHDOG_IDLE_POLL_MS`) otherwise, since #270: armed-only, the shape
 * `useOrchestratorRuns` established, left an idle monitor blind to a run
 * starting, because nothing on this page fires an event when one does.
 *
 * `live` (task-18) is the second half of that same "only poll when there is
 * something to poll FOR" argument, moved from the hook's own knowledge to
 * the caller's. The hook can see `phase === 'armed'`; it cannot see whether
 * anything it feeds actually renders a reading that changes on a clock.
 * Settings, after the monitor took its State row and Activity feed away,
 * renders four knobs and nothing else — a poll there redraws identical
 * output forever — so it passes `live: false`. The monitor takes the
 * default. `live: false` skips the interval and NOTHING else: the mount
 * fetch, the focus refetch, `save()` and the error posture below are
 * deliberately identical under both settings, because those are how a
 * Settings group learns the sweeper's config changed on another device, and
 * that has nothing to do with whether anything on screen ticks.
 *
 * Unlike `useAgents`/`useOrchestratorRuns`, this hook surfaces `error` as
 * its own field rather than folding a failed fetch into a synthesized "off"
 * value. Those two hooks feed passive board chrome where "couldn't reach the
 * API" and "the feature is off" already render identically to a viewer; this
 * hook feeds a Settings group whose whole job is to report on ITSELF — a
 * silent fallback to some default status would tell an operator staring at
 * "off" that the watchdog is disabled when the truth is this tab simply
 * could not reach the server, which is a materially different fact to act
 * on. `status` therefore stays whatever it last WAS (or `null`, before the
 * first successful answer) on a failure, and `error` carries the reason
 * alongside it — the same "leave the last good value on screen" fallback
 * `useOrchestratorArchive`'s own `refresh` takes, but paired with a field a
 * caller can actually render a message from, because both of this hook's
 * consumers need to say something a plain silent no-op would not.
 *
 * `save` posts the patch and replaces `status` directly from the POST's own
 * response — never a `reload()` call afterwards. `writeWatchdogConfig`
 * merges the patch it receives over the file's OWN current contents and
 * `POST /api/agents/watchdog/config` returns the full resulting
 * `WatchdogStatus` for exactly this reason (design §5.3): a second GET
 * immediately after the POST would answer the identical question the POST's
 * response already carried, at the cost of a second round trip the Settings
 * group's own redraw does not need.
 */
export function useWatchdog(opts: { live?: boolean } = {}): {
  status: WatchdogStatus | null;
  error: string | null;
  saveError: WatchdogSaveError | null;
  reload: () => Promise<void>;
  save: (patch: Partial<WatchdogConfig>) => Promise<void>;
} {
  const { live = true } = opts;

  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<WatchdogSaveError | null>(null);

  // Flipped false on unmount, checked before every setState below — the
  // identical guard and identical StrictMode rationale `useOrchestratorRuns`'
  // own `mountedRef` carries (see that hook's comment for the full
  // mechanics): re-asserted in the effect BODY, not only in `useRef`'s
  // initializer, because `useRef`'s initial value is computed exactly once
  // for the life of the fiber and never again on a later effect run, so a
  // StrictMode dev-only mount → cleanup → remount cycle would otherwise
  // leave this flag stuck `false` for the whole of the component's real,
  // on-screen life.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const fresh = await fetchWatchdog();
      if (mountedRef.current) {
        setStatus(fresh);
        setError(null);
        // `saveError` is deliberately NOT cleared here. This reload runs on
        // the window's schedule (mount, and every focus), not the user's: a
        // tab switch must not erase the one line telling them their change
        // never stuck. And the freshly-read `config` this very call just
        // installed is what makes that line TRUE rather than stale — the
        // values on screen are once again the server's own, which is
        // precisely what the message says. The next save attempt is the only
        // thing that clears it.
      }
    } catch (e) {
      // The last good status stays on screen (see the class comment above)
      // — only `error` changes, so a transient hiccup does not blank out a
      // State row that was reading real data a moment ago.
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : 'failed to load watchdog status');
      }
    }
  }, []);

  const save = useCallback(async (patch: Partial<WatchdogConfig>) => {
    // Cleared synchronously, BEFORE the await: a retry must not sit there
    // displaying the previous attempt's refusal while the new POST is still
    // in flight, which reads as "still broken" for as long as the round trip
    // takes.
    setSaveError(null);
    try {
      const fresh = await updateWatchdogConfig(patch);
      if (mountedRef.current) {
        setStatus(fresh);
        setError(null);
        setSaveError(null);
      }
    } catch (e) {
      if (mountedRef.current) {
        // Neither `status` nor `error` is touched: the failure was on the
        // write, so the last value the server actually returned is still
        // correct on screen, and `error` keeps meaning "this tab could not
        // READ the watchdog" for the other consumer that renders it.
        //
        // The field is the patch's first key. Every control posts exactly
        // one — the whole group's save path is one knob at a time
        // (`WatchdogGroup`) — so "first" and "only" are the same key here,
        // and a patch with no keys at all reports `null` rather than
        // dropping the message.
        const [first] = Object.keys(patch) as (keyof WatchdogConfig)[];
        setSaveError({
          field: first ?? null,
          message: e instanceof Error ? e.message : 'failed to save watchdog config'
        });
      }
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = (): void => {
      void reload();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  // The live poll: an interval that exists only while the caller asked to be live, on the fast cadence while `status?.phase` reads `'armed'` and
  // the slow `WATCHDOG_IDLE_POLL_MS` otherwise (#270 — it used to be armed-ONLY, and an idle monitor never noticed a run starting until a focus
  // event). `useOrchestratorRuns`' own polling effect makes the related trade — a surface left open and unattended must not spend that whole
  // stretch polling fast for a state that is not moving — but this one cannot go fully quiet, because the phase change it is waiting for has no
  // event on this page. The moment a reload lands `'armed'`, this effect reruns and swaps the slow interval for the fast one; the moment a later
  // reload finds `'idle'`/`'off'` again, it swaps back on that very render. Before the first answer (`status` null, or a failed first read) the
  // slow cadence applies too, so a monitor whose first GET failed retries rather than sitting on its error until focus.
  //
  // `live` sits in the same guard and the same dependency array rather than wrapping the effect, so a caller that ever flips the flag gets the
  // interval installed or torn down on that render like any other input. `live: false` still means NO interval at either cadence.
  const armed = status?.phase === 'armed';
  useEffect(() => {
    if (!live) return;
    const id = setInterval(
      () => {
        void reload();
      },
      armed ? WATCHDOG_POLL_MS : WATCHDOG_IDLE_POLL_MS
    );
    return () => clearInterval(id);
  }, [live, armed, reload]);

  return { status, error, saveError, reload, save };
}
