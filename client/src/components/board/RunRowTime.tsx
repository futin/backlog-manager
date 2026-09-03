import { formatSpan, isTerminalStage, itemDoneClock, itemDurationMs } from '../../lib/run-time';
import type { RunQueueItem, RunStage } from '../../../../shared/types';

/**
 * `RowTime`: one queue row's time reading, moved out of RunDrawer.tsx (its
 * first and, until now, only reader) so the Runs section's detail pane
 * (`RunDetail.tsx`, Task 6) can render the identical thing instead of
 * deriving its own.
 *
 * Lives in `board/` rather than `runs/` for the same reason `ItemCard.tsx`'s
 * `ACTIVE_RUN_STAGES` does, and the precedent is not hypothetical:
 * `RunDetail.tsx` already imports `ACTIVE_RUN_STAGES` from
 * `../board/ItemCard`, so `runs/` reading a run-stage vocabulary out of
 * `board/` is an established direction of dependency here, not a new one
 * this move invents. The drawer got here first; that is reason enough for
 * this to stay beside it rather than move to where its newer reader lives.
 *
 * Shared because there has to be exactly ONE reading of "how long did this
 * item take" for the drawer and the detail pane to ever agree with each
 * other. The pane's own version counted queue wait — the stretch between an
 * item's `pending` stamp and the moment work on it actually began — back
 * into the duration it printed; Task 2 measured that as wrong on a real run
 * (see `itemQueueWaitMs`'s doc comment, `lib/run-time.ts`: a late item in a
 * serially worked queue read as having taken as long as the whole run, not
 * the work actually done on it). `itemDurationMs` below already excludes
 * that interval correctly. Rewriting the pane to match would still leave two
 * implementations that happen to agree today and can silently drift apart
 * tomorrow; moving the one correct implementation here and having both
 * surfaces call it is what makes them agree by construction.
 *
 * `item` takes a `Pick`, not the full `RunQueueItem`, because the two
 * callers hold different shapes: the drawer's rows are `RunQueueItem`, the
 * detail pane's archived rows are `ArchiveQueueItem` (`RunQueueItem` minus
 * `verification`, shared/types.ts). Both carry `id`/`stage`/`stageAt`, which
 * is all this function ever reads, so the narrower type is what lets either
 * caller pass its row as-is rather than padding one out with a field it
 * doesn't have.
 *
 * `testIdPrefix` defaults to `run-drawer-time` — the drawer's own literal
 * prefix — so this move alone changes nothing it renders: an unpassed prop
 * reproduces the exact test id `test/run-time-ui.test.tsx` and
 * `test/orchestrator-drawer.test.tsx` already assert on. A second caller in
 * the same document (the detail pane, once Task 6 wires it in) supplies its
 * own prefix instead of colliding on that same test id twice on one page.
 */

/**
 * The stages a row prints no time at all for.
 *
 * `ungroomed` and `skipped` are the two exits where no work happened: the gate
 * turned the item away, or the run never got to it. A duration measured across
 * either is a measurement of nothing — the seconds the orchestrator spent
 * reading a file and deciding not to queue it — and printing one would put a
 * number in the same column where its neighbours carry real work, inviting the
 * comparison. Blank is the honest reading; the row's chip already says why.
 */
export const TIMELESS_STAGES: readonly RunStage[] = ['ungroomed', 'skipped'];

/**
 * The row's right-hand time reading: what a person scanning the queue wants
 * without opening anything — how long each item took, and when the finished
 * ones finished.
 *
 * Three shapes, because a queue row is in one of three situations and they
 * answer different questions. A finished row gets `<duration> · <HH:MM>`: both
 * halves matter and neither implies the other — the duration is the cost, the
 * clock time is what lets a person line the item up against something else
 * that happened this morning. An active row gets `<duration> elapsed`, with
 * the word carrying the tense the finished rows do not need. A `pending` row
 * gets an em dash: not "0s", which claims a measurement, but the typographic
 * mark for a field with nothing in it yet.
 *
 * A `null` duration degrades to whichever half survives rather than blanking
 * the row: a terminal row with a stamp for its exit but nothing before it can
 * still honestly say WHEN it ended even when it cannot say how long it took.
 *
 * `now` is the run's CLAMPED clock (`runClockMs`, lib/run-time.ts), not the
 * wall clock, and it is `null` for a run that can prove no instant at all.
 * Both callers hold the run and compute it once per render; this component
 * deliberately takes no run of its own and keeps its wording at
 * `<span> elapsed` regardless (bug-15). Once the number is bounded that word
 * is honest — the span really did elapse — the status chip beside it names
 * the exit, and the stalled dot below it carries the tense. Passing the run
 * in just to swap one word would re-fork the very function this component
 * exists to keep single across the drawer and the Runs pane.
 *
 * An active row with a `null` clock therefore renders nothing at all, via the
 * `text === ''` branch that already existed for an unmeasurable span: there
 * is no instant to measure the elapsed time TO, and a stopped run with an
 * unreadable heartbeat is exactly that case.
 */
export function RowTime({ item, now, testIdPrefix = 'run-drawer-time' }: {
  item: Pick<RunQueueItem, 'id' | 'stage' | 'stageAt'>;
  now: number | null;
  testIdPrefix?: string;
}): JSX.Element | null {
  if (TIMELESS_STAGES.includes(item.stage)) return null;

  if (item.stage === 'pending') {
    return <span className="run-drawer-item-time" data-testid={`${testIdPrefix}-${item.id}`}>—</span>;
  }

  const duration = itemDurationMs(item, now);
  const span = duration === null ? null : formatSpan(duration);
  const terminal = isTerminalStage(item.stage);
  const done = terminal ? itemDoneClock(item) : null;

  const text = terminal
    ? [span, done].filter((part) => part !== null).join(' · ')
    : span === null ? '' : `${span} elapsed`;

  if (text === '') return null;
  return <span className="run-drawer-item-time" data-testid={`${testIdPrefix}-${item.id}`}>{text}</span>;
}
