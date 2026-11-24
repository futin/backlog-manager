import { Dot } from '../ui/Dot';
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
 *  - **live** — `resolving…` behind a breathing `live` dot, and a ` session ↗` text link (`sessionUrl` on the Settings `linkBase`, as the launch sheet builds
 *    it) once the spawn has answered with an id, no link while it has not (`live.sessionId` is `null` between the POST and the dashboard's answer). Live wins
 *    over an outcome: a second session's state is the one that is true now.
 *  - **pushed** — `resolved — waiting for GitHub` behind a `done` dot, while `shownOutcome` still holds it: GitHub has not seen the push yet, or has not
 *    finished re-computing mergeability. No link; there is nothing left to watch in the session.
 *  - **stopped** — `resolve stopped: <reason>`, and a ` session ↗` text link when the session is known, because a stop is the case where a person wants to
 *    read what happened.
 *  - **up-to-date**, an outcome for another head, or nothing — no line at all: an up-to-date base has nothing worth a line, and an outcome about another head
 *    is about a PR that no longer exists (`shownOutcome`).
 *
 * Which outcome still shows is `shownOutcome`'s call, never re-derived here (`.claude/rules/board.md`: every derivation has one home in `lib/`). Every shape
 * is a line of text in the why-line's look (`.prs-why`), never a `Chip`: the line sits right under the Merge split and the Open icon, and a 28 px outline
 * chip there read as one more button even as a `<label>` (user report, 2026-11-24). A state draws as a dot and a word, as the Jira card's status does
 * (§8.9), and the one thing to click is the `session ↗` text link. The dot is `aria-hidden`, so the line still reads as its words alone.
 *
 * Every shape carries `role="status"`, as `PrOutcomeLine` does: a Resolve click that stood records no outcome line by design, so this line appearing is the
 * click's only answer, and a screen reader has to hear it. The region mounts only when there is something to say, so a quiet PR carries no empty one.
 */
export function PrResolveLine({ pr, state }: { pr: PullRequestRow; state: PrResolveState | undefined }) {
  const { settings } = useSettings();
  if (state === undefined) return null;

  const sessionLink = (id: string | null) =>
    id !== null && (
      <>
        {' '}
        <a className="prs-textlink" href={sessionUrl(settings.linkBase, id)} target="_blank" rel="noreferrer">
          session ↗
        </a>
      </>
    );

  if (state.live !== null) {
    return (
      <p className="prs-why prs-resolve-note prs-resolve-state" data-testid="pr-resolve" role="status">
        <Dot tone="live" breathe />
        <span>
          resolving…
          {sessionLink(state.live.sessionId)}
        </span>
      </p>
    );
  }

  const outcome = shownOutcome(pr, state.outcome);
  if (outcome === null || outcome.outcome === 'up-to-date') return null;
  if (outcome.outcome === 'pushed') {
    return (
      <p className="prs-why prs-resolve-note prs-resolve-state" data-testid="pr-resolve" role="status">
        <Dot tone="done" />
        <span>resolved — waiting for GitHub</span>
      </p>
    );
  }
  return (
    <p className="prs-why prs-resolve-note" data-testid="pr-resolve" role="status">
      {`resolve stopped: ${outcome.reason}`}
      {sessionLink(outcome.sessionId)}
    </p>
  );
}
