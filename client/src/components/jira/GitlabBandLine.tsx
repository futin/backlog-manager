import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import { useNow } from '../../hooks/useNow';
import { bandTotals } from '../../lib/delivery';
import type { JiraIssue } from '../../../../shared/types';

/**
 * The Board band's GitLab line (GitLab connection spec §7.2, mock `Cards.dc.html`; DESIGN.md §8.9.1, the band): `GitLab: 3 open · 1 failing · 1 merged ·
 * polled 2m ago`, a second line under the board's own sub-line. The words are `bandTotals`' alone — over the TOPS the page shows after its filters, each top's
 * lead MR, the oldest `polledAt` — so the line cannot count an MR no card shows.
 *
 * Drawn only while delivery is shown at all (`useDeliveryIndex` is `null` otherwise) and while some top on the board maps a GitLab project (`bandTotals` is
 * `null` otherwise): an unconfigured GitLab leaves the band exactly as it was. It ticks on a clock of its own, as `JiraBandSub` does, so its `polled` age moves
 * without re-rendering every card; the totals are a walk over the tops (hundreds at most) against an index built once per payload.
 */
export function GitlabBandLine({ tops }: { tops: readonly JiraIssue[] }) {
  const index = useDeliveryIndex();
  const now = useNow(index !== null, 1_000);
  if (index === null) return null;
  const line = bandTotals(tops, index, now);
  if (line === null) return null;
  return <span className="jira-band-gitlab">{line}</span>;
}
