import { useCallback, useEffect, useRef, useState } from 'react';

import { hasTracker, isTrackersPayload, TRACKER_CYCLE_MS } from '../lib/tracker';
import type { TrackersPayload } from '../../../shared/types';

/**
 * `GET /api/trackers` — the shell's one instance (the tracker strip spec, §4), provided through `TrackersContext` to the strip chip and to Shared
 * Settings' Trackers card. Nothing else calls this hook directly: two instances would be two clocks.
 *
 * **On the server's poll clock.** After every answer there is exactly one pending timer, aimed at `newest polledAt + TRACKER_CYCLE_MS +
 * TRACKER_FETCH_SLACK_MS` — just after the server's next sweep should have stamped a fresh `polledAt`. That is what makes the chip's POLL bar reach its
 * end and snap back: the client asks right after the server has answered itself, rather than on a blind interval that drifts against the server's and
 * shows a bar stuck full for up to a cycle. The slack covers the sweep's own two requests per repo.
 *
 * - **The floor while a sweep is still landing** — see `nextDelay`: the server stamps repos one at a time, so an answer can catch half a sweep.
 * - **A one-second floor.** A stamp already older than a cycle (a background tab, a server restarting) would put the deadline in the past; firing at
 *   once and getting the same stale stamp back would loop. One second is the chip's own tick, so nothing faster could show.
 * - **One cycle** from now when no github row has polled yet, and after an error — there is no stamp to aim at, and a failed read retried faster than the
 *   server polls would only hammer a server that is already not answering.
 * - **No timer at all without a github row.** One fetch, so the Settings card can say "files" or "none", and then nothing: there is no clock to follow.
 * - **Focus still refetches at once**, and re-arms from that answer — the pending timer is cleared first, so there is never more than one.
 *
 * A failed fetch keeps whatever is in state and raises `error`, exactly as `useBoard` does: a card that emptied itself on one failed poll would report
 * "no trackers" for a network blip, which is a stronger claim than the failure supports.
 */
export const TRACKER_FETCH_SLACK_MS = 500;

/** The schedule's floor — see the header. */
const MIN_DELAY_MS = 1_000;

export interface TrackersState {
  data: TrackersPayload | null;
  loading: boolean;
  error: boolean;
  reload: () => void;
}

/**
 * How long to wait after this answer before asking again, or `null` for "don't".
 *
 * **A sweep is not an instant.** The server stamps repos one after another — about 0.8 s each, so five connected repos spread their stamps over ~4 s
 * (measured on the running stack while building the strip). An answer taken mid-sweep therefore holds some fresh stamps and some a whole cycle old, and
 * aiming only at the newest would leave the old ones' popover rows reading `0s` on a full bar until the NEXT answer, a cycle later. So while any healthy
 * repo is DUE — a cycle old but not yet two, i.e. its restamp is landing now — the next ask is the one-second floor, which collects the rest of the sweep
 * within a few answers. Overdue and failing repos never hurry it: an overdue stamp means the server is not polling that repo, a failing one's stamp does not
 * move, and fetching every second for either would be a loop that learns nothing.
 *
 * That includes the newest stamp itself. Its deadline passing with nothing due means every stamp is overdue or failing — a background tab, a stalled
 * poller, every repo forbidden — and the floor there would be a permanent 1 Hz loop (caught in the final review), so the next ask is one whole cycle
 * away instead, which is still often enough for the chip's `overdue` to stay true. The floor is only for a deadline that is near, never one already gone.
 */
function nextDelay(data: TrackersPayload, now: number): number | null {
  if (!hasTracker(data.projects)) return null;
  let newest = -Infinity;
  let due = false;
  for (const p of data.projects) {
    if (p.source !== 'github' || p.polledAt === null) continue;
    const ms = Date.parse(p.polledAt);
    if (Number.isNaN(ms)) continue;
    if (ms > newest) newest = ms;
    const age = now - ms;
    if (p.access === 'ok' && age >= TRACKER_CYCLE_MS && age < 2 * TRACKER_CYCLE_MS) due = true;
  }
  if (newest === -Infinity) return TRACKER_CYCLE_MS;
  if (due) return MIN_DELAY_MS;
  const deadline = newest + TRACKER_CYCLE_MS + TRACKER_FETCH_SLACK_MS - now;
  if (deadline <= 0) return TRACKER_CYCLE_MS;
  return Math.max(deadline, MIN_DELAY_MS);
}

export function useTrackers(): TrackersState {
  const [state, setState] = useState<Omit<TrackersState, 'reload'>>({ data: null, loading: true, error: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An answer that lands after unmount must not arm a timer nobody will clear.
  const mounted = useRef(true);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const reload = useCallback(() => {
    clear();
    const arm = (ms: number | null): void => {
      clear();
      if (ms === null || !mounted.current) return;
      timer.current = setTimeout(reload, ms);
    };
    fetch('/api/trackers')
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<unknown>;
      })
      .then((data) => {
        // Checked here rather than trusted in the readers: both map over the
        // two arrays, so a wrong-shaped 200 would throw inside a render and
        // take the page down with it. A malformed body lands on the same
        // `error` path an unreachable API does — one "no usable answer"
        // state, not two.
        if (!isTrackersPayload(data)) throw new Error('malformed /api/trackers response');
        if (!mounted.current) return;
        setState({ data, loading: false, error: false });
        arm(nextDelay(data, Date.now()));
      })
      .catch(() => {
        if (!mounted.current) return;
        setState((prev) => ({ data: prev.data, loading: false, error: true }));
        arm(TRACKER_CYCLE_MS);
      });
  }, [clear]);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
      clear();
    };
  }, [reload, clear]);

  useEffect(() => {
    const onFocus = (): void => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  return { ...state, reload };
}
