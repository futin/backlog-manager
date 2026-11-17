import { useCallback, useState } from 'react';

import { fetchPrResolves, fetchPullRequests } from '../lib/prs-api';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';
import type { PrResolveState, PullRequestsPayload } from '../../../shared/types';

/**
 * How long after one `GET /api/prs` settles the next is asked (#277: from the answer, not the wall clock). A minute: each read is one GraphQL query per
 * registered repo against GitHub's separate GraphQL budget, and the page's own writes re-read the PR they touched, so a faster poll would spend that budget
 * on rows nobody changed.
 */
export const PRS_POLL_MS = 60_000;

/**
 * The one read of `GET /api/prs` (`.claude/DESIGN.md` §8.11). Mounted once, by the shell's `PullRequestsProvider` (`hooks/PullRequestsContext.tsx`, spec §4.9a)
 * while a GitHub project is registered; GitHub › PRs and Settings' `Access` card (`GithubAccessGroup`, §8.6) read its context. The rail counts open PRs
 * on every page, so the read is no longer a page's to arm. The server's PR cache has no timer of its own, so this mount is what arms it — `armed` is
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
 *
 * **The resolve states ride the same tick** (spec 2026-11-17-pr-conflict-resolve-design.md, "The board"): `GET /api/agents/pr-resolve` is asked beside
 * `GET /api/prs`, in the one task `useRefreshing` coalesces, so a Resolve conflicts row and its status line are never a poll behind the PR they describe and
 * no second timer exists for them. The two reads are not equals: the PR read alone decides `error` and what `refresh` resolves, because the page's own error
 * line and the update timer's verdict are both about PRs. A failed resolves read keeps the last `resolves` and says nothing — the server answers it from
 * memory and a file scan, so a failure is the network or a proxy page, which the PR read beside it will already be reporting.
 */
export interface PullRequestsRead {
  data: PullRequestsPayload | null;
  error: string | null;
  refresh: () => Promise<PullRequestsPayload | null>;
  /** Every PR with a live resolve session or an outcome file, from the last resolves read that answered; `[]` until one does. */
  resolves: PrResolveState[];
}

export function usePullRequests(): PullRequestsRead {
  const [data, setData] = useState<PullRequestsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolves, setResolves] = useState<PrResolveState[]>([]);
  const mountedRef = useMountedRef();

  const load = useCallback(async (): Promise<PullRequestsPayload | null> => {
    // Both reads leave in the same tick, the PR read first. The resolves read's own rejection handler turns a failure into "keep the last", so it can
    // never reject the `Promise.all` below and land in `error`; the PR read's rejection still does.
    const prsRead = fetchPullRequests();
    const resolvesRead = fetchPrResolves().then(
      (payload) => {
        if (mountedRef.current) setResolves(payload.resolves);
      },
      () => undefined
    );
    try {
      const [fresh] = await Promise.all([prsRead, resolvesRead]);
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

  return { data, error, refresh, resolves };
}
