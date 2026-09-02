/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { StageBars } from '../client/src/components/runs/StageBars';
import { MACHINE_STAGES } from '../client/src/lib/run-stats';

/**
 * `StageBars` renders `runStageTotals`'/`sumStageTotals`'s output (both
 * exported and covered by run-stats.test.ts since an earlier task, neither
 * ever rendered anywhere before this one) as the seven-row "where did the
 * time go" breakdown the design doc calls for. This suite exercises the
 * widget in isolation against a bare `StageTotals` object built by hand — it
 * does not re-derive totals from a run fixture, because that derivation
 * already has its own suite and re-testing the arithmetic here would only be
 * pinning the same numbers twice under two different names.
 *
 * `testId` is asserted throughout via a literal `'stage-bars'`. The
 * component takes it as a prop specifically so its two real callers (the
 * per-run detail pane, the range-wide toolbar tile) can render side by side
 * on one page without colliding on the same test id — a literal here is
 * enough to prove the prop actually reaches every row, without needing a
 * second literal to prove the point twice.
 */
describe('StageBars', () => {
  it('renders exactly seven rows, in MACHINE_STAGES order, each labelled with its own stage name', () => {
    render(<StageBars totals={{ dispatched: 1_000, merging: 500 }} testId="stage-bars" />);

    const rows = screen.getAllByTestId(/^stage-bars-/);
    expect(rows).toHaveLength(7);
    // Order is asserted structurally, not just by count: a widget rendered
    // twice on the same screen (a run's own card, the range-wide tile) only
    // stays comparable at a glance if `fixing` sits at the same position in
    // both, which this pins by checking the exact id sequence, not just that
    // the seven expected ids exist somewhere in the document.
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(
      MACHINE_STAGES.map((stage) => `stage-bars-${stage}`)
    );

    rows.forEach((row, i) => {
      expect(row).toHaveClass('run-bars-row');
      expect(row.querySelector('.run-bars-label')).toHaveTextContent(MACHINE_STAGES[i]);
    });
  });

  it('formats a present value with formatSpanCompact', () => {
    render(<StageBars totals={{ dispatched: 26_760_000, merging: 23_000 }} testId="stage-bars" />);

    expect(screen.getByTestId('stage-bars-dispatched')).toHaveTextContent('7h 26m');
    expect(screen.getByTestId('stage-bars-merging')).toHaveTextContent('23s');
  });

  it('prints an em dash with the -none modifier and no fill for an absent stage', () => {
    render(<StageBars totals={{ dispatched: 1_000 }} testId="stage-bars" />);

    const row = screen.getByTestId('stage-bars-fixing');
    const value = row.querySelector('.run-bars-value');
    expect(value).toHaveTextContent('—');
    expect(value).toHaveClass('run-bars-value-none');
    expect(row.querySelector('.run-bars-fill')).not.toBeInTheDocument();
  });

  // The fixture's two present values are 2:1, so the widths must land on
  // exactly 100.0% and 50.0% — not merely "the first bigger than the
  // second" — which is what actually proves `pct`'s one-decimal formatting
  // and its `ms / max` arithmetic rather than just its direction.
  it('scales bar widths to the largest value in the set', () => {
    render(<StageBars totals={{ dispatched: 1_000, fixing: 500 }} testId="stage-bars" />);

    const dispatchedFill = screen.getByTestId('stage-bars-dispatched').querySelector('.run-bars-fill') as HTMLElement;
    const fixingFill = screen.getByTestId('stage-bars-fixing').querySelector('.run-bars-fill') as HTMLElement;
    expect(dispatchedFill.style.width).toBe('100.0%');
    expect(fixingFill.style.width).toBe('50.0%');
  });

  it('renders seven dashes and zero fills for empty totals — the widget never hides', () => {
    render(<StageBars totals={{}} testId="stage-bars" />);

    const root = screen.getByTestId('stage-bars');
    expect(root).toHaveClass('run-bars');
    expect(root.querySelectorAll('.run-bars-row')).toHaveLength(7);
    expect(root.querySelectorAll('.run-bars-fill')).toHaveLength(0);
    expect(root.querySelectorAll('.run-bars-value-none')).toHaveLength(7);
  });
});
