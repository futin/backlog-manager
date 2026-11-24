import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { JiraMentionIssue } from '../../../shared/types';
import { useJiraMentions, type JiraMentionsState } from './useJiraMentions';

/**
 * The shell's one `useJiraMentions` instance (Jira mentions <-> board link, Task 2), handed to every reader under it: the Mentions page, and after it the
 * board's markers and the mention modal opened over the board. `JiraSessionsContext`'s shape and reason — two instances would be two clocks and two
 * newest-read counters that could hold two different answers about one cache, and a write made through one would not reach the other's `data`. The
 * provider is the hook's ONE caller (a source guard in `test/jira/jira-mentions-provider.test.tsx` pins it).
 *
 * `enabled` is `jiraConfigured && section === 'jira'` from `App`: while false the hook reads nothing and arms no timer but keeps its last `data`, so the
 * poll costs nothing on Files, GitHub, Runs and Settings and coming back to Jira shows the old answer while one read refreshes it. The element stays
 * mounted whatever `enabled` says, so a section pick never remounts the shell beneath it. `loading` is true while disabled with no data, so no consumer
 * may read it as "a read is in flight".
 *
 * The default value is "nothing known" (`data: null`), not a throw: a component rendered without the provider draws the reading it has for no payload and
 * never fetches — only the provider does. Its writes resolve `{ ok: false }` rather than reject, the hook's own never-reject contract.
 */
const UNAVAILABLE = { ok: false, message: 'mentions unavailable' } as const;
const NOTHING: JiraMentionsState = {
  data: null,
  loading: false,
  error: null,
  reload: () => {},
  sweep: () => Promise.resolve(),
  checking: false,
  dismiss: () => Promise.resolve(UNAVAILABLE),
  restore: () => Promise.resolve(UNAVAILABLE),
  discardDraft: () => Promise.resolve(UNAVAILABLE),
  postReply: () => Promise.resolve(UNAVAILABLE)
};

export const JiraMentionsContext = createContext<JiraMentionsState>(NOTHING);

export function JiraMentionsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const state = useJiraMentions({ enabled });
  return <JiraMentionsContext.Provider value={state}>{children}</JiraMentionsContext.Provider>;
}

export function useJiraMentionsContext(): JiraMentionsState {
  return useContext(JiraMentionsContext);
}

const EMPTY: ReadonlyMap<string, JiraMentionIssue> = new Map();

/**
 * The tickets still waiting on the user, by key — built from `data.issues` ONLY (a dismissed ticket is not waiting, so it carries no marker). EMPTY while
 * there is no payload, Jira is unconfigured, or the cache has never been stamped (`polledAt` null): an unstamped cache has not checked, and an empty answer
 * from it must not read as "nothing waiting".
 */
export function useMentionIndex(): ReadonlyMap<string, JiraMentionIssue> {
  const { data } = useJiraMentionsContext();
  return useMemo(() => {
    if (data === null || !data.configured || data.polledAt === null) return EMPTY;
    return new Map(data.issues.map((i) => [i.key, i]));
  }, [data]);
}
