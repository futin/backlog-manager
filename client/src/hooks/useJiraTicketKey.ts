import { useSyncExternalStore } from 'react';
import { isJiraKey } from '../../../shared/types';
import type { TicketOrigin } from '../lib/jira-page';
import { withoutDeepLink } from '../lib/deep-link';
import { ticketAddress, ticketState } from '../lib/ticket-url';

/**
 * useJiraTicketKey — the ticket the `ticket` page shows (Jira detail tabs spec §2.1, §2.2; Jira ticket URL spec), shared by the page, the modal's
 * `Open full page ↗` and `App`'s address and popstate effects. A module store for the reason the persisted stores are: the modal writes it in the same handler
 * that moves the page, and `App` reads it to keep the address in step, so several mounted readers and writers must agree without a remount.
 *
 * **The address bar is the source of truth, and nothing here is persisted.** The key lives in `?section=jira&ticket=<KEY>`, so a reload, a pasted link and
 * the browser's Back all land on the same ticket without a second copy in localStorage that could disagree with the URL. The module value is only the mirror
 * that lets React readers rerender; `App` seeds it from the address on load and from `history.state` on popstate through `syncJiraTicket`, which writes no
 * history (a write there would make Back push a new entry on every press).
 *
 * **Why the origin rides in `history.state`.** The ticket page's Back arrow returns to wherever the ticket was opened from (board, sessions, mentions), and
 * that is a fact about this ONE history entry, not about the key: the same key can be reached from two places. State belongs to the entry, survives a reload
 * of it, and is `null` on a pasted link, which reads `board`.
 *
 * **The history rule.** none -> key PUSHES an entry (Back leaves the ticket); key -> another key REPLACES (paging through tickets must not stack Back
 * presses, and the entry's origin stays); key -> none REPLACES with `null` state at the address without the deep-link pair, so the entry that was the ticket
 * becomes the page it closed to. The same key again writes nothing.
 *
 * A closed STRING store, so "no ticket" is `''`, never `null`: `isJiraKey` is the one definition of a key, which also keeps a value out of the address unless
 * it is shaped like one; a setter given anything else (other than `''`) ignores the call.
 */
export const JIRA_TICKET_KEY_KEY = 'backlog-manager.jira-ticket-key';

type Snapshot = { key: string; origin: TicketOrigin };

let current: Snapshot = { key: '', origin: 'board' };
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
  if (next.key === current.key && next.origin === current.origin) return;
  current = next;
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const useJiraTicketKey = (): string => useSyncExternalStore(subscribe, () => current.key);
export const useJiraTicketOrigin = (): TicketOrigin => useSyncExternalStore(subscribe, () => current.origin);

/** The current value for non-React readers (`App`'s popstate handler). */
export const getJiraTicket = (): Snapshot => current;

/** Sets the store and writes NO history: the load seed and popstate, where the address already says it. */
export function syncJiraTicket(key: string, origin: TicketOrigin): void {
  if (key !== '' && !isJiraKey(key)) return;
  publish({ key, origin: key === '' ? 'board' : origin });
}

export function setJiraTicketKey(key: string, origin?: TicketOrigin): void {
  if (key !== '' && !isJiraKey(key)) return;
  const prev = current.key;
  if (key === prev) return;
  const { pathname, search, hash } = window.location;
  if (prev === '' && key !== '') {
    const o = origin ?? 'board';
    window.history.pushState(ticketState(o), '', ticketAddress(pathname, search, hash, key));
    publish({ key, origin: o });
  } else if (key !== '') {
    window.history.replaceState(window.history.state, '', ticketAddress(pathname, search, hash, key));
    publish({ key, origin: current.origin });
  } else {
    window.history.replaceState(null, '', withoutDeepLink(pathname, search, hash));
    publish({ key: '', origin: 'board' });
  }
}

/** Drops the value an older build persisted, once, so a stale key is not left in storage forever. */
export function forgetLegacyTicketKey(): void {
  try {
    localStorage.removeItem(JIRA_TICKET_KEY_KEY);
  } catch {
    /* storage can be unavailable; there is nothing to forget then */
  }
}
