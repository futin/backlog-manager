import { Chip } from '../ui/Chip';
import { useSettings } from '../../hooks/useSettings';
import { sessionUrl } from '../../lib/agents';
import { shownOutcome } from '../../lib/pr-resolve';
import type { PrResolveState, PullRequestRow } from '../../../../shared/types';

/**
 * The resolve status line under a pull request's key strip (.claude/DESIGN.md §8.11, "Actions and their reasons"; spec
 * 2026-11-17-pr-conflict-resolve-design.md, "The board"). `PrActions` draws it as a sibling of the why-line, so it reads the same in Inbox, Matrix and Cards
 * without a layout knowing it exists.
 *
 * It says the one thing a person cannot see on GitHub: what the last Resolve conflicts session did.
 *  - **live** — a `resolving…` chip, a link to the session (`sessionUrl` on the Settings `linkBase`, as the launch sheet builds it) once the spawn has
 *    answered with an id, plain while it has not (`live.sessionId` is `null` between the POST and the dashboard's answer). Live wins over an outcome: a
 *    second session's state is the one that is true now.
 *  - **pushed** — a `resolved — waiting for GitHub` chip, while `shownOutcome` still holds it: GitHub has not seen the push yet, or has not finished
 *    re-computing mergeability. Not a link; there is nothing left to watch in the session.
 *  - **stopped** — `resolve stopped: <reason>` as a line of text (the why-line's look, `.prs-why`), and a ` session ↗` text link when the session is known,
 *    because a stop is the case where a person wants to read what happened.
 *  - **up-to-date**, an outcome for another head, or nothing — no line at all: an up-to-date base has nothing worth a line, and an outcome about another head
 *    is about a PR that no longer exists (`shownOutcome`).
 *
 * Which outcome still shows is `shownOutcome`'s call, never re-derived here (`.claude/rules/board.md`: every derivation has one home in `lib/`). The status
 * chips are `Chip`s because the look is the board's chip and has one home; the non-link ones are `as="label"`, the only non-button shape `Chip` offers that
 * is not a link, so a status never reads as a control.
 */
export function PrResolveLine({ pr, state }: { pr: PullRequestRow; state: PrResolveState | undefined }) {
  const { settings } = useSettings();
  if (state === undefined) return null;

  if (state.live !== null) {
    const id = state.live.sessionId;
    return (
      <div data-testid="pr-resolve">
        {id === null ? (
          <Chip as="label" size={28}>
            resolving…
          </Chip>
        ) : (
          <Chip as="a" size={28} href={sessionUrl(settings.linkBase, id)} title="Open the resolve session">
            resolving…
          </Chip>
        )}
      </div>
    );
  }

  const outcome = shownOutcome(pr, state.outcome);
  if (outcome === null || outcome.outcome === 'up-to-date') return null;
  if (outcome.outcome === 'pushed') {
    return (
      <div data-testid="pr-resolve">
        <Chip as="label" size={28}>
          resolved — waiting for GitHub
        </Chip>
      </div>
    );
  }
  return (
    <p className="prs-why" data-testid="pr-resolve">
      {`resolve stopped: ${outcome.reason}`}
      {outcome.sessionId !== null && (
        <>
          {' '}
          <a className="prs-textlink" href={sessionUrl(settings.linkBase, outcome.sessionId)} target="_blank" rel="noreferrer">
            session ↗
          </a>
        </>
      )}
    </p>
  );
}
