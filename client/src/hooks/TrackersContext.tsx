import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { useAnsweredAt } from './useAnsweredAt';
import { useTrackers, type TrackersState } from './useTrackers';

/**
 * The shell's one `useTrackers` instance (the tracker strip spec, §4), handed to every reader — the strip chip, Shared Settings' Sources card and
 * GitHub › Settings.
 *
 * One instance because two would be two clocks: each hook schedules its own fetch off the answer it got, so two callers would fetch twice per cycle and,
 * worse, could hold two different answers — the chip saying one repo is failing while the card beside it says the other. The provider sits in `App`,
 * above the rail and every section, because the chip outlives any section.
 *
 * The default value is the hook's own loading state, not `null`-and-throw: a component rendered without the provider (a test mounting `SettingsView`
 * alone, or a future surface) draws its loading branch — "checking…" — rather than taking the page down. It never fetches; only the provider does.
 *
 * `answeredAt` is when the current answer landed (`useAnsweredAt`, #588), for Settings › Shared's `Last read` foot; optional so a test's hand-built value
 * may leave it out, which reads as "no stamp".
 */
export type TrackersContextValue = TrackersState & { answeredAt?: number | null };

const LOADING: TrackersContextValue = { data: null, loading: true, error: false, reload: () => {}, saveInterval: () => Promise.resolve(), refusals: {} };

export const TrackersContext = createContext<TrackersContextValue>(LOADING);

export function TrackersProvider({ children }: { children: ReactNode }) {
  const state = useTrackers();
  const answeredAt = useAnsweredAt(state.data);
  const value = useMemo<TrackersContextValue>(() => ({ ...state, answeredAt }), [state, answeredAt]);
  return <TrackersContext.Provider value={value}>{children}</TrackersContext.Provider>;
}

export function useTrackersContext(): TrackersContextValue {
  return useContext(TrackersContext);
}
