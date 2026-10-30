import { departedOutcomes, transientFailures } from '../../lib/pr-layouts';
import type { PrOutcome } from '../../lib/prs';
import type { PrRepoView } from '../../../../shared/types';

/**
 * The page-level notes Inbox and Matrix share (.claude/DESIGN.md §8.11, "What every layout carries"; specs `2026-10-29-prs-layouts-design.md` and
 * `2026-10-30-prs-page-fixes-design.md`). Cards says most of this in each repo's own card; the two list layouts have no card per repo, so these lines are drawn
 * once, here, and a layout that re-wrote them would be a second place to forget one.
 *
 * `part="above"` is what a person should read before the list: the outcome of every PR a write took off it (`a/x#12 merged` — `departedOutcomes`, because the
 * most important outcome on the page must not vanish with the row that earned it), and each sync-off repo's server sentence once (`repo.syncOff`, never a
 * client copy; every disabled action already says the short `sync off`). `part="below"` is each truncated repo's `<repo>: showing n of total` — the page says
 * what it left out rather than paginating, and a note under the list cannot be mistaken for a row — then each repo that could not be read, as one
 * `Can't read · <repo> — <detail>` line (`access` when the server gave no detail). That line used to be Inbox's own list and Matrix's muted table row; a repo
 * that failed is not a pull request, so it is never drawn as one, and the one home keeps the two layouts from spelling it twice.
 *
 * `part="failures"` is those `Can't read` lines alone, for Cards: its card head already says `showing n of total` and `sync off`, and its departed outcomes
 * stay in the card where the row was, so the only thing it has no place of its own for is a repo it could not read.
 *
 * An error outcome keeps the error colour, like the line under a row. Nothing is drawn when there is nothing to say.
 */
export function PrRepoNotes({
  repos,
  outcomes,
  part
}: {
  repos: readonly PrRepoView[];
  outcomes: Record<string, PrOutcome>;
  part: 'above' | 'below' | 'failures';
}) {
  if (part !== 'above') {
    const truncated = part === 'below' ? repos.filter((repo) => repo.truncated) : [];
    const failures = transientFailures(repos);
    if (truncated.length === 0 && failures.length === 0) return null;
    return (
      <div className="prs-notes">
        {truncated.map((repo) => (
          <p key={repo.repo} className="prs-notes-line" data-testid={`pr-truncated-${repo.repo}`}>
            {`${repo.repo}: showing ${repo.prs.length} of ${repo.total}`}
          </p>
        ))}
        {failures.map((repo) => (
          <p key={repo.repo} className="prs-notes-line" data-testid={`pr-cantread-${repo.repo}`}>
            {`Can't read · ${repo.repo} — ${repo.detail ?? repo.access}`}
          </p>
        ))}
      </div>
    );
  }
  const departed = departedOutcomes(outcomes, repos);
  const syncOff = repos.filter((repo) => repo.syncOff !== null);
  if (departed.length === 0 && syncOff.length === 0) return null;
  return (
    <div className="prs-notes">
      {departed.map(({ key, outcome }) => (
        <p
          key={key}
          className={outcome.kind === 'error' ? 'prs-notes-line prs-notes-error' : 'prs-notes-line'}
          role="status"
          data-testid={`pr-departed-${key}`}
        >
          {`${key} ${outcome.text}`}
        </p>
      ))}
      {syncOff.map((repo) => (
        <p key={repo.repo} className="prs-notes-line" data-testid={`pr-syncoff-${repo.repo}`}>
          {repo.syncOff}
        </p>
      ))}
    </div>
  );
}
