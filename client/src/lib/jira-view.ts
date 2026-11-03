/**
 * jira-view.ts — which of the Board page's two views (`board`, the agent deck over the status shelves, or `list`, one row per session) this browser last had
 * open (Jira sessions spec §7, C1; DESIGN.md §8.9.1).
 *
 * The key, the member list and the guard, and nothing that touches React — `lib/jira-page.ts`'s split, for its reason: the guard can be tested without
 * rendering a page, and `hooks/useJiraView.ts` is the one binding over it. It is NOT a third `JIRA_PAGES` entry: the rail's Jira tree stays `Board` / `Setup`
 * and this is a view inside the Board page (C1).
 *
 * Takes `unknown`, not `string`, for `isJiraPage`'s reason: `localStorage` round-trips through `JSON.parse`, so a stored value can be a number, an object or
 * `null` just as easily as a word this union never had, and the Board page must never have to render neither view.
 */

export type JiraViewMode = 'board' | 'list';

/** Declaration order is the switch's order: Board, then List. */
export const JIRA_VIEWS: readonly JiraViewMode[] = ['board', 'list'];

export const JIRA_VIEW_KEY = 'backlog-manager.jira-view';

export function isJiraView(v: unknown): v is JiraViewMode {
  return typeof v === 'string' && (JIRA_VIEWS as readonly string[]).includes(v);
}
