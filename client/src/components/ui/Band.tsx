import type { ReactNode } from 'react';

/**
 * Band — the page header (.claude/DESIGN.md §8.2's "the page header is a band,
 * not a card", applied by §8.3/§8.4/§8.5/§8.6).
 *
 * A band rather than a card because a page header is not one more object
 * competing with the objects under it: it sits directly on `--board`, carries
 * the 19/500 title over its one 13/400 line (§8.1), and reserves a right slot
 * for whatever controls that page — search, a project select, Orchestrate.
 *
 * `children` IS the right slot, rather than a `right` prop, because every band
 * on this board has one and most have several controls in it; a slot that is
 * the component's children reads as "these belong to this header" at the call
 * site without a nested fragment. `SheetHead` below makes the opposite choice
 * for the opposite reason — see its own comment.
 */
/* `className` is the page's own LAYOUT class, never a second look — the same contract `Sheet` has carried since task-38 (`.runs-history-sheet`,
   `.runs-detail`), and the reason DESIGN.md §12.1 gives for it: where a band sits in a page's grid is a fact about that page, and the primitive cannot
   know it. `test/design-guards.test.ts` guard 7 enforces the other half — no page may name `.ui-band` in a selector at all. */
export function Band({ title, sub, children, className }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={className ? `ui-band ${className}` : 'ui-band'}>
      <div className="ui-band-text">
        <h2 className="ui-band-title">{title}</h2>
        {sub && <p className="ui-band-sub">{sub}</p>}
      </div>
      {children && <div className="ui-band-right">{children}</div>}
    </header>
  );
}
