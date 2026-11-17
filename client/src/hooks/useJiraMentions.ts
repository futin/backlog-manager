import { useCallback, useEffect, useRef, useState } from 'react';

import { asMentionsFailure, fetchJiraMentions, postJiraMentions, postJiraReply, type JiraMentionsFailure } from '../lib/jira-mentions';
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

export type JiraReplyWrite = JiraMentionsWrite & { posted?: { id: string; url: string } };

export interface JiraMentionsState {
  data: JiraMentionsPayload | null;
  loading: boolean;
  error: JiraMentionsFailure | null;
  reload: () => void;
  sweep: () => Promise<void>;
  checking: boolean;
  dismiss: (key: string, ids: string[]) => Promise<JiraMentionsWrite>;
  restore: (key: string) => Promise<JiraMentionsWrite>;
  /** Drops the key's reply draft; the answer replaces `data`. */
  discardDraft: (key: string) => Promise<JiraMentionsWrite>;
  /**
   * Posts the reply to Jira (the one comment write). A second call for a key already out RESOLVES WITH THE FIRST ONE'S OUTCOME, not `ok`: the modal draws
   * "Posted" from `ok`, and an `ok` for a click whose post it never saw land would say so over a post that then failed.
   */
  postReply: (key: string, text: string) => Promise<JiraReplyWrite>;
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
  const status = useJiraContext();
  const access = status.data?.access;
  // The shell's `reload` is a fresh closure per render in some providers; a ref keeps `write` stable.
  const reloadStatus = useRef(status.reload);
  reloadStatus.current = status.reload;
  // Keys whose dismiss or restore is still out: a double click would send a second POST that the server answers 400 ("not an open mention"), and that
  // refusal would land in the band over a click that had in fact worked.
  const writing = useRef(new Set<string>());
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

  // A write's answer replaces `data` and re-arms the timer from its stamp. Taking a sequence number here retires any read still in flight. A success
  // also re-reads the SHELL status: the rail's Jira › Mentions count and the popover's `Mentions · N` come from `status.mentions.count`, which would
  // otherwise disagree with this page for up to a poll interval after the reader's own click.
  const landed = useCallback(
    (data: JiraMentionsPayload): { ok: true } => {
      if (!mounted.current) return { ok: true };
      latest.current += 1;
      setState({ data, loading: false, error: null });
      clear();
      const ms = nextDelay(data, Date.now());
      if (ms !== null) timer.current = setTimeout(reload, ms);
      reloadStatus.current();
      return { ok: true };
    },
    [clear, reload]
  );
  const failed = useCallback((e: unknown): { ok: false; message: string } => {
    const failure = asMentionsFailure(e);
    if (mounted.current) setState((prev) => ({ ...prev, error: failure }));
    return { ok: false, message: failure.message };
  }, []);
  const write = useCallback(
    async (path: 'sweep' | 'dismiss' | 'restore' | 'draft/discard', body: object): Promise<JiraMentionsWrite> => {
      try {
        return landed(await postJiraMentions(path, body));
      } catch (e) {
        return failed(e);
      }
    },
    [landed, failed]
  );

  const sweep = useCallback(async (): Promise<void> => {
    setSweeping(true);
    try {
      await write('sweep', {});
    } finally {
      if (mounted.current) setSweeping(false);
    }
  }, [write]);

  // A second dismiss or restore for a key already out resolves `ok` without posting: the first one's answer is the one the caller is waiting on.
  const once = useCallback(
    async (key: string, send: () => Promise<JiraMentionsWrite>): Promise<JiraMentionsWrite> => {
      if (writing.current.has(key)) return { ok: true };
      writing.current.add(key);
      try {
        return await send();
      } finally {
        writing.current.delete(key);
      }
    },
    []
  );
  const dismiss = useCallback((key: string, ids: string[]) => once(key, () => write('dismiss', { key, commentIds: ids })), [once, write]);
  const restore = useCallback((key: string) => once(key, () => write('restore', { key })), [once, write]);

  const discardDraft = useCallback((key: string) => once(key, () => write('draft/discard', { key })), [once, write]);

  // Single-flight per key, sharing the OUTCOME: the second caller gets the first one's promise (a `once` would resolve it `ok` without a post). The
  // server's own `replying` set is the cross-tab guard; this one stops a double click here from drawing a 409 over a post that worked.
  const replying = useRef(new Map<string, Promise<JiraReplyWrite>>());
  const postReply = useCallback(
    (key: string, text: string): Promise<JiraReplyWrite> => {
      const out = replying.current.get(key);
      if (out !== undefined) return out;
      const run = (async (): Promise<JiraReplyWrite> => {
        try {
          const { payload, posted } = await postJiraReply(key, text);
          return { ...landed(payload), posted };
        } catch (e) {
          return failed(e);
        } finally {
          replying.current.delete(key);
        }
      })();
      replying.current.set(key, run);
      return run;
    },
    [landed, failed]
  );

  const d = state.data;
  const blocked = (access !== undefined && access !== 'ok') || (d !== null && d.configured && d.retryAt !== null);
  const checking = sweeping || (d !== null && d.configured && d.polledAt === null && !blocked);

  return { ...state, reload, sweep, checking, dismiss, restore, discardDraft, postReply };
}
