import type { ReactNode } from 'react';

import { useDialogEscape } from '../../hooks/useDialogEscape';
import { useNarrow } from '../../hooks/useNarrow';

/**
 * Modal — the sidecar (.claude/DESIGN.md §8.7 "Sidecar modal", the design
 * spec's §6.1 and §12.2).
 *
 * A shell with air around it: `--scrim` over everything, a `--strip` panel at
 * 16 px radius carrying the design's ONE shell lift (§5 — `0 24px 64px` at
 * `--shadow2`; nothing else on this board floats), a 290 px facts column left
 * of a body with a clean top edge.
 *
 * **This is the only modal anywhere in this app, and that is a decision rather
 * than a coincidence** — stated here because a future reader should not have to
 * re-derive it from the spec, the same way `RunControls`' header states its own
 * "why one component". There is no run modal and none is added: everything a
 * run modal would have drawn is the Runs page's own detail sheet (§8.4.1),
 * always beside the list. That sheet, and not a modal, is also the only surface
 * able to hold `RunControls` at all — a Pause or a Resume has to have a
 * standing place for the length of a run, which a surface a reader opens and
 * closes does not offer. So `Modal` is composed by exactly one surface, the
 * item (`board/ItemModal.tsx`), and a second composer is a design change, not a
 * reuse.
 *
 * **It owns the scrim, the exit and the Escape key, and its composers own
 * none of them.** `useDialogEscape` is called HERE rather than by the item
 * modal, which is what keeps bug-23's rule — one owner, a LIFO stack, the
 * topmost dialog closes — true of every surface that opens through this shell
 * without each of them having to remember it. Three callers of that hook
 * remain (this, and `FormSheet`'s two sheets); the run drawer left the stack
 * outright with task-37.
 *
 * `useNarrow` is the single authority for the 700 px shape, called rather than
 * restated as an `@media` rule of this family's own: under it the panel goes
 * full-screen and the facts column folds ABOVE the body instead of beside it.
 * A media query could carry the geometry but not the reading order, and two
 * copies of the breakpoint that had to agree is exactly what that hook exists
 * to prevent.
 */
export function Modal({ label, facts, children, onClose }: { label: string; facts: ReactNode; children: ReactNode; onClose: () => void }) {
  const narrow = useNarrow();
  useDialogEscape(onClose);

  return (
    <>
      {/* The scrim is the exit a pointer reaches for first; the close control
          below is the one a keyboard reaches. Both, because neither alone is
          "a real exit" (§6.1) for both kinds of reader. */}
      <div className="ui-modal-scrim" data-testid="modal-scrim" onClick={onClose} />
      <div className={narrow ? 'ui-modal ui-modal-narrow' : 'ui-modal'} role="dialog" aria-modal="true" aria-label={label}>
        <button type="button" className="ui-modal-close" aria-label="close" onClick={onClose}>
          ✕
        </button>
        {/* Two slots, named rather than positional: a facts column that is
            always the facts and a body that is always the content is what lets
            the 290 px / fold-above geometry live in one stylesheet rule instead
            of in whatever order a composer happened to pass its children in. */}
        <div className="ui-modal-facts">{facts}</div>
        <div className="ui-modal-body">{children}</div>
      </div>
    </>
  );
}
