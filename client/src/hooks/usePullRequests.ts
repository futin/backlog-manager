import { useCallback, useState } from 'react';

import { fetchPullRequests } from '../lib/prs-api';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';
import type { PullRequestsPayload } from '../../../shared/types';

/**
 * How long after one `GET /api/prs` settles the next is asked (#277: from the answer, not the wall clock). A minute: each read is one GraphQL query per
 * registered repo against GitHub's separate GraphQL budget, and the page's own writes re-read the PR they touched, so a faster poll would spend that budget
 * on rows nobody changed.
 */
export const PRS_POLL_MS = 60_000;

/**
 * The one read of `GET /api/prs` (`.claude/DESIGN.md` §8.11). Mounted by two pages and no other: GitHub › PRs, and GitHub › Settings' `Access` card
 * (`GithubAccessGroup`, §8.6), which lists the repos the PRs page hides. That is the whole of "nothing reads PRs while nobody is on a page that shows them":
 * the server's PR cache has no timer of its own, so a page's mount is what arms this poll — `armed` is constant `true`, as `useMachines`'s is — and leaving
 * the page unmounts it. The two pages are never open together, so there is one poll at a time. Enters through `useRefreshing` (mount + focus + the coalesced timer), so two `refresh()` calls during one read fold into one
 * follow-up rather than two requests (#277).
 *
 * A failed read after a success keeps the last `data` and sets `error` beside it: the page draws the rows it has and says the refresh failed, instead of
 * blanking a list a person is part-way through reading. The next answer clears `error`. `refresh` resolves whatever happened — the task catches its own
 * failure — so a caller can `await` it after a write without a `try`. State is set only while mounted (`useMountedRef`): a read can land after the page is gone.
 */
export function usePullRequests(): { data: PullRequestsPayload | null; error: string | null; refresh: () => Promise<unknown> } {
  const [data, setData] = useState<PullRequestsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useMountedRef();

  const load = useCallback(async () => {
    try {
      const fresh = await fetchPullRequests();
      if (!mountedRef.current) return;
      setData(fresh);
      setError(null);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [mountedRef]);

  const refresh = useRefreshing(load, { armed: true, intervalMs: PRS_POLL_MS });

  return { data, error, refresh };
}
