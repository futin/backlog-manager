/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { RunStrip } from '../client/src/components/board/RunStrip';
import { watchdogStoodDown } from '../shared/agent';
import { COUPLING_ROWS, rowWatchdog } from './helpers/watchdog-coupling';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun, RunWatchdog } from '../shared/types';

/**
 * The BOARD half of the Resume/stand-down coupling — the sweeper half lives
 * in `test/watchdog-sweep.test.ts` ("the Resume coupling"), driven from the
 * same `COUPLING_ROWS` table, because one is a React tree in jsdom and the
 * other a Nest app in node and no single `it` can hold both.
 *
 * What the two halves together assert, and why it needs saying in a file of
 * its own rather than as another row in the strip's own suite: **the board
 * offers a hand resume exactly when the watchdog will not spawn one.** That
 * sentence is the only thing standing between a person's click and the
 * sweeper's next tick both driving `--resume` into the same `run.json` —
 * `AgentsService.resume()` refuses a *fresh* run, not a second resume of a
 * crashed one, and grace is a backoff measured from the last spawn, not a
 * lock. Two `--resume` sessions reconcile, stage-write and merge against a
 * run file whose single-writer guarantee assumes one process, and both end
 * in a merge to `main`.
 *
 * `test/orchestrator-strip.test.tsx` already pins the two states in which
 * Resume renders (exhausted, and off) and the two board-side blocks. What it
 * cannot pin — what nothing pinned until the whole-branch review — is that
 * those states are the SAME states the sweeper stands down in. The proof it
 * was unpinned is concrete: widening `showResume` to `canResume === true`
 * left all 1102 tests green.
 *
 * Every case passes `canResume` — the board-side half of the gate — as true,
 * so the watchdog record is the only thing deciding, which is what makes a
 * widened condition here go red instead of merely rendering more.
 */
const fixture = rawFixture as OrchestratorRun;

type Payload = OrchestratorRun & { fresh: boolean; pastRuns: number; watchdog?: RunWatchdog };

/** A crashed run (`status: 'running'` from the fixture, `fresh: false`) —
 *  `isCrashed`'s own definition — carrying this row's watchdog record. */
function crashed(watchdog: RunWatchdog): Payload {
  return { ...fixture, fresh: false, pastRuns: 0, watchdog };
}

describe('the Resume control renders exactly when the watchdog has stood down', () => {
  it.each(COUPLING_ROWS)('$name', (row) => {
    const watchdog = rowWatchdog(row);

    // Leg one: the predicate itself, against the row's hand-checked verdict.
    // Without this, both halves could agree with a `watchdogStoodDown` that
    // had been broken into a constant and this suite would still pass.
    expect(watchdogStoodDown(watchdog)).toBe(row.standsDown);

    // Leg two: the board renders the control on exactly that verdict.
    render(<RunStrip run={crashed(watchdog)} onOpen={() => {}} canResume />);

    const button = screen.queryByRole('button', { name: 'Resume run' });
    expect(button === null).toBe(!row.standsDown);
  });
});
