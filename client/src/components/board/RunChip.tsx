import { isCrashed } from '../../lib/run-watchdog';
import { Dot } from '../ui/Dot';
import type { DotTone } from '../ui/Dot';
import type { OrchestratorRun, StartingRun } from '../../../../shared/types';

/** What this chip needs from a run in the payload: its status and whether its
 *  heartbeat is still fresh. A narrow pick, like `ItemCard`'s own `RunCardState`
 *  and for the same reason — everything else on the run belongs to the Runs
 *  section, which is exactly where a click on this chip sends the reader. */
export type RunChipState = Pick<OrchestratorRun, 'status'> & { fresh: boolean };

/**
 * The four readings this chip can carry, worst first — and that order is the
 * whole specification of the dot (DESIGN.md §8.3): crashed over paused or
 * starting over live. The count line names every state present in this same
 * order, so the dot's colour and the words beside it can never be read as
 * disagreeing about which state is the serious one.
 *
 * `paused` and `starting` share a rung deliberately: both mean a run exists and
 * is not moving, and neither outranks the other — a board with one of each has
 * no reason to prefer either colour, and they are the same colour anyway.
 *
 * The tones are reached for by the TOKEN each must paint, not by their names.
 * `--fill-progress` is what §8.3 gives a live run, and on this board's `Dot`
 * that token is the `done` tone (`.ui-dot-done`) — the same fill a reached
 * stage node takes, which is the identical reading seen from a stage track:
 * work has moved. Adding a second tone that painted `--fill-progress` under a
 * happier name would be the synonym §8.2 rules out for tokens, one level down.
 */
const STATES: { key: 'crashed' | 'paused' | 'starting' | 'live'; word: string; tone: DotTone; isRunState: boolean }[] = [
  { key: 'crashed', word: 'crashed', tone: 'crashed', isRunState: true },
  { key: 'paused', word: 'paused', tone: 'live', isRunState: true },
  /* The one entry that is not a state a RUN is in: a starting entry has no run
     file yet, which is the whole reason `StartingRunsService` exists. That is
     what `isRunState: false` is for below — its count is never measured
     against the run total, because the two are counts of different things and
     `1 run · starting` would be claiming the run IS the starting one. */
  { key: 'starting', word: 'starting', tone: 'live', isRunState: false },
  { key: 'live', word: 'live', tone: 'done', isRunState: true }
];

/**
 * The count line the chip prints, e.g. `2 runs · 1 live ›`, `1 run · crashed ›`,
 * `1 starting ›` — the design's own three worked examples (spec §3.2,
 * DESIGN.md §8.3), which this function reproduces exactly.
 *
 * Two rules produce all three:
 *
 *  - The lead segment counts the RUNS in the payload, and is absent when there
 *    are none. That is why `1 starting ›` has no lead: a starting entry is not
 *    a run — there is no run file yet, which is the entire reason
 *    `StartingRunsService` exists.
 *  - Each state a RUN can be in is named, in `STATES` order, with its count —
 *    except when that count is the whole of the run list, where the number
 *    would only repeat the lead segment. That is why `1 run · crashed` says
 *    `crashed` and `2 runs · 1 live` says `1 live`. A starting entry always
 *    keeps its count, because it is not one of the runs the lead counts.
 *
 * Exported so the precedence and the wording are testable without a render,
 * the same bargain `liveBarFor` (ItemCard.tsx) makes.
 */
export function runChipReading(
  runs: readonly RunChipState[],
  starting: readonly StartingRun[]
): { tone: DotTone; line: string; counts: Record<'crashed' | 'paused' | 'starting' | 'live', number> } | null {
  const counts = {
    /* `isCrashed` (lib/run-watchdog.ts) rather than a second `status ===
       'running' && !fresh` written here: a crashed run renders as crashed and
       never as nothing, and the one implementation of "is it crashed" is what
       keeps this chip, the Runs list and the sweeper from drifting about where
       the line falls. */
    crashed: runs.filter((r) => isCrashed(r)).length,
    paused: runs.filter((r) => r.status === 'paused').length,
    starting: starting.length,
    live: runs.filter((r) => r.status === 'running' && r.fresh).length
  };

  if (runs.length === 0 && starting.length === 0) return null;

  const segments: string[] = [];
  if (runs.length > 0) segments.push(`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`);
  for (const state of STATES) {
    const n = counts[state.key];
    if (n === 0) continue;
    // The count is dropped only when it IS the lead segment's number and the
    // two are counting the same things — `1 run · 1 crashed` says one number
    // twice. `starting` is never one of those (see `isRunState` above).
    segments.push(state.isRunState && n === runs.length ? state.word : `${n} ${state.word}`);
  }

  /* The first state present in worst-first order IS the dot, so the colour and
     the words are one derivation rather than two agreeing expressions. A
     payload that carries only finished runs reaches this with no state at all
     — the chip still renders (`1 run ›`), because the rule is "absent when the
     payload carries no run and no starting entry" and a finished run is still
     a run — and takes the quiet default `Dot` paints with no tone at all. */
  const worst = STATES.find((s) => counts[s.key] > 0);

  return { tone: worst?.tone ?? 'done', line: segments.join(' · '), counts };
}

/**
 * RunChip — everything the Board still says about orchestrator runs, in one
 * control that opens Runs (DESIGN.md §8.3, "The run chip").
 *
 * It replaces three components at once — the run strip above the columns,
 * `StartingStrip` and `RunDrawer` — because, in the user's own words when this
 * was decided, "the board can show the issues, but the runs shows more info, no
 * reason to keep it in both places". What stays on the Board is the card's own
 * live strip and this chip; every reading the three departing components
 * carried lands in the Runs section (§8.4.1's own table says where).
 *
 * It reads the payload `BoardView` already holds and issues no request of its
 * own, and it renders the `starting` array with NO client-side filter — the
 * same rule `StartingStrip` followed, carried forward rather than re-derived.
 * The eviction rules that keep a stale placeholder off the board live in
 * `StartingRunsService.expired()` on the server (bug-21), and a filter here
 * would be a second expression agreeing with them until the day it did not.
 *
 * A `<button>`, not a link: there is no router here, and its click calls the
 * same section setter the rail's own Runs entry calls (`App.tsx`'s `change`),
 * so the two cannot drift about what "open Runs" means.
 */
export function RunChip({ runs, starting, onOpen }: { runs: readonly RunChipState[]; starting: readonly StartingRun[]; onOpen: () => void }) {
  const reading = runChipReading(runs, starting);
  // Nothing at all, rather than an empty chip: a control that says "0 runs" is
  // a permanent invitation to read a page with nothing on it.
  if (reading === null) return null;

  return (
    <button type="button" className="board-run-chip" onClick={onOpen} data-testid="run-chip">
      {/* `breathe` only while something is actually moving — §8.8's one motion
          mechanism, and a ring pulsing around a crashed or paused run would be
          an animation asserting something false. */}
      <Dot tone={reading.tone} breathe={reading.counts.live > 0} />
      <span className="board-run-chip-line">{reading.line}</span>
      {/* aria-hidden: the accessible name is the reading alone. The glyph is
          the design's own "this opens somewhere" mark and says nothing a
          screen reader needs said twice. */}
      <span className="board-run-chip-mark" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
