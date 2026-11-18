import { useNow } from '../../hooks/useNow';
import { bandSub } from '../../lib/jira';
import { Pill } from '../ui/Pill';
import { PollAge } from '../ui/PollAge';
import type { JiraBoardStatus } from '../../../../shared/types';

/**
 * Shared by Jira › Board and Jira › Sessions (DESIGN.md §8.9.1, the band: the sub-line says where the data came from and what is wrong with it).
 *
 * Mock A, "fact pills" (2026-11-18): the site as a quiet word, each count a neutral `Pill`, Jira's failure — when the last sweep had one — as the one red pill,
 * then the board's freshness as a toned dot and its age (`PollAge`, the shell Jira chip's rule). The red lives on the failure pill and the dot alone, so the
 * counts beside them keep reading as counts. The full sentence `bandSub` still builds rides on the row's `title`: hover gets the old line back whole, and it is
 * what the tests read.
 *
 * On its own one-second clock: `12 s ago` needs seconds, and ticking the whole page for it would re-render every card once a second for a date that changes
 * once a day.
 */
export function JiraBandSub({ board, site, counts }: { board: JiraBoardStatus; site: string; counts: { issues: number; parents: number } | null }) {
  const now = useNow(true, 1_000);
  const sub = bandSub(board, site, now, counts);
  return (
    <span className="jira-band-sub jira-band-row" title={sub.text}>
      {sub.site !== '' && <span className="jira-band-site">{sub.site}</span>}
      {sub.facts.map((fact) => (
        <Pill key={fact} raised>{fact}</Pill>
      ))}
      {sub.failure !== null && (
        <Pill tone="bad" title={sub.failure}>
          <span className="jira-band-failure">{sub.failure}</span>
        </Pill>
      )}
      <PollAge tone={sub.tone} age={sub.age} polled={sub.polled} />
    </span>
  );
}
