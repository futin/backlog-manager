import { useJiraView } from '../../hooks/useJiraView';
import { JIRA_VIEWS, type JiraViewMode } from '../../lib/jira-view';
import { Segmented } from '../ui/Segmented';

/**
 * JiraViewSwitch — the band's Board | List switch (Jira sessions spec C1, §7; DESIGN.md §8.9.1), `ui/Segmented`'s `track` skin (§8.11) as GitHub › PRs'
 * layout switch draws it. It is the stored view's one writer on the Jira page (`hooks/useJiraView`, which the page's reader shares by construction).
 *
 * `listReady` is how a view can be declared before it exists: while it is false the List option is drawn `disabled` and the switch reads `board` whatever is
 * stored, so a person who stored `list` on a build that had one is not left on a page that cannot draw it. The page flips it when the List lands.
 */
const LABELS: Record<JiraViewMode, string> = { board: 'Board', list: 'List' };

export function JiraViewSwitch({ listReady }: { listReady: boolean }) {
  const [view, setView] = useJiraView();
  return (
    <Segmented<JiraViewMode>
      track
      label="View"
      value={listReady ? view : 'board'}
      options={JIRA_VIEWS.map((v) => ({ value: v, label: LABELS[v], disabled: v === 'list' && !listReady }))}
      onChange={setView}
    />
  );
}
