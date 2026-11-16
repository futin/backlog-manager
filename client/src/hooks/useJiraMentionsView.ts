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
 * its view"): the `List | Cards` pick and Show dismissed. Two `persistedStore`s, `useJiraView`'s shape, for that file's reason: the band's switch and the
 * view under it are separate mounted readers of one value, and the modal's `Mention 1 of N` (Task 10) reads Show dismissed too.
 *
 * The keys, member lists and guards are `lib/jira-mentions.ts`'s. Anything stored that is not a member reads as the default — `list`, and dismissed hidden —
 * the shapes that always have something to say.
 */
const view = persistedStore<JiraMentionsView>(JIRA_MENTIONS_VIEW_KEY, isJiraMentionsView, 'list');
const dismissed = persistedStore<JiraMentionsDismissedPick>(JIRA_MENTIONS_DISMISSED_KEY, isJiraMentionsDismissedPick, 'hidden');

export const useJiraMentionsView = view.useValue;
export const setJiraMentionsView = view.set;

/** Show dismissed as a boolean, over the stored word. */
export function useJiraMentionsDismissed(): [boolean, (show: boolean) => void] {
  const [pick, set] = dismissed.useValue();
  return [pick === 'shown', (show) => set(show ? 'shown' : 'hidden')];
}
