import { useCallback, useEffect, useRef, useState } from 'react';

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
 * Every linked Jira session, live and ended, with its derived state (Jira sessions spec §6, §7). Mounted ONCE, by `JiraSessionsProvider` — at the shell,
 * around the rail and the Jira section — so Detail, the deck, the List and the rail badge read one answer and one clock rather than each running a poll of
 * their own (`JiraContext`'s reasoning).
 *
 * **`open`** is "a Jira page is on screen": it adds `?open=1`, which is what quickens the server's reconciler to ~15 s. The shell passes whether the Jira
 * section is the current one, so the same instance that feeds the rail badge with the section closed never holds the reconciler at the fast rate.
 *
 * **`enabled`** is "Jira is configured": the instance now lives at the shell (so the rail badge and the section share one poll), above the answer to
 * whether Jira exists at all, so it must be mountable and silent. While it is false the task fetches nothing and the timer is not armed — an
 * unconfigured machine makes no request for this — and `data` stays whatever it was (`null` on a machine that never had Jira). Flipping `open` or
 * `enabled` re-asks once, so landing on the section (or the status answering `configured`) does not wait out the remaining 15 s on a read that was
 * made under the other flag; the trigger is the coalesced one, so it folds into a read already in flight.
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

export function useJiraSessions({ open, enabled = true }: { open: boolean; enabled?: boolean }): JiraSessionsState {
  const [data, setData] = useState<JiraSessionsPayload | null>(null);
  const mountedRef = useMountedRef();

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const fresh = await fetchJiraSessions(open);
      if (mountedRef.current) setData(fresh);
    } catch {
      // Keep what is on screen; see the hook's comment.
    }
  }, [open, enabled, mountedRef]);

  const reload = useRefreshing(load, { armed: enabled, intervalMs: JIRA_SESSIONS_POLL_MS });

  // The mount already asked (`useRefreshing`), so the first run of this effect is skipped rather than doubled into a second request.
  const flags = useRef({ open, enabled });
  useEffect(() => {
    if (flags.current.open === open && flags.current.enabled === enabled) return;
    flags.current = { open, enabled };
    if (enabled) void reload();
  }, [open, enabled, reload]);

  return { data, reload };
}
