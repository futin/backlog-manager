import { GlyphTile } from '../ui/GlyphTile';
import { Pill } from '../ui/Pill';
import { Sheet, SheetHead } from '../ui/Sheet';
import { PrRow } from './PrRow';
import { PrRepoNotes } from './PrRepoNotes';
import { useNow } from '../../hooks/useNow';
import type { PrLayoutProps } from './pr-layout-props';
import { cardRepos, departedOutcomes, repoShortName, transientFailures } from '../../lib/pr-layouts';
import { parsePrKey } from '../../lib/prs';
import { pollAge } from '../../lib/tracker';
import type { PrRepoView, PullRequestRow } from '../../../../shared/types';

/**
 * `polled 12 s ago`, on a one-second clock of its own: the age is the only reading on the page that moves every second, so it owns its own `useNow` and
 * re-renders a span, not every row of every repo. Cards' repo heads draw it; the page's band says the newest shown repo's age through `PrBandSub`, which reads
 * the same `pollAge`.
 */
export function PolledAge({ polledAt }: { polledAt: string | null }) {
  const now = useNow(polledAt !== null, 1_000);
  const age = pollAge(polledAt, now);
  return age === null ? null : <span>{`polled ${age} ago`}</span>;
}

/**
 * One repo's card: its head (a dark repo tile, the short repo name, an `N open` pill, and the poll age at the trailing edge) and its rows (`PrRow`, the anatomy Inbox
 * shares, minus the repo name the head already says), plus a line for each PR a write of this page took off the list (.claude/DESIGN.md §8.11, "Repo
 * heading" and "Row anatomy"). The departed rule is `departedOutcomes'` — the same function Inbox and Matrix's notes call — so the rule that keeps `#12 merged` on the page after
 * its row is gone has one home. A card is drawn only for a repo `cardRepos` keeps, so it never says `no open pull requests`; and a repo that could not be read
 * says so once, in the `Can't read` line under the cards, not in red inside its own.
 */
function RepoSheet(props: PrLayoutProps & { repo: PrRepoView; shown: readonly string[] }) {
  const { repo, outcomes, shown } = props;
  const departed = departedOutcomes(outcomes, [repo]);

  return (
    <Sheet as="section" className="prs-repo">
      <div className="prs-repo-inner" data-testid={`pr-repo-${repo.repo}`}>
        <div className="prs-repo-head" data-testid={`pr-head-${repo.repo}`}>
          <SheetHead
            title={
              <span className="prs-repo-title">
                <GlyphTile glyph="branch" tone="ink" size={28} />
                <span className="prs-repo-name">{repoShortName(repo.repo, shown)}</span>
                <span className="prs-repo-pills">
                  {repo.prs.length > 0 && <Pill>{`${repo.prs.length} open`}</Pill>}
                  {repo.syncOff !== null && <Pill tone="warn">sync off</Pill>}
                </span>
              </span>
            }
            right={
              <span className="prs-repo-trail">
                <PolledAge polledAt={repo.polledAt} />
                {repo.truncated && <span>{`showing ${repo.prs.length} of ${repo.total}`}</span>}
              </span>
            }
          />
          {repo.syncOff !== null && <p className="prs-note">{repo.syncOff}</p>}
        </div>
        {repo.prs.length > 0 && (
          <ul className="prs-list" aria-label={`${repo.repo} pull requests`}>
            {repo.prs.map((pr) => (
              <PrRow key={pr.number} repo={repo} pr={pr} props={props} tileSize={28} />
            ))}
          </ul>
        )}
        {departed.map(({ key, outcome }) => (
          <p key={key} className={outcome.kind === 'error' ? 'prs-outcome prs-outcome-error' : 'prs-outcome'}>
            {`#${parsePrKey(key)?.number} ${outcome.text}`}
          </p>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * GitHub › PRs, Cards layout (.claude/DESIGN.md §8.11; specs `2026-10-29-prs-layouts-design.md`, "Cards", and `2026-10-30-prs-page-fixes-design.md`): one card
 * per repo that has an open PR or a departed outcome to show (`cardRepos`), then the `Can't read` lines (`PrRepoNotes` `failures`). An empty repo is counted
 * in the toolbar's note instead of drawn as an empty card. When there is no card and no failure, the page says `no open pull requests` once — the same two
 * lists `emptyRepoNote` guards on, so the sentence and the count never both draw. The cards flow in `.prs-cards-grid` (two-up when the pane has room, one
 * column below); the `Can't read` lines stay outside it so a note is never a grid cell beside a card.
 */
export function PrCards(props: PrLayoutProps) {
  const cards = cardRepos(props.repos, props.outcomes);
  if (cards.length === 0 && transientFailures(props.repos).length === 0) return <p className="prs-status">no open pull requests</p>;
  const shown = cards.map((repo) => repo.repo);
  return (
    <>
      <div className="prs-cards-grid">
        {cards.map((repo) => (
          <RepoSheet key={repo.repo} {...props} repo={repo} shown={shown} />
        ))}
      </div>
      <PrRepoNotes repos={props.repos} outcomes={props.outcomes} part="failures" />
    </>
  );
}
