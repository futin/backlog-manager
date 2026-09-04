import { itemStageSpans } from '../../lib/run-stats';
import { formatClock, formatSpan, inStageMs, stepperDots, stepperTerminal } from '../../lib/run-time';
import type { StageSpan } from '../../lib/run-stats';
import type { StepperDot } from '../../lib/run-time';
import type { MergeMode, RunQueueItem } from '../../../../shared/types';

/**
 * `StageTrack`: the seven-node, full-width stage stepper for ONE run queue
 * item — `RowStepper`'s 6px-dot drawer row (`RunDrawer.tsx`, `.run-stepper*`
 * in styles.css) scaled up to span the Runs pane's own ~1000px item card,
 * with each node's own duration printed underneath it. Task 6 wires this
 * into that card in place of the old `.run-detail-stagebar` and its 10px
 * caption, and deletes both — the pair the design doc's own complaint names
 * outright: every pipeline stage painted the bar the same cyan, and the
 * caption holding the per-stage durations — "the most useful thing the pane
 * knows" — was, in the user's own words, "not visible at all" underneath it.
 *
 * SEVEN NODES, NOT EIGHT. Built directly off `stepperDots(item, live,
 * terminal)`, which itself walks `stepperStages(terminal)` (run-time.ts) —
 * `dispatched` through the run's own success exit, never `pending`/
 * `preflight`. That function's own comment gives the reason: nothing about
 * the item is happening yet at either of those two, so a dot for them would
 * draw a position on a track the item has not actually started, and
 * `RunDetail`'s lead line already prints both durations in words beside this
 * track.
 *
 * `terminal` — 'merged' or 'branched' — is resolved from the required
 * `mergeModeEffective` prop via `stepperTerminal` (run-time.ts), not read off
 * `mergeModeEffective` directly: a still-mid-pipeline item has no
 * `merged`/`branched` stage of its own yet, so the run's mode is its only
 * available answer, but an item that has ALREADY reached one of the two
 * success exits answers with its own `stage` instead — see
 * `stepperTerminal`'s own doc comment for why that item-first rule exists (a
 * run's mode can move on to `'branch'` after this item already merged under
 * the old one, mid-queue, and the item's own finished stage must not be
 * relabelled after the fact). See `stepperDots`'s own doc comment
 * (run-time.ts) for why `stepperDots` itself still takes the resolved word
 * as a required parameter with no default.
 *
 * EQUAL COLUMNS, NOT TIME-PROPORTIONAL. The grid (styles.css) gives
 * `merging` (seconds) and `inspecting` (minutes) the exact same seventh of
 * the width — the same refusal `.run-stepper`'s own CSS comment states for
 * the drawer's tiny version, "a position indicator, not a time axis":
 * scaling the track to duration would shrink the short stages to invisible
 * slivers beside the long ones. That refusal is what left the drawer's
 * version unable to show "how long" at all; this component answers it a
 * different way — the actual span, printed in the reader's own words under
 * the node it belongs to — rather than by bending the geometry into
 * something it cannot honestly be.
 *
 * HOLLOW-ON-GREEN. `lastVisited` (below) is the highest-index node that is
 * NOT hollow, and both of a node's own connector segments are keyed against
 * THAT shared boundary, never against whether the node ITSELF is hollow —
 * so a hollow node sitting between two visited ones still draws an
 * unbroken green line straight through it on both sides. This is
 * deliberate, not a gap to close: `stepperDots`'s own comment calls exactly
 * this reading "the most useful thing the row says" — this item passed
 * through that stage without stopping — and breaking the line to mark the
 * gap would erase it.
 *
 * A STOPPED RUN'S TRACK CARRIES NO CURRENT NODE AT ALL (bug-15). `live` says
 * whether the run holding this item is still alive — derived by the caller
 * from the run itself (`runIsLive`, run-time.ts), since neither this item nor
 * this component can know — and with `live={false}` the node the item is
 * sitting on renders `stalled` (amber, static) instead of `current` (cyan,
 * pulsing). An aborted run's in-flight item is still AT `dispatched`; what is
 * false is that anything is happening there, which is precisely the claim the
 * pulsing ring makes. `now` is the caller's CLAMPED clock (`runClockMs`) for
 * the same reason, and may be `null` for a run that can prove no instant at
 * all — every value this component prints degrades to `—` on one.
 *
 * THE SWEEP IS THE ONLY MOTION ON THE TRACK. Every dot, every segment,
 * every duration is a static read that only changes when the surrounding
 * poll re-renders the component with a new `now`. The single exception is
 * the segment entering the CURRENT node (`data-in="live"`, styles.css): a
 * slow cyan gradient sweeping along it, plus the current dot's own pulsing
 * ring — the one place on the whole track where "this is happening right
 * now, this instant" is a fact a static reading cannot state. Everywhere
 * else, motion would just be decoration competing with the numbers for
 * attention. `prefers-reduced-motion` (styles.css) already zeroes every
 * animation in the app, these two included, landing both on a plain solid
 * cyan instead.
 *
 * Every attribute selector a node's `data-in`/`data-out` feed into is
 * scoped in the CSS to `.run-track-node[...]` rather than left as a bare
 * `[data-in=...]`: nothing else in `client/` uses those two attribute names
 * today, so the rendered result is identical either way, but a bare
 * attribute selector is app-global, and an unscoped one here would be a
 * trap for the next feature that happens to reach for the same names.
 *
 * `null` only for `ungroomed` — matching `RowStepper`'s own rule: an item
 * that never entered the pipeline has no progress to draw, and seven hollow
 * dots would draw a track for a run that was never happening.
 */

/**
 * The two connector states one node's own `::before`/`::after` pseudo-
 * elements render as (styles.css). Computed from the node's index against
 * `lastVisited` — the highest-index dot that is not hollow — rather than
 * from whether THIS node is hollow, which is the whole "hollow-on-green"
 * point this file's own header comment makes: a skipped node in the middle
 * of a visited run still sits on two `'done'` segments.
 *
 * `in` reaches `'live'` only for the segment entering the CURRENT node —
 * the one node `stepperDots` ever marks `state: 'current'` — and
 * `'stalled'` only for the one it marks `state: 'stalled'` (bug-15: the
 * stage a stopped run died on, which gets a static amber lead-in rather than
 * the animated `run-track-sweep` — the sweep is a claim about right now).
 * Every other combination bottoms out at `'done'` (behind or at
 * `lastVisited`) or `'idle'` (ahead of it), matching
 * `.run-track-node[data-in=...]` / `[data-out=...]` in styles.css exactly.
 *
 * `total` is the caller's own `dots.length` — always 7, whichever terminal
 * word the run's last dot carries — rather than a re-import of
 * `stepperStages(terminal).length`: the caller already has the array this
 * index space is drawn from in scope (it is iterating it), so asking it to
 * pass the one number it needs costs less than a second call to recompute
 * an array this function would then throw away.
 */
function segmentState(
  i: number,
  lastVisited: number,
  state: StepperDot['state'],
  total: number
): { in: 'none' | 'done' | 'live' | 'stalled' | 'idle'; out: 'none' | 'done' | 'idle' } {
  const into = i === 0
    ? 'none'
    : i <= lastVisited
      ? state === 'current' ? 'live' : state === 'stalled' ? 'stalled' : 'done'
      : 'idle';
  const out = i === total - 1 ? 'none' : i < lastVisited ? 'done' : 'idle';
  return { in: into, out };
}

/**
 * One node's value-span content, in the priority order the design fixes:
 *
 * 1. The CURRENT node reads its own ticking `inStageMs` — the one reading
 *    on the whole track that moves without a fresh `stageAt` entry, because
 *    it is measuring against `now`, not against a stamp. `—`/`-none` when
 *    the current stage's own stamp will not parse (case 8 in this file's
 *    test suite): a ticking reading needs a start point to tick FROM. A
 *    STALLED node takes this same branch (bug-15) and it is the one reading
 *    on a stopped run's track worth having — "it died 7m 24s into dispatch",
 *    bounded now that the clock is clamped at the run's last heartbeat
 *    instead of ticking against the wall clock forever.
 * 2. The run's own success exit (`terminal` — 'merged' or 'branched'), once
 *    visited, reads the finish CLOCK instead of a span — `-when`, a distinct
 *    register from `-none`: this is a known fact ("when it finished"), not
 *    an absent one, and the last arrival on any item has no "next stamp" for
 *    a span to measure it against in the first place. Both success exits
 *    take this branch identically — a branch-mode item finished exactly as
 *    much as a merge-mode one did, just at a different destination.
 * 3. Any other visited node reads its own span from `itemStageSpans` —
 *    but only when one actually exists FOR that stage. A node can be
 *    visited (filled) and still have no span: the item's own chronologically
 *    LAST recorded arrival closes no span of its own (see `itemStageSpans`'s
 *    doc comment), which is exactly the parked-item case this file's test
 *    suite pins — filled, but reading `—` all the same.
 * 4. Everything else — a genuinely hollow node, or a filled one with no
 *    span per (3) — reads a plain `—`/`-none`.
 */
function trackValue(
  dot: StepperDot,
  item: Pick<RunQueueItem, 'stage' | 'stageAt'>,
  now: number | null,
  spans: readonly StageSpan[],
  terminal: 'merged' | 'branched'
): { text: string; modifier: 'none' | 'when' | null } {
  if (dot.state === 'current' || dot.state === 'stalled') {
    const ms = inStageMs(item, now);
    return ms === null ? { text: '—', modifier: 'none' } : { text: formatSpan(ms), modifier: null };
  }

  if (dot.stage === terminal && dot.state !== 'hollow') {
    return { text: formatClock(item.stageAt[terminal]) ?? '—', modifier: 'when' };
  }

  const span = spans.find((s) => s.stage === dot.stage);
  if (span !== undefined) return { text: formatSpan(span.ms), modifier: null };

  return { text: '—', modifier: 'none' };
}

export function StageTrack({ item, now, live, mergeModeEffective }: {
  item: Pick<RunQueueItem, 'id' | 'stage' | 'stageAt' | 'fixLoops'>;
  now: number | null;
  live: boolean;
  mergeModeEffective: MergeMode;
}): JSX.Element | null {
  if (item.stage === 'ungroomed') return null;

  // The run's own success exit — usually, but this item's OWN exit when it
  // has already reached one. See this file's header comment and
  // `stepperTerminal`'s own doc comment (run-time.ts) for the full rule and
  // why an already-finished item must not be relabelled by a run that later
  // moved on to the other mode.
  const terminal = stepperTerminal(item, mergeModeEffective);

  const dots = stepperDots(item, live, terminal);
  const spans = itemStageSpans(item);
  const lastVisited = dots.reduce((last, dot, i) => (dot.state !== 'hollow' ? i : last), -1);

  return (
    <div className="run-track" data-testid={`run-track-${item.id}`}>
      {dots.map((dot, i) => {
        const { in: dataIn, out: dataOut } = segmentState(i, lastVisited, dot.state, dots.length);
        const value = trackValue(dot, item, now, spans, terminal);
        const valueClass = ['run-track-val', value.modifier !== null && `run-track-val-${value.modifier}`]
          .filter(Boolean)
          .join(' ');

        return (
          <div
            key={dot.stage}
            className="run-track-node"
            data-testid={`run-track-${item.id}-${dot.stage}`}
            data-in={dataIn}
            data-out={dataOut}
          >
            <span className={`run-track-dot run-track-dot-${dot.state}`} aria-hidden="true" />
            {dot.stage === 'fixing' && item.fixLoops > 0 && (
              <span
                className="run-track-loops"
                data-testid={`run-track-${item.id}-loops`}
                title={`${item.fixLoops} fix loop${item.fixLoops === 1 ? '' : 's'}`}
                aria-label={`${item.fixLoops} fix loop${item.fixLoops === 1 ? '' : 's'}`}
              >
                ×{item.fixLoops}
              </span>
            )}
            <span className={`run-track-name run-track-name-${dot.state}`}>{dot.stage}</span>
            <span className={valueClass} data-testid={`run-track-${item.id}-${dot.stage}-val`}>
              {value.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
