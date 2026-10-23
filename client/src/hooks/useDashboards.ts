import { useCallback, useEffect, useState } from 'react';

import { fetchDashboards } from '../lib/dashboards';
import { useMountedRef } from './useMountedRef';
import type { DashboardsView } from '../../../shared/types';

/**
 * The configured dashboards, read once on mount (spec "Settings card"): what the Settings card draws and what `machineLabelByHost` names a remote run from.
 * No polling and no focus trigger, unlike `useTicks` — the file changes only when a person edits it, and every write answers the whole view, so a page that
 * makes one calls `refresh` (or draws the write's answer) rather than waiting on a clock. A burst of `useRefreshing`'s focus reads would cost a request per tab
 * switch to learn what the person who just came back already knows.
 *
 * A failed read leaves `view` as it was — the last good one stays on screen — and says why in `error`, which the next good read clears. `refresh` never
 * rejects:
 * its failure is `error`, and the caller has nothing to catch.
 */
export function useDashboards(): { view: DashboardsView | null; error: string | null; refresh: () => Promise<void> } {
  const [view, setView] = useState<DashboardsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useMountedRef();

  const refresh = useCallback(async () => {
    try {
      const fresh = await fetchDashboards();
      if (!mountedRef.current) return;
      setView(fresh);
      setError(null);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'failed to load dashboards');
    }
  }, [mountedRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { view, error, refresh };
}
