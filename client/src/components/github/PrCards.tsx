import { Pill } from '../ui/Pill';
import { Sheet, SheetHead } from '../ui/Sheet';
import { PrActions } from './PrActions';
import { PrFoot } from './PrFoot';
import { PrRepoNotes } from './PrRepoNotes';
import { useNow } from '../../hooks/useNow';
import type { PrLayoutProps } from './pr-layout-props';
import { ageText, cardRepos, departedOutcomes, transientFailures } from '../../lib/pr-layouts';
import { prRunWarning } from '../../lib/pr-run';
import { prChips } from '../../lib/prs';
import { pollAge } from '../../lib/tracker';
import type { PrRepoView, PrWriteResult, PullRequestRow } from '../../../../shared/types';

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
 * One open pull request in a card (.claude/DESIGN.md §8.11, "Row anatomy"), in the row vocabulary Inbox and Matrix share: `#<n>` (a link to github.com, in a
 * new tab) and the title; `author · head → base · age` — the age because Cards has no Updated column; the state chips (`prChips`) with the run warning
 * (`prRunWarning`) among them, warn-toned and never a refusal; then the foot (`PrFoot`: the merge Confirm and the outcome line). The key strip (`PrActions`)
 * is the row's side, so a blocked key's reason and the busy rule live there once. The Confirm is page state (`PrLayoutProps.confirming`), one per page.
 */
function CardRow({ repo, pr, props }: { repo: PrRepoView; pr: PullRequestRow; props: PrLayoutProps }) {
  const key = `${repo.repo}#${pr.number}`;
  // The mark's presence, not its clock: `Update` frees, and `updating…` leaves the row, only when the page's timer has judged the re-read.
  const updating = props.marks[key] !== undefined;
  const outcome = props.outcomes[key];
  const warning = prRunWarning(pr, repo.repo, props.ctx, props.now);
  const age = ageText(pr.updatedAt, props.now);
  const chips = prChips(pr);
  const write = (call: () => Promise<PrWriteResult>) => props.write(key, pr.headSha, call);
  return (
    <li className="prs-row" data-testid={`pr-row-${key}`}>
      <div className="prs-row-main">
        <div className="prs-row-title">
          <a className="prs-num" href={pr.url} target="_blank" rel="noreferrer noopener">
            #{pr.number}
          </a>
          <span className="prs-title">{pr.title}</span>
        </div>
        <div className="prs-meta">
          <span>{pr.author ?? 'ghost'}</span>
          <span aria-hidden="true">·</span>
          <span className="prs-branches">{`${pr.head} → ${pr.base}`}</span>
          {age !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{age}</span>
            </>
          )}
        </div>
        {(chips.length > 0 || warning !== null) && (
          <div className="prs-chips">
            {chips.map((chip) => (
              <Pill key={chip.label} tone={chip.tone}>
                {chip.label}
              </Pill>
            ))}
            {warning !== null && <Pill tone="warn">{warning}</Pill>}
          </div>
        )}
        <PrFoot
          repo={repo}
          pr={pr}
          outcome={outcome}
          updating={updating}
          confirming={props.confirming === key}
          onDismiss={() => props.setConfirming(null)}
          onWrite={write}
        />
      </div>
      <PrActions
        repo={repo}
        pr={pr}
        updating={updating}
        outcome={outcome}
        busy={props.inFlight.has(key)}
        onMerge={() => props.setConfirming(key)}
        onWrite={write}
      />
    </li>
  );
}

/**
 * One repo's card: its heading and its rows, plus a line for each PR a write of this page took off the list (.claude/DESIGN.md §8.11, "Repo heading" and "Row
 * anatomy"). The departed rule is `departedOutcomes'` — the same function Inbox and Matrix's notes call — so the rule that keeps `#12 merged` on the page after
 * its row is gone has one home. A card is drawn only for a repo `cardRepos` keeps, so it never says `no open pull requests`; and a repo that could not be read
 * says so once, in the `Can't read` line under the cards, not in red inside its own.
 */
function RepoSheet(props: PrLayoutProps & { repo: PrRepoView }) {
  const { repo, outcomes } = props;
  const departed = departedOutcomes(outcomes, [repo]);

  return (
    <Sheet as="section" className="prs-repo">
      <div className="prs-repo-inner" data-testid={`pr-repo-${repo.repo}`}>
        <div className="prs-repo-head" data-testid={`pr-head-${repo.repo}`}>
          <SheetHead
            title={repo.repo}
            sub={
              <span className="prs-repo-sub">
                <PolledAge polledAt={repo.polledAt} />
                {repo.truncated && <span>{`showing ${repo.prs.length} of ${repo.total}`}</span>}
              </span>
            }
            right={repo.syncOff !== null ? <Pill tone="warn">sync off</Pill> : undefined}
          />
          {repo.syncOff !== null && <p className="prs-note">{repo.syncOff}</p>}
        </div>
        {repo.prs.length > 0 && (
          <ul className="prs-list" aria-label={`${repo.repo} pull requests`}>
            {repo.prs.map((pr) => (
              <CardRow key={pr.number} repo={repo} pr={pr} props={props} />
            ))}
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
