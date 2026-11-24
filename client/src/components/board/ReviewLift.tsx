import { useEffect, useState } from 'react';

import { useAction } from '../../hooks/useAction';
import { liftReview, readHeld } from '../../lib/agents';
import { reviewLiftText, type HeldReading } from '../../lib/review-lift';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import type { BacklogItem } from '../../../../shared/types';

/**
 * ReviewLift — the item modal's **Lift review**, drawn under the dispatch control and above `PlanApprove` (.claude/DESIGN.md §8.7: the confirmation is
 * `ui/Confirm`, inline in place of the chip, never a second overlay). The in-review-without-PR spec.
 *
 * An `in-review` label is a guard every execute gate reads, and it is lifted automatically only when the PR that answers it merges into the base. An
 * in-place execute (finish `merge` or `branch`) sets the label and opens no PR, and a PR closed unmerged lifts nothing, so the item stays blocked by a review
 * that is not happening — the board says so (`inReviewNoPr`, `IN_REVIEW_NO_PR_REASON`), and this is the way out short of a terminal. It is drawn only for
 * that case: with a referencing PR open, the label is doing its job and the PR is where the work goes.
 *
 * The label never comes off by itself, because the work it guarded may still exist only on this machine. Opening the confirm asks
 * (`GET /api/items/held`) whether a local `execute/<n>` branch or `.worktrees/execute-<n>` is left, and words the sentence by the answer — but Lift is
 * enabled in every state, checking included: the read cannot see an uncommitted checkout or another machine, so it informs the person and never decides.
 * One read per opening, never per render. Accept posts `POST /api/items/review` with `inReview: false`, the tenth guarded write route; success draws a
 * `review lifted` note and asks the board to re-read (`onLifted`), and a refusal prints the server's sentence verbatim with the chip back.
 *
 * `onLifted`'s presence is what draws the control at all, as `PlanApprove`'s `onApproved` is, so a render site with nothing to re-read offers no write.
 */
export function ReviewLift({ item, onLifted }: { item: BacklogItem; onLifted?: () => void }) {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'done'>('idle');
  // Bumped on each opening: the read is keyed to an opening, so a re-render (the board's poll hands the modal a new item object) never re-asks git.
  const [opening, setOpening] = useState(0);
  const [held, setHeld] = useState<HeldReading>('pending');
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (opening === 0) return;
    let current = true;
    setHeld('pending');
    readHeld(item.projectPath, item.id).then(
      (answer) => current && setHeld(answer),
      () => current && setHeld('failed')
    );
    return () => {
      current = false;
    };
    // `item` deliberately absent: the opening is the trigger, and the project and id of one modal's item do not change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening]);

  // The note is checked FIRST, for `PlanApprove`'s reason: the board hands the modal the re-read item, which no longer carries the flag, and gating on the
  // flag first would drop the note the moment the lift it reports took effect.
  if (stage === 'done') {
    return (
      <p className="item-claim-note" data-testid="review-lifted">
        review lifted
      </p>
    );
  }
  if (!onLifted || item.status !== 'open' || item.source !== 'github' || item.inReviewNoPr !== true) return null;

  const open = (): void => {
    setStage('confirm');
    setOpening((k) => k + 1);
  };
  // The confirm closes at once, so a second click on Accept lands on nothing; `useAction`'s guard covers the rest.
  const accept = (): void => {
    setStage('idle');
    run(() => liftReview(item.projectPath, item.id), {
      onSuccess: () => {
        setStage('done');
        onLifted();
      }
    });
  };

  return (
    <div className="item-facts-claim">
      {stage === 'confirm' ? (
        <Confirm
          label="confirm lift review"
          testId="review-lift-confirm"
          acceptLabel="Lift review"
          dismissLabel="Keep in review"
          onDismiss={() => setStage('idle')}
          onAccept={accept}
        >
          {reviewLiftText(item.id, held)}
        </Confirm>
      ) : (
        <Chip size={28} data-testid="review-lift" title="remove the in-review label so this item can be executed again" disabled={busy} onClick={open}>
          Lift review
        </Chip>
      )}
      {error !== null && (
        <span className="run-controls-error" data-testid="review-lift-error">
          {error}
        </span>
      )}
    </div>
  );
}
