import type { PrOutcome } from '../../lib/prs';

/**
 * The one line a finished write leaves under a pull request (.claude/DESIGN.md §8.11, "Row anatomy"; spec `2026-10-29-prs-layouts-design.md`, "Writes and
 * outcomes"). It is its own component because every layout that draws a PR — Cards' row, Inbox's item, Matrix's expanded row — shows the same line, and a
 * line each of them re-derived would be one more place to forget the `updating` rule.
 *
 * An `updating` outcome ("updating…") is a promise that GitHub is still merging base into head, so it is shown only while the page's mark says it is
 * (`updating`, the mark's presence) and drops out the moment the page drops the mark — a read that judged the update, or the timer's one re-read; every other outcome stays
 * until the next write on that PR leaves, which clears it. The write and its outcome belong to the page (`PullRequestsView`), so the line outlives a row the re-read removed — this
 * component only draws what it is handed. An error keeps the server's own sentence, in the error colour: the board does not paraphrase GitHub's refusal.
 * `hasOutcomeLine` is that same test as a predicate, so a layout that wraps the line in a row of its own (Matrix) draws no empty row when the line draws
 * nothing. Nothing is rendered when there is no line, so a quiet row does not carry an empty `role="status"` region.
 */
export function hasOutcomeLine(outcome: PrOutcome | undefined, updating: boolean): outcome is PrOutcome {
  return outcome !== undefined && !(outcome.kind === 'updating' && !updating);
}

export function PrOutcomeLine({ outcome, updating }: { outcome: PrOutcome | undefined; updating: boolean }) {
  if (!hasOutcomeLine(outcome, updating)) return null;
  return (
    <p className={outcome.kind === 'error' ? 'prs-outcome prs-outcome-error' : 'prs-outcome'} data-testid="pr-outcome" role="status">
      {outcome.text}
    </p>
  );
}
