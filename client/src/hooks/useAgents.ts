import { useCallback, useEffect, useState } from 'react';

import { fetchAgentsStatus } from '../lib/agents';
import { useCoalescedFetch } from './useCoalescedFetch';
import { useMountedRef } from './useMountedRef';
import type { AgentsStatus } from '../../../shared/types';

/**
 * The dispatch status, on mount and on window focus — the same cadence
 * `useBoard` uses, and for the same reason: what changes it (a dashboard
 * started, a session opened in another repo) happens outside this tab, and you
 * come back to the tab afterwards. A timer would ask the same question worse,
 * and the server's project-map cache means a focus refetch is nearly free.
 *
 * #277: never two requests in flight FROM ONE HOOK INSTANCE. Focus storms and
 * explicit `reload`s each used to start their own `/api/agents/status` (the
 * duplicate pending requests seen when the server stalled); now a trigger that
 * lands mid-flight queues exactly ONE follow-up behind it
 * (`useCoalescedFetch`), so the answer a late caller gets was requested after
 * it asked. The coalescing is per instance, not per page: two components that
 * each call `useAgents` still each hold their own poller.
 *
 * `null` means "not answered yet". Callers render no button in that state
 * rather than a disabled one, so a board load does not flash a dead control.
 *
 * bug-13: `reload` RESOLVES to the status it fetched rather than returning
 * void. The setState it also performs is enough for every caller that only
 * wants the board to re-render with a newer answer — but not for the one that
 * has to act on that answer inside the handler that asked for it
 * (`DispatchButton`, deciding whether a click on a project-visibility block
 * may open the sheet after all). That state lands on a later render, which is
 * one render too late for the click that provoked it, so the answer is handed
 * back directly as well. A caller that asks while a request is in flight is
 * handed the follow-up's answer — the same promise as every other caller that
 * asked during that flight.
 */
export function useAgents(): { status: AgentsStatus | null; reload: () => Promise<AgentsStatus> } {
  const [status, setStatus] = useState<AgentsStatus | null>(null);

  const mounted = useMountedRef();

  const load = useCallback(
    () =>
      fetchAgentsStatus()
        .then((fresh) => {
          if (mounted.current) setStatus(fresh);
          return fresh;
        })
        // A failing status endpoint is our own API being down, which the board's
        // own error state already covers. Report it as "off" rather than leaving
        // it null forever: null means "still asking".
        //
        // Resolved, never rejected, and the returned promise carries the same
        // off-status the state gets: an awaiting caller is inside a click
        // handler, where an unhandled rejection would be an uncaught error in
        // the UI, and `enabled: false` already reads as an environment-level
        // block — i.e. "open nothing" — to everything that consumes it.
        .catch(() => {
          const off: AgentsStatus = {
            enabled: false,
            reachable: false,
            remoteAnswer: false,
            spawnAvailable: false,
            spawnMaxPermission: null,
            projectPaths: []
          };
          if (mounted.current) setStatus(off);
          return off;
        }),
    [mounted]
  );

  const reload = useCoalescedFetch(load);

  useEffect(() => {
    // `void`: the promise is the return of an explicit re-ask (bug-13), and
    // neither of these two triggers has anything to do with the answer beyond
    // the setState `reload` performs itself.
    void reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = (): void => {
      void reload();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  return { status, reload };
}
