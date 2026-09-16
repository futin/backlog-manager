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
 * `columns` is OPTIONAL, and the caller that omits it is the reason (task-38):
 * Runs › Watchdog's activity feed is a real `<table>` — five columns of the
 * same five fields on every line, with a header row a scrolling reader needs
 * to keep — and a `<table>` laid out by this component's own grid would have
 * its columns set by the grid and its semantics by the element, which is two
 * layouts fighting. What that caller needs from this component is the box, so
 * with no `columns` it gets the box and lays itself out. The grid stays the
 * default, because a ledger whose rows are spans is the ordinary case.
 *
 * `DayKicker` is the rule ABOUT a list, not a card inside it (§8.5): 13/500
 * `--ink2` on the ledger's own ground, so a day heading never competes with
 * the rows under it. Since task-38 it is also STICKY against whichever box is
 * scrolling it — see its rule in styles.css for why that belongs to the
 * primitive rather than to the one page that draws day groups today.
 */
export function Ledger({ columns, children, label }: { columns?: string; children: ReactNode; label?: string }) {
  return (
    <div className="ui-ledger" role="group" aria-label={label}>
      {columns === undefined ? (
        children
      ) : (
        <div className="ui-ledger-grid" style={{ gridTemplateColumns: columns }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function DayKicker({ children }: { children: ReactNode }) {
  return <div className="ui-ledger-day">{children}</div>;
}
