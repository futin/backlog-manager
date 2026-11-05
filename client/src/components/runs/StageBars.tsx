import { MACHINE_STAGES } from '../../lib/run-stats';
import { formatSpanCompact } from '../../lib/run-time';
import type { StageTotals } from '../../lib/run-stats';

/**
 * `StageBars`: one stacked 10 px bar of machine time over a legend of all seven `MACHINE_STAGES`, answering "where did the time actually go" over an
 * already-computed `StageTotals`. Rendered twice and knows nothing about either caller: inside the per-run detail pane over `runStageTotals`, and as the
 * wide Runs tile over `sumStageTotals` folded across the visible range. It takes the derived totals plus a `testId` to namespace its legend entries under —
 * no fetching, no arithmetic beyond the one share below.
 *
 * The bar carries a segment ONLY for a stage that recorded time, width = its share of the total, so the widths sum to 100 %. The legend carries ALL seven,
 * always in pipeline order, a stage with nothing reading `—`: dropping the empty ones would misreport "no time recorded" as "this stage does not exist for
 * this run", and — since the widget sits twice on one screen — would put `fixing` at a different position in each, defeating the side-by-side comparison.
 * An empty total still draws the (empty) bar for the same reason: the widget never hides.
 *
 * Segment width goes through React's `style` prop, which is CSSOM and so allowed under `style-src 'self'`; the colour is a flat token chosen by `data-stage`
 * in styles.css, never a tint. Segments and swatches are `aria-hidden`: the legend's text is the reading, and the bar only repeats it.
 *
 * NOT the per-item stage bar: `StageTrack` answers how ONE item's time split across the stages it visited; this answers how a whole run (or range) split.
 */
export function StageBars({ totals, testId }: { totals: StageTotals; testId: string }): JSX.Element {
  // Floored at 1, never 0: every entry could be absent (a run that aborts before leaving `pending` records nothing) and an all-zero divisor would put
  // `NaN%` into a width. The floor only changes the divisor — the `ms > 0` guard still keeps every empty stage out of the bar.
  const total = Math.max(1, MACHINE_STAGES.reduce((sum, stage) => sum + (totals[stage] ?? 0), 0));

  return (
    <div className="run-bars" data-testid={testId}>
      <div className="run-bars-bar" aria-hidden="true">
        {MACHINE_STAGES.map((stage) => {
          const ms = totals[stage] ?? 0;
          if (ms <= 0) return null;
          // One decimal place, so two close stages still draw visibly different lengths.
          return <span key={stage} className="run-bars-seg" data-stage={stage} style={{ width: `${((ms / total) * 100).toFixed(1)}%` }} />;
        })}
      </div>
      <div className="run-bars-legend">
        {MACHINE_STAGES.map((stage) => {
          const ms = totals[stage] ?? 0;
          return (
            <div key={stage} className="run-bars-item" data-testid={`${testId}-${stage}`}>
              <span className="run-bars-swatch" data-stage={stage} aria-hidden="true" />
              <span className="run-bars-label">{stage}</span>
              <span className={`run-bars-value${ms > 0 ? '' : ' run-bars-value-none'}`}>{ms > 0 ? formatSpanCompact(ms) : '—'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
