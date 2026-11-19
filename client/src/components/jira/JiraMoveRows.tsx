import { useEffect, useRef } from 'react';

import { statusTone, transitionOptions } from '../../lib/jira';
import type { JiraTransition } from '../../../../shared/types';
import { Glyph } from '../ui/Glyphs';

/* The Status chip's Move-to popover rows. Moved out of `JiraDetail.tsx` unchanged (Jira detail tabs plan, Task 4) so the Detail body and its tabs can
   draw it; DESIGN.md §8.9.2. */

/**
 * The Move-to popover's rows (`Modal.dc.html`, spec §4.4): one per offered transition in Jira's order, labelled by `transitionOptions` (the landing status, or the
 * transition's own name when two land together), each with a dot in the landing status's tone. Every row that lands on the CURRENT status is pinned first, in
 * Jira's order, with a tick and `aria-disabled` — a move to where the ticket already is would post a no-op — and the rest follow in Jira's order. The disabled rows
 * stay buttons, not `disabled` ones, so a screen reader still reads them; they just do nothing. Focus lands on the first row that DOES something when the panel
 * mounts, since it mounts only while open.
 */
export function JiraMoveRows({ transitions, current, onPick }: { transitions: readonly JiraTransition[]; current: string; onPick: (id: string) => void }) {
  const labels = transitionOptions(transitions);
  const rows = transitions.map((t, i) => ({ t, label: labels[i].label, here: t.to.name === current }));
  const ordered = [...rows.filter((r) => r.here), ...rows.filter((r) => !r.here)];
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const firstEnabled = ordered.findIndex((r) => !r.here);
  return (
    <>
      <div className="jira-move-head">Move to</div>
      {ordered.map((r, i) => (
        <button
          key={r.t.id}
          ref={i === firstEnabled ? first : undefined}
          type="button"
          className="jira-move-row"
          aria-disabled={r.here ? true : undefined}
          onClick={() => !r.here && onPick(r.t.id)}
        >
          <span className="jira-status-dot" data-tone={statusTone(r.t.to.category)} aria-hidden="true" />
          <span className="jira-move-label">{r.label}</span>
          {r.here && <Glyph name="tick" size={14} />}
        </button>
      ))}
      <div className="jira-move-note">Jira transitions, applied on click</div>
    </>
  );
}
