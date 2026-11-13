import { useAgents } from '../../hooks/useAgents';
import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { reviewButtonLabel, reviewRowText } from '../../lib/review-copy';
import { reviewHalf, reviewState } from '../../../../shared/review';
import type { GitlabMr, JiraIssue, JiraSessionsPayload, JiraStatusPayload, ReviewHalf } from '../../../../shared/types';
import { Glyph } from '../ui/Glyphs';

/**
 * ReviewRow — Jira Detail's CodeRabbit row under the delivery track (CodeRabbit review spec §5.2; mocks `opt-b-open.png` and `opt-b-none.png`; DESIGN.md
 * §8.9.2, Delivery track › Review step / CodeRabbit row). A hairline, then the state's sentence on a tint of its tone at the left and an ink `ui-split-28`
 * button with the play glyph at the right. The button is a lone half of the Run split — no chevron, since there is no menu behind it — and it opens the Run
 * launch sheet pre-set to the review action; it dispatches nothing itself (Task 8 owns the launch, this row only reports the pick through `onReview`).
 *
 * It acts on the LEAD MR only, the one the track draws: `Also:` MRs get no row. The row is absent where the sentence is (`reviewRowText` is `null` for
 * `reviewing`, `clean`, `unknown` and an unread review) and for a lead that is not open, which only this caller knows.
 *
 * **The button is hidden, not disabled,** where it can never work: no review candidate repo (`repos`, the lead's GitLab project view's local paths), agents
 * off or not yet answered (a board load must not flash a dead control), or no `onReview` to call. It is DISABLED, with a title naming the session, while the
 * live-session gate holds (`reviewGate`) — two sessions pushing one MR branch is the failure it prevents, and the server's 409s are the authority for what
 * this view cannot see (another tab's in-flight reservation).
 *
 * `useAgents` is read HERE and not in the pane, so a ticket whose row is absent mounts no poller for it.
 */

/** Whether a dashboard row's checkout is one of the candidates: the main checkout itself or one of its `.worktrees/` trees (how a Jira worktree is laid out). */
function inCandidate(path: string | undefined, repos: readonly string[]): boolean {
  return path !== undefined && repos.some((r) => path === r || path.startsWith(`${r}/`));
}

/**
 * The live-session gate (spec §5.2), as the sentence for a disabled button or `null` when nothing blocks. Two checks, ticket first:
 * - **On the ticket:** a live `run` link on the key, or any `status.live` entry for it (a `starting` reservation has no link yet) — the one-run gate `Run`
 *   applies. A `branch` or `manual` link on the key does not count here; the branch check catches it when it sits on the MR's branch.
 * - **On the branch:** a live link of any `how` whose stored `branch` is the MR's source branch in a candidate repo, or whose dashboard row is `working` or
 *   `question` on that branch in a candidate checkout.
 * The client sees only the links and rows it already reads; dispatch's 409 covers an in-flight reservation from another tab.
 */
export function reviewGate(
  issue: JiraIssue,
  mr: GitlabMr,
  repos: readonly string[],
  live: JiraStatusPayload['live'],
  links: JiraSessionsPayload['links']
): string | null {
  const open = links.filter((l) => l.endedAt === null);
  const onKey = live[issue.key] ?? open.find((l) => l.key === issue.key && l.how === 'run');
  if (onKey !== undefined) return `${onKey.name} is live on this ticket`;
  const onBranch = open.find(
    (l) =>
      (l.branch === mr.sourceBranch && repos.includes(l.repo)) ||
      (l.row !== null && (l.row.status === 'working' || l.row.status === 'question') && l.row.gitBranch === mr.sourceBranch && inCandidate(l.row.projectPath, repos))
  );
  return onBranch === undefined ? null : `${onBranch.name} is live on ${mr.sourceBranch}`;
}

export function ReviewRow({
  issue,
  lead,
  now,
  repos,
  onReview
}: {
  issue: JiraIssue;
  lead: GitlabMr;
  now: number;
  /** The review candidates: local repo paths mapped to the lead's GitLab project under the issue's Jira project (`GitlabProjectView.repos`). */
  repos: string[];
  /** The Run launch sheet's opener (Task 8). Absent, the row draws its sentence and no button. */
  onReview?: (half: ReviewHalf, mr: GitlabMr, repos: string[]) => void;
}) {
  const { status: agents } = useAgents();
  const { data: jira } = useJiraContext();
  const { data: sessions } = useJiraSessionsContext();
  if (lead.state !== 'opened') return null;
  const text = reviewRowText(lead.review, now);
  if (text === null || lead.review === null) return null;
  const state = reviewState(lead.review, now);
  const half = reviewHalf(state);
  const label = reviewButtonLabel(state);
  const tone = state === 'open' ? 'amber' : 'grey';
  const showButton = half !== null && label !== null && onReview !== undefined && repos.length > 0 && agents !== null && agents.enabled;
  const blocked = showButton ? reviewGate(issue, lead, repos, jira?.live ?? {}, sessions?.links ?? []) : null;
  return (
    <div className="jira-dlv-review">
      <span className="jira-dlv-review-text" data-tone={tone}>
        {text}
      </span>
      {showButton && (
        <span className="ui-split ui-split-28">
          <button type="button" className="ui-split-main" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => onReview(half, lead, repos)}>
            <span className="ui-split-icon" aria-hidden="true">
              <Glyph name="play" />
            </span>
            {label}
          </button>
        </span>
      )}
    </div>
  );
}
