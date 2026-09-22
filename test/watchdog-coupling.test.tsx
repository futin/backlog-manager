/**
 * @jest-environment jsdom
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { RunControls } from '../client/src/components/RunControls';
import type { RunControlsRun } from '../client/src/components/RunControls';
import { watchdogStoodDown } from '../shared/agent';
import { COUPLING_ROWS, rowWatchdog } from './helpers/watchdog-coupling';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun } from '../shared/types';

/**
 * The CLIENT half of the Resume/stand-down coupling — the sweeper half lives
 * in `test/watchdog-sweep.test.ts` ("the Resume coupling"), driven from the
 * same `COUPLING_ROWS` table, because one is a React tree in jsdom and the
 * other a Nest app in node and no single `it` can hold both.
 *
 * What the two halves together assert, and why it needs saying in a file of
 * its own: **the board offers a hand resume exactly when the watchdog will not
 * spawn one.** That sentence is the only thing standing between a person's
 * click and the sweeper's next tick both driving `--resume` into the same
 * `run.json` — `AgentsService.resume()` refuses a *fresh* run, not a second
 * resume of a crashed one, and grace is a backoff measured from the last
 * spawn, not a lock. Two `--resume` sessions reconcile, stage-write and merge
 * against a run file whose single-writer guarantee assumes one process, and
 * both end in a merge to `main`.
 *
 * ## task-38: the rendering leg is back, and it drives `RunControls`
 *
 * task-37 deleted the client surface this suite used to drive (`RunStrip`'s
 * crashed strip), leaving the coupling vacuously true for two merges and this
 * file standing on a source scan alone. task-38 restored it in the place
 * DESIGN.md §8.4.1's moved-rules table names: the Runs detail sheet's head,
 * which is `RunControls`.
 *
 * So the rendering leg below renders `RunControls` for a crashed run in each
 * row's watchdog state and asserts the control appears on exactly
 * `row.standsDown`. Two things make that the whole client half rather than one
 * of several:
 *
 *  - `RunControls` is the ONLY client reader of `watchdogStoodDown`, which
 *    leg three pins. The Watchdog page's own Resume (§8.4.2) is this same
 *    component, not a second control that agrees with it — which is why that
 *    page does not appear in the reader list below and must not start to.
 *  - The environment half of the gate (`resumeGate`) is held open in every
 *    case here, deliberately: `run-controls.test.tsx` owns the cases where it
 *    is not, and mixing the two would let a row pass for the wrong reason.
 */
const ROOT = join(__dirname, '..');
const fixture = rawFixture as OrchestratorRun;
const OPEN_GATE = { canResume: true, blockedReason: null };

describe('the Resume stand-down verdict', () => {
  /**
   * Leg one, and the leg the helper's own comment calls load-bearing: the
   * predicate against each row's hand-checked verdict. Without it both
   * implementations could agree with a `watchdogStoodDown` that had been
   * broken into a constant, and every suite would stay green while saying
   * something false.
   */
  it.each(COUPLING_ROWS)('$name', (row) => {
    expect(watchdogStoodDown(rowWatchdog(row))).toBe(row.standsDown);
  });

  /**
   * Leg two, restored by task-38: what the CLIENT actually draws for each row.
   *
   * A crashed run — `status: 'running'` with a dead heartbeat, which is
   * `isCrashed`'s whole definition — in each row's watchdog state, rendered
   * through the detail sheet's head. The Resume control appears on exactly
   * `row.standsDown` and on nothing else, which is the sentence at the top of
   * this file expressed as a rendering.
   */
  it.each(COUPLING_ROWS)('draws the detail head Resume iff the sweeper stands down — $name', (row) => {
    const run: RunControlsRun = {
      status: 'running',
      project: fixture.project,
      fresh: false,
      pauseRequested: false,
      stopRequested: false,
      queue: fixture.queue.map((q) => ({ id: q.id, stage: q.stage })),
      watchdog: rowWatchdog(row)
    };
    render(<RunControls run={run} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />);

    expect(screen.queryByTestId('run-controls-resume') !== null).toBe(row.standsDown);
    // And never the other two: a crashed run has nothing to pause and no
    // pause request to cancel, so a head offering either would be claiming
    // this board can still talk to the process.
    expect(screen.queryByTestId('run-controls-pause')).toBeNull();
    expect(screen.queryByTestId('run-controls-cancel')).toBeNull();
    // bug-39: Stop is drawn on EVERY row, which is what keeps this table a
    // statement about the RESUME coupling alone. A crashed run is always
    // stoppable — that is the bug this control closes — so a Stop that
    // varied with `standsDown` would mean the two questions had been folded
    // into one again.
    expect(screen.getByTestId('run-controls-stop')).toBeInTheDocument();
  });

  /**
   * bug-39's leg, and a SECOND pass over the same rows rather than a
   * `stopRequested` column, for the reason `test/watchdog-sweep.test.ts`'s
   * own stop leg gives: the answer under a stop does not vary by row, so a
   * column would be one rule written out seven times. Swept over every row
   * anyway — including the rows where the sweeper WOULD spawn and the head
   * would otherwise offer nothing — because "a stop suppresses both sides"
   * is only worth asserting where the two sides disagree without it.
   */
  it.each(COUPLING_ROWS)('offers no Resume under a stop request, whatever the row says — $name', (row) => {
    const run: RunControlsRun = {
      status: 'running',
      project: fixture.project,
      fresh: false,
      pauseRequested: false,
      stopRequested: true,
      queue: fixture.queue.map((q) => ({ id: q.id, stage: q.stage })),
      watchdog: rowWatchdog(row)
    };
    render(<RunControls run={run} gate={OPEN_GATE} resuming={false} onChanged={jest.fn()} />);

    expect(screen.queryByTestId('run-controls-resume')).toBeNull();
    // What it offers instead is nothing at all (bug-53): a stopped run has
    // nothing to pause, no second stop to ask for, and no stop to withdraw —
    // the `--abort` session the stop spawned is already ending it.
    expect(screen.getByTestId('run-controls-stop-note')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  /**
   * An absent `watchdog` key is its own case, and it is not in the table
   * because it is not a STATE of the sweeper — it is the server not having
   * annotated this run yet (`OrchestratorRunsPayload`'s own doc comment: the
   * narrow window between a run first going crashed and the next annotation
   * pass). An unknown must read as "the sweeper may still act", never as a
   * stand-down, or the one window in which nothing can be known about the
   * sweeper's intentions is the one window a click could race it.
   */
  it('offers no Resume while the server has not annotated the run yet', () => {
    render(
      <RunControls
        run={{
          status: 'running',
          project: fixture.project,
          fresh: false,
          pauseRequested: false,
          stopRequested: false,
          queue: fixture.queue.map((q) => ({ id: q.id, stage: q.stage }))
        }}
        gate={OPEN_GATE}
        resuming={false}
        onChanged={jest.fn()}
      />
    );
    expect(screen.queryByTestId('run-controls-resume')).toBeNull();
    // The Stop is not gated on the annotation and must not become so: a run
    // the server has not described yet is still a run a person can end, and
    // this window — between a run first going crashed and the next
    // annotation pass — is precisely when they are most likely to want to.
    expect(screen.getByTestId('run-controls-stop')).toBeInTheDocument();
  });

  /**
   * Leg three: WHO reads the predicate. A source scan rather than a render,
   * because what is being pinned is the SET of readers — a second client
   * surface that derived the same verdict for itself would render correctly
   * today and drift the day one of the two was widened, which is exactly the
   * defect that survived a whole branch with 1102 tests green.
   *
   * `shared/agent.ts` is where it is declared; `server/src/agents/
   * watchdog.service.ts` is the sweeper's `visit()`; `RunControls.tsx` is the
   * one client surface that offers the click, drawn both in the Runs detail
   * sheet's head and in the Watchdog page's Watching rows. That the Watchdog
   * page is NOT on this list is the point rather than an omission: §8.4.2's
   * `Resume now` is this same component, so the two surfaces read the
   * predicate once between them.
   */
  it('is read by the sweeper and by the one client control that offers the click', () => {
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // The declaration itself is not a reader, and neither is prose: the
        // match is a CALL, which is the only shape that can act on the
        // verdict. Several files mention the name in a comment explaining why
        // they do not read it, and those must not count — nor must
        // `shared/agent.ts`'s own `export function` line, which is a call's
        // twin as far as a regex is concerned.
        const src = readFileSync(full, 'utf8').replace(/export function watchdogStoodDown\s*\(/g, '');
        if (/\bwatchdogStoodDown\s*\(/.test(src)) readers.push(full.slice(ROOT.length + 1));
      }
    };
    walk(join(ROOT, 'client', 'src'));
    walk(join(ROOT, 'server', 'src'));
    walk(join(ROOT, 'shared'));

    expect(readers.sort()).toEqual(['client/src/components/RunControls.tsx', 'server/src/agents/watchdog.service.ts']);
  });
});
