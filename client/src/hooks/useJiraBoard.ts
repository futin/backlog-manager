import { useCallback, useEffect, useRef, useState } from 'react';

import type { JiraIssue, SyncInterval } from '../../../shared/types';
import { useJiraContext } from './JiraContext';
import { BOARD_TRACKER_POLL_MS } from './useBoard';
import { useCoalescedFetch } from './useCoalescedFetch';
import { useMountedRef } from './useMountedRef';

/**
 * One Jira board's cached issue list — `GET /api/jira/boards/:id/issues` — for the Board page (Jira phase 2).
 *
 * **Polled on `BOARD_TRACKER_POLL_MS`, not on the board's own interval.** The server's sweep is what the board's interval paces; the route this reads
 * answers from that cache with no outbound call, so asking it every 15 s is cheap, and it is what keeps the page's rendered poll age close to the real
 * one (the reason `useBoard` gives for the same constant). The board's interval only decides whether there is anything to poll: `armed` while an id is
 * chosen and the board syncs. A board that is `off` — or whose interval is not known yet (`null`) — is read once on mount and then only on `reload`,
 * because nothing on the server moves its cache.
 *
 * Built on `useCoalescedFetch`, so the client poller rule holds: one request of its own in flight, the timer armed by an answer, and a trigger that lands
 * mid-flight (the id changing, `reload`, a tick) folded into ONE follow-up. The task reads the id through a ref, so that follow-up asks for the board the
 * id is NOW, not the one it was when the flight began.
 *
 * **State belongs to an id.** The held list is stamped with the id it was read for, and only an answer for the CURRENT id may write: switching boards
 * never shows the old board's cards under the new name, and a late answer for the board the page has left is dropped rather than painted over. While the
 * held list is for another id the hook reads as empty and `loading`. A `null` id reads as empty and not loading — there is nothing to wait for.
 *
 * A failed read keeps the list already held (for the same id) and raises `error`, as `useBoard` does: one dropped poll is not "this board is empty".
 * A 404 is the one failure that is a fact, not a dropped poll: the board was deleted in another browser. The shell's status is re-read at once, so the page
 * falls to the first board by name now and not at that board's next poll (up to its whole interval, and never for a page of `off` boards).
 *
 * **`nudge` is how a write elsewhere reaches this list** (Jira phase 3, plan ruling R7). The issue modal's landed write bumps a counter `JiraView` owns and
 * hands down; a CHANGE of that number asks at once, through the same coalesced `request` every other trigger uses, whatever the interval — `off` included,
 * because an `off` board is otherwise read only on mount and a write would never show on it (spec §6.1: every write reloads the board). The server spliced
 * the re-read issue into every cache holding it before the write's 200, so this one read is what moves the card now rather than at the next 15 s tick. A
 * counter rather than a callback the modal calls: the modal never reaches into the board's hook, and only the number's change means anything — mount is the
 * id effect's job, so the value the hook is mounted with asks for nothing of its own.
 */
export interface JiraBoardState {
  issues: JiraIssue[];
  polledAt: string | null;
  loading: boolean;
  error: boolean;
  /** Reads now, whatever the interval; resolves when that read settles and never rejects. */
  reload: () => Promise<unknown>;
}

interface Held {
  id: string;
  issues: JiraIssue[];
  polledAt: string | null;
  error: boolean;
}

const NO_ISSUES: JiraIssue[] = [];

export function useJiraBoard(id: string | null, interval: SyncInterval | null, nudge: number): JiraBoardState {
  const [held, setHeld] = useState<Held | null>(null);
  const mounted = useMountedRef();
  const idRef = useRef(id);
  idRef.current = id;
  const { reload: reloadStatus } = useJiraContext();
  const reloadStatusRef = useRef(reloadStatus);
  reloadStatusRef.current = reloadStatus;

  const load = useCallback(async (): Promise<void> => {
    const asked = idRef.current;
    if (asked === null) return;
    try {
      const res = await fetch(`/api/jira/boards/${encodeURIComponent(asked)}/issues`);
      if (res.status === 404 && mounted.current && idRef.current === asked) reloadStatusRef.current();
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { issues?: unknown; polledAt?: unknown };
      if (!Array.isArray(body.issues)) throw new Error('malformed board response');
      const polledAt = typeof body.polledAt === 'string' ? body.polledAt : null;
      if (mounted.current && idRef.current === asked) setHeld({ id: asked, issues: body.issues as JiraIssue[], polledAt, error: false });
    } catch {
      if (mounted.current && idRef.current === asked) {
        setHeld((prev) => {
          const same = prev !== null && prev.id === asked;
          return { id: asked, issues: same ? prev.issues : NO_ISSUES, polledAt: same ? prev.polledAt : null, error: true };
        });
      }
    }
  }, [mounted]);

  const armed = id !== null && interval !== null && interval !== 'off';
  const request = useCoalescedFetch(load, { armed, intervalMs: BOARD_TRACKER_POLL_MS });

  // Mount, and a new id: ask at once. A null id asks for nothing.
  useEffect(() => {
    if (id !== null) void request();
  }, [id, request]);

  // A nudge: ask at once when the number MOVES. The ref remembers the last value acted on, so the mount (which the effect above already covers), an id
  // change and StrictMode's second effect pass all compare equal and ask nothing twice.
  const nudgeRef = useRef(nudge);
  useEffect(() => {
    if (nudgeRef.current === nudge) return;
    nudgeRef.current = nudge;
    if (id !== null) void request();
  }, [nudge, id, request]);

  if (id === null) return { issues: NO_ISSUES, polledAt: null, loading: false, error: false, reload: request };
  if (held === null || held.id !== id) return { issues: NO_ISSUES, polledAt: null, loading: true, error: false, reload: request };
  return { issues: held.issues, polledAt: held.polledAt, loading: false, error: held.error, reload: request };
}
