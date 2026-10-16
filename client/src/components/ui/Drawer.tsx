import type { ReactNode } from 'react';

import { useDialogEscape } from '../../hooks/useDialogEscape';
import { useNarrow } from '../../hooks/useNarrow';

/**
 * Drawer — the third overlay shape (.claude/DESIGN.md §8.7 "Drawer"), beside `Modal` and `FormSheet`: a scrim, and a 400 px panel against the window's right
 * edge, full height, full screen under 700 px. Copied from the dashboard's releases drawer, the one surface it serves here (`ReleasesDrawer`, §8.10), and a
 * shell rather than that surface's own markup so the look has one home in `components/ui/` like every other overlay.
 *
 * It owns the scrim, the ✕ and the Escape key, exactly as the other two shells do — see `Modal.tsx`'s header for why the hook lives in the shell and not
 * in its composers. The composer owns everything inside, its heading included: there is no head bar here, the ✕ sits in the panel's top-right corner the
 * way `Modal`'s does, and `label` is the dialog's accessible name for the reason `FormSheet`'s header gives.
 *
 * `useNarrow` decides the phone shape in JS and the CSS only draws it, the rule every overlay here follows. The panel stops a click's propagation instead of
 * the scrim being a sibling underneath it, which is the dashboard's shape: a scrim that wraps the panel is one element, so no layout can leave a strip of
 * page between the two where a click would land on neither.
 */
export function Drawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const narrow = useNarrow();
  useDialogEscape(onClose);

  return (
    <div className="ui-drawer-scrim" onClick={onClose}>
      <aside
        className={narrow ? 'ui-drawer ui-drawer-narrow' : 'ui-drawer'}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="ui-drawer-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
        {children}
      </aside>
    </div>
  );
}
