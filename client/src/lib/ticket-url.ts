import { TICKET_ORIGINS, type TicketOrigin } from './jira-page';
import { withoutDeepLink } from './deep-link';

/**
 * ticket-url.ts — the address of the Jira ticket page and the state that rides with it (Jira ticket URL spec).
 *
 * The ticket page's address is the deep-link pair `?section=jira&ticket=<KEY>` on `/`, the one scheme `lib/deep-link.ts` reads. These are the pure halves
 * `App` composes into `history.pushState` / `replaceState`, kept free of `window` so the address can be tested as a string.
 */

/**
 * The address for one ticket: every parameter that is not part of a deep link kept in place, then `section=jira&ticket=<key>`, and the hash kept. Going through
 * `withoutDeepLink` is what makes a stale `section=runs` or an old `ticket` vanish rather than double up, and keeps the "which params are deep-link params"
 * list in one file.
 */
export function ticketAddress(pathname: string, search: string, hash: string, key: string): string {
  const base = withoutDeepLink(pathname, search, '');
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}section=jira&ticket=${encodeURIComponent(key)}${hash}`;
}

/**
 * The origin a history entry was opened from. `history.state` is whatever any code or a previous app version left there, so it is read as `unknown`: only a
 * recognised `jiraTicketOrigin` counts, and everything else, including a pasted link's null state, reads `board`.
 */
export function originFromState(state: unknown): TicketOrigin {
  if (typeof state !== 'object' || state === null) return 'board';
  const origin = (state as { jiraTicketOrigin?: unknown }).jiraTicketOrigin;
  return (TICKET_ORIGINS as readonly unknown[]).includes(origin) ? (origin as TicketOrigin) : 'board';
}

/** The `history.state` a ticket entry is pushed with; the inverse of `originFromState`. */
export function ticketState(origin: TicketOrigin): { jiraTicketOrigin: TicketOrigin } {
  return { jiraTicketOrigin: origin };
}
