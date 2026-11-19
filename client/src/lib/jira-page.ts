/**
 * jira-page.ts — which of the Jira section's five pages this browser last had open (Jira phase 2, spec §6; DESIGN.md §8.0's sub-nav rule; `ticket` since the Jira detail tabs spec §2.1).
 *
 * The key, the member list and the guard, and nothing that touches React — `lib/runs-mode.ts`'s split, for its reason: the guard can be tested without
 * rendering a section, and `hooks/useJiraPage.ts` is the one binding over it. The rail's tree and the Board page's own "Set up" link are two mounted
 * readers of one value, which is why the value is a module store and not a `usePersistedState` per caller.
 *
 * Takes `unknown`, not `string`: `localStorage` round-trips through `JSON.parse`, so a stored value can be a number, an object or `null` just as easily as
 * a word this union never had, and the one outcome the Jira section must never have is rendering neither page.
 *
 * `ticket` is the page for one ticket read by key (`hooks/useJiraTicketKey.ts`). It is a member like the others, so a stored `ticket` survives a reload, but it
 * is only a page while a key is held: `JiraView` draws the Board for `ticket` with an empty key and writes `board` back, and the rail draws its row only while
 * a key is held (spec §2.1, §2.2).
 */

export type JiraPage = 'board' | 'sessions' | 'mentions' | 'setup' | 'ticket';

/** Declaration order is the rail tree's order. */
export const JIRA_PAGES: readonly JiraPage[] = ['board', 'sessions', 'mentions', 'setup', 'ticket'];

export const JIRA_PAGE_KEY = 'backlog-manager.jira-page';

export function isJiraPage(v: unknown): v is JiraPage {
  return typeof v === 'string' && (JIRA_PAGES as readonly string[]).includes(v);
}
