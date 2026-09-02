/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { StageTrack } from '../client/src/components/runs/StageTrack';
import { STEPPER_STAGES } from '../client/src/lib/run-time';
import type { RunQueueItem, RunStage } from '../shared/types';

/**
 * `StageTrack` renders `stepperDots`'/`itemStageSpans`'s already-tested
 * output (run-time.ts, run-stats.ts) as the full-width, per-node-duration
 * stepper the design doc calls for. This suite exercises the RENDERING
 * decisions layered on top of that data — which of four sources fills a
 * node's value span, the segment-state algebra (`data-in`/`data-out`), the
 * fix-loop badge — against hand-built fixtures; it does not re-derive or
 * re-pin `stepperDots`'/`itemStageSpans`'s own arithmetic, which already has
 * its own suite in run-time.test.ts/run-stats.test.ts.
 *
 * Same fixed-clock convention as run-time.test.ts: `T0` and `at(offset)`,
 * with `now` always passed to the component explicitly rather than read
 * from the real clock — case 9 below is the one that pins that directly,
 * by rerendering with an advanced `now` and checking the reading advances
 * by exactly that much.
 */
const T0 = Date.parse('2026-08-31T09:20:45Z');

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

/**
 * The local `HH:MM` `formatClock` (run-time.ts) would print for this stamp,
 * built the same hand way run-time-ui.test.tsx's own clock assertions
 * already are, rather than importing the function under (indirect) test.
 */
function clockOf(iso: string): string {
  const local = new Date(Date.parse(iso));
  const hh = `${local.getHours()}`.padStart(2, '0');
  const mm = `${local.getMinutes()}`.padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Just the four fields StageTrack reads — never a whole RunQueueItem, which would bury them. */
function trackItem(
  id: string,
  stage: RunStage,
  stageAt: Partial<Record<RunStage, string>>,
  fixLoops = 0
): Pick<RunQueueItem, 'id' | 'stage' | 'stageAt' | 'fixLoops'> {
  return { id, stage, stageAt, fixLoops };
}

describe('StageTrack', () => {
  it('renders seven nodes, one per STEPPER_STAGES entry, in pipeline order, each named for its own stage', () => {
    const { container } = render(
      <StageTrack item={trackItem('bug-1', 'pending', { pending: at(0) })} now={T0} />
    );

    const nodes = Array.from(container.querySelectorAll('.run-track-node'));
    expect(nodes).toHaveLength(7);
    // Order asserted structurally, not just by count — same reasoning
    // stage-bars.test.tsx pins its own row order on: the seven columns only
    // stay meaningful if `fixing` sits at the same position every render.
    expect(nodes.map((n) => n.getAttribute('data-testid'))).toEqual(
      STEPPER_STAGES.map((stage) => `run-track-bug-1-${stage}`)
    );
    nodes.forEach((node, i) => {
      expect(node.querySelector('.run-track-name')).toHaveTextContent(STEPPER_STAGES[i]);
    });
  });

  it('prints each visited node\'s own stage span, the finish clock on merged, and leaves a cleanly-skipped stage hollow on a green line', () => {
    const stageAt = {
      pending: at(0), preflight: at(15_000), dispatched: at(60_000), inspecting: at(360_000),
      reviewing: at(380_000), verifying: at(700_000), merging: at(760_000), merged: at(772_000)
    };
    render(<StageTrack item={trackItem('bug-2', 'merged', stageAt)} now={T0 + 1_000_000} />);

    expect(screen.getByTestId('run-track-bug-2-dispatched-val')).toHaveTextContent('5m 00s');
    expect(screen.getByTestId('run-track-bug-2-inspecting-val')).toHaveTextContent('20s');
    expect(screen.getByTestId('run-track-bug-2-reviewing-val')).toHaveTextContent('5m 20s');
    expect(screen.getByTestId('run-track-bug-2-verifying-val')).toHaveTextContent('1m 00s');
    expect(screen.getByTestId('run-track-bug-2-merging-val')).toHaveTextContent('12s');

    // `fixing` was never visited, but sits between two visited neighbours
    // (reviewing, verifying) — hollow dot, green line straight through it.
    const fixingNode = screen.getByTestId('run-track-bug-2-fixing');
    expect(fixingNode.querySelector('.run-track-dot')).toHaveClass('run-track-dot-hollow');
    const fixingVal = screen.getByTestId('run-track-bug-2-fixing-val');
    expect(fixingVal).toHaveTextContent('—');
    expect(fixingVal).toHaveClass('run-track-val-none');
    expect(fixingNode).toHaveAttribute('data-in', 'done');
    expect(fixingNode).toHaveAttribute('data-out', 'done');

    const mergedVal = screen.getByTestId('run-track-bug-2-merged-val');
    expect(mergedVal).toHaveClass('run-track-val-when');
    expect(mergedVal).toHaveTextContent(clockOf(at(772_000)));

    expect(screen.getByTestId('run-track-bug-2-dispatched')).toHaveAttribute('data-in', 'none');
    expect(screen.getByTestId('run-track-bug-2-merged')).toHaveAttribute('data-out', 'none');
  });

  it('rings the current node, ticks its value from `now`, hollows what is still ahead, and carries the fix-loop badge', () => {
    const stageAt = {
      pending: at(0), dispatched: at(10_000), inspecting: at(20_000),
      reviewing: at(30_000), fixing: at(40_000)
    };
    render(<StageTrack item={trackItem('bug-3', 'fixing', stageAt, 1)} now={T0 + 684_000} />);

    const fixingNode = screen.getByTestId('run-track-bug-3-fixing');
    expect(fixingNode.querySelector('.run-track-dot')).toHaveClass('run-track-dot-current');
    expect(fixingNode).toHaveAttribute('data-in', 'live');
    expect(screen.getByTestId('run-track-bug-3-fixing-val')).toHaveTextContent('10m 44s');

    for (const stage of ['verifying', 'merging', 'merged']) {
      const node = screen.getByTestId(`run-track-bug-3-${stage}`);
      expect(node.querySelector('.run-track-dot')).toHaveClass('run-track-dot-hollow');
      expect(node).toHaveAttribute('data-in', 'idle');
      expect(screen.getByTestId(`run-track-bug-3-${stage}-val`)).toHaveTextContent('—');
    }

    const badge = screen.getByTestId('run-track-bug-3-loops');
    expect(badge).toHaveTextContent('×1');
    expect(badge).toHaveAttribute('title', '1 fix loop');
    expect(badge).toHaveAttribute('aria-label', '1 fix loop');
  });

  it('pluralises the fix-loop badge at 2 and renders no badge at all when fixLoops is 0', () => {
    const stageAt = { pending: at(0), dispatched: at(10_000), fixing: at(40_000) };

    const { rerender } = render(<StageTrack item={trackItem('bug-4', 'fixing', stageAt, 2)} now={T0 + 100_000} />);
    const badge = screen.getByTestId('run-track-bug-4-loops');
    expect(badge).toHaveTextContent('×2');
    expect(badge).toHaveAttribute('aria-label', '2 fix loops');

    rerender(<StageTrack item={trackItem('bug-4', 'fixing', stageAt, 0)} now={T0 + 100_000} />);
    expect(screen.queryByTestId('run-track-bug-4-loops')).not.toBeInTheDocument();
  });

  it('renders a fully hollow track for a pending item, with no live segment anywhere', () => {
    const { container } = render(
      <StageTrack item={trackItem('bug-5', 'pending', { pending: at(0) })} now={T0} />
    );

    expect(screen.getByTestId('run-track-bug-5')).toBeInTheDocument();

    const dots = container.querySelectorAll('.run-track-dot');
    expect(dots).toHaveLength(7);
    dots.forEach((dot) => expect(dot).toHaveClass('run-track-dot-hollow'));

    container.querySelectorAll('.run-track-node').forEach((node) => {
      expect(['none', 'idle']).toContain(node.getAttribute('data-in'));
      expect(['none', 'idle']).toContain(node.getAttribute('data-out'));
    });
    expect(container.querySelectorAll('[data-in="live"]')).toHaveLength(0);
  });

  it('renders nothing for an ungroomed item', () => {
    const { container } = render(<StageTrack item={trackItem('bug-6', 'ungroomed', {})} now={T0} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('run-track-bug-6')).not.toBeInTheDocument();
  });

  it('fills through the last-visited stage on a parked item, rings nothing, and reads the merged value as — rather than a clock', () => {
    const stageAt = { pending: at(0), dispatched: at(5_000), inspecting: at(10_000) };
    const { container } = render(<StageTrack item={trackItem('bug-7', 'parked', stageAt)} now={T0 + 500_000} />);

    expect(screen.getByTestId('run-track-bug-7-dispatched').querySelector('.run-track-dot'))
      .toHaveClass('run-track-dot-filled');
    // `inspecting` is visited (filled) but, unlike bug-2's `fixing` gap, it is
    // the item's own LAST recorded arrival — nothing came after it for
    // `itemStageSpans` to measure it against, so it reads — same as a hollow
    // node despite being filled. Visited and "has a value" are not the same
    // fact, and this is the case that tells them apart.
    expect(screen.getByTestId('run-track-bug-7-inspecting').querySelector('.run-track-dot'))
      .toHaveClass('run-track-dot-filled');
    expect(screen.getByTestId('run-track-bug-7-inspecting-val')).toHaveTextContent('—');
    expect(container.querySelectorAll('.run-track-dot-current')).toHaveLength(0);

    const mergedVal = screen.getByTestId('run-track-bug-7-merged-val');
    expect(mergedVal).toHaveTextContent('—');
    expect(mergedVal).toHaveClass('run-track-val-none');
    expect(mergedVal).not.toHaveClass('run-track-val-when');
  });

  it('reads a hollow — with -none when the current stage\'s own stamp will not parse', () => {
    const stageAt = { dispatched: at(0), inspecting: at(10_000), reviewing: at(20_000), fixing: 'garbage' };
    render(<StageTrack item={trackItem('bug-8', 'fixing', stageAt)} now={T0 + 100_000} />);

    const fixingVal = screen.getByTestId('run-track-bug-8-fixing-val');
    expect(fixingVal).toHaveTextContent('—');
    expect(fixingVal).toHaveClass('run-track-val-none');
  });

  it('reads its current-stage value from the `now` prop, never the real clock', () => {
    const stageAt = { dispatched: at(0), inspecting: at(5_000), reviewing: at(10_000), fixing: at(15_000) };
    const item = trackItem('bug-9', 'fixing', stageAt);

    const { rerender } = render(<StageTrack item={item} now={T0 + 135_000} />);
    expect(screen.getByTestId('run-track-bug-9-fixing-val')).toHaveTextContent('2m 00s');

    rerender(<StageTrack item={item} now={T0 + 195_000} />);
    expect(screen.getByTestId('run-track-bug-9-fixing-val')).toHaveTextContent('3m 00s');
  });
});
