import { useId, type ReactNode } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { useAction } from '../../hooks/useAction';
import { useNarrow } from '../../hooks/useNarrow';
import type { DeliveryNext } from '../../lib/delivery';
import { openDesktopJira } from '../../lib/jira';
import { openButtons, type SessionLink } from '../../lib/jira-sessions';
import { reviewGateText, reviewRowText } from '../../lib/review-copy';
import { reviewState } from '../../../../shared/review';
import type { GitlabMr, JiraAction, JiraIssue, ReviewHalf } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { JiraRunMenu } from './JiraRunMenu';
import { ReviewMenu } from './ReviewMenu';
import { reviewGate, ReviewSplit, ReviewWhy } from './ReviewRow';
import { SessionOpen } from './SessionOpen';

/**
 * NextRow — one Delivery row's next step, under its track (Jira detail tabs spec §4.5, §4.5.1; mocks `Main.html` `.rv` and `States.html`, one card per
 * table row; DESIGN.md §8.9.6, Delivery › the next row). A hairline, the sentence on a pill at the left, then the row's one control and a quiet `Ignore` at
 * the right. Which of them draw is `deliveryNext`'s answer, never re-derived here; this component only maps its `button` kind to a control:
 *
 * - `request` / `fix` — the review split (`ReviewRow.tsx`'s pieces, its rules unchanged), on THIS row's MR: every expanded target with an open lead gets
 *   one (§4.4), not only the ticket's lead. `fix` becomes `Open session` while a live `review` session is on the key — the session already asks fix or
 *   leave, so a second launch would be two sessions on one branch — drawn by `SessionOpen`, the Agent card's own control, so the click goes where that
 *   session lives (Dashboard, Desktop or the hand-over) by the same table.
 * - `run` — a second `JiraRunMenu`, `home="modal"`: the same component as the frame's head, so its states (no repo, a live run) cannot differ from it.
 * - `merge` / `gitlab` — a link to the MR's own page in a new tab, `Merge in GitLab ↗` or `GitLab ↗`: the board never merges a GitLab MR.
 *
 * **Review skills** (Jira review skills spec §4) add one control, and only while this machine has at least one (`group: 'review'` in `GET /api/jira`'s
 * skills); with none every branch above is exactly what it was. The split is no longer the lone review control:
 *
 * | Next kind | Control | With ≥1 review skill |
 * | --- | --- | --- |
 * | `request` / `fix` (no live bot review link) | `ReviewSplit` | `ReviewSplit` + its `More reviewers` chevron (`ReviewMenu`) |
 * | `fix` with a live bot `review` link | `Open session` | `Open session`, then the ghost `Review ▾` |
 * | `run` | `Run ▾` | `Run ▾`, then the ghost |
 * | `merge` / `gitlab` | the GitLab chip | the chip, then the ghost |
 * | none | nothing (the row may draw nothing) | the ghost alone, so the row draws |
 *
 * The ghost draws only on an OPEN MR — a merged or closed lead has nothing left to review — and the chevron and the ghost hide and disable exactly as the
 * split does (no candidate repo, agents off or unanswered, no `onReview`, plus no `onReviewSkill`), under the one `reviewGate`, whose reason line names the
 * ghost `Review`. A live review-SKILL session is not `liveReviewLink` (that is the bot's, `action === 'review'`), so it never turns `fix` into `Open
 * session`; the gate still holds the split for it, by its name, since it sits on the same branch.
 *
 * The sentence is `deliveryNext`'s for the Pipeline and Merge rows and today's `reviewRowText` for a ringed Review step (the table leaves it to the caller),
 * amber only for open findings, as the CodeRabbit row was. A row with no sentence, no control and no `Ignore` draws nothing — a waiting `reviewing` MR, a
 * merged one. `Ignore` writes through the caller (`onIgnore`), which owns the store and the ticket's MR list the write prunes against.
 */
export function NextRow({
  issue,
  mr,
  now,
  next,
  repos,
  agentsOn,
  liveReviewLink,
  onReview,
  onReviewSkill,
  onRun,
  onIgnore
}: {
  issue: JiraIssue;
  /** This row's MR: the target's lead. */
  mr: GitlabMr;
  now: number;
  next: DeliveryNext;
  /** The review candidates: local repo paths mapped to `mr`'s GitLab project under the issue's Jira project (`GitlabProjectView.repos`). */
  repos: string[];
  /** Whether the dashboard says agents are on — read once by the tab, not per row, so N targets do not mount N pollers. */
  agentsOn: boolean;
  /** The newest live link on the key whose action is `review`, or `null`. */
  liveReviewLink: SessionLink | null;
  onReview?: (half: ReviewHalf, mr: GitlabMr, repos: string[]) => void;
  /** A `Review menu` skill pick: the launch sheet's skill variant on `mr`. Absent, no chevron and no ghost draw. */
  onReviewSkill?: (skillId: string, mr: GitlabMr, repos: string[]) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  onIgnore: (step: 'review' | 'pipeline') => void;
}) {
  const { data: jira } = useJiraContext();
  const { data: sessions } = useJiraSessionsContext();
  const phone = useNarrow();
  const handover = useAction();
  const whyId = useId();

  const sentence = next.sentence ?? (next.step === 'review' ? reviewRowText(mr.review, now) : null);
  const tone = next.step === 'review' && mr.review !== null && reviewState(mr.review, now) === 'open' ? 'amber' : 'grey';

  // Where a review can start at all (the split's hide conditions, unchanged), whether the skills join it, and the one gate both share — read once per row.
  const canReview = onReview !== undefined && repos.length > 0 && agentsOn;
  const reviewSkills = (jira?.skills ?? []).filter((k) => k.group === 'review');
  const withSkills = canReview && onReviewSkill !== undefined && reviewSkills.length > 0;
  const gate = canReview ? reviewGate(issue, mr, repos, jira?.live ?? {}, sessions?.links ?? []) : null;
  const blocked = gate === null ? null : reviewGateText(gate);
  const pickSkill = (id: string): void => onReviewSkill?.(id, mr, repos);

  let control: ReactNode = null;
  let why: ReactNode = null;
  // Every branch but the split's offers the skills through the ghost (the table in the header); the split's carries them on its chevron instead.
  let ghost = true;
  if (next.button === 'fix' && liveReviewLink !== null && liveReviewLink.sessionId !== null) {
    const l = liveReviewLink;
    const b = openButtons(l, l.row, l.state, { phone, wide: true });
    control = (
      <SessionOpen
        issueKey={issue.key}
        sessionId={l.sessionId as string}
        row={l.row}
        launch={l.surface}
        state={l.state}
        buttons={{ ...b, primary: { ...b.primary, label: 'Open session' } }}
        onHandover={(id) => handover.run(() => openDesktopJira(id))}
      />
    );
  } else if (next.button === 'request' || next.button === 'fix') {
    const half: ReviewHalf = next.button;
    const label = half === 'fix' ? 'Fix review' : 'Request review';
    ghost = false;
    if (canReview) {
      const bot = (): void => onReview(half, mr, repos);
      control = withSkills ? (
        <ReviewMenu mr={mr} half={half} skills={reviewSkills} blocked={blocked} whyId={whyId} onBot={bot} onSkill={pickSkill} ghost={false} />
      ) : (
        <ReviewSplit label={label} blocked={blocked} whyId={whyId} onClick={bot} />
      );
      if (gate !== null) why = <ReviewWhy gate={gate} label={label} id={whyId} />;
    }
  } else if (next.button === 'run') {
    control = <JiraRunMenu issue={issue} home="modal" onPick={onRun} />;
  } else if (next.button === 'merge' || next.button === 'gitlab') {
    control = (
      <Chip as="a" size={28} variant={next.button === 'merge' ? 'ink' : 'outline'} href={mr.webUrl}>
        {next.button === 'merge' ? 'Merge in GitLab ↗' : 'GitLab ↗'}
      </Chip>
    );
  }

  let ghostEl: ReactNode = null;
  if (ghost && withSkills && mr.state === 'opened') {
    ghostEl = <ReviewMenu mr={mr} half={null} skills={reviewSkills} blocked={blocked} whyId={whyId} onSkill={pickSkill} ghost />;
    if (gate !== null) why = <ReviewWhy gate={gate} label="Review" id={whyId} />;
  }

  const ignoreStep = next.ignore;
  if (sentence === null && control === null && ghostEl === null && ignoreStep === null) return null;
  return (
    <>
      <div className="jira-dlv-next">
        {sentence !== null && (
          // The sentence carries itself as a `title`: it ellipsises before the controls give up any width.
          <span className="jira-dlv-next-text" data-tone={tone} title={sentence}>
            {sentence}
          </span>
        )}
        <span className="jira-dlv-next-btns">
          {control}
          {ghostEl}
          {ignoreStep !== null && (
            <Chip size={28} variant="flat" onClick={() => onIgnore(ignoreStep)}>
              Ignore
            </Chip>
          )}
        </span>
      </div>
      {why}
      {handover.error !== null && (
        <p className="jira-modal-error" role="alert">
          {handover.error}
        </p>
      )}
    </>
  );
}
