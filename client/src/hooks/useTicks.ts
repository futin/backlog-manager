import { useCallback, useState } from 'react';

import { fetchTicks, resetTicks, updateTickConfig, type TickConfigPatch } from '../lib/ticks';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';
import type { TicksPayload } from '../../../shared/types';

/**
 * How long after one `GET /api/ticks` settles the next is asked (#277: from the answer, not the wall clock), while the caller asked to be live. Ticks land
 * on a job's schedule — minutes apart at the fastest — and the page's halted badge and "last tick" ages only need to notice one within a quarter minute; 15 s
 * is the cadence `WATCHDOG_IDLE_POLL_MS` and `BOARD_TRACKER_POLL_MS` already use for the app's other "something may move with no event here" polls.
 */
export const TICKS_POLL_MS = 15_000;

/**
 * The tick breaker's state (spec `2026-10-22-tick-breaker-design.md`, "Client") — the one hook Runs › Ticks and the Settings card both read. Same shape as
 * `useWatchdog`: a mount + focus read through `useRefreshing` (so never two of its own in flight, #277), a poll only while `live`, and writes that replace
 * `data` from the POST's own answer rather than a follow-up GET (every write route answers the whole `TicksPayload` for exactly that reason).
 *
 * `live: false` is the Settings card's setting: nothing on it ticks, so a poll would redraw identical output forever. It reads once on mount (and on focus,
 * which is how the card learns the setting changed on another device) and nothing else.
 *
 * `error` and `saveError` are two fields because they need two places on screen: a failed READ leaves `data` intact and says the page is stale; a failed WRITE
 * says THIS change did not stick (an unreadable `tick.json` answers 409 with its path) and is cleared only by the next write — a focus reload must not erase
 * the one line telling the person their Reset never landed. Neither failure replaces `data`: the last good payload stays on screen.
 */
export function useTicks(opts: { live?: boolean } = {}): {
  data: TicksPayload | null;
  error: string | null;
  saveError: string | null;
  reload: () => Promise<void>;
  save: (patch: TickConfigPatch) => Promise<void>;
  reset: (project: string) => Promise<void>;
} {
  const { live = true } = opts;

  const [data, setData] = useState<TicksPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A request can land after the component is gone; every setState below checks this first.
  const mountedRef = useMountedRef();

  const load = useCallback(async () => {
    try {
      const fresh = await fetchTicks();
      if (mountedRef.current) {
        setData(fresh);
        setError(null);
      }
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'failed to load ticks');
    }
  }, [mountedRef]);

  const reload = useRefreshing(load, { armed: live, intervalMs: TICKS_POLL_MS });

  /** Both writes share one posture, so they share one body: clear the old refusal BEFORE the await (a retry must not sit under the last attempt's message),
   *  install the answer on success, keep `data` and say why on failure. */
  const write = useCallback(
    async (call: () => Promise<TicksPayload>, fallback: string) => {
      setSaveError(null);
      try {
        const fresh = await call();
        if (mountedRef.current) {
          setData(fresh);
          setError(null);
          setSaveError(null);
        }
      } catch (e) {
        if (mountedRef.current) setSaveError(e instanceof Error ? e.message : fallback);
      }
    },
    [mountedRef]
  );

  const save = useCallback((patch: TickConfigPatch) => write(() => updateTickConfig(patch), 'failed to save tick config'), [write]);
  const reset = useCallback((project: string) => write(() => resetTicks(project), 'failed to reset ticks'), [write]);

  return { data, error, saveError, reload, save, reset };
}
