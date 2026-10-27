import { useEffect, useRef, useState } from 'react';

import { useAction } from '../../hooks/useAction';
import { approvePlan } from '../../lib/agents';
import { planApprovePrompt } from '../../lib/plan-review';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import type { BacklogItem } from '../../../../shared/types';

/**
 * PlanApprove — the item modal's **Approve plan** (#367), drawn under the facts column's dispatch control and above `ClaimRelease` (.claude/DESIGN.md §8.7:
 * the confirmation is `ui/Confirm`, inline in place of the chip, never a second overlay).
 *
 * A tick's groom writes its plan with the `plan-review` mark, and every execute gate refuses an item that carries it until a person has read the plan. Before
 * this, lifting the mark meant a terminal — `backlog.mjs plan-review '#N' off` or deleting a frontmatter line — while the plan itself was being read here.
 * The person reading it is the one entitled to approve it, so the approval sits beside the body.
 *
 * Two shapes, by source, because the board writes tracker items and never item files:
 *
 * - **Tracker** — `Approve plan` → a confirm → `POST /api/items/plan-review` with `planReview: false`, one of the guarded item write routes. Success draws a
 *   `plan approved` note in place of the chip and asks the board to re-read (`onApproved`), so the dispatch chip above stops reading `Review plan` once the
 *   fresh item lands. A refusal prints the server's sentence verbatim and the chip comes back.
 * - **Files** — no request at all. A line saying why, and `Copy prompt`, which copies a sentence a Claude session can act on (`planApprovePrompt`). It reads
 *   `Copied` for 2 s; with no clipboard API, or a refused write, the prompt is drawn below so it can be selected by hand — `WorktreeRow`'s posture.
 *
 * Drawn only for an open item that carries the mark; anything else renders nothing, so the modal can mount it unconditionally.
 */
export function PlanApprove({ item, onApproved }: { item: BacklogItem; onApproved?: () => void }) {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'done'>('idle');
  // The in-flight guard, `busy` and the refusal's message are `useAction`'s (#286), as they are for ClaimRelease beside it.
  const { busy, error, run } = useAction();

  // The note is checked FIRST: the board hands the modal the fresh item once its re-read lands (#367, BoardView's `openItem`), and that item no longer
  // carries the mark — gating on the mark first would drop the note the moment the approval it reports took effect.
  if (stage === 'done') {
    return (
      <p className="item-claim-note" data-testid="plan-approved">
        plan approved
      </p>
    );
  }
  if (item.status !== 'open' || item.planReview !== true) return null;
  if (item.source === 'files') return <PlanApprovePrompt item={item} />;

  // The confirm closes at once and the chip comes back disabled while the request is out; a refusal lands back at `idle` with the message under the chip.
  const accept = (): void => {
    setStage('idle');
    run(() => approvePlan(item.projectPath, item.id), {
      onSuccess: () => {
        setStage('done');
        onApproved?.();
      }
    });
  };

  return (
    <div className="item-facts-claim">
      {stage === 'confirm' ? (
        <Confirm
          label="confirm approve plan"
          testId="plan-approve-confirm"
          acceptLabel="Approve"
          dismissLabel="Keep in review"
          onDismiss={() => setStage('idle')}
          onAccept={accept}
        >
          {`Approve the plan on ${item.id}? The next tick, or Execute here, can then run it.`}
        </Confirm>
      ) : (
        <Chip size={28} data-testid="plan-approve" title="lift the plan-review mark so the plan can be executed" disabled={busy} onClick={() => setStage('confirm')}>
          Approve plan
        </Chip>
      )}
      {error !== null && (
        <span className="run-controls-error" data-testid="plan-approve-error">
          {error}
        </span>
      )}
    </div>
  );
}

/** The files-project shape: the board never writes an item file, so approval is a prompt for a Claude session to carry out. */
function PlanApprovePrompt({ item }: { item: BacklogItem }) {
  const prompt = planApprovePrompt(item);
  const canCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
  const [copied, setCopied] = useState(false);
  const [refused, setRefused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  const copy = (): void => {
    if (!canCopy) {
      setRefused(true);
      return;
    }
    navigator.clipboard.writeText(prompt).then(
      () => {
        setRefused(false);
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => setRefused(true)
    );
  };
  return (
    <div className="item-facts-claim">
      <p className="item-claim-note">Approve from a Claude session — the board never writes item files.</p>
      <Chip size={28} data-testid="plan-approve-copy" title="copy a prompt that lifts the plan-review mark" onClick={copy}>
        {copied ? 'Copied' : 'Copy prompt'}
      </Chip>
      {refused && (
        <code className="item-plan-prompt" data-testid="plan-approve-prompt">
          {prompt}
        </code>
      )}
    </div>
  );
}
