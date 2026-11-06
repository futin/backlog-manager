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
  const segments = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('.run-bars-seg'));

  it('renders a legend of seven entries, in MACHINE_STAGES order, each labelled with its own stage name', () => {
    render(<StageBars totals={{ dispatched: 1_000, merging: 500 }} testId="stage-bars" />);

    const items = screen.getAllByTestId(/^stage-bars-/);
    expect(items).toHaveLength(7);
    // Order is pinned by the exact id sequence: the widget is rendered twice on one screen (a run's own card, the range tile) and only stays comparable
    // at a glance if `fixing` sits at the same position in both.
    expect(items.map((item) => item.getAttribute('data-testid'))).toEqual(MACHINE_STAGES.map((stage) => `stage-bars-${stage}`));
    items.forEach((item, i) => {
      expect(item.querySelector('.run-bars-label')).toHaveTextContent(MACHINE_STAGES[i]);
      expect(item.querySelector('.run-bars-swatch')).toHaveAttribute('data-stage', MACHINE_STAGES[i]);
    });
  });

  it('formats a present value with formatSpanCompact and an absent one as an em dash', () => {
    render(<StageBars totals={{ dispatched: 26_760_000, merging: 23_000 }} testId="stage-bars" />);

    expect(screen.getByTestId('stage-bars-dispatched')).toHaveTextContent('7h 26m');
    expect(screen.getByTestId('stage-bars-merging')).toHaveTextContent('23s');
    const absent = screen.getByTestId('stage-bars-fixing').querySelector('.run-bars-value');
    expect(absent).toHaveTextContent('—');
    expect(absent).toHaveClass('run-bars-value-none');
  });

  it('draws a segment only for a stage with time, and the widths sum to 100 %', () => {
    render(<StageBars totals={{ dispatched: 1_000, fixing: 500, merging: 250, verifying: 0 }} testId="stage-bars" />);

    const segs = segments(screen.getByTestId('stage-bars'));
    expect(segs.map((seg) => seg.getAttribute('data-stage'))).toEqual(['dispatched', 'fixing', 'merging']);
    const sum = segs.reduce((acc, seg) => acc + parseFloat(seg.style.width), 0);
    expect(sum).toBeCloseTo(100, 0);
  });

  it('sizes segments by share of the total: 3h and 1h is 75 % and 25 %', () => {
    const hour = 3_600_000;
    render(<StageBars totals={{ dispatched: 3 * hour, fixing: hour }} testId="stage-bars" />);

    const segs = segments(screen.getByTestId('stage-bars'));
    expect(segs.map((seg) => seg.style.width)).toEqual(['75.0%', '25.0%']);
  });

  it('renders seven dashes and no segment for empty totals — the bar is still drawn', () => {
    render(<StageBars totals={{}} testId="stage-bars" />);

    const root = screen.getByTestId('stage-bars');
    expect(root).toHaveClass('run-bars');
    expect(root.querySelector('.run-bars-bar')).toBeInTheDocument();
    expect(segments(root)).toHaveLength(0);
    expect(root.querySelectorAll('.run-bars-value-none')).toHaveLength(7);
    expect(root.querySelectorAll('.run-bars-value')).toHaveLength(7);
  });
});
