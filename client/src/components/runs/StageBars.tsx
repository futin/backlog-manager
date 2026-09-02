import { MACHINE_STAGES } from '../../lib/run-stats';
import { formatSpanCompact } from '../../lib/run-time';
import type { StageTotals } from '../../lib/run-stats';

/**
 * `StageBars`: seven horizontal bars, one per `MACHINE_STAGES` entry,
 * answering "where did the time actually go" over an already-computed
 * `StageTotals` record. `runStageTotals`/`sumStageTotals` (lib/run-stats.ts)
 * have produced this number since an earlier task — exported, tested, and
 * until this file, never rendered anywhere.
 *
 * Rendered twice, and knows nothing about either caller: once inside the
 * per-run detail pane over a single run's own `runStageTotals(authority,
 * now)` (Task 6), and once as a wide toolbar tile over `sumStageTotals`
 * folded across every run in the visible range (Task 7). This component only
 * ever takes the already-derived totals plus a `testId` to namespace its
 * rows under — no fetching, no arithmetic beyond the one `pct` below —
 * matching the "derive in lib/, render in components/" split the rest of
 * this feature keeps.
 *
 * NOT the per-item stage bar. The existing `.run-detail-stagebar`
 * (RunDetail.tsx, predating this redesign, slated for deletion once
 * `StageTrack.tsx` — Task 5 — replaces it) answers a different question: how
 * ONE item's own time split across the stages it personally visited, drawn
 * as one bar per ITEM with a segment per stage. This widget answers "across
 * this whole run (or range), how much did each stage category cost in
 * total" — one bar per STAGE, summed over every item — which is why the two
 * do not share a colour model: no per-stage tone here at all (see
 * styles.css's `.run-bars*` block for that reasoning in full), just a fixed
 * seven rows in one hue.
 *
 * ALWAYS SEVEN ROWS, ALWAYS IN PIPELINE ORDER — the `MACHINE_STAGES.map`
 * below never filters, so a stage this run/range never recorded still gets
 * its row, reading `—` rather than disappearing (see this file's own test
 * suite's empty-totals case). Dropping empty rows would misreport "no time
 * recorded" as "this stage does not exist for this run," and — since this
 * component is deliberately rendered twice on the same screen, a run's own
 * card beside the range-wide tile — a variable row count would also mean
 * `fixing` sits at a different vertical position in each, defeating the
 * side-by-side comparison both instances exist to support.
 */
export function StageBars({ totals, testId }: { totals: StageTotals; testId: string }): JSX.Element {
  // Floored at 1, never 0: every entry could legitimately be absent (a run
  // that aborts before ever leaving `pending` records nothing in any of the
  // seven), and dividing by an all-zero max would put `NaN%` into every
  // bar's width.
  // The floor only ever changes the DIVISOR, never which bars end up drawn —
  // the `ms > 0` guard below still hides a bar for every stage the floor was
  // needed for, so a run with genuinely nothing recorded still renders seven
  // dashes and zero fills rather than seven bars of NaN width.
  const max = Math.max(1, ...MACHINE_STAGES.map((stage) => totals[stage] ?? 0));

  return (
    <div className="run-bars" data-testid={testId}>
      {MACHINE_STAGES.map((stage) => {
        const ms = totals[stage] ?? 0;
        // One decimal place, matching `.run-bars-value`'s own tabular-nums
        // precision (styles.css) — so two stages whose totals are close but
        // not equal still draw two visibly different bar lengths instead of
        // both rounding to the same whole percent.
        const pct = ((ms / max) * 100).toFixed(1);
        return (
          <div key={stage} className="run-bars-row" data-testid={`${testId}-${stage}`}>
            <span className="run-bars-label">{stage}</span>
            <span className="run-bars-track">
              {/* No bar at all — not a zero-width one — for an absent or
                  literally-zero stage, so "never recorded" reads as the same
                  honest blank the `—` value beside it names (styles.css's
                  `.run-bars*` header comment has the reasoning in full).
                  `aria-hidden`: the value span already carries this same
                  reading as text, so the fill would only ever be a
                  redundant announcement to assistive tech. */}
              {ms > 0 && <span className="run-bars-fill" style={{ width: `${pct}%` }} aria-hidden="true" />}
            </span>
            <span className={`run-bars-value${ms > 0 ? '' : ' run-bars-value-none'}`}>
              {ms > 0 ? formatSpanCompact(ms) : '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
