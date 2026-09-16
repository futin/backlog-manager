import type { ReactNode } from 'react';

import { useDialogEscape } from '../../hooks/useDialogEscape';
import { useNarrow } from '../../hooks/useNarrow';

/**
 * FormSheet — the sheet (.claude/DESIGN.md §8.7 "Sheet", the design spec's §6.2
 * and §12.2).
 *
 * The shell `LaunchSheet` and `OrchestrateSheet` both wear: scrim, air on every
 * side, 620 px wide, the same one shell lift the sidecar modal carries (§5),
 * full-screen under 700 px. It is a shell and nothing else — every step and
 * field either sheet already had stays exactly where it was, in its own file.
 *
 * `steps` is optional because only one of the two has steps: the orchestrate
 * sheet's three-step header is a 13/500 stepper on a hairline, and the launch
 * sheet has no steps at all. A slot that is absent draws no hairline, rather
 * than an empty rule above the body.
 *
 * `footer` holds the actions and is a REQUIRED prop that may be `null`. Both
 * sheets end in a row of them (cancel + launch; back + next/start), and a sheet
 * whose actions were just more `children` would let one of them scroll its own
 * Start out of reach — the footer is pinned under the scrolling body for that
 * reason. Required so a composer has to decide, and the bar is drawn only when
 * something came back: the launch sheet's launched and blocked states have no
 * actions left, and an empty bar with a rule over it is a control row with no
 * controls.
 *
 * **`label` is a prop the spec's §12.2 table does not list, and it is here on
 * purpose** (§12.2 amended with it in the same change). The dialog's accessible
 * name and its visible title are not the same string on either sheet: the
 * launch sheet reads `dispatch <id>` to a screen reader while showing a kicker
 * and a title, and the orchestrate sheet reads `orchestrate <project>`. `title`
 * is a node, so a name cannot be derived from it; deriving one would also have
 * silently renamed both dialogs, which is the kind of change a suite catches
 * and a person does not. `Modal` takes the same prop for the same reason.
 *
 * Escape and the 700 px shape are this component's, exactly as they are
 * `Modal`'s — see that file's header for why the hook lives in the shell and
 * not in its composers. Neither sheet binds `useDialogEscape` any more.
 */
export function FormSheet({
  label,
  title,
  steps,
  footer,
  children,
  onClose
}: {
  label: string;
  title: ReactNode;
  steps?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const narrow = useNarrow();
  useDialogEscape(onClose);

  return (
    <>
      {/* No test id: both sheets draw this one element, and the three-deep
          Escape case mounts them together — a shared id would match twice and
          fail as an ambiguity rather than as the thing it was asserting. The
          class is the handle, and it is the shell's own. */}
      <div className="ui-form-sheet-scrim" onClick={onClose} />
      <div className={narrow ? 'ui-form-sheet ui-form-sheet-narrow' : 'ui-form-sheet'} role="dialog" aria-modal="true" aria-label={label}>
        <div className="ui-form-sheet-head">
          <div className="ui-form-sheet-title">{title}</div>
          <button type="button" className="ui-form-sheet-close" aria-label="close" onClick={onClose}>
            ✕
          </button>
        </div>
        {steps && <div className="ui-form-sheet-steps">{steps}</div>}
        <div className="ui-form-sheet-body">{children}</div>
        {footer && <div className="ui-form-sheet-foot">{footer}</div>}
      </div>
    </>
  );
}
