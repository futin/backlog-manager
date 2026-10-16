import { useEffect, useState } from 'react';

import { JIRA_PAGE_KEY, isJiraPage, type JiraPage } from '../lib/jira-page';

/**
 * useJiraPage — the Jira section's page (`board` or `setup`), shared by every surface that names it. `useRunsMode`'s shape and its reason: the rail's
 * sub-nav tree and a link inside the Board page both ask the same question at once, and `usePersistedState` is a `useState` per caller, so a write from
 * one would reach localStorage and never reach the already-mounted other. The value is held once, at module level, with every mounted reader subscribed.
 *
 * `lib/jira-page.ts` stays the one home of the key, the member list and the guard; this is the React binding over it.
 *
 * Reads go through `isJiraPage` on the way out of storage, and anything that is not a page — absent, not JSON, a word this build never had — is `board`,
 * the page that always has something to say. Storage is read on every mount rather than cached beside the listeners, so a `localStorage.clear()` or a
 * write from a second tab is never contradicted by a stale module value.
 */

type Listener = (p: JiraPage) => void;

const listeners = new Set<Listener>();

function read(): JiraPage {
  try {
    const raw = localStorage.getItem(JIRA_PAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isJiraPage(parsed) ? parsed : 'board';
  } catch {
    // Private mode, or a stored value that is not JSON at all.
    return 'board';
  }
}

/** Written the way `usePersistedState` writes every other key: JSON, not a bare string. */
function write(page: JiraPage): void {
  try {
    localStorage.setItem(JIRA_PAGE_KEY, JSON.stringify(page));
  } catch {
    /* ignore: private mode / quota — the in-memory value still moves */
  }
}

export function setJiraPage(page: JiraPage): void {
  write(page);
  for (const l of listeners) l(page);
}

export function useJiraPage(): [JiraPage, (p: JiraPage) => void] {
  const [page, setPage] = useState<JiraPage>(read);

  useEffect(() => {
    listeners.add(setPage);
    return () => {
      listeners.delete(setPage);
    };
  }, []);

  return [page, setJiraPage];
}
