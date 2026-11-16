import { useCallback, useEffect, useRef, useState } from 'react';

import { asMentionsFailure, fetchJiraMentions, postJiraMentions, type JiraMentionsFailure } from '../lib/jira-mentions';
import { JIRA_MENTIONS_POLL_MS, type JiraMentionsPayload } from '../../../shared/types';
import { useJiraContext } from './JiraContext';
import { JIRA_STATUS_FLOOR_MS } from './useJira';
import { TRACKER_FETCH_SLACK_MS } from './useTrackers';
import { useWindowFocus } from './useWindowFocus';

/**
 * `GET /api/jira/mentions` for the Mentions page (Jira mentions phase 1) — `useJira`'s mechanics aimed at the mentions cache's own clock.
 *
 * - **One timer**, set after every answer for `polledAt + JIRA_MENTIONS_POLL_MS + TRACKER_FETCH_SLACK_MS`, floored at `JIRA_STATUS_FLOOR_MS` (a stamp older
 *   than its interval, or `null`, would otherwise loop at once). **None while unconfigured**: there is no clock to follow.
 * - **Focus refetches at once** and re-arms; the pending timer is cleared first, so there is never more than one.
 * - **Newest read wins** (#231, the same counter as `useJira`): a superseded read writes nothing. A POST's answer also takes a sequence number when it
 *   settles, so a GET that started before it cannot land over it.
 * - A failed read keeps `data`, raises `error` and retries at the floor.
 *
 * `error` is a `JiraMentionsFailure | null`, shared by reads and writes: `message`, and `retryAt` for a 429 sweep (the page's "Jira asked to wait until"
 * copy). `checking` is true while this hook's own sweep is out, or while the cache has never been stamped (`polledAt` null) and nothing blocks the check —
 * Jira reachable per the shell's status `access` (read through `useJiraContext`) and no `retryAt`; the page then says "checking", never "Nothing waiting".
 *
 * `dismiss` and `restore` also RESOLVE their own outcome (`JiraMentionsWrite`) — still never rejecting, and still raising `error` for the band — because
 * the mention modal sits over that band under a scrim, and a refusal it cannot see is a click that did nothing. `error` alone would not do: it is shared
 * with the poll, so the modal could not tell its own write's refusal from a read's.
 */
export type JiraMentionsWrite = { ok: true } | { ok: false; message: string };

export interface JiraMentionsState {
  data: JiraMentionsPayload | null;
  loading: boolean;
  error: JiraMentionsFailure | null;
  reload: () => void;
  sweep: () => Promise<void>;
  checking: boolean;
  dismiss: (key: string, ids: string[]) => Promise<JiraMentionsWrite>;
  restore: (key: string) => Promise<JiraMentionsWrite>;
}

function nextDelay(data: JiraMentionsPayload, now: number): number | null {
  if (!data.configured) return null;
  const polled = data.polledAt === null ? NaN : Date.parse(data.polledAt);
  if (Number.isNaN(polled)) return JIRA_STATUS_FLOOR_MS;
  return Math.max(polled + JIRA_MENTIONS_POLL_MS + TRACKER_FETCH_SLACK_MS - now, JIRA_STATUS_FLOOR_MS);
}

export function useJiraMentions(): JiraMentionsState {
  const [state, setState] = useState<{ data: JiraMentionsPayload | null; loading: boolean; error: JiraMentionsFailure | null }>({
    data: null,
    loading: true,
    error: null
  });
  const [sweeping, setSweeping] = useState(false);
  const access = useJiraContext().data?.access;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const latest = useRef(0);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const reload = useCallback(() => {
    clear();
    const seq = ++latest.current;
    const current = (): boolean => mounted.current && seq === latest.current;
    fetchJiraMentions()
      .then((data) => {
        if (!current()) return;
        setState({ data, loading: false, error: null });
        const ms = nextDelay(data, Date.now());
        clear();
        if (ms !== null) timer.current = setTimeout(reload, ms);
      })
      .catch((e: unknown) => {
        if (!current()) return;
        setState((prev) => ({ data: prev.data, loading: false, error: asMentionsFailure(e) }));
        clear();
        timer.current = setTimeout(reload, JIRA_STATUS_FLOOR_MS);
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

  // A write's answer replaces `data` and re-arms the timer from its stamp. Taking a sequence number here retires any read still in flight.
  const write = useCallback(
    async (path: 'sweep' | 'dismiss' | 'restore', body: object): Promise<JiraMentionsWrite> => {
      try {
        const data = await postJiraMentions(path, body);
        if (!mounted.current) return { ok: true };
        latest.current += 1;
        setState({ data, loading: false, error: null });
        clear();
        const ms = nextDelay(data, Date.now());
        if (ms !== null) timer.current = setTimeout(reload, ms);
        return { ok: true };
      } catch (e) {
        const failure = asMentionsFailure(e);
        if (mounted.current) setState((prev) => ({ ...prev, error: failure }));
        return { ok: false, message: failure.message };
      }
    },
    [clear, reload]
  );

  const sweep = useCallback(async (): Promise<void> => {
    setSweeping(true);
    try {
      await write('sweep', {});
    } finally {
      if (mounted.current) setSweeping(false);
    }
  }, [write]);

  const dismiss = useCallback((key: string, ids: string[]) => write('dismiss', { key, commentIds: ids }), [write]);
  const restore = useCallback((key: string) => write('restore', { key }), [write]);

  const d = state.data;
  const blocked = (access !== undefined && access !== 'ok') || (d !== null && d.configured && d.retryAt !== null);
  const checking = sweeping || (d !== null && d.configured && d.polledAt === null && !blocked);

  return { ...state, reload, sweep, checking, dismiss, restore };
}
