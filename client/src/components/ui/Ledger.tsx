import type { ReactNode } from 'react';

/**
 * Ledger and DayKicker — .claude/DESIGN.md §8.4's "every table scrolls inside
 * its own sheet".
 *
 * `Ledger` owns the `overflow-x` box, and that is the whole reason it is a
 * component: a table that scrolls the PAGE sideways takes the rail and the
 * band with it, and the fix has to live where the box is rather than in each
 * page that happens to render a table. `columns` is a grid template, handed
 * down rather than guessed, because the columns differ per ledger and the
 * alignment is the reading.
 *
 * `DayKicker` is the rule ABOUT a list, not a card inside it (§8.5): 13/500
 * `--ink2` on the ledger's own ground, so a day heading never competes with
 * the rows under it.
 */
export function Ledger({ columns, children, label }: { columns: string; children: ReactNode; label?: string }) {
  return (
    <div className="ui-ledger" role="group" aria-label={label}>
      <div className="ui-ledger-grid" style={{ gridTemplateColumns: columns }}>
        {children}
      </div>
    </div>
  );
}

export function DayKicker({ children }: { children: ReactNode }) {
  return <div className="ui-ledger-day">{children}</div>;
}
