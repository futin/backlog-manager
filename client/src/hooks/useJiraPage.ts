import { JIRA_PAGE_KEY, isJiraPage, type JiraPage } from '../lib/jira-page';
import { persistedStore } from './persistedStore';

/**
 * useJiraPage — the Jira section's page (`board` or `setup`), shared by every surface that names it. A `persistedStore`, for the reason that file gives: the
 * rail's sub-nav tree and a link inside the Board page both ask the same question at once.
 *
 * `lib/jira-page.ts` stays the one home of the key, the member list and the guard; this is the React binding over it. Anything stored that is not a page is
 * `board`, the page that always has something to say.
 */
const store = persistedStore<JiraPage>(JIRA_PAGE_KEY, isJiraPage, 'board');

export const useJiraPage = store.useValue;
export const setJiraPage = store.set;
