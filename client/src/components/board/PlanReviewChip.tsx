import { planReviewReading, planReviewTitle } from '../../lib/plan-review';
import type { PlanReviewTally } from '../../lib/plan-review';
import { Dot } from '../ui/Dot';

/**
 * PlanReviewChip — the band's `N plans awaiting review` reading (#367), placed right after `RunChip` (.claude/DESIGN.md §8.3).
 *
 * A tick grooms only while fewer plans carry the `plan-review` mark than its `--max-plans` cap, so a backlog of unread plans stops grooming silently: the
 * tick answers `idle` and nothing on the board said why. This is that reading, on the surface where the plans are read. Scoped to the picked project it
 * reads `count/cap` once a tick has recorded its caps for that project (`lastDecide`), and the bare count before one has; across all projects it reads the
 * summed count and names every project whose tick is blocked. The arithmetic is `lib/plan-review.ts`'s; this file only draws it.
 *
 * A static reading, not a control: it opens nothing, so it is a `span`, not RunChip's button, and carries no `›` mark. The dot is the paused tone while
 * any project is at its cap — work is waiting on a person, the same reading a paused run gives — and toneless otherwise. Absent when there is nothing to
 * say, for the reason RunChip gives: a chip reading `0 plans` is a permanent invitation to look at nothing.
 */
export function PlanReviewChip({ tallies, projectValue }: { tallies: readonly PlanReviewTally[]; projectValue: string | null }) {
  const reading = planReviewReading(tallies, projectValue);
  if (reading === null) return null;
  const scoped = projectValue === null ? tallies : tallies.filter((t) => t.projectPath === projectValue);
  const blocked = scoped.some((t) => t.blocked);
  return (
    <span className="board-plan-chip" data-testid="plan-review-chip" title={planReviewTitle(tallies)}>
      {blocked ? <Dot tone="paused" /> : <Dot />}
      <span className="board-run-chip-line">{reading}</span>
    </span>
  );
}
