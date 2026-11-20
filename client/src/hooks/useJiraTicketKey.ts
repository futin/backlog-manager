import { isJiraKey } from '../../../shared/types';
import { persistedJsonStore } from './persistedStore';

/**
 * useJiraTicketKey — the ticket the `ticket` page shows (Jira detail tabs spec §2.1, §2.2), shared by the page, the modal's `Open full page ↗` and the rail's
 * row. A module store for `persistedStore`'s reason: the modal writes it in the same handler that moves the page, and the rail draws a row from it, so three
 * mounted readers and writers must agree without a remount.
 *
 * A closed STRING store, so "no ticket" is `''`, never `null`: the guard accepts a Jira key (`isJiraKey`, the one definition — which also keeps a stored value
 * out of a URL path unless it is shaped like a key) or the empty string, and anything else reads `''`. A reload on the page reopens the same ticket; only a
 * failed read's `Forget <KEY>` clears it. Returns the value alone, for `useJiraDetailTab`'s reason.
 */
export const JIRA_TICKET_KEY_KEY = 'backlog-manager.jira-ticket-key';

const store = persistedJsonStore<string>(JIRA_TICKET_KEY_KEY, (v) => (isJiraKey(v) ? v : ''));

export const useJiraTicketKey = store.useValue;
export const setJiraTicketKey = store.set;
