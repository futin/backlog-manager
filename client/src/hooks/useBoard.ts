import { useCallback, useEffect, useState } from 'react';

import type { ItemsIndex, ProjectSummary } from '../../../shared/types';

export interface BoardState {
  items: ItemsIndex | null;
  projects: ProjectSummary[] | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

/**
 * res.ok before res.json(). Nest answers a server-side failure with a JSON
 * error body, which parses perfectly well — so without this check a 500 landed
 * in state as if it were the index, `items.items` read as undefined, and the
 * board showed "nothing registered yet": the one message that sends you off to
 * run a backlog skill when the actual problem is on the server.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

/**
 * One fetch pair per mount, plus a refetch on window focus: items change when
 * a skill runs in some terminal, which is exactly when you alt-tab back to
 * the board — polling would answer the same question worse.
 *
 * A failed refetch keeps whatever is already in state and raises `error`.
 * Nothing renders a staleness cue, so the board goes on showing the last good
 * data as though it were current; only a failure with nothing to keep reaches
 * BoardView's "board unavailable".
 */
export function useBoard(): BoardState {
  const [state, setState] = useState<Omit<BoardState, 'refetch'>>({
    items: null,
    projects: null,
    loading: true,
    error: false
  });

  const refetch = useCallback(() => {
    Promise.all([
      fetchJson<ItemsIndex>('/api/items'),
      fetchJson<ProjectSummary[]>('/api/projects')
    ])
      .then(([items, projects]) => setState({ items, projects, loading: false, error: false }))
      .catch(() =>
        setState((prev) => ({ items: prev.items, projects: prev.projects, loading: false, error: true }))
      );
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const onFocus = (): void => refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetch]);

  return { ...state, refetch };
}
