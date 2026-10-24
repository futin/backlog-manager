import { useCallback, useState } from 'react';

import { fetchMachines } from '../lib/dashboards';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';
import type { MachinesStatus } from '../../../shared/types';

/**
 * How long after one `GET /api/dashboards/machines` settles the next is asked (#277: from the answer, not the wall clock). A minute: the answer is a health
 * probe of every remote plus each machine's usage reading, and the server caches usage for far longer than this, so a faster poll would only re-ask a cache.
 * The page's dots and bars have to notice a remote going down or a window resetting while it is left open, which a minute does; mount and focus (below) cover
 * "I just came back".
 */
export const MACHINES_POLL_MS = 60_000;

/**
 * Health and usage for every machine, for Settings › Dashboards (spec 2026-10-23 "States"). Mounted ONLY by that page, which is what keeps the minute poll
 * from running anywhere else — `armed` is therefore constant `true`; the page's mount is the arming. Enters through `useRefreshing` (mount + focus + the
 * coalesced timer), never a `setInterval` of its own, so a focus storm or a `reload` that lands mid-flight folds into one follow-up (#277).
 *
 * A failed read keeps the previous answer (or `null` before the first) and says nothing: the page already tells "this machine is unreachable" per machine from
 * a SUCCESSFUL answer, and a failed read of the route itself is not a state worth a banner that flickers on every blip. The next timer, focus or `reload`
 * simply asks again. State is set only while mounted (`useMountedRef`), because a read can land after the page is gone.
 */
export function useMachines(): { machines: MachinesStatus | null; reload: () => Promise<void> } {
  const [machines, setMachines] = useState<MachinesStatus | null>(null);
  const mountedRef = useMountedRef();

  const load = useCallback(async () => {
    try {
      const fresh = await fetchMachines();
      if (mountedRef.current) setMachines(fresh);
    } catch {
      // Keep what is on screen; see the hook's comment.
    }
  }, [mountedRef]);

  const reload = useRefreshing(load, { armed: true, intervalMs: MACHINES_POLL_MS });

  return { machines, reload };
}
