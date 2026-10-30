import { Pill } from '../ui/Pill';
import { PrActions } from './PrActions';
import { PrOutcomeLine } from './PrOutcomeLine';
import { prChips, type PrOutcome } from '../../lib/prs';
import type { PrRepoView, PrWriteResult, PullRequestRow } from '../../../../shared/types';

/**
 * One open pull request on GitHub › PRs (.claude/DESIGN.md §8.11, "Row anatomy").
 *
 * Reads, top to bottom: `#<n>` (a link to github.com, in a new tab — the page manages the PR, it does not replace GitHub's view of it) and the title; the
 * author and `head → base`; the state chips (`prChips`) and, when something on this machine or another is still working the branch, the warn-toned
 * warning (`prRunWarning`, derived by the page and handed in) — a warning, never a refusal, so every action stays as enabled as it would be without it; the
 * three actions; and one outcome line.
 *
 * The actions strip and the outcome line are `PrActions` and `PrOutcomeLine` — the same two Inbox and Matrix draw — so a blocked action's reason (`.prs-why`,
 * `aria-describedby`), the inline merge `Confirm`, and the disabled-while-a-write-is-in-flight rule live there, once. The write and its outcome are the
 * page's (`onWrite`), so an outcome outlives a row the re-read removed — a merged PR leaves the open list, and `PullRequestsView` keeps its line.
 */
export function PrRow({
  repo,
  pr,
  warning,
  outcome,
  updating,
  onWrite,
  busy
}: {
  repo: PrRepoView;
  pr: PullRequestRow;
  /** `prRunWarning`'s reading for this PR, or `null`. */
  warning: string | null;
  outcome: PrOutcome | undefined;
  /** `isUpdating` for this PR's mark — the page owns the mark and its clock. */
  updating: boolean;
  /** Runs one write for this PR and resolves once its outcome is recorded and the page has re-read. Never rejects. */
  onWrite: (call: () => Promise<PrWriteResult>) => Promise<void>;
  /** The page's in-flight set says a write of this PR is running (`PrActions`' `busy`), so a row drawn after a layout switch is born disabled. */
  busy?: boolean;
}) {
  const key = `${repo.repo}#${pr.number}`;

  return (
    <li className="prs-row" data-testid={`pr-row-${key}`}>
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
      </div>
      {(prChips(pr).length > 0 || warning !== null) && (
        <div className="prs-chips">
          {prChips(pr).map((chip) => (
            <Pill key={chip.label} tone={chip.tone}>
              {chip.label}
            </Pill>
          ))}
          {warning !== null && <Pill tone="warn">{warning}</Pill>}
        </div>
      )}
      {/* `onMerge` reaches nothing from here: the merge Confirm is page state (`PrLayoutProps.confirming`) that this row is not handed. */}
      <PrActions repo={repo} pr={pr} updating={updating} outcome={outcome} busy={busy === true} onMerge={() => undefined} onWrite={onWrite} />
      <PrOutcomeLine outcome={outcome} updating={updating} />
    </li>
  );
}
