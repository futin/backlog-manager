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
 * One fetch pair per mount, plus a refetch on window focus: items change when
 * a skill runs in some terminal, which is exactly when you alt-tab back to
 * the board — polling would answer the same question worse. Errors keep the
 * previous data so a blip degrades to "stale" rather than "blank".
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
      fetch('/api/items').then((res) => res.json() as Promise<ItemsIndex>),
      fetch('/api/projects').then((res) => res.json() as Promise<ProjectSummary[]>)
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
