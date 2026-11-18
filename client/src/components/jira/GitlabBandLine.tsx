import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import { useNow } from '../../hooks/useNow';
import { bandDelivery } from '../../lib/delivery';
import { Glyph } from '../ui/Glyphs';
import { Pill } from '../ui/Pill';
import { PollAge } from '../ui/PollAge';
import type { JiraIssue } from '../../../../shared/types';

/**
 * The Board band's GitLab half (GitLab connection spec §7.2; DESIGN.md §8.9.1, the band; mock A "fact pills", 2026-11-18): on the Jira half's row, after a
 * divider — the merge glyph, a pill per non-zero count (`open`, `failing` in red, `merged`), then GitLab's own dot and age. The counts are `bandDelivery`'s
 * alone — over the ISSUES the page's filters match (every card and on-board lane header a filter leaves, parent-lanes spec §6.2), each issue's lead MR, the
 * oldest `polledAt` — so a filter narrows them with the lanes, and they count no MR outside what the filters match — a card in a folded lane or past a cell's
 * `+ N more` cut still counts. The old sentence, `GitLab: 3 open · 1 failing · 1 merged · polled 2m ago`, rides on the half's `title`.
 *
 * Drawn only while delivery is shown at all (`useDeliveryIndex` is `null` otherwise) and while some matching issue maps a GitLab project (`bandDelivery` is
 * `null` otherwise): an unconfigured GitLab leaves the band exactly as it was. It ticks on a clock of its own, as `JiraBandSub` does, so its age moves without
 * re-rendering every card; the totals are a walk over the issues (up to 500) against an index built once per payload.
 */
export function GitlabBandLine({ issues }: { issues: readonly JiraIssue[] }) {
  const index = useDeliveryIndex();
  const now = useNow(index !== null, 1_000);
  if (index === null) return null;
  const delivery = bandDelivery(issues, index, now);
  if (delivery === null) return null;
  return (
    <span className="jira-band-gitlab" title={delivery.text}>
      <span className="jira-band-sep" aria-hidden="true" />
      <Glyph name="merge" />
      <span className="sr-only">GitLab</span>
      {delivery.parts.map((part) => (
        <Pill key={part.word} tone={part.word === 'failing' ? 'bad' : 'neutral'} raised={part.word !== 'failing'}>{`${part.n} ${part.word}`}</Pill>
      ))}
      {delivery.parts.length === 0 && delivery.age !== null && <span className="jira-band-quiet">no merge requests</span>}
      <PollAge tone={delivery.tone} age={delivery.age} polled={delivery.polled} />
    </span>
  );
}
