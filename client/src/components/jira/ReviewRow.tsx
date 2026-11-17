import { useId } from 'react';
import { useAgents } from '../../hooks/useAgents';
import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { reviewBlockedTail, reviewButtonLabel, reviewGateText, reviewRowText } from '../../lib/review-copy';
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
 * this view cannot see (another tab's in-flight reservation). A blocked button also wears the dashed skin and points (`aria-describedby`) at a reason line
 * under the row — the session's name in bold, where it is live, and that the button waits until it ends or is stopped — because a hover-only title was
 * not found: a disabled ink split drew exactly like an enabled one (2026-11-16).
 *
 * `useAgents` is read HERE, beside the one decision it feeds, rather than threaded down from the pane. Hooks run before the early returns below, so the row
 * mounts its own `/api/agents/status` poller whenever the pane draws a lead, open or not, sentence or not — one instance per open Detail, which is the cost.
 * The sentence carries itself as a `title`: it ellipsises before the button gives up any width, and a failed read's suffix overflows at 1440 px.
 */

/** Whether a dashboard row's checkout is one of the candidates: the main checkout itself or one of its `.worktrees/` trees (how a Jira worktree is laid out). */
function inCandidate(path: string | undefined, repos: readonly string[]): boolean {
  return path !== undefined && repos.some((r) => path === r || path.startsWith(`${r}/`));
}

/**
 * The live-session gate (spec §5.2): the session that blocks the button and where it is live (`null` for the ticket, the MR's source branch otherwise), or
 * `null` when nothing blocks. Structured rather than a sentence so the reason line can set the name apart; `reviewGateText` words it. Two checks, ticket first:
 * - **On the ticket:** a live `run` link on the key, quiet or not, or any `status.live` entry for it (a `starting` reservation has no link yet) — the strict
 *   ticket check a review's dispatch keeps (a Run's own gate is quiet-only, spec 2026-11-17-jira-quiet-run-gate-design.md). A `branch` or `manual` link on the key does not count here; the branch check catches it when it sits on the MR's branch.
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
): { name: string; where: string | null } | null {
  const open = links.filter((l) => l.endedAt === null);
  const onKey = live[issue.key] ?? open.find((l) => l.key === issue.key && l.how === 'run');
  if (onKey !== undefined) return { name: onKey.name, where: null };
  const onBranch = open.find(
    (l) =>
      (l.branch === mr.sourceBranch && repos.includes(l.repo)) ||
      (l.row !== null && (l.row.status === 'working' || l.row.status === 'question') && l.row.gitBranch === mr.sourceBranch && inCandidate(l.row.projectPath, repos))
  );
  return onBranch === undefined ? null : { name: onBranch.name, where: mr.sourceBranch };
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
  const whyId = useId();
  if (lead.state !== 'opened') return null;
  const text = reviewRowText(lead.review, now);
  if (text === null || lead.review === null) return null;
  const state = reviewState(lead.review, now);
  const half = reviewHalf(state);
  const label = reviewButtonLabel(state);
  const tone = state === 'open' ? 'amber' : 'grey';
  const showButton = half !== null && label !== null && onReview !== undefined && repos.length > 0 && agents !== null && agents.enabled;
  const gate = showButton ? reviewGate(issue, lead, repos, jira?.live ?? {}, sessions?.links ?? []) : null;
  const blocked = gate === null ? null : reviewGateText(gate);
  return (
    <>
      <div className="jira-dlv-review">
        <span className="jira-dlv-review-text" data-tone={tone} title={text}>
          {text}
        </span>
        {showButton && (
          // Blocked, the split wears the board's dashed skin (`.ui-split-dashed`, as `Run ▾` with no repo and a blocked Merge do): the ink skin has no
          // :disabled look of its own, so a disabled ink button read as clickable.
          <span className={blocked === null ? 'ui-split ui-split-28' : 'ui-split ui-split-28 ui-split-dashed'} title={blocked ?? undefined}>
            <button
              type="button"
              className="ui-split-main"
              disabled={blocked !== null}
              title={blocked ?? undefined}
              aria-describedby={blocked === null ? undefined : whyId}
              onClick={() => onReview(half, lead, repos)}
            >
              <span className="ui-split-icon" aria-hidden="true">
                <Glyph name="play" />
              </span>
              {label}
            </button>
          </span>
        )}
      </div>
      {gate !== null && label !== null && (
        // The reason on screen, under the row rather than inside its pill: the pill ellipsises and a branch name is long; this line wraps instead.
        <p className="jira-dlv-review-why" id={whyId}>
          <span>
            <strong>{gate.name}</strong>
            {reviewGateText(gate).slice(gate.name.length)}
            {reviewBlockedTail(label)}
          </span>
        </p>
      )}
    </>
  );
}
