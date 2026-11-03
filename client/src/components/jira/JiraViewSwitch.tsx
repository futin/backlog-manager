import { useJiraView } from '../../hooks/useJiraView';
import { JIRA_VIEWS, type JiraViewMode } from '../../lib/jira-view';
import { Segmented } from '../ui/Segmented';

/**
 * JiraViewSwitch — the band's Board | List switch (Jira sessions spec C1, §7; DESIGN.md §8.9.1), `ui/Segmented`'s `track` skin (§8.11) as GitHub › PRs'
 * layout switch draws it. It is the stored view's one writer on the Jira page (`hooks/useJiraView`, which the page's reader shares by construction).
 *
 * Both views exist, so both options are live and the switch reads the stored view as it is. (It used to take a `listReady` flag that drew List `disabled` and
 * read `board` whatever was stored, so a view could be declared before it was built; that flag went when the List landed, and `Segmented`'s per-option
 * `disabled` stays for the next view that is declared first.)
 */
const LABELS: Record<JiraViewMode, string> = { board: 'Board', list: 'List' };

export function JiraViewSwitch() {
  const [view, setView] = useJiraView();
  return (
    <Segmented<JiraViewMode>
      track
      label="View"
      value={view}
      options={JIRA_VIEWS.map((v) => ({ value: v, label: LABELS[v] }))}
      onChange={setView}
    />
  );
}
