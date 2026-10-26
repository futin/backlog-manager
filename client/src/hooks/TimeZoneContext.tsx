import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { fetchTimeZone, updateTimeZone } from '../lib/settings-api';
import { browserTimeZone, readableZone } from '../lib/time-zone';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';

/**
 * The board's one shared time zone (#241), read once in the shell and handed to every surface that draws a clock, a day or a week.
 *
 * `zone` is what every reading uses: the zone stored on the API host (`stored`) when somebody chose one on Settings › Shared, else this browser's own
 * (`browser`) — so with nothing on disk every surface draws exactly what it drew before the setting existed. A stored id this browser's engine rejects
 * reads as `browser` too (`readableZone`), because a formatter built on it would throw mid-render.
 *
 * Fetched on mount and on window focus, through `useRefreshing` with no `armed` — the `useWatchdog` posture for a setting: it changes only when a person
 * changes it, so a poll would redraw identical output forever, and focus is how a tab learns another device changed it. A failed read keeps the last good
 * `stored` (and so `null`, the browser's zone, on a first read that fails): a hiccup must not move every clock on the page.
 *
 * The default value — no provider mounted — is the browser's zone and no stored one, so every suite that renders a component bare keeps today's readings and
 * stays green untouched. It never fetches; only the provider does.
 */
export interface TimeZoneState {
  zone: string;
  stored: string | null;
  browser: string;
  save: (zone: string | null) => Promise<void>;
  saveError: string | null;
}

const BARE: TimeZoneState = { zone: browserTimeZone(), stored: null, browser: browserTimeZone(), save: () => Promise.resolve(), saveError: null };

export const TimeZoneContext = createContext<TimeZoneState>(BARE);

export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mountedRef = useMountedRef();

  const load = useCallback(async () => {
    try {
      const fresh = await fetchTimeZone();
      if (mountedRef.current) setStored(fresh.timeZone);
    } catch {
      // The last good `stored` stays — see the header.
    }
  }, [mountedRef]);
  useRefreshing(load);

  // `saveError` is cleared before the await, as `useWatchdog.save` does, so a retry never shows the previous refusal while the new POST is in flight. A
  // refusal leaves `stored` alone: the value on screen is still the server's own, which is what the error row says.
  const save = useCallback(
    async (zone: string | null) => {
      setSaveError(null);
      try {
        const fresh = await updateTimeZone(zone);
        if (mountedRef.current) setStored(fresh.timeZone);
      } catch (e) {
        if (mountedRef.current) setSaveError(e instanceof Error ? e.message : 'failed to save time zone');
      }
    },
    [mountedRef]
  );

  const value = useMemo<TimeZoneState>(() => {
    const browser = browserTimeZone();
    return { zone: readableZone(stored, browser), stored, browser, save, saveError };
  }, [stored, save, saveError]);

  return <TimeZoneContext.Provider value={value}>{children}</TimeZoneContext.Provider>;
}

export function useTimeZone(): TimeZoneState {
  return useContext(TimeZoneContext);
}
