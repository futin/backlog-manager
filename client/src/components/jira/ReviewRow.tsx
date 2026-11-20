import { reviewBlockedTail, reviewGateText } from '../../lib/review-copy';
import type { GitlabMr, JiraIssue, JiraSessionsPayload, JiraStatusPayload } from '../../../../shared/types';
import { Glyph } from '../ui/Glyphs';

/**
 * ReviewRow — the review button's rules and its two drawn pieces, for the Delivery tab's next row (Jira detail tabs spec §4.4, §4.5; CodeRabbit review spec
 * §5.2; DESIGN.md §8.9.6, Delivery › the next row). `NextRow` composes them on its `request` and `fix` branches; this file keeps what was the CodeRabbit
 * row's own — the live-session gate, the split and the reason line — so the rules did not change when the row became one branch of a larger one.
 *
 * - **`ReviewSplit`** — an ink `ui-split-28` with the play glyph: a lone half of the Run split, no chevron, since there is no menu behind it. It opens the Run
 *   launch sheet pre-set to the review; it dispatches nothing itself. Blocked, it is DISABLED, wears the dashed skin (`.ui-split-dashed`, as `Run ▾` with no
 *   repo and a blocked Merge do — the ink skin has no :disabled look of its own, so a disabled ink split read as clickable, 2026-11-16), carries the gate's
 *   sentence as its title on both the button and its wrapper (a disabled button takes no hover), and points (`aria-describedby`) at the reason line.
 * - **`ReviewWhy`** — the reason on screen, under the row rather than inside its pill: the session's name in bold, where it is live, and that the button
 *   waits until it ends or is stopped. The pill ellipsises and a branch name is long; this line wraps instead.
 *
 * Whether the split draws at all is the caller's (hidden, not disabled, where it can never work: no candidate repo, agents off or not yet answered, no
 * `onReview`), because only the caller knows all three; `reviewGate` is the disabled half, and dispatch's 409s stay the authority for what this view cannot
 * see.
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

/** The review play-button split; `blocked` is `reviewGateText`'s sentence while the gate holds, `whyId` the reason line it points at. */
export function ReviewSplit({
  label,
  blocked,
  whyId,
  onClick
}: {
  label: 'Fix review' | 'Request review';
  blocked: string | null;
  whyId: string;
  onClick: () => void;
}) {
  return (
    <span className={blocked === null ? 'ui-split ui-split-28' : 'ui-split ui-split-28 ui-split-dashed'} title={blocked ?? undefined}>
      <button
        type="button"
        className="ui-split-main"
        disabled={blocked !== null}
        title={blocked ?? undefined}
        aria-describedby={blocked === null ? undefined : whyId}
        onClick={onClick}
      >
        <span className="ui-split-icon" aria-hidden="true">
          <Glyph name="play" />
        </span>
        {label}
      </button>
    </span>
  );
}

/** The blocked split's reason line: who holds the MR (bold), where, and that the button waits. */
export function ReviewWhy({ gate, label, id }: { gate: { name: string; where: string | null }; label: 'Fix review' | 'Request review'; id: string }) {
  return (
    <p className="jira-dlv-next-why" id={id}>
      <span>
        <strong>{gate.name}</strong>
        {reviewGateText(gate).slice(gate.name.length)}
        {reviewBlockedTail(label)}
      </span>
    </p>
  );
}
