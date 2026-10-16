import { useCallback, useEffect, useState } from 'react';

import type { ReleasesResponse } from '../../../shared/types';
import { useMountedRef } from './useMountedRef';

/**
 * useReleases — `GET /api/releases`, the shell's one read of this checkout's release tags (docs/subsystems/releases.md), for the rail's version chip and
 * the What's new drawer.
 *
 * Read on mount and on `refresh()` — which the shell calls as the drawer opens — and never on a timer. A version changes only when the server's checkout
 * moves, which on this machine means a merge, a pull and a restart, so a poll would be requests spent asking a question whose answer cannot change under an
 * open tab. That is also why this is not `useCoalescedFetch`: there is no timer to arm, and two overlapping reads of one immutable answer cannot disagree.
 *
 * A failed read, or one whose body is not the releases shape (a stale server without the route answers the SPA's 404 page or something else entirely), keeps
 * whatever the last good read gave — `null` before one — so a blip never takes the chip away. The route itself never answers an error status.
 */
export function useReleases(): { data: ReleasesResponse | null; refresh: () => void } {
  const [data, setData] = useState<ReleasesResponse | null>(null);
  const mounted = useMountedRef();

  const refresh = useCallback(() => {
    fetch('/api/releases')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (mounted.current && isReleasesResponse(body)) setData(body);
      })
      .catch(() => {
        /* keep the previous answer */
      });
  }, [mounted]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, refresh };
}

function isReleasesResponse(v: unknown): v is ReleasesResponse {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { current?: unknown; releases?: unknown };
  if (!Array.isArray(r.releases)) return false;
  if (r.current === null) return true;
  const c = r.current as { version?: unknown; ahead?: unknown } | undefined;
  return typeof c === 'object' && c !== null && typeof c.version === 'string' && typeof c.ahead === 'number';
}
