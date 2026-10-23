import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchOffers } from '../lib/dashboards';
import { useMountedRef } from './useMountedRef';
import type { ProjectOffers } from '../../../shared/types';

/**
 * One project's machine offers (spec "The picker"), asked when `project` becomes non-null and again when it changes — a launch sheet passes its project path
 * once it opens and `null` otherwise, so a closed sheet costs no request (the server's answer is a fan-out to every remote, and it is cached there for 60 s,
 * so one ask per open is the cadence that matches it).
 *
 * The answer is tagged with the project it was asked for and a mismatched tag reads as no answer, so switching projects never shows one frame of the previous
 * project's cards under the new key — the reasoning `useFetched` documents. `useFetched` itself is not used because this hook needs `refresh` to resolve with
 * the new answer in state (the sheet's "retry" awaits it), and a one-shot keyed read has no such trigger. A request that lands after a newer one was started
 * is dropped by sequence number, never applied over it.
 *
 * A failed read keeps the last good offers for the SAME project and says why in `error`; for a new project there is nothing to keep. `refresh` never rejects.
 */
export function useOffers(project: string | null): { offers: ProjectOffers | null; error: string | null; refresh: () => Promise<void> } {
  const [held, setHeld] = useState<{ project: string; offers: ProjectOffers | null; error: string | null } | null>(null);
  const mountedRef = useMountedRef();
  const seq = useRef(0);

  const load = useCallback(
    async (p: string | null) => {
      // Bumped for null too: closing the sheet must also drop an answer still in flight for the project it had open.
      const mine = ++seq.current;
      if (p === null) return;
      try {
        const fresh = await fetchOffers(p);
        if (mountedRef.current && mine === seq.current) setHeld({ project: p, offers: fresh, error: null });
      } catch (e) {
        if (!mountedRef.current || mine !== seq.current) return;
        const message = e instanceof Error ? e.message : 'failed to load machines';
        setHeld((prev) => ({ project: p, offers: prev?.project === p ? prev.offers : null, error: message }));
      }
    },
    [mountedRef]
  );

  useEffect(() => {
    void load(project);
  }, [project, load]);

  const refresh = useCallback(() => load(project), [load, project]);

  const current = held !== null && held.project === project ? held : null;
  return { offers: current?.offers ?? null, error: current?.error ?? null, refresh };
}
