import { useCallback, useEffect, useRef, useState } from 'react';

import { postSweep, refusalText, type SweepService } from '../lib/sweep';

/**
 * The state behind `Sync now` and a GitHub row's sync icon — held by the CHIP, not the popover, which unmounts on close: closing it mid-sweep and opening it
 * again must still find the buttons disabled. `pending` is the one in-flight target (`''` for the site-wide ask); a ref guards the double click the state
 * cannot (a second click lands before React has re-rendered the disabled button), the reason `useAction` gives. One in flight at a time is the server's
 * own rule — it joins a sweep already running — so every sync button is disabled while any is out.
 *
 * A 200 re-reads the shell's status (`reload`); a 409 means nothing is being polled, so the buttons stay disabled with the server's sentence as their title
 * until the shell's status next changes (`status` is its payload; a new one clears `blocked`, since the poller may be armed again); anything else is a
 * notice, kept until the next ask.
 */
export function useSweep(service: SweepService, reload: () => void, zone: string, status: unknown) {
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  useEffect(() => setBlocked(null), [status]);
  const out = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    (target?: string): void => {
      if (out.current) return;
      out.current = true;
      setPending(target ?? '');
      setNotice(null);
      void postSweep(service, target).then((outcome) => {
        out.current = false;
        if (!mounted.current) return;
        setPending(null);
        if (outcome.ok) {
          reload();
          return;
        }
        if (outcome.status === 409) setBlocked(outcome.message);
        else setNotice(refusalText(service, outcome, zone));
      });
    },
    [service, reload, zone]
  );

  return { pending, notice, blocked, run };
}
