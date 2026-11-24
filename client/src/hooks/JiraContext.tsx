import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { useAnsweredAt } from './useAnsweredAt';
import { useJira, type JiraState } from './useJira';

/**
 * The shell's one `useJira` instance (Jira phase 2), handed to every reader — the rail, the chip, and the Jira section's four pages. `TrackersContext`'s
 * shape and its reason: two instances would be two clocks that could hold two different answers. The provider sits in `App`, above the rail and every
 * section, because the rail's Jira entry and the chip outlive any section.
 *
 * The default value is the hook's own loading state, not `null`-and-throw: a component rendered without the provider (a test mounting a page alone)
 * draws its loading branch rather than taking the page down. It never fetches; only the provider does.
 *
 * `answeredAt` is when the current answer landed (`useAnsweredAt`, #588), for Settings › Shared's `Last read` foot; optional so a test's hand-built value
 * may leave it out, which reads as "no stamp".
 */
export type JiraContextValue = JiraState & { answeredAt?: number | null };

const LOADING: JiraContextValue = { data: null, loading: true, error: false, reload: () => {} };

export const JiraContext = createContext<JiraContextValue>(LOADING);

export function JiraProvider({ children }: { children: ReactNode }) {
  const state = useJira();
  const answeredAt = useAnsweredAt(state.data);
  const value = useMemo<JiraContextValue>(() => ({ ...state, answeredAt }), [state, answeredAt]);
  return <JiraContext.Provider value={value}>{children}</JiraContext.Provider>;
}

export function useJiraContext(): JiraContextValue {
  return useContext(JiraContext);
}
