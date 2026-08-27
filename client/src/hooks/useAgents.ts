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
 */
export function useAgents(): { status: AgentsStatus | null; reload: () => void } {
  const [status, setStatus] = useState<AgentsStatus | null>(null);

  const reload = useCallback(() => {
    fetchAgentsStatus()
      .then(setStatus)
      // A failing status endpoint is our own API being down, which the board's
      // own error state already covers. Report it as "off" rather than leaving
      // it null forever: null means "still asking".
      .catch(() => setStatus({
        enabled: false, reachable: false, remoteAnswer: false,
        spawnAvailable: false, spawnMaxPermission: null, projectPaths: []
      }));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = (): void => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  return { status, reload };
}
