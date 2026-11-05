import { useCallback, useEffect, useRef, useState } from 'react';

import { postSweep, refusalText, type SweepService } from '../lib/sweep';

/**
 * The state behind `Sync now` and a GitHub row's sync icon — held by the CHIP, not the popover, which unmounts on close: closing it mid-sweep and opening it
 * again must still find the buttons disabled. `pending` is the one in-flight target (`''` for the site-wide ask); a ref guards the double click the state
 * cannot (a second click lands before React has re-rendered the disabled button), the reason `useAction` gives. One in flight at a time is the server's
 * own rule — it joins a sweep already running — so every sync button is disabled while any is out.
 *
 * A 200 re-reads the shell's status (`reload`); a 409 means nothing is being polled, so the buttons stay disabled with the server's sentence as their title
 * until the fact the 409 stands on next changes (`armedKey` is that fact as a string — Jira's `armed`, GitHub's token + registered tracker — NOT the status payload,
 * which is a fresh object every poll and would re-enable the buttons after one interval with nothing changed; a new key clears `blocked`, since the poller may be
 * armed again); anything else is a notice, kept until the next ask, a change of `armedKey`, or — for a 429 — the clock it names.
 */
export function useSweep(service: SweepService, reload: () => void, zone: string, armedKey: string) {
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  // A notice is a refusal's sentence, and a changed `armedKey` is the poller's own state moving, so it goes with `blocked`; a 429's also goes at the clock it names.
  useEffect(() => {
    setBlocked(null);
    setNotice(null);
  }, [armedKey]);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    },
    []
  );
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
      if (waitTimer.current !== null) clearTimeout(waitTimer.current);
      waitTimer.current = null;
      void postSweep(service, target).then((outcome) => {
        out.current = false;
        if (!mounted.current) return;
        setPending(null);
        if (outcome.ok) {
          reload();
          return;
        }
        if (outcome.status === 409) setBlocked(outcome.message);
        else {
          setNotice(refusalText(service, outcome, zone));
          const until = outcome.status === 429 && outcome.retryAt !== null ? Date.parse(outcome.retryAt) : NaN;
          if (!Number.isNaN(until)) waitTimer.current = setTimeout(() => setNotice(null), Math.max(0, until - Date.now()));
        }
      });
    },
    [service, reload, zone]
  );

  return { pending, notice, blocked, run };
}
