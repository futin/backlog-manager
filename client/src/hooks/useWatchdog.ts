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
 * The watchdog's own status (design §4.2, §6.4) — the one hook both
 * `WatchdogMonitor` (Runs › Watchdog) and `WatchdogGroup` (Settings) read,
 * mount + focus like `useAgents`, plus the ARMED-ONLY poll
 * `useOrchestratorRuns` already established the pattern for: an interval
 * that exists only while there is something worth re-reading on a clock,
 * torn down the moment there is not.
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
  reload: () => Promise<void>;
  save: (patch: Partial<WatchdogConfig>) => Promise<void>;
} {
  const { live = true } = opts;

  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    return () => { mountedRef.current = false; };
  }, []);

  const reload = useCallback(async () => {
    try {
      const fresh = await fetchWatchdog();
      if (mountedRef.current) {
        setStatus(fresh);
        setError(null);
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
    try {
      const fresh = await updateWatchdogConfig(patch);
      if (mountedRef.current) {
        setStatus(fresh);
        setError(null);
      }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : 'failed to save watchdog config');
      }
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = (): void => { void reload(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  // The armed-only poll: an interval that exists only while the caller asked
  // to be live AND `status?.phase` reads `'armed'`.
  // `useOrchestratorRuns`' own polling effect makes the identical trade for
  // the identical reason — a surface left open and unattended must not spend
  // that whole stretch polling an API for a state that is not moving. The
  // moment a reload lands `'armed'`, this effect reruns and installs the
  // interval; the moment a later reload finds `'idle'`/`'off'` again, it
  // reruns once more and tears the interval back down on that very render.
  //
  // `live` sits in the same guard and the same dependency array rather than
  // wrapping the effect, so a caller that ever flips the flag gets the
  // interval installed or torn down on that render like any other input.
  useEffect(() => {
    if (!live || status?.phase !== 'armed') return;
    const id = setInterval(() => { void reload(); }, WATCHDOG_POLL_MS);
    return () => clearInterval(id);
  }, [live, status?.phase, reload]);

  return { status, error, reload, save };
}
