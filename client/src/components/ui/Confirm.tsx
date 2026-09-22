import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { useDialogEscape } from '../../hooks/useDialogEscape';
import { Chip } from './Chip';

/**
 * Confirm — the one confirmation step on this board (.claude/DESIGN.md §8.4.1, the detail sheet's head; §8.7 says why it is not an overlay).
 *
 * bug-53: the run's Stop ended a multi-hour unattended run on one click, sitting at Pause's size one pixel-miss away from it, because `client/src` had
 * never grown a confirmation at all — pause needed none, stop was copied from pause, and nothing was left to reach for. This is the thing to reach for,
 * in `ui/` rather than inline in `RunControls`, so the next destructive control asks the same way instead of inventing a second way to ask.
 *
 * **Inline, in the row the click came from, and never a dialog layer.** §8.7 is explicit that `Modal` is composed by exactly one surface and that
 * nothing else on this board floats; a scrimmed box over the Runs page would be a second modal and would sit on top of the detail sheet it is asking
 * about, hiding the very run it names. So the control that was clicked is REPLACED in place by the question and its two answers — the reader's eye is
 * already there, and dismissing it puts the row back exactly as it was.
 *
 * **Escape goes through `useDialogEscape`, even though this is not a dialog**, because bug-23's rule is about who owns the key, not about what paints a
 * scrim: a second `window` listener of this component's own would run beside the stack's, and an item modal opened over a Watchdog row would take its
 * confirm with it on one press. Joining the stack makes this the topmost entry for as long as it is drawn — it mounts after anything already open —
 * and it leaves by identity when it unmounts, whichever way it goes.
 *
 * **The safe answer takes the focus.** A person who clicked by mistake presses Enter or Space next as often as anything, and the button under the focus
 * then decides the outcome, so the dismissal holds it and the destructive answer has to be reached for. Focused through the container rather than a ref
 * on the chip: `Chip` passes through `data-*` and `aria-*` alone, deliberately, and a `ref` channel is not worth widening that for one caller.
 *
 * The accept chip is `danger`, the dismissal `flat` — §8.4.1's rule that a control that destroys nothing must not read as one, applied both ways.
 */
export function Confirm({
  label,
  children,
  acceptLabel,
  dismissLabel,
  onAccept,
  onDismiss,
  testId
}: {
  /** The group's accessible name — what a screen reader announces before the question itself. */
  label: string;
  /** The question, in the consequences' own terms. Not "Are you sure?": that is the confirmation people click through without reading. */
  children: ReactNode;
  acceptLabel: string;
  dismissLabel: string;
  onAccept: () => void;
  onDismiss: () => void;
  /** The group's `data-testid`; the two answers carry `<testId>-accept` and `<testId>-dismiss`. */
  testId: string;
}) {
  useDialogEscape(onDismiss);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('[data-confirm-dismiss]')?.focus();
  }, []);

  return (
    <span ref={root} className="ui-confirm" role="group" aria-label={label} data-testid={testId}>
      <span className="ui-confirm-text">{children}</span>
      <Chip size={28} variant="danger" data-testid={`${testId}-accept`} onClick={onAccept}>
        {acceptLabel}
      </Chip>
      <Chip size={28} variant="flat" data-testid={`${testId}-dismiss`} data-confirm-dismiss="" onClick={onDismiss}>
        {dismissLabel}
      </Chip>
    </span>
  );
}
