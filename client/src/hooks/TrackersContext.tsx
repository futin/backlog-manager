import { createContext, useContext, type ReactNode } from 'react';

import { useTrackers, type TrackersState } from './useTrackers';

/**
 * The shell's one `useTrackers` instance (the tracker strip spec, §4), handed to every reader — the strip chip and Shared Settings' Trackers card.
 *
 * One instance because two would be two clocks: each hook schedules its own fetch off the answer it got, so two callers would fetch twice per cycle and,
 * worse, could hold two different answers — the chip saying one repo is failing while the card beside it says the other. The provider sits in `App`,
 * above the rail and every section, because the chip outlives any section.
 *
 * The default value is the hook's own loading state, not `null`-and-throw: a component rendered without the provider (a test mounting `SettingsView`
 * alone, or a future surface) draws its loading branch — "checking…" — rather than taking the page down. It never fetches; only the provider does.
 */
const LOADING: TrackersState = { data: null, loading: true, error: false, reload: () => {}, saveInterval: () => Promise.resolve(), refusals: {} };

export const TrackersContext = createContext<TrackersState>(LOADING);

export function TrackersProvider({ children }: { children: ReactNode }) {
  const state = useTrackers();
  return <TrackersContext.Provider value={state}>{children}</TrackersContext.Provider>;
}

export function useTrackersContext(): TrackersState {
  return useContext(TrackersContext);
}
