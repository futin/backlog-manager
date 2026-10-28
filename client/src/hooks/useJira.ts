import { useCallback, useEffect, useRef, useState } from 'react';

import { isJiraStatusPayload, soonestBoard } from '../lib/jira';
import { SYNC_INTERVALS, type JiraStatusPayload } from '../../../shared/types';
import { TRACKER_FETCH_SLACK_MS } from './useTrackers';
import { useWindowFocus } from './useWindowFocus';

/**
 * `GET /api/jira` — the shell's one instance (Jira phase 2, §6), provided through `JiraContext` to the rail (which draws the Jira entry only while
 * `configured` is true), the chip, and the Board and Setup pages. Nothing else calls this hook directly: two instances would be two clocks, and could hold
 * two different answers — the chip saying a board is failing while the page beside it says it is fine.
 *
 * `useTrackers`'s shape, aimed at the boards' own clock rather than the GitHub cycle: after every answer there is exactly one pending timer, set for
 * `soonest board's polledAt + its interval + TRACKER_FETCH_SLACK_MS` — just after the server's next sweep of that board should have stamped a fresh
 * `polledAt`. That is what lets the chip's age reading snap back right after a sweep instead of drifting against a blind interval. The slack is
 * `useTrackers`'s own constant, because it covers the same thing: the sweep's calls land one after another, not at the tick.
 *
 * - **A fifteen-second floor** (`JIRA_STATUS_FLOOR_MS`). A stamp already older than its interval (a background tab, a server restarting, a board whose
 *   sweep is failing so its stamp never moves) puts the deadline in the past; firing at once and getting the same stale stamp back would loop. Fifteen
 *   seconds is the poller's own base tick (`TRACKER_POLL_MS`), so nothing faster could show a new stamp. A board that has never polled is due now and
 *   reads the floor too — that is how the status catches the first sweep's stamp within one tick.
 * - **No timer at all** while unconfigured, with no boards, or with only `off` boards — `soonestBoard` returns `null` for the last two. One fetch, so the
 *   shell can say `configured: false` or `sync off`, and then nothing: there is no clock to follow. What can change that (a Setup save) calls `reload`.
 * - **Focus refetches at once** and re-arms from that answer; the pending timer is cleared first, so there is never more than one.
 * - **Only the newest read may write** (#231, the same rule and the same counter as `useTrackers`). The focus read, the timer's read and a save's reload
 *   can be in flight together and settle out of order; a superseded read does nothing at all when it settles — no state, no timer, no `error`. A counter
 *   rather than an `AbortController`, because an abort rejects the fetch and `catch` would then have to tell a superseded read from a real failure.
 *
 * A failed read — a network error, a non-2xx, or a 200 that is not a status payload — keeps whatever is in state, raises `error` and retries at the floor:
 * there is no stamp in a failed answer to aim at, and a page that emptied itself on one blip would claim `No boards yet`, a stronger statement than a
 * failure supports. This hook is NOT built on `useCoalescedFetch`, for `useTrackers`'s reason (see its header and CLAUDE.md's #231 exception): the timer is
 * aimed at the server's clock, and the sequence counter, not a single flight, is what keeps an older answer from landing over a newer one.
 */
export const JIRA_STATUS_FLOOR_MS = 15_000;

export interface JiraState {
  data: JiraStatusPayload | null;
  loading: boolean;
  error: boolean;
  reload: () => void;
}

/** How long after this answer to ask again, or `null` for "don't": no timer without a board that syncs. */
function nextDelay(data: JiraStatusPayload, now: number): number | null {
  if (!data.configured) return null;
  const soonest = soonestBoard(data.boards, now);
  if (soonest === null) return null;
  const interval = SYNC_INTERVALS[soonest.interval];
  if (interval === null) return null;
  const polled = soonest.polledAt === null ? NaN : Date.parse(soonest.polledAt);
  if (Number.isNaN(polled)) return JIRA_STATUS_FLOOR_MS;
  return Math.max(polled + interval + TRACKER_FETCH_SLACK_MS - now, JIRA_STATUS_FLOOR_MS);
}

export function useJira(): JiraState {
  const [state, setState] = useState<Pick<JiraState, 'data' | 'loading' | 'error'>>({ data: null, loading: true, error: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An answer that lands after unmount must not arm a timer nobody will clear.
  const mounted = useRef(true);
  // The newest read's sequence number — see "Only the newest read may write" in the header.
  const latest = useRef(0);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const reload = useCallback(() => {
    clear();
    const seq = ++latest.current;
    const current = (): boolean => mounted.current && seq === latest.current;
    const arm = (ms: number | null): void => {
      clear();
      if (ms === null || !mounted.current) return;
      timer.current = setTimeout(reload, ms);
    };
    fetch('/api/jira')
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<unknown>;
      })
      .then((data) => {
        // Checked here rather than trusted in the readers: they map over the collections, so a wrong-shaped 200 would throw inside a render and take the
        // page down with it. A malformed body lands on the same `error` path an unreachable API does.
        if (!isJiraStatusPayload(data)) throw new Error('malformed /api/jira response');
        if (!current()) return;
        setState({ data, loading: false, error: false });
        arm(nextDelay(data, Date.now()));
      })
      .catch(() => {
        if (!current()) return;
        setState((prev) => ({ data: prev.data, loading: false, error: true }));
        arm(JIRA_STATUS_FLOOR_MS);
      });
  }, [clear]);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
      clear();
    };
  }, [reload, clear]);

  useWindowFocus(reload);

  return { ...state, reload };
}
