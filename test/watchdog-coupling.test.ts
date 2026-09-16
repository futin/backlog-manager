import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { watchdogStoodDown } from '../shared/agent';
import { COUPLING_ROWS, rowWatchdog } from './helpers/watchdog-coupling';

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
 * ## task-37: this file lost a leg, on purpose, and the second case is what
 * ## makes that temporary
 *
 * The client surface it drove was `RunStrip`'s crashed strip, which this task
 * deleted (DESIGN.md §8.3's "What leaves"). Its replacement is the Runs
 * detail sheet's head — `RunControls` gaining the crashed-run Resume behind
 * this same predicate, which §8.4.1's moved-rules table names outright and
 * task 3 builds. Between this task's merge and that one there is NO
 * crashed-run Resume anywhere in `client/src`, so the rendering leg has
 * nothing to drive and the coupling is, for those two merges, vacuously true.
 *
 * That interim is safe in the one direction that matters: the hazard above is
 * a SECOND spawn, and a client offering no Resume at all cannot cause one. It
 * is a lost affordance, not a lost guarantee — a crashed run is resumed by
 * hand from a terminal until the detail head lands.
 *
 * It is also a coupling that can be silently forgotten, which is what the
 * second case below exists to prevent: it pins the exact set of files that
 * read `watchdogStoodDown`, so the moment a client surface starts reading it
 * this suite goes red and whoever added it has to restore the rendering leg
 * here rather than ship the half of the coupling that only agrees with itself.
 */
const ROOT = join(__dirname, '..');

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
   * Leg two, standing in for the rendering leg until task 3 restores it: WHO
   * reads the predicate. A source scan rather than a render, because what is
   * being pinned is precisely that no component reads it right now — there is
   * no element to query for.
   *
   * `shared/agent.ts` is where it is declared; `server/src/agents/
   * watchdog.service.ts` is the sweeper's `visit()`, the surviving half of the
   * coupling. When the Runs detail head starts reading it, this list gains a
   * client file — and that is the signal to bring back the case this file used
   * to carry: render the head for each row and assert the control appears on
   * exactly `row.standsDown`.
   */
  it('is read by the sweeper alone until the Runs detail head lands (task 3)', () => {
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

    expect(readers.sort()).toEqual(['server/src/agents/watchdog.service.ts']);
  });
});
