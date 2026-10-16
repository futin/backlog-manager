/**
 * jira-page.ts — which of the Jira section's two pages this browser last had open (Jira phase 2, spec §6; DESIGN.md §8.0's sub-nav rule).
 *
 * The key, the member list and the guard, and nothing that touches React — `lib/runs-mode.ts`'s split, for its reason: the guard can be tested without
 * rendering a section, and `hooks/useJiraPage.ts` is the one binding over it. The rail's tree and the Board page's own "Set up" link are two mounted
 * readers of one value, which is why the value is a module store and not a `usePersistedState` per caller.
 *
 * Takes `unknown`, not `string`: `localStorage` round-trips through `JSON.parse`, so a stored value can be a number, an object or `null` just as easily as
 * a word this union never had, and the one outcome the Jira section must never have is rendering neither page.
 */

export type JiraPage = 'board' | 'setup';

/** Declaration order is the rail tree's order. */
export const JIRA_PAGES: readonly JiraPage[] = ['board', 'setup'];

export const JIRA_PAGE_KEY = 'backlog-manager.jira-page';

export function isJiraPage(v: unknown): v is JiraPage {
  return typeof v === 'string' && (JIRA_PAGES as readonly string[]).includes(v);
}
