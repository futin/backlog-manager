import type { ReactNode } from 'react';

import { Dot } from '../ui/Dot';
import { Pill } from '../ui/Pill';

/**
 * Which of the four type columns this is — and the reason the value is a slug
 * rather than a `Section`: it is simultaneously the CSS hook
 * (`.board-col-<slug>`) and the ramp hue's own name (`Dot`'s
 * `ramp-<slug>` tone, DESIGN.md §8.2). All four happen to equal their section
 * now that `out-of-scope` — the one abbreviation this file ever carried, and
 * only ever as a class-name fragment — left the Board for Archive.
 *
 * Archive's four columns are NOT these: its fourth is out-of-scope, which has
 * no ramp hue of its own (`--ink3`, §5.1), and its header is task 4's to
 * redraw. That is why this component takes a closed union rather than a
 * `Section`, and why Archive still draws its own header inline.
 */
export type BoardColumnSlug = 'refactors' | 'ideas' | 'bugs' | 'tasks';

/**
 * One column of the board: a header and the stack of cards under it
 * (DESIGN.md §8.3, "Columns").
 *
 * Extracted from `BoardView`'s own inline markup by task-37 because the design
 * spec's §12.3 names it a Board composition: an 8 px ramp `Dot`, the name at
 * 15/500, and a `Pill` carrying the count pushed right. No rule is drawn under
 * the header — the cards' own ground gap is the only separation, which is the
 * one place §8's standing "nothing on `--board` uses `--strip-hi` as its only
 * separator" rule does not apply, because the separator here is a gap and not
 * a stroke.
 *
 * The count is a prop rather than `Children.count(children)`: the board sorts
 * and filters the column's items before it maps them, so it holds the number
 * already, and counting rendered children would make the header depend on how
 * the caller chose to wrap them — Archive groups its cards by month, and a
 * count of month groups is not a count of cards.
 */
export function BoardColumn({ slug, label, count, children }: { slug: BoardColumnSlug; label: string; count: number; children: ReactNode }) {
  return (
    <div className={`board-col board-col-${slug}`} data-testid="board-col">
      {/* `.board-col-head`, not the `.board-col-h` this markup was extracted
          from: that class still carries the hairline rule under the header,
          and Archive still draws one (its own header is task 4's to redraw).
          This header draws none — the cards' own ground gap is the only
          separation — so it takes its own class rather than an override that
          would have to undo a border the other surface still wants. */}
      <div className="board-col-head">
        <Dot tone={`ramp-${slug}`} />
        <span className="board-col-name" data-testid="col-name">
          {label}
        </span>
        {/* The test hook and the "pushed right" layout sit on a wrapper rather
            than on the `Pill`, because a primitive that accepted a className or
            a margin from its caller is the drift `ui/` exists to stop — page
            CSS lays a primitive out, and this span is where that laying out
            happens (the design spec's §12.1). */}
        <span className="board-col-pill" data-testid="col-count">
          <Pill tone="neutral">{count}</Pill>
        </span>
      </div>
      {/* The column's cards, in their own element rather than as this
          component's remaining children. Two reasons: an empty column needs
          something to render in place of the stack, and any per-column overflow
          later has to scroll the cards without dragging the header off with
          them. */}
      <div className="board-col-cards">{children}</div>
    </div>
  );
}
