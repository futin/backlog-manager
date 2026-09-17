import type { ReactNode } from 'react';

/** The tones a figure's value may carry — the ramp read as a verdict, never as decoration. */
export type FigureTone = 'ink' | 'live' | 'good' | 'warn' | 'bad';

/**
 * FigureStrip and Figure — .claude/DESIGN.md §8.4's "one card the ground
 * divides".
 *
 * Six figures on Runs › History and three on Watchdog are ONE sheet cut by its
 * own ground into cells, rather than six cards in a row: six cards would draw
 * six borders and six shadows to say one thing, and the reading a person wants
 * is the row, not any cell in it. The strip wraps 5 → 3 → 2 across the
 * breakpoints (the design spec's §12.2) so the row never becomes a column of
 * one-cell cards on the way down.
 *
 * `line` is §1's delta line — "a 12 px line mixing two colors, the number
 * colored and the trailing words grey" — and takes a node rather than a string
 * precisely so the caller can colour that number without this component
 * growing a formatting vocabulary of its own.
 */
/**
 * `cols` is the strip's widest column count, and it is a PROP rather than a
 * second class family on the composing page because that is the rule §12.1
 * sets for exactly this case: a surface that needs a variant adds a prop. The
 * two callers genuinely differ — Runs › History carries five figures plus a
 * wide sixth cell, Runs › Watchdog carries three (DESIGN.md §8.4.2) — and a
 * three-figure strip laid into a five-column grid would leave two empty cells
 * of `--strip` beside the last one, which reads as a figure that failed to
 * load rather than as a row of three.
 *
 * It names the count at the WIDEST width only; both variants still wrap down
 * through the same 1100/700 breakpoints, so neither page has its own
 * responsive story to keep in agreement with the other.
 */
/* `className` is the page's own LAYOUT class and never a second look — see `Band`'s own note for the contract, which is `Sheet`'s. `cols` stays a prop
   because 3-vs-5 is a fact about the CONTENT (how many cells there are); where the strip stands is a fact about the page, and the two must not be
   confused into one knob. */
export function FigureStrip({ children, cols = 5, testId, className }: { children: ReactNode; cols?: 3 | 5; testId?: string; className?: string }) {
  const base = cols === 3 ? 'ui-figure-strip ui-figure-strip-3' : 'ui-figure-strip';
  return (
    <div className={className ? `${base} ${className}` : base} data-testid={testId}>
      {children}
    </div>
  );
}

export function Figure({
  label,
  value,
  unit,
  line,
  tone = 'ink',
  wide,
  title,
  testId,
  children
}: {
  label: ReactNode;
  /**
   * Optional, and the one cell that omits it is why: History's sixth, wide
   * cell's subject is a seven-row chart rather than a number (§8.4.1 — "at
   * full width the bar is now the cell's subject rather than a sparkline
   * beside a number"), and a 30/700 figure over it would be a second headline
   * competing with the rows it summarises. Every other cell in this app has
   * one.
   */
  value?: ReactNode;
  unit?: ReactNode;
  line?: ReactNode;
  tone?: FigureTone;
  /** The sixth figure on History's strip, which takes the row's full width. */
  wide?: boolean;
  /**
   * The long-form reading a cell's label and line cannot hold — `rework /
   * completed`'s full sentence about what the ratio divides (§8.4.1 keeps it
   * "as the cell's `title`"). A native `title`, not a tooltip component: it is
   * a clarification a reader may want once, not a reading the cell owes them.
   */
  title?: string;
  /** A hook on the CELL, so a suite can scope an assertion to one figure —
   *  its value, its line and its label together — rather than reaching for a
   *  `closest('.ui-figure')` from whatever inner span happened to carry one.
   *  Named `testId` like `StageBars`' own, not a `data-*` pass-through, so the
   *  one attribute this component forwards stays one attribute. */
  testId?: string;
  /** What the cell draws INSTEAD of a value, under the label and line — the
   *  wide cell's `StageBars`, and nothing else today. */
  children?: ReactNode;
}) {
  return (
    <div className={wide ? 'ui-figure ui-figure-wide' : 'ui-figure'} title={title} data-testid={testId}>
      <span className="ui-figure-label">{label}</span>
      {value !== undefined && (
        <span className={`ui-figure-value ui-figure-${tone}`}>
          {value}
          {unit && <span className="ui-figure-unit">{unit}</span>}
        </span>
      )}
      {line && <span className="ui-figure-line">{line}</span>}
      {children}
    </div>
  );
}
