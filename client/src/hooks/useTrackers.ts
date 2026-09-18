import { useCallback, useEffect, useState } from 'react';

import { isTrackersPayload } from '../lib/tracker';
import type { TrackersPayload } from '../../../shared/types';

/**
 * `GET /api/trackers` for the Shared Settings page's Trackers card (task-45).
 *
 * The same cadence `useAgents` has — on mount and on window focus, never a
 * poll — and for the same reason: this is a settings page someone opens,
 * reads and leaves, and the one value on it that moves on its own (the poll
 * age) is a reading whose staleness is bounded by how long the page has been
 * open. The BOARD is the surface that polls, because it renders the age as a
 * live fact beside the items it describes.
 *
 * A failed fetch keeps whatever is in state and raises `error`, exactly as
 * `useBoard` does: a card that emptied itself on one failed poll would report
 * "no trackers" for a network blip, which is a stronger claim than the failure
 * supports.
 */
export interface TrackersState {
  data: TrackersPayload | null;
  loading: boolean;
  error: boolean;
  reload: () => void;
}

export function useTrackers(): TrackersState {
  const [state, setState] = useState<Omit<TrackersState, 'reload'>>({ data: null, loading: true, error: false });

  const reload = useCallback(() => {
    fetch('/api/trackers')
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<unknown>;
      })
      .then((data) => {
        // Checked here rather than trusted in the card: the card maps over
        // both arrays, so a wrong-shaped 200 would throw inside a render and
        // take the whole Settings page down with it. A malformed body lands on
        // the same `error` path an unreachable API does — one "no usable
        // answer" state, not two.
        if (!isTrackersPayload(data)) throw new Error('malformed /api/trackers response');
        setState({ data, loading: false, error: false });
      })
      .catch(() => setState((prev) => ({ data: prev.data, loading: false, error: true })));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = (): void => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  return { ...state, reload };
}
