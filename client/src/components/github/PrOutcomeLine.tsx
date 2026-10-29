import type { PrOutcome } from '../../lib/prs';

/**
 * The one line a finished write leaves under a pull request (.claude/DESIGN.md §8.11, "Row anatomy"; spec `2026-10-29-prs-layouts-design.md`, "Writes and
 * outcomes"). It is its own component because every layout that draws a PR — Cards' row, Inbox's item, Matrix's expanded row — shows the same line, and a
 * line each of them re-derived would be one more place to forget the `updating` rule.
 *
 * An `updating` outcome ("updating…") is a promise that GitHub is still merging base into head, so it is shown only while the page's mark says it is
 * (`updating`, `isUpdating` in `lib/prs.ts`) and drops out the moment the mark expires or a re-read shows the PR no longer behind; every other outcome stays
 * until the next write replaces it. The write and its outcome belong to the page (`PullRequestsView`), so the line outlives a row the re-read removed — this
 * component only draws what it is handed. An error keeps the server's own sentence, in the error colour: the board does not paraphrase GitHub's refusal.
 * Nothing is rendered when there is no line, so a quiet row does not carry an empty `role="status"` region.
 */
export function PrOutcomeLine({ outcome, updating }: { outcome: PrOutcome | undefined; updating: boolean }) {
  if (outcome === undefined || (outcome.kind === 'updating' && !updating)) return null;
  return (
    <p className={outcome.kind === 'error' ? 'prs-outcome prs-outcome-error' : 'prs-outcome'} data-testid="pr-outcome" role="status">
      {outcome.text}
    </p>
  );
}
