import { JIRA_VIEW_KEY, isJiraView, type JiraViewMode } from '../lib/jira-view';
import { persistedStore } from './persistedStore';

/**
 * useJiraView — the Board page's view (`board` or `list`), shared by every surface that names it (Jira sessions spec §7, C1). A `persistedStore`, for the
 * reason that file gives: the Board page's band switch and the issue List's own band are separate mounted readers of one value (the rail badge opens the
 * Sessions page and no longer writes it).
 *
 * `lib/jira-view.ts` stays the one home of the key, the member list and the guard; this is the React binding over it. Anything stored that is not a view is
 * `board`, the view that always has something to say (Review Focus 4).
 */
const store = persistedStore<JiraViewMode>(JIRA_VIEW_KEY, isJiraView, 'board');

export const useJiraView = store.useValue;
export const setJiraView = store.set;
