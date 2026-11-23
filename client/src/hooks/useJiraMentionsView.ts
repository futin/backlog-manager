import {
  JIRA_MENTIONS_DISMISSED_KEY,
  JIRA_MENTIONS_VIEW_KEY,
  isJiraMentionsDismissedPick,
  isJiraMentionsView,
  type JiraMentionsDismissedPick,
  type JiraMentionsView
} from '../lib/jira-mentions';
import { persistedStore } from './persistedStore';

/**
 * useJiraMentionsView / useJiraMentionsDismissed — the Mentions page's two per-viewer conveniences (spec "The page": "remembered the way the Board remembers
 * its view"): the `List | Cards` pick and Show dismissed. Each has one mounted reader, `JiraMentionsView` — the modal's `Mention 1 of N` arrives from it as
 * a prop, already counted with Show dismissed applied — so several readers is not why they are `persistedStore`s. The store's guard-and-fallback read is:
 * `usePersistedState` hands back whatever was stored, unchecked, where a store reads a word this build never wrote as the default; and the board's persisted
 * module stores share one body (`hooks/persistedStore.ts`) rather than each growing its own.
 *
 * The keys, member lists and guards are `lib/jira-mentions.ts`'s. Anything stored that is not a member reads as the default — `list`, and dismissed hidden —
 * the shapes that always have something to say.
 */
const view = persistedStore<JiraMentionsView>(JIRA_MENTIONS_VIEW_KEY, isJiraMentionsView, 'list');
const dismissed = persistedStore<JiraMentionsDismissedPick>(JIRA_MENTIONS_DISMISSED_KEY, isJiraMentionsDismissedPick, 'hidden');

export const useJiraMentionsView = view.useValue;

/** Show dismissed as a boolean, over the stored word. */
export function useJiraMentionsDismissed(): [boolean, (show: boolean) => void] {
  const [pick, set] = dismissed.useValue();
  return [pick === 'shown', (show) => set(show ? 'shown' : 'hidden')];
}
