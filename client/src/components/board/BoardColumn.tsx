import type { ReactNode } from 'react';

import { Dot } from '../ui/Dot';
import { Pill } from '../ui/Pill';

/**
 * Which type column this is — and the reason the value is a slug rather than a
 * `Section`: it is simultaneously the CSS hook (`.board-col-<slug>`) and, for
 * the four that have one, the ramp hue's own name (`Dot`'s `ramp-<slug>` tone,
 * DESIGN.md §8.2). Every member happens to equal its section name now that
 * `oos` — the one abbreviation this file ever carried, and only ever as a
 * class-name fragment — is gone.
 *
 * `out-of-scope` is the fifth member and Archive's alone: the Board has no
 * column for a rejection (§8.3) and Archive has no Tasks column (§8.5), so the
 * union is the two surfaces' columns put together rather than either one's.
 * task-39 widened it, and that widening is what makes "Archive reuses the
 * Board's own column language rather than drawing a second one" (§8.5) true by
 * construction instead of by two files agreeing about a header's anatomy. The
 * union stays closed rather than becoming `Section` because the fifth member is
 * exactly what `RAMP_SLUGS` below has to be able to exclude.
 */
export type BoardColumnSlug = 'refactors' | 'ideas' | 'bugs' | 'tasks' | 'out-of-scope';

/**
 * The four slugs that name a TYPE, and so carry the category ramp's hue (§8.2).
 *
 * `out-of-scope` is deliberately absent and falls through to `Dot`'s own
 * toneless base, a plain `--ink3` (§8.5): a rejection is a verdict rather than a
 * type, and giving it a ramp colour would put it in the same vocabulary as the
 * three columns beside it that are still live work. Written as a list to
 * subtract from rather than as a `slug === 'out-of-scope' ? …` test, because a
 * sixth slug added later with no ramp hue of its own should read as "not on the
 * ramp" here rather than have to be remembered as a second exception.
 */
const RAMP_SLUGS = ['refactors', 'ideas', 'bugs', 'tasks'] as const;

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
 * count of month groups is not a count of cards. That caller is not
 * hypothetical since task-39: `ArchiveView` renders this component under its
 * own four columns, passing the count summed across the month groups it wraps
 * the cards in.
 */
export function BoardColumn({ slug, label, count, children }: { slug: BoardColumnSlug; label: string; count: number; children: ReactNode }) {
  /* Narrowed through the list rather than cast: `tone` is `DotTone`, whose
     `ramp-` members are exactly `RAMP_SLUGS`, so the template literal below is
     only a legal tone inside this branch. */
  const ramp = (RAMP_SLUGS as readonly string[]).includes(slug) ? (slug as (typeof RAMP_SLUGS)[number]) : null;

  return (
    <div className={`board-col board-col-${slug}`} data-testid="board-col">
      {/* `.board-col-head`, not the `.board-col-h` this markup was extracted
          from. That class carried a hairline rule under the header and was
          Archive's alone once the Board stopped drawing one; task-39 put
          Archive on this component, so the rule — and the class — went with the
          surface that was still asking for it. This header draws none: the
          cards' own ground gap is the only separation, and §8's standing
          "nothing on `--board` uses `--strip-hi` as its only separator" rule
          does not apply, because a gap is not a stroke. */}
      <div className="board-col-head">
        {ramp === null ? <Dot /> : <Dot tone={`ramp-${ramp}`} />}
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
