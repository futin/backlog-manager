import { persistedJsonStore } from './persistedStore';

/**
 * useJiraDetailTab — the Detail body's selected tab (Jira detail tabs spec §1.3), shared by the modal and the ticket page. A module store for `persistedStore`'s
 * reason: the modal and the page draw the same body, and a tab chosen in one must be the tab the other opens on, without either remounting at the right moment.
 *
 * Written on every user selection and never on a fallback: a remembered `delivery` that this ticket does not draw (an unmapped project) is shown as `ticket` for
 * that render by the caller, and the store keeps `delivery`, so the next mapped ticket opens on Delivery again. Anything stored that is not a tab reads
 * `ticket`, the one tab every ticket can draw. Returns the value alone (not a tuple): the writer is the separate `setJiraDetailTab`, because the body that
 * selects and the body that only reads are not always the same component.
 */
export type DetailTab = 'ticket' | 'delivery' | 'agent' | 'children';

/** Declaration order is the tablist's order. */
export const DETAIL_TABS: readonly DetailTab[] = ['ticket', 'delivery', 'agent', 'children'];

export const JIRA_DETAIL_TAB_KEY = 'backlog-manager.jira-detail-tab';

export function isDetailTab(v: unknown): v is DetailTab {
  return typeof v === 'string' && (DETAIL_TABS as readonly string[]).includes(v);
}

const store = persistedJsonStore<DetailTab>(JIRA_DETAIL_TAB_KEY, (v) => (isDetailTab(v) ? v : 'ticket'));

export const useJiraDetailTab = store.useValue;
export const setJiraDetailTab = store.set;
