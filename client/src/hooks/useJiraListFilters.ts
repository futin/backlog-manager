import { useEffect, useState } from 'react';

import { DEFAULT_LIST_FILTERS, LIST_CHIPS, LIST_WINDOWS, type ListFilters } from '../lib/jira-list';

/**
 * useJiraListFilters — the List view's chip, repo, run, window and All tickets (Jira sessions spec §7.2), shared by every surface that sets or reads them
 * (C4). `useJiraView`'s shape and its reason: the List's own bar and the rail badge's click are separate mounted writers of one value, and `usePersistedState`
 * is a `useState` per caller, so a write from one would never reach the other. The value is held once, at module level, with every mounted reader subscribed,
 * and `setJiraListFilters` is exported for a caller that is not a component at all: the rail badge writes `{ chip: 'needs-you', allTickets: true }` and
 * flips the view in the same handler, so the List it lands on is already showing every session that wants a person.
 *
 * **Nothing is persisted.** The view mode is a preference a person returns to; these are a question they were asking a minute ago ("what is ended since
 * Monday"), and a stored `needs-you` chip would greet the next visit with a list that looks empty for no reason it can say. A reload starts from the
 * defaults — chip All, window 7 d, board scope — and the rail badge is how a person gets to "needs you" on purpose. The module value lives for the tab, so
 * leaving the Jira page and coming back keeps the filters, which is the case that matters.
 *
 * Every write goes through `clean`, so a caller handing over a chip or window this build does not have (a future badge, a typo) cannot leave the List with a
 * filter it has no chip for.
 */

type Listener = (f: ListFilters) => void;

const listeners = new Set<Listener>();
let current: ListFilters = DEFAULT_LIST_FILTERS;

function clean(f: ListFilters): ListFilters {
  return {
    chip: LIST_CHIPS.includes(f.chip) ? f.chip : DEFAULT_LIST_FILTERS.chip,
    repo: typeof f.repo === 'string' && f.repo !== '' ? f.repo : null,
    run: typeof f.run === 'string' && f.run !== '' ? f.run : null,
    window: LIST_WINDOWS.some((w) => w.value === f.window) ? f.window : DEFAULT_LIST_FILTERS.window,
    allTickets: f.allTickets === true
  };
}

/** Merge a patch into the shared filters and tell every mounted reader. Callable outside React. */
export function setJiraListFilters(patch: Partial<ListFilters>): void {
  current = clean({ ...current, ...patch });
  for (const l of listeners) l(current);
}

/** Back to the defaults — the tests' reset between cases, and what a "clear" would call. */
export function resetJiraListFilters(): void {
  setJiraListFilters(DEFAULT_LIST_FILTERS);
}

export function useJiraListFilters(): [ListFilters, (patch: Partial<ListFilters>) => void] {
  const [filters, setFilters] = useState<ListFilters>(current);

  useEffect(() => {
    listeners.add(setFilters);
    // A write between this render and the effect (the badge's click lands in the same event as the mount) would otherwise be missed.
    setFilters(current);
    return () => {
      listeners.delete(setFilters);
    };
  }, []);

  return [filters, setJiraListFilters];
}
