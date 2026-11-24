import { createContext, useContext } from 'react';

/**
 * The function that opens the mention modal for a ticket key (Jira mentions <-> board link, Task 4), provided by `JiraView` and read by every `@ N` mark under
 * it. `null` outside a provider, which is how a mark rendered anywhere else (a test, a surface that has no modal host) draws nothing instead of a dead button.
 *
 * It lives in its own file, not in `JiraView.tsx`: the marks sit in `JiraCard`, which `JiraView` reaches through the board, so a context exported from
 * `JiraView` would close the import cycle JiraView -> JiraBoardView -> JiraLaneBoard -> JiraCard -> JiraMentionMarkFor -> JiraView.
 */
export const MentionOpenContext = createContext<((key: string) => void) | null>(null);

export function useOpenMention(): ((key: string) => void) | null {
  return useContext(MentionOpenContext);
}
