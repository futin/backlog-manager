import { GlyphTile } from '../ui/GlyphTile';
import { Pill } from '../ui/Pill';
import { Sheet, SheetHead } from '../ui/Sheet';
import { PrRow } from './PrRow';
import { PrRepoNotes } from './PrRepoNotes';
import { useNow } from '../../hooks/useNow';
import type { PrLayoutProps } from './pr-layout-props';
import { cardRepos, checksGlyph, checksTone, departedOutcomes, transientFailures } from '../../lib/pr-layouts';
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

/** Worst first: a card's tile is the checks tone of its sickest row, so a repo with one failing PR reads red before a person opens it. */
const WORST: readonly PullRequestRow['checks'][] = ['failure', 'pending', 'unknown', 'none', 'success'];
function worstChecks(prs: readonly PullRequestRow[]): PullRequestRow['checks'] {
  return WORST.find((c) => prs.some((p) => p.checks === c)) ?? 'none';
}

/**
 * One repo's card: its head (a tile in its worst row's checks tone, the repo, an `N open` pill, the poll age) and its rows (`PrRow`, the anatomy Inbox
 * shares, minus the repo name the head already says), plus a line for each PR a write of this page took off the list (.claude/DESIGN.md §8.11, "Repo
 * heading" and "Row anatomy"). The departed rule is `departedOutcomes'` — the same function Inbox and Matrix's notes call — so the rule that keeps `#12 merged` on the page after
 * its row is gone has one home. A card is drawn only for a repo `cardRepos` keeps, so it never says `no open pull requests`; and a repo that could not be read
 * says so once, in the `Can't read` line under the cards, not in red inside its own.
 */
function RepoSheet(props: PrLayoutProps & { repo: PrRepoView }) {
  const { repo, outcomes } = props;
  const departed = departedOutcomes(outcomes, [repo]);
  const worst = worstChecks(repo.prs);

  return (
    <Sheet as="section" className="prs-repo">
      <div className="prs-repo-inner" data-testid={`pr-repo-${repo.repo}`}>
        <div className="prs-repo-head" data-testid={`pr-head-${repo.repo}`}>
          <SheetHead
            title={
              <span className="prs-repo-title">
                <GlyphTile glyph={checksGlyph(worst)} tone={checksTone(worst)} size={32} />
                <span>{repo.repo}</span>
              </span>
            }
            sub={
              <span className="prs-repo-sub">
                <PolledAge polledAt={repo.polledAt} />
                {repo.truncated && <span>{`showing ${repo.prs.length} of ${repo.total}`}</span>}
              </span>
            }
            right={
              <span className="prs-repo-pills">
                {repo.prs.length > 0 && <Pill>{`${repo.prs.length} open`}</Pill>}
                {repo.syncOff !== null && <Pill tone="warn">sync off</Pill>}
              </span>
            }
          />
          {repo.syncOff !== null && <p className="prs-note">{repo.syncOff}</p>}
        </div>
        {repo.prs.length > 0 && (
          <ul className="prs-list" aria-label={`${repo.repo} pull requests`}>
            {repo.prs.map((pr) => (
              <PrRow key={pr.number} repo={repo} pr={pr} props={props} />
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
 * lists `emptyRepoNote` guards on, so the sentence and the count never both draw.
 */
export function PrCards(props: PrLayoutProps) {
  const cards = cardRepos(props.repos, props.outcomes);
  if (cards.length === 0 && transientFailures(props.repos).length === 0) return <p className="prs-status">no open pull requests</p>;
  return (
    <>
      {cards.map((repo) => (
        <RepoSheet key={repo.repo} {...props} repo={repo} />
      ))}
      <PrRepoNotes repos={props.repos} outcomes={props.outcomes} part="failures" />
    </>
  );
}
