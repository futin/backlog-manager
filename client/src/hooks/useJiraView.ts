import { useEffect, useState } from 'react';

import { JIRA_VIEW_KEY, isJiraView, type JiraViewMode } from '../lib/jira-view';

/**
 * useJiraView — the Board page's view (`board` or `list`), shared by every surface that names it (Jira sessions spec §7, C1). `useJiraPage`'s shape and its
 * reason: the Board page's band switch and the issue List's own band are separate mounted readers of one value (the rail badge opens the Sessions page and no longer writes it),
 * and `usePersistedState` is a `useState` per caller, so a write from one would reach localStorage and never reach the already-mounted others. The value is
 * held once, at module level, with every mounted reader subscribed.
 *
 * `lib/jira-view.ts` stays the one home of the key, the member list and the guard; this is the React binding over it.
 *
 * Reads go through `isJiraView` on the way out of storage, and anything that is not a view — absent, not JSON, a word this build never had — is `board`, the
 * view that always has something to say (Review Focus 4). Storage is read on every mount rather than cached beside the listeners, so a
 * `localStorage.clear()` or a write from a second tab is never contradicted by a stale module value.
 */

type Listener = (v: JiraViewMode) => void;

const listeners = new Set<Listener>();

function read(): JiraViewMode {
  try {
    const raw = localStorage.getItem(JIRA_VIEW_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isJiraView(parsed) ? parsed : 'board';
  } catch {
    // Private mode, or a stored value that is not JSON at all.
    return 'board';
  }
}

/** Written the way `usePersistedState` writes every other key: JSON, not a bare string. */
function write(view: JiraViewMode): void {
  try {
    localStorage.setItem(JIRA_VIEW_KEY, JSON.stringify(view));
  } catch {
    /* ignore: private mode / quota — the in-memory value still moves */
  }
}

export function setJiraView(view: JiraViewMode): void {
  write(view);
  for (const l of listeners) l(view);
}

export function useJiraView(): [JiraViewMode, (v: JiraViewMode) => void] {
  const [view, setView] = useState<JiraViewMode>(read);

  useEffect(() => {
    listeners.add(setView);
    return () => {
      listeners.delete(setView);
    };
  }, []);

  return [view, setJiraView];
}
