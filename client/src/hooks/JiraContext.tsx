import { createContext, useContext, type ReactNode } from 'react';

import { useJira, type JiraState } from './useJira';

/**
 * The shell's one `useJira` instance (Jira phase 2), handed to every reader — the rail, the chip, and the Jira section's two pages. `TrackersContext`'s
 * shape and its reason: two instances would be two clocks that could hold two different answers. The provider sits in `App`, above the rail and every
 * section, because the rail's Jira entry and the chip outlive any section.
 *
 * The default value is the hook's own loading state, not `null`-and-throw: a component rendered without the provider (a test mounting a page alone)
 * draws its loading branch rather than taking the page down. It never fetches; only the provider does.
 */
const LOADING: JiraState = { data: null, loading: true, error: false, reload: () => {} };

export const JiraContext = createContext<JiraState>(LOADING);

export function JiraProvider({ children }: { children: ReactNode }) {
  const state = useJira();
  return <JiraContext.Provider value={state}>{children}</JiraContext.Provider>;
}

export function useJiraContext(): JiraState {
  return useContext(JiraContext);
}
