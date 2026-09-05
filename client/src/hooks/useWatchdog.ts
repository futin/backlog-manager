import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchWatchdog, updateWatchdogConfig } from '../lib/agents';
import type { WatchdogConfig, WatchdogStatus } from '../../../shared/types';

/**
 * How often to poll `GET /api/agents/watchdog` while the sweeper reports
 * `armed` — the Settings State row's "next check in 42s" (design §6.4) has
 * to move on its own for that sentence to be worth showing at all. 5s, the
 * identical cadence `useOrchestratorRuns`' own `POLL_MS` uses for the live
 * run strip, and for the same balancing act: fast enough that the row reads
 * as live rather than stale, slow enough that leaving Settings open all
 * afternoon costs a trickle of same-origin GETs rather than a flood.
 */
export const WATCHDOG_POLL_MS = 5_000;

/**
 * The watchdog's own status (design §4.2, §6.4) — Settings' one hook, mount
 * + focus like `useAgents`, plus the ARMED-ONLY poll `useOrchestratorRuns`
 * already established the pattern for: an interval that exists only while
 * there is something worth re-reading on a clock, torn down the moment
 * there is not.
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
 * caller can actually render a message from, because this hook's one
 * consumer needs to say something a plain silent no-op would not.
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
export function useWatchdog(): {
  status: WatchdogStatus | null;
  error: string | null;
  reload: () => Promise<void>;
  save: (patch: Partial<WatchdogConfig>) => Promise<void>;
} {
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

  // The armed-only poll: an interval that exists only while `status?.phase`
  // reads `'armed'`. `useOrchestratorRuns`' own polling effect makes the
  // identical trade for the identical reason — a board (here, a Settings
  // tab) left open and unattended must not spend that whole stretch polling
  // an API for a state that is not moving. The moment a reload lands
  // `'armed'`, this effect reruns and installs the interval; the moment a
  // later reload finds `'idle'`/`'off'` again, it reruns once more and tears
  // the interval back down on that very render.
  useEffect(() => {
    if (status?.phase !== 'armed') return;
    const id = setInterval(() => { void reload(); }, WATCHDOG_POLL_MS);
    return () => clearInterval(id);
  }, [status?.phase, reload]);

  return { status, error, reload, save };
}
