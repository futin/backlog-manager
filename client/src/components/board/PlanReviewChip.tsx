import { planReviewReading, planReviewTitle } from '../../lib/plan-review';
import type { PlanReviewTally } from '../../lib/plan-review';
import { Dot } from '../ui/Dot';

/**
 * PlanReviewChip — the band's `N plans awaiting review` reading (#367) and the Board's way into that pile (#387), placed right after `RunChip` (.claude/DESIGN.md §8.3).
 *
 * A tick grooms only while fewer plans carry the `plan-review` mark than its `--max-plans` cap, so a backlog of unread plans stops grooming silently: the
 * tick answers `idle` and nothing on the board said why. This is that reading, on the surface where the plans are read. Scoped to the picked project it
 * reads `count/cap` once a tick has recorded its caps for that project (`lastDecide`), and the bare count before one has; across all projects it reads the
 * summed count and names every project whose tick is blocked. The arithmetic is `lib/plan-review.ts`'s; this file only draws it.
 *
 * A control since #387: a click flips the Board's `Awaiting review` filter — on when off, off when on — which narrows the board to exactly the items this
 * chip counts (`awaitsPlanReview`), and leaves the project scope as it is. So it is RunChip's button, with RunChip's affordance and `›` mark, and is
 * `aria-pressed` while that filter is on; the Filters panel's `Plan review` › `Awaiting review` chip is the same state, so the two entry points can never
 * disagree. The mark is `aria-hidden`, so the button's accessible name is the reading alone. The dot is the paused tone while any project is at its cap —
 * work is waiting on a person, the same reading a paused run gives — and toneless otherwise.
 *
 * Absent when there is nothing to say, for the reason RunChip gives: a chip reading `0 plans` is a permanent invitation to look at nothing. That holds with
 * the filter on, too: approve the last plan in the pile and the chip vanishes while the filter stays on, over an empty board. The way back is the one every
 * other filter has — the panel's chip, the Filters badge, `Clear all` — not a chip kept alive to read `0`.
 */
export function PlanReviewChip({
  tallies,
  projectValue,
  pressed,
  onToggle
}: {
  tallies: readonly PlanReviewTally[];
  projectValue: string | null;
  /** Whether the Board's `Awaiting review` filter is on. */
  pressed: boolean;
  onToggle: () => void;
}) {
  const reading = planReviewReading(tallies, projectValue);
  if (reading === null) return null;
  const scoped = projectValue === null ? tallies : tallies.filter((t) => t.projectPath === projectValue);
  const blocked = scoped.some((t) => t.blocked);
  return (
    <button
      type="button"
      className="board-plan-chip"
      data-testid="plan-review-chip"
      title={planReviewTitle(tallies)}
      aria-pressed={pressed}
      onClick={onToggle}
    >
      {blocked ? <Dot tone="paused" /> : <Dot />}
      <span className="board-run-chip-line">{reading}</span>
      <span className="board-run-chip-mark" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
