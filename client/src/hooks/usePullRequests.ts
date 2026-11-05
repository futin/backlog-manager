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
 * The one read of `GET /api/prs` (`.claude/DESIGN.md` §8.11). Mounted once, by the shell's `PullRequestsProvider` (`hooks/PullRequestsContext.tsx`, spec §4.9a)
 * while a GitHub project is registered; GitHub › PRs and Settings' `Access` card (`GithubAccessGroup`, §8.6) read its context. The rail counts PRs that need
 * you on every page, so the read is no longer a page's to arm. The server's PR cache has no timer of its own, so this mount is what arms it — `armed` is
 * constant `true`, as `useMachines`'s is — and it stops when no GitHub project is registered. Enters through `useRefreshing` (mount + focus + the coalesced
 * timer), so two `refresh()` calls during one read fold into one follow-up rather than two requests (#277).
 *
 * A failed read after a success keeps the last `data` and sets `error` beside it: the page draws the rows it has and says the refresh failed, instead of
 * blanking a list a person is part-way through reading. The next answer clears `error`. `refresh` resolves whatever happened — the task catches its own
 * failure — so a caller can `await` it after a write without a `try`. State is set only while mounted (`useMountedRef`): a read can land after the page is gone.
 *
 * What `refresh` resolves is the payload it just stored, or `null` when the read rejected (after `error` was set) or the page is already gone. A caller that
 * awaits a re-read and then judges it — the page's 30 s update timer asks whether the answer it just waited for carries a changed row — must judge THAT
 * answer: the hook's `data` as the caller's closure sees it is the render before the await, so reading it afterwards compares the old rows with themselves.
 * `null` is the one value for "there is no fresh answer to judge", so the caller needs neither a `try` nor a second look at `error` to tell it apart.
 */
export function usePullRequests(): { data: PullRequestsPayload | null; error: string | null; refresh: () => Promise<PullRequestsPayload | null> } {
  const [data, setData] = useState<PullRequestsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useMountedRef();

  const load = useCallback(async (): Promise<PullRequestsPayload | null> => {
    try {
      const fresh = await fetchPullRequests();
      // An unmounted page stored nothing, so it resolves nothing either: a payload handed back here would be one no `data` ever held.
      if (!mountedRef.current) return null;
      setData(fresh);
      setError(null);
      return fresh;
    } catch (e) {
      // `error` is set BEFORE the `null` resolves, so a caller that sees `null` finds the reason already stored.
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [mountedRef]);

  const refresh = useRefreshing(load, { armed: true, intervalMs: PRS_POLL_MS });

  return { data, error, refresh };
}
