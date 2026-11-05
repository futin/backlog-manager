import type { ReactNode } from 'react';

/**
 * One fact in an item modal's facts column: a 11/500 label over its value (.claude/DESIGN.md §6.1).
 *
 * Hoisted from `board/ItemModal.tsx` unchanged in Jira phase 2, so the Jira issue modal draws the same column the backlog item modal does instead of a
 * second copy (the design spec's §12.1: a look more than one surface draws has one home in `ui/`).
 *
 * A component rather than nine hand-written pairs, because a fact that is
 * absent must draw NOTHING — no label, no empty value, no stray separator —
 * and "absent" is a different question per fact (an empty string for a date, a
 * `null` for `groomed`, a zero for a counter). Each call site answers its own
 * question and this renders only what survived it.
 */
export function Fact({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="item-fact">
      {/* The glyph is an `aria-hidden` sibling BEFORE the word, and the word stays a direct text node of the `dt`: the Jira dialog's label glyphs (restyle
          spec §4.4) must not change the label a test or a reader matches on. The item modal passes none and draws what it always did. */}
      <dt className="item-fact-label">
        {icon}
        {label}
      </dt>
      <dd className="item-fact-value">{children}</dd>
    </div>
  );
}
