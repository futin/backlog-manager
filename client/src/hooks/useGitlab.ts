import { useCallback, useState } from 'react';

import { errorOf } from '../lib/http';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';
import type { GitlabPayload } from '../../../shared/types';

/**
 * How long after one `GET /api/gitlab` settles the next is asked (#277: from the answer, not the wall clock). The route reads the server's in-memory MR cache
 * and costs GitLab nothing — the server's own sweep runs on its `GITLAB_POLL_MS` (2 min) — so this period only decides how soon a finished sweep shows. 30 s
 * keeps the Sources row and the MR badges within a half minute of it without a request that would outpace the cache it reads.
 */
export const GITLAB_CLIENT_POLL_MS = 30_000;

function isPayload(data: unknown): data is GitlabPayload {
  const d = data as { status?: unknown; jiraProjects?: unknown; mrs?: unknown } | null;
  return typeof d === 'object' && d !== null && typeof d.status === 'object' && d.status !== null && typeof d.jiraProjects === 'object' && Array.isArray(d.mrs);
}

async function fetchGitlab(): Promise<GitlabPayload> {
  const res = await fetch('/api/gitlab');
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new Error(errorOf(body, `could not read GitLab (${res.status})`));
  }
  const data: unknown = await res.json().catch(() => null);
  if (!isPayload(data)) throw new Error('unexpected /api/gitlab response');
  return data;
}

/**
 * The one read of `GET /api/gitlab`, mounted once by the shell's `GitlabProvider` (`hooks/GitlabContext.tsx`). Shaped like `usePullRequests`, minus its enable
 * gate: the Sources row needs GitLab's status whatever the answer is (not configured, no mapped repos), so the poll is armed constant `true` and never stops.
 *
 * A failed read after a success keeps the last `data` and sets `error` beside it; a failed FIRST read leaves `data: null` and sets `error` — the failure
 * lands in this hook's state and nowhere else, so a sibling that reads other contexts renders its own content regardless (spec Review Focus 4). `refresh`
 * resolves the payload it stored, or `null` when the read rejected (after `error` was set) or the shell is gone, and never rejects.
 */
export function useGitlab(): { data: GitlabPayload | null; error: string | null; refresh: () => Promise<GitlabPayload | null> } {
  const [data, setData] = useState<GitlabPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useMountedRef();

  const load = useCallback(async (): Promise<GitlabPayload | null> => {
    try {
      const fresh = await fetchGitlab();
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

  const refresh = useRefreshing(load, { armed: true, intervalMs: GITLAB_CLIENT_POLL_MS });

  return { data, error, refresh };
}
