import type { MouseEvent, ReactNode, SyntheticEvent } from 'react';

/**
 * Fold — a `<details>` whose open state is held by the caller (DESIGN.md §8.9.6, Delivery › target rows, and §8.9.2's Worktrees fold). Three surfaces fold
 * this way — a Delivery target row, its older-MRs fold, the ticket's Worktrees — and each needs the state outside the element: the target rows are opened
 * by a strip pill and must stay open when a poll swaps the lead, and a re-render of an uncontrolled `<details>` carrying `open` would fight the browser.
 *
 * A summary click is prevented and reported through `onToggle`, so the caller's state is the only writer — except a click on a link inside the summary (a
 * row's `!iid ↗`), which must open its page and leave the fold alone. A browser that opens the element itself (find-in-page) fires the native `toggle`
 * event; when the element's state then differs from `open` it is reported too, so the state follows the browser rather than closing it on the next render.
 * The body renders only while open: a closed Delivery row mounts no next row, no second `Run ▾` and no review split.
 */
export function Fold({
  className,
  open,
  onToggle,
  head,
  children
}: {
  className: string;
  open: boolean;
  onToggle: () => void;
  head: ReactNode;
  children: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLElement>): void => {
    if ((e.target as Element).closest('a') !== null) return;
    e.preventDefault();
    onToggle();
  };
  const onNative = (e: SyntheticEvent<HTMLDetailsElement>): void => {
    if (e.currentTarget.open !== open) onToggle();
  };
  return (
    <details className={className} open={open} onToggle={onNative}>
      <summary onClick={onClick}>{head}</summary>
      {open && children}
    </details>
  );
}
