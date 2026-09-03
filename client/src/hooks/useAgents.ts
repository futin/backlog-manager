import { useCallback, useEffect, useState } from 'react';

import { fetchAgentsStatus } from '../lib/agents';
import type { AgentsStatus } from '../../../shared/types';

/**
 * The dispatch status, on mount and on window focus — the same cadence
 * `useBoard` uses, and for the same reason: what changes it (a dashboard
 * started, a session opened in another repo) happens outside this tab, and you
 * come back to the tab afterwards. A timer would ask the same question worse,
 * and the server's project-map cache means a focus refetch is nearly free.
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
 * back directly as well.
 */
export function useAgents(): { status: AgentsStatus | null; reload: () => Promise<AgentsStatus> } {
  const [status, setStatus] = useState<AgentsStatus | null>(null);

  const reload = useCallback(() => (
    fetchAgentsStatus()
      .then((fresh) => {
        setStatus(fresh);
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
          enabled: false, reachable: false, remoteAnswer: false,
          spawnAvailable: false, spawnMaxPermission: null, projectPaths: []
        };
        setStatus(off);
        return off;
      })
  ), []);

  useEffect(() => {
    // `void`: the promise is the return of an explicit re-ask (bug-13), and
    // neither of these two triggers has anything to do with the answer beyond
    // the setState `reload` performs itself.
    void reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = (): void => { void reload(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  return { status, reload };
}
