import { useCallback, useEffect, useState } from 'react';

import { hasSyncingTracker } from '../lib/tracker';
import { useCoalescedFetch } from './useCoalescedFetch';
import { useMountedRef } from './useMountedRef';
import type { ItemsIndex, ProjectSummary } from '../../../shared/types';

/**
 * How long after one re-read of the payload settles the next starts, while a
 * tracker project is registered (task-45; the wait runs from the answer, not
 * the wall clock, since #277). Matched to the server's own `TRACKER_POLL_MS` rather
 * than tuned separately — the point is that the modal's rendered poll age stays close
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
 * the one poll this hook has: its items move when someone edits an issue
 * on another machine, which this browser has no event for, and the item modal
 * renders the poll age as a live reading. So while any registered project
 * resolves to a tracker, the pair is re-read `BOARD_TRACKER_POLL_MS` after the
 * last answer settled — the same "poll only while there is something moving"
 * shape `useOrchestratorRuns` has, and it disarms the moment the last tracker
 * project leaves the registry.
 *
 * #277: at most one pair is ever in flight. The poll used to be a
 * wall-clock interval timer, which kept firing into a server that had stopped answering
 * and stacked a pending pair per tick; now a focus, a `refetch` or a tick that
 * lands mid-flight queues exactly ONE follow-up behind it
 * (`useCoalescedFetch`).
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

  const mounted = useMountedRef();

  // The ONE way a request pair leaves this hook — mount, focus, `refetch` and the tracker poll all go through `useCoalescedFetch` below, so the pair is
  // never in flight twice. `items` and `projects` are one request for that purpose: the follow-up re-reads both, together, once.
  // That is also what keeps an older answer from landing over a newer one (#270): with one pair in the air, the last to settle is always the newest
  // asked, so a read started before a claim was released can no longer paint it back after the read started after it.
  const load = useCallback(
    () =>
      Promise.all([fetchJson<ItemsIndex>('/api/items'), fetchJson<ProjectSummary[]>('/api/projects')])
        .then(([items, projects]) => {
          if (mounted.current) setState({ items, projects, loading: false, error: false });
        })
        .catch(() => {
          if (mounted.current) setState((prev) => ({ items: prev.items, projects: prev.projects, loading: false, error: true }));
        }),
    [mounted]
  );

  // Armed off the LAST payload's own answer, so a board with no tracker
  // project keeps exactly the fetch-on-mount-and-focus behaviour it always
  // had: no timer is armed at all, rather than one that ticks and does
  // nothing. `projects` being an input means connecting a project arms the
  // timer on the next payload and disconnecting the last one clears it — a
  // pair already in flight at that moment still lands, and nothing re-arms
  // after it.
  // A repo whose sync is `off` (#17) counts as no tracker here: its cache is
  // not moving, so re-reading it every fifteen seconds would re-read the same
  // bytes — and turning it back on refetches through the Trackers card's own
  // answer, then this board's next mount or focus.
  const tracked = hasSyncingTracker(state.projects);
  const request = useCoalescedFetch(load, { armed: tracked, intervalMs: BOARD_TRACKER_POLL_MS });
  const refetch = useCallback(() => {
    void request();
  }, [request]);

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
