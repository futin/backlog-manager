import { useRef } from 'react';

import { needsYouCount } from '../lib/jira-list';
import { useJiraSessionsContext } from './JiraSessionsContext';

/**
 * useJiraNeedsYou — the rail badge's count (Jira sessions spec §7.4, C4), read from the shell's one sessions answer (`JiraSessionsContext`) and never from a
 * poll of its own. The hold is the point of the hook: `needsYouCount` is `null` while the dashboard is unreachable (every live session then reads Lost
 * contact, which cannot say who is waiting), and a failed read of the route keeps the previous payload (`useJiraSessions`), so in both cases the badge keeps
 * the last number it was sure of — a flicker to nothing would tell a person nobody needs them at exactly the moment nobody can say. Before any answer, and
 * with Jira unconfigured (the provider never fetches), it is 0.
 *
 * The last count lives in a ref written during render: the same payload always yields the same write, so a re-render or a discarded render cannot move it.
 */
export function useJiraNeedsYou(): number {
  const { data } = useJiraSessionsContext();
  const last = useRef(0);
  const count = needsYouCount(data);
  if (count !== null) last.current = count;
  return last.current;
}
