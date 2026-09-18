import { useCallback, useEffect, useState } from 'react';

import { hasTracker } from '../lib/tracker';
import type { ItemsIndex, ProjectSummary } from '../../../shared/types';

/**
 * How often the board re-reads the payload while a tracker project is
 * registered (task-45). Matched to the server's own `TRACKER_POLL_MS` rather
 * than tuned separately — the point is that the rendered poll age stays close
 * to the real one, and a client interval slower than the server's would make
 * the board claim the items are older than they are, while a faster one would
 * ask the same question twice for the same answer.
 *
 * Not imported from the server's constant: this module is bundled into the
 * browser and `poller.service.ts` imports Nest. The number is small, the two
 * are pinned together by `test/tracker-board.test.tsx`.
 */
export const BOARD_TRACKER_POLL_MS = 15_000;

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
 * One fetch pair per mount, plus a refetch on window focus: a FILES project's
 * items change when a skill runs in some terminal, which is exactly when you
 * alt-tab back to the board — polling would answer the same question worse.
 *
 * A TRACKER project is the case that argument does not cover, and task-45 adds
 * the one interval this hook has: its items move when someone edits an issue
 * on another machine, which this browser has no event for, and the board
 * renders the poll age as a live reading. So while any registered project
 * resolves to a tracker, the pair is re-read every `BOARD_TRACKER_POLL_MS` —
 * the same "poll only while there is something moving" shape
 * `useOrchestratorRuns` has, and it disarms the moment the last tracker
 * project leaves the registry.
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
    Promise.all([fetchJson<ItemsIndex>('/api/items'), fetchJson<ProjectSummary[]>('/api/projects')])
      .then(([items, projects]) => setState({ items, projects, loading: false, error: false }))
      .catch(() => setState((prev) => ({ items: prev.items, projects: prev.projects, loading: false, error: true })));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const onFocus = (): void => refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetch]);

  // Armed off the LAST payload's own answer, so a board with no tracker
  // project keeps exactly the fetch-on-mount-and-focus behaviour it always
  // had: no interval is created at all, rather than one that ticks and does
  // nothing. `projects` being a dependency means connecting a project starts
  // the interval on the next payload and disconnecting the last one stops it.
  const tracked = hasTracker(state.projects);
  useEffect(() => {
    if (!tracked) return;
    const timer = setInterval(refetch, BOARD_TRACKER_POLL_MS);
    return () => clearInterval(timer);
  }, [tracked, refetch]);

  return { ...state, refetch };
}
