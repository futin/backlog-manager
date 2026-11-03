import { createContext, useContext, type ReactNode } from 'react';

import { useJiraSessions, type JiraSessionsState } from './useJiraSessions';

/**
 * The Jira section's one `useJiraSessions` instance, handed to every reader under it — Detail's live cards and history, the Run chip's gate and, as the
 * deck and the List land, their rows. `JiraContext`'s shape and reason: two instances would be two clocks that could hold two different answers about one
 * session. The provider sits in `JiraView`, so the poll runs only while the Jira section is on screen, and says `open` because it is.
 *
 * The default value is "nothing known" (`data: null`), not a throw: a component rendered without the provider (a test mounting Detail or the Run menu
 * alone) draws the reading it has for no sessions payload, and never fetches — only the provider does.
 */
const NOTHING: JiraSessionsState = { data: null, reload: () => Promise.resolve() };

export const JiraSessionsContext = createContext<JiraSessionsState>(NOTHING);

export function JiraSessionsProvider({ open, children }: { open: boolean; children: ReactNode }) {
  const state = useJiraSessions({ open });
  return <JiraSessionsContext.Provider value={state}>{children}</JiraSessionsContext.Provider>;
}

export function useJiraSessionsContext(): JiraSessionsState {
  return useContext(JiraSessionsContext);
}
