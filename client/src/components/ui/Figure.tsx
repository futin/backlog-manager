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
export function FigureStrip({ children }: { children: ReactNode }) {
  return <div className="ui-figure-strip">{children}</div>;
}

export function Figure({
  label, value, unit, line, tone = 'ink', wide
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  line?: ReactNode;
  tone?: FigureTone;
  /** The sixth figure on History's strip, which takes the row's full width. */
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'ui-figure ui-figure-wide' : 'ui-figure'}>
      <span className="ui-figure-label">{label}</span>
      <span className={`ui-figure-value ui-figure-${tone}`}>
        {value}
        {unit && <span className="ui-figure-unit">{unit}</span>}
      </span>
      {line && <span className="ui-figure-line">{line}</span>}
    </div>
  );
}
