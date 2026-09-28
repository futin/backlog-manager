import { useCallback, useEffect, useRef, useState } from 'react';

import { hasSyncingTracker, isTrackersPayload, syncCycleMs, TRACKER_CYCLE_MS } from '../lib/tracker';
import type { SyncInterval, TrackersPayload } from '../../../shared/types';

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
 * - **No timer at all without a github row that syncs.** One fetch, so the Settings card can say "files" or "none", and then nothing: there is no clock
 *   to follow. A row whose sync is `off` (#17) counts as none — nothing on the server moves it, and the one thing that can, this machine's own
 *   `POST /api/trackers/sync`, refetches through the card's own answer.
 * - **Each repo on its own interval** (#17). "The newest stamp plus a cycle" assumed one sweep restamps every repo; with `1m` and `5m` repos it does not,
 *   so the deadline is the EARLIEST next stamp still ahead, each row's stamp plus its own `syncCycleMs`, and a row is DUE for one base cycle after its own
 *   cycle ends — never for its whole second cycle, which for a `5m` repo would be five minutes of asking every second.
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
  /**
   * The Trackers card's one write (#17): `POST /api/trackers/sync`, then a refetch, so the picker shows the value the SERVER now reads rather than the one
   * clicked. Resolves on every outcome and never throws — a refusal is a reading for the card, not an exception for its click handler.
   */
  saveInterval: (repo: string, interval: SyncInterval) => Promise<void>;
  /** The last refused `saveInterval` per repo — the answer's own `error`, shown as that repo's row hint — cleared by the next successful read. */
  refusals: Readonly<Record<string, string>>;
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
  if (!hasSyncingTracker(data.projects)) return null;
  let stamped = false;
  let deadline = Infinity;
  let due = false;
  for (const p of data.projects) {
    const cycle = p.source === 'github' ? syncCycleMs(p.interval) : null;
    if (cycle === null || p.polledAt === null) continue;
    const ms = Date.parse(p.polledAt);
    if (Number.isNaN(ms)) continue;
    stamped = true;
    const next = ms + cycle + TRACKER_FETCH_SLACK_MS - now;
    if (next > 0 && next < deadline) deadline = next;
    const age = now - ms;
    if (p.access === 'ok' && age >= cycle && age < cycle + TRACKER_CYCLE_MS) due = true;
  }
  if (!stamped) return TRACKER_CYCLE_MS;
  if (due) return MIN_DELAY_MS;
  if (deadline === Infinity) return TRACKER_CYCLE_MS;
  return Math.max(deadline, MIN_DELAY_MS);
}

export function useTrackers(): TrackersState {
  const [state, setState] = useState<Pick<TrackersState, 'data' | 'loading' | 'error'>>({ data: null, loading: true, error: false });
  const [refusals, setRefusals] = useState<Readonly<Record<string, string>>>({});
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
        // A fresh answer supersedes whatever a refused save said about it: the row reads the server's value again, and the refusal was about a moment.
        setRefusals({});
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

  /*
   * Refetch on success, and ONLY on success: the refetch is what moves the pill, and a refusal must leave the old value selected with the reason beside it —
   * a refetch there would clear the reason before anyone read it. `reload` is also what re-aims the schedule, which matters here: turning the last repo
   * back on from `off` is the one moment a card with no timer needs one again.
   */
  const saveInterval = useCallback(
    async (repo: string, interval: SyncInterval): Promise<void> => {
      let res: Response;
      try {
        res = await fetch('/api/trackers/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo, interval })
        });
      } catch {
        if (mounted.current) setRefusals((prev) => ({ ...prev, [repo]: 'the server did not answer — nothing was changed' }));
        return;
      }
      if (res.ok) {
        reload();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const error = typeof body?.error === 'string' ? body.error : `refused (${res.status})`;
      if (mounted.current) setRefusals((prev) => ({ ...prev, [repo]: error }));
    },
    [reload]
  );

  return { ...state, reload, saveInterval, refusals };
}
