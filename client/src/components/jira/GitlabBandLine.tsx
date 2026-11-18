import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import { useNow } from '../../hooks/useNow';
import { bandTotals } from '../../lib/delivery';
import type { JiraIssue } from '../../../../shared/types';

/**
 * The Board band's GitLab line (GitLab connection spec §7.2, mock `Cards.dc.html`; DESIGN.md §8.9.1, the band): `GitLab: 3 open · 1 failing · 1 merged ·
 * polled 2m ago`, a second line under the board's own sub-line. The words are `bandTotals`' alone — over the ISSUES the page's filters match (every card
 * and on-board lane header a filter leaves, parent-lanes spec §6.2), each issue's lead MR, the oldest `polledAt` — so a filter narrows the line with the
 * lanes, and the line counts no MR outside what the filters match — a card in a folded lane or past a cell's `+ N more` cut still counts.
 *
 * Drawn only while delivery is shown at all (`useDeliveryIndex` is `null` otherwise) and while some matching issue maps a GitLab project (`bandTotals` is
 * `null` otherwise): an unconfigured GitLab leaves the band exactly as it was. It ticks on a clock of its own, as `JiraBandSub` does, so its `polled` age moves
 * without re-rendering every card; the totals are a walk over the issues (up to 500) against an index built once per payload.
 */
export function GitlabBandLine({ issues }: { issues: readonly JiraIssue[] }) {
  const index = useDeliveryIndex();
  const now = useNow(index !== null, 1_000);
  if (index === null) return null;
  const line = bandTotals(issues, index, now);
  if (line === null) return null;
  return <span className="jira-band-gitlab">{line}</span>;
}
