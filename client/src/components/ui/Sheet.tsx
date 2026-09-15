import type { ElementType, ReactNode } from 'react';

/**
 * Sheet and SheetHead — the card (.claude/DESIGN.md §8.2, §7's "title + one-line
 * subtitle" pattern).
 *
 * One borderless `--strip` card at 16 px radius (§4) with no shadow (§5): on
 * this board a card is told from the page by its ground, not by a lift, which
 * is what keeps a page of six of them from reading as six floating panels.
 *
 * `as` exists because a sheet is a *look*, not an element: Settings' groups are
 * `<section>`s, the Runs detail sheet is an `<aside>`, and a table's scroll box
 * is a plain `<div>`. Defaulting to `<div>` and letting the composer name the
 * element keeps the semantics with the page that knows them.
 */
export function Sheet({ children, as: As = 'div', className }: { children: ReactNode; as?: ElementType; className?: string }) {
  return <As className={className ? `ui-sheet ${className}` : 'ui-sheet'}>{children}</As>;
}

/**
 * The head of a sheet: the 19/500 title, its one 13/400 line, and a right slot
 * for ONE control (§7 — a filter chip "sits top-right of the card it filters").
 *
 * `right` is a prop here where `Band` uses `children`, and the difference is
 * the rule each states: a band heads a page and collects its controls, a sheet
 * head takes one. A named prop that holds one control is a harder thing to
 * quietly fill with four than a children slot is.
 */
export function SheetHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="ui-sheet-head">
      <div className="ui-sheet-head-text">
        <h3 className="ui-sheet-title">{title}</h3>
        {sub && <p className="ui-sheet-sub">{sub}</p>}
      </div>
      {right && <div className="ui-sheet-head-right">{right}</div>}
    </div>
  );
}
