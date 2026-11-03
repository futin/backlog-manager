import { createContext, useContext, type ReactNode } from 'react';

import { useJiraSessions, type JiraSessionsState } from './useJiraSessions';

/**
 * The shell's one `useJiraSessions` instance, handed to every reader under it — Detail's live cards and history, the Run chip's gate, the deck and the List
 * rows and the rail's Needs-you badge. `JiraContext`'s shape and reason: two instances would be two clocks that could hold two different answers about one
 * session. The provider sits in `App`'s shell around the rail AND the section, because the badge counts with the section closed; `enabled` is whether Jira
 * is configured (no poll and no badge otherwise) and `open` whether the Jira section is the current one, which is what asks the server for its fast
 * reconciler. The element stays mounted whatever either flag says, so a status answer or a section pick never remounts the shell beneath it.
 *
 * The default value is "nothing known" (`data: null`), not a throw: a component rendered without the provider (a test mounting Detail or the Run menu
 * alone) draws the reading it has for no sessions payload, and never fetches — only the provider does.
 */
const NOTHING: JiraSessionsState = { data: null, reload: () => Promise.resolve() };

export const JiraSessionsContext = createContext<JiraSessionsState>(NOTHING);

export function JiraSessionsProvider({ open, enabled = true, children }: { open: boolean; enabled?: boolean; children: ReactNode }) {
  const state = useJiraSessions({ open, enabled });
  return <JiraSessionsContext.Provider value={state}>{children}</JiraSessionsContext.Provider>;
}

export function useJiraSessionsContext(): JiraSessionsState {
  return useContext(JiraSessionsContext);
}
