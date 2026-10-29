import { PrRow } from './PrRow';
import { Pill } from '../ui/Pill';
import { Sheet, SheetHead } from '../ui/Sheet';
import { useNow } from '../../hooks/useNow';
import type { PrLayoutProps } from './pr-layout-props';
import { departedOutcomes } from '../../lib/pr-layouts';
import { prRunWarning } from '../../lib/pr-run';
import { isUpdating } from '../../lib/prs';
import { pollAge } from '../../lib/tracker';
import type { PrRepoView } from '../../../../shared/types';

/**
 * `polled 12 s ago`, on a one-second clock of its own: the age is the only reading on the page that moves every second, so it owns its own `useNow` and
 * re-renders a span, not every row of every repo. Exported because the page's toolbar draws the newest shown repo's age with it.
 */
export function PolledAge({ polledAt }: { polledAt: string | null }) {
  const now = useNow(polledAt !== null, 1_000);
  const age = pollAge(polledAt, now);
  return age === null ? null : <span>{`polled ${age} ago`}</span>;
}

/**
 * One repo's card: its heading and its rows, plus a line for each PR a write of this page took off the list (.claude/DESIGN.md §8.11, "Repo heading" and "Row
 * anatomy"). The departed rule is `departedOutcomes`' — the same function Inbox and Matrix's notes call — so the rule that keeps `#12 merged` on the page after
 * its row is gone has one home.
 */
function RepoSheet({ repo, outcomes, marks, now, ctx, write, inFlight }: PrLayoutProps & { repo: PrRepoView }) {
  const departed = departedOutcomes(outcomes, [repo]);
  const readings = [
    repo.truncated ? `showing ${repo.prs.length} of ${repo.total}` : null,
    repo.polledAt !== null && repo.prs.length === 0 ? 'no open pull requests' : null
  ].filter((r): r is string => r !== null);

  return (
    <Sheet as="section" className="prs-repo">
      <div className="prs-repo-inner" data-testid={`pr-repo-${repo.repo}`}>
        <div className="prs-repo-head" data-testid={`pr-head-${repo.repo}`}>
          <SheetHead
            title={repo.repo}
            sub={
              <span className="prs-repo-sub">
                <PolledAge polledAt={repo.polledAt} />
                {readings.map((r) => (
                  <span key={r}>{r}</span>
                ))}
              </span>
            }
            right={repo.syncOff !== null ? <Pill tone="warn">sync off</Pill> : undefined}
          />
          {repo.syncOff !== null && <p className="prs-note">{repo.syncOff}</p>}
          {repo.access !== 'ok' && repo.detail !== null && <p className="prs-note prs-note-bad">{repo.detail}</p>}
        </div>
        {repo.prs.length > 0 && (
          <ul className="prs-list" aria-label={`${repo.repo} pull requests`}>
            {repo.prs.map((pr) => {
              const key = `${repo.repo}#${pr.number}`;
              return (
                <PrRow
                  key={pr.number}
                  repo={repo}
                  pr={pr}
                  warning={prRunWarning(pr, repo.repo, ctx, now)}
                  outcome={outcomes[key]}
                  updating={isUpdating(marks[key], pr, now)}
                  onWrite={(call) => write(key, pr.headSha, call)}
                  busy={inFlight.has(key)}
                />
              );
            })}
          </ul>
        )}
        {departed.map(({ key, outcome }) => (
          <p key={key} className={outcome.kind === 'error' ? 'prs-outcome prs-outcome-error' : 'prs-outcome'}>
            {`#${key.slice(repo.repo.length + 1)} ${outcome.text}`}
          </p>
        ))}
      </div>
    </Sheet>
  );
}

/** GitHub › PRs, Cards layout (.claude/DESIGN.md §8.11; spec `2026-10-29-prs-layouts-design.md`, "Cards"): today's one card per repo, minus no-access repos. */
export function PrCards(props: PrLayoutProps) {
  return (
    <>
      {props.repos.map((repo) => (
        <RepoSheet key={repo.repo} {...props} repo={repo} />
      ))}
    </>
  );
}
