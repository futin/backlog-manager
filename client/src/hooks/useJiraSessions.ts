import { useCallback, useState } from 'react';

import { fetchJiraSessions } from '../lib/jira';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';
import type { JiraSessionsPayload } from '../../../shared/types';

/**
 * How long after one `GET /api/jira/sessions` settles the next is asked (#277: from the answer, not the wall clock). Fifteen seconds is the server's own
 * reconciler rate while a Jira page is open (spec §5), so a faster poll would only re-read the same memory and a slower one would draw a state the server
 * has already moved past — which matters here more than for most polls, because the state strip is what tells a person a session is waiting on them.
 */
export const JIRA_SESSIONS_POLL_MS = 15_000;

/**
 * Every linked Jira session, live and ended, with its derived state (Jira sessions spec §6, §7). Mounted ONCE, by `JiraSessionsProvider` — the Jira
 * section's page — so Detail, the deck and the List read one answer and one clock rather than each running a poll of their own (`JiraContext`'s reasoning).
 *
 * **`open`** is "a Jira page is on screen": it adds `?open=1`, which is what quickens the server's reconciler to ~15 s. The section passes `true`; a reader
 * that is not a page (the rail badge) passes `false`, so a configured Jira with the section closed never holds the reconciler at the fast rate.
 *
 * It enters through `useRefreshing` (mount + window focus + the coalesced timer), never a `setInterval` of its own, so a focus storm or a `reload` that
 * lands mid-flight folds into one follow-up (#277) — `useMachines`' shape, and `armed` is constant `true` for the same reason: the mount is the arming.
 *
 * A failed read keeps the previous answer (or `null` before the first) and says nothing: the payload carries its own `reachable` flag for "the dashboard
 * did not answer", and a failed read of THIS route is a blip the next tick fixes — a banner for it would flicker on every one. State is set only while
 * mounted (`useMountedRef`), because a read can land after the page is gone.
 */
export interface JiraSessionsState {
  /** `null` until the first answer lands (or when none ever has), which readers draw as "no sessions known", not as an empty ticket. */
  data: JiraSessionsPayload | null;
  /** Re-ask now — a landed Stop or Unlink calls it so the card goes away without waiting for the timer. */
  reload: () => Promise<void>;
}

export function useJiraSessions({ open }: { open: boolean }): JiraSessionsState {
  const [data, setData] = useState<JiraSessionsPayload | null>(null);
  const mountedRef = useMountedRef();

  const load = useCallback(async () => {
    try {
      const fresh = await fetchJiraSessions(open);
      if (mountedRef.current) setData(fresh);
    } catch {
      // Keep what is on screen; see the hook's comment.
    }
  }, [open, mountedRef]);

  const reload = useRefreshing(load, { armed: true, intervalMs: JIRA_SESSIONS_POLL_MS });

  return { data, reload };
}
