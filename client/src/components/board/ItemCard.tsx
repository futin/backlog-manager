import { elapsedSince, formatCreated } from '../../lib/item-age';
import { isInProgress, progressLabel } from '../../lib/item-progress';
import type { ProjectHues } from '../../lib/project-hue';
import { Dot } from '../ui/Dot';
import { Marker } from '../ui/Marker';
import { DispatchButton, dispatchAvailable } from './DispatchButton';
import { ATTENTION_RUN_STAGES } from '../../../../shared/types';
import type { AgentsStatus, BacklogItem, RunQueueItem, RunStage } from '../../../../shared/types';

/**
 * The `RunStage` values that mean the orchestrator is working this item right
 * now — a literal list rather than "everything not terminal and not pending",
 * because that broader formula would also catch `preflight`, and Task 11's own
 * brief enumerates exactly these six as "shown" without it. Preflight is a real
 * pipeline stage (it sits between `pending` and `dispatched` in RunStage's
 * own documented order — see shared/types.ts) but a usually-instant one for
 * an already-groomed item, and a card that flickered a marker on for the
 * fraction of a poll cycle preflight actually takes would read as noise
 * rather than as a state anyone could act on.
 *
 * Task 9 turned what these six earn from a footer chip into the card's own
 * live strip: "which of these twelve is being worked" is a question asked of a
 * whole column at once, and a 9.5px chip in a card's foot could no more answer
 * it than the 3px amber inset the hand-run bar replaced could.
 * The two stages below are the same claim's other half.
 *
 * Exported for the same reason REFACTOR_KINDS above is: so a test can
 * assert against the exact list the card renders from, not a restatement
 * of it. Also read by BoardView (the column rank) — one list, two readers,
 * neither restating the other.
 */
export const ACTIVE_RUN_STAGES: readonly RunStage[] = ['dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging'];

/*
 * `ATTENTION_RUN_STAGES` — the two stages that mean the run has STOPPED and
 * will not restart until a person does something — used to be declared right
 * here, as the exact opposite claim to the six above. bug-11 moved it to
 * shared/types.ts beside `RUN_CLAIMED_STAGES`, where its own doc comment now
 * gives the reasoning; `client/src/lib/item-stale.ts` reads it to keep an
 * item a run is blocked on out of Archive, and a lib module cannot import a
 * React component.
 *
 * The card's use of it is unchanged; the rendering rule it used to encode is
 * not. The two lists chose the live strip's COLOUR until task-37 — amber for a
 * blocked run, cyan for a running one — and DESIGN.md §8.3 takes that second
 * tone away: one `--fill-live` hatched fill covers both, and the stage word
 * alone carries the distinction, because this design marks state by ink and
 * never by accent (§5). What the two lists still decide is whether there is a
 * strip at all, and which word is on it.
 */

/**
 * What this card needs from a fresh run's queue entry: the stage, and the
 * first-arrival stamps to age it against. A narrow pick rather than the whole
 * `RunQueueItem` because everything else on that shape (sessionId, worktree,
 * verification output, questions) belongs to the Runs section's detail, and a
 * card that accepted it would invite reading fields the card has no room to
 * render.
 */
export type RunCardState = Pick<RunQueueItem, 'stage' | 'stageAt'>;

/** The bar's three volatile facts, in a shape a test can assert directly. */
export type LiveBar = {
  /** The word(s) the bar prints: a run stage, or `progressLabel`'s wording. */
  label: string;
  /**
   * `run` → the orchestrator is working it, unattended; `human` → a person is
   * involved, either because a hand session holds the file or because the run
   * has stopped and is waiting on one.
   *
   * It no longer picks a fill: DESIGN.md §8.3 draws one `--fill-live` strip for
   * both. It is kept because it is the precedence's own verdict in a shape a
   * test can read without a render, and because the card still marks the two
   * apart in its markup (`data-tone`) for anything that needs to tell them
   * apart without re-deriving the two stage lists.
   */
  tone: 'run' | 'human';
  /** The stamp to age against, or null when nothing here can be aged. */
  anchor: string | null;
  /** The bar's title attribute — the one place the exact stamp is legible. */
  title: string;
};

/**
 * Which bar a card wears, or null for none. Exported and pure so the
 * precedence below is testable without a render, and so the ordering is
 * stated once in one place rather than as nested ternaries in JSX.
 *
 * The precedence, top wins:
 *   1. an attention stage  → human, labelled with the stage
 *   2. an active stage     → run, labelled with the stage
 *   3. `isInProgress(item)` → human, labelled by `progressLabel` (unchanged)
 *   4. none of those       → no bar
 *
 * Run facts outrank the file's own marker (1–2 over 3) because the run payload
 * is re-polled every 5s while it is fresh, where a `started:` stamp can be
 * arbitrarily stale — a leftover hand-run stamp must not mask a live run's
 * actual stage. In practice the two rarely co-occur at all: `backlog-execute`
 * runs inside the per-item worktree and stamps the worktree's copy of the item
 * file, never the main tree's copy this board renders (task-9's own Goal
 * section has the full finding), which is exactly why a run's stage is the
 * ONLY thing that can say an orchestrated item is live.
 *
 * The two stage lists and the hand session's own words are deliberately NOT
 * merged into one list, and DESIGN.md §8.3 says so outright: `reviewing` is a
 * `RunStage` (shared/types.ts) and `grooming`/`executing`/`in progress` are
 * `progressLabel`'s own three (`client/src/lib/item-progress.ts:39-43`), off a
 * `phase:` key. They are two axes that happen to print in the same 24 px strip.
 *
 * The anchor prefers `stageAt.dispatched` over the current stage's own
 * arrival, and that is not a fallback ordering — it is the reading. `stageAt`
 * keeps FIRST arrivals only (shared/types.ts), so a `fixing` → `reviewing`
 * loop does not re-stamp either one; anchoring on the current stage would
 * still under-report a long item as "2m in reviewing" rather than "40m in the
 * orchestrator's hands", which is the analogue of `started:` and the thing a
 * reader scanning a column actually wants. `needs-answers` needs the fallback
 * because its route (pending → preflight → needs-answers) never visits
 * `dispatched` at all, and there the current stage's arrival IS the right
 * reading: how long it has been waiting on you.
 */
export function liveBarFor(item: BacklogItem, run?: RunCardState): LiveBar | null {
  const stage = run?.stage;
  if (stage !== undefined && (ATTENTION_RUN_STAGES.includes(stage) || ACTIVE_RUN_STAGES.includes(stage))) {
    const anchor = run?.stageAt.dispatched ?? run?.stageAt[stage] ?? null;
    return {
      label: stage,
      tone: ATTENTION_RUN_STAGES.includes(stage) ? 'human' : 'run',
      anchor,
      // The stage word is already on the bar, so the title's job is only the
      // stamp behind it — omitted entirely rather than trailing an `undefined`
      // when there is none, the same rule the elapsed reading follows.
      title: anchor === null ? stage : `${stage} since ${anchor}`
    };
  }
  if (isInProgress(item)) {
    return {
      label: progressLabel(item),
      tone: 'human',
      anchor: item.started,
      // Literal `in progress`, not `progressLabel`'s wording: this string
      // names the stored KEY the stamp came from, which is the same key
      // whether the phase reads grooming, executing or nothing at all.
      title: `in progress since ${item.started}`
    };
  }
  return null;
}

/**
 * The two `kind:` values a refactor may carry. An enum here rather than a
 * clamp on the read side (see BacklogItem.kind in shared/types.ts): the server
 * passes the frontmatter value through verbatim, and this list is the only
 * place that decides whether it means anything. A third kind is one entry
 * here — never a new directory, and never a change to the scanner.
 *
 * Exported so a test can assert against the same list the badge renders from
 * rather than restating the strings.
 */
export const REFACTOR_KINDS: readonly string[] = ['chore', 'debt'];

/**
 * The board's card, redrawn at the design's scale (DESIGN.md §8.3, "The card"):
 * `--strip`, 12 px radius, no stroke and no shadow, hover changing the cursor
 * and nothing else — a card is a button by role (§5), and this design marks
 * nothing by hover. Face padding 14/16/12 with a 10 px internal gap, a title
 * that wraps, a foot of project dot + name against `id · date`, and a marker
 * row whose right end is the dispatch chip.
 *
 * Archive renders this same card (§5.1), which is why nothing here reads the
 * run payload, the clock or the staleness window for itself: every one of
 * those arrives as a prop from whichever view is doing the deciding.
 */
export function ItemCard({
  item,
  hues,
  onOpen,
  agents,
  onDispatch,
  now,
  stale,
  run,
  runBlock,
  reverify
}: {
  item: BacklogItem;
  hues: ProjectHues;
  onOpen: () => void;
  /** null until the status probe answers; absent when the board is rendered
   *  without dispatch at all (older tests, and any future read-only view). */
  agents?: AgentsStatus | null;
  onDispatch?: () => void;
  /**
   * The clock, passed in rather than read here, so this stays a pure function
   * of its props: the board owns the one ticking timer (`useNow`) and every
   * card renders against the same instant. Defaulted so a card can still be
   * rendered on its own.
   */
  now?: number;
  /**
   * Task 5: whether nobody has touched this item inside the staleness
   * window. Decided by BoardView (`isStale`, lib/item-stale.ts) and handed
   * down, never computed here — the window is a setting and the age needs a
   * clock, and this component owns neither, the same discipline `now` and
   * `run` already follow.
   *
   * In practice this is only ever true on a task: every other stale section
   * has already left the Board by the time a card renders (`leavesBoard`).
   * The prop is not narrowed to tasks anyway, because the rule about which
   * sections survive belongs to the board's filter, not to the card's
   * markup.
   *
   * ArchiveView renders this same card for the sections that DID leave and
   * deliberately passes nothing here — every card in its three stale columns
   * is stale by construction, so a marker on all of them carries no
   * information, exactly as `groomed` on a task would not. Its column
   * headings say it once instead. The prop stays open to that surface all
   * the same; what it does not have is a caller that always sets it.
   */
  stale?: boolean;
  /**
   * This card's entry in a fresh orchestrator run's queue, or undefined when
   * no such run currently says anything about it. Looked up by BoardView, not
   * derived here — this component stays a pure function of whatever it is
   * handed, the same discipline `now` above already follows, and `liveBarFor`
   * carries the long version of why the source is a run payload rather than
   * anything on `item` itself.
   *
   * The stage AND its stamps, in one prop rather than two: they are two
   * halves of a single volatile fact, and a card handed a stage from one poll
   * with stamps from another would print an elapsed for a stage it is not
   * showing. `runBlock` below is a genuinely different question off the same
   * payload and stays its own prop for the reason stated there.
   */
  run?: RunCardState;
  /**
   * Why a run forbids dispatching this item, or null/undefined when none
   * does — passed straight through to `DispatchButton`.
   *
   * Deliberately a SECOND prop rather than something derived from `run`
   * beside it: the two answer different questions off the same payload.
   * `run` decides whether this card shows a live strip and reads
   * `ACTIVE_RUN_STAGES`/`ATTENTION_RUN_STAGES` above, which correctly exclude
   * `pending` and `preflight`; the block reads `RUN_CLAIMED_STAGES`
   * (shared/types.ts),
   * which must INCLUDE them — a pending item is already claimed even though
   * a badge for it would be noise. Collapsing the two would break one rule
   * or the other. See `runClaimBlock` (shared/agent.ts) for who computes it.
   */
  runBlock?: string | null;
  /** Re-ask the dashboard status, resolving to the fresh answer — passed
   *  straight through to `DispatchButton`, which spends it on the one block
   *  a click may clear (bug-13; its own prop comment carries the reasoning).
   *  Threaded rather than derived for the same reason `agents` is: the
   *  status belongs to one hook per view, not to forty cards. */
  reverify?: () => Promise<AgentsStatus>;
}) {
  const at = now ?? Date.now();
  /* One derivation for the whole strip — see `liveBarFor` above for the
     precedence and for why a run's stage outranks the item file's own stamp.
     `isInProgress` is no longer read directly here: it is row 3 of that
     precedence, and reading it separately is how a card ends up wearing one
     state and printing another. */
  const bar = liveBarFor(item, run);
  /* null when the anchor is not a value this can age — a hand-edited `started`
     (the CLI writes a UTC timestamp, and older files a bare date), or a queue
     entry carrying no stamp for the stage it reports. The strip still renders;
     it just drops the reading rather than printing NaN into it. */
  const elapsed = bar === null || bar.anchor === null ? null : elapsedSince(bar.anchor, at);
  const created = formatCreated(item.created, at);

  /* The marker row's own contents, built before the JSX rather than inside it,
     because whether the row exists at all is a question about this list's
     length and about the dispatch control beside it — and the row's rule
     (DESIGN.md §8.3) is "whenever a marker applies OR dispatch is available",
     which cannot be written as a chain of `&&`s in the markup without stating
     each marker's condition twice.

     Order is the same one the footer markers had and for the same reasons: a
     refactor's `kind` is what the item IS rather than where it has got to, so
     it leads; `groomed` is on bugs only, because a task is groomed by
     construction and a marker that is always on says nothing; `done` is
     history; `stale` reads last among them because it is the only one derived
     against a clock and a setting rather than read straight off a key.

     `kind` is gated on the section as well as the value: it is meaningless on
     a bug or a task, and a hand-added `kind: debt` on one of those should not
     sprout a marker the rest of the system has no notion of. An unrecognised
     value renders nothing at all — it stays on disk (the CLI round-trips every
     unknown key) and is reported by the API verbatim, so the only thing a new
     kind needs is an entry in REFACTOR_KINDS above. Silence, not a fallback
     marker: one reading `kind: whatevr` would present a typo as a category. */
  const markers = [
    item.section === 'refactors' && REFACTOR_KINDS.includes(item.kind) ? { tone: 'kind' as const, word: item.kind } : null,
    item.section === 'bugs' && item.groomed ? { tone: 'groomed' as const, word: 'groomed' } : null,
    item.status === 'done' ? { tone: 'done' as const, word: 'done' } : null,
    stale ? { tone: 'stale' as const, word: 'stale' } : null
  ].filter((m): m is { tone: 'kind' | 'groomed' | 'done' | 'stale'; word: string } => m !== null);

  /* Asked through `dispatchAvailable` rather than by re-deriving the action and
     the gate here: the row has to reserve its space exactly when the control
     will draw itself, and two expressions that agree today are the shape this
     repo pins tests against everywhere else. `onDispatch` is part of the
     question because a caller that passes none renders no control whatever the
     status says. */
  const dispatchable = onDispatch !== undefined && dispatchAvailable(item, agents ?? null);

  return (
    <div
      className="board-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {/* The live strip: 24 px across the card's top edge, `--fill-live` under
          the `.hatch` utility, the stage word left and the elapsed reading
          right (DESIGN.md §8.3). It sits OUTSIDE .board-card-face precisely so
          it can reach the card's own left and right edges — a strip inset by
          the face's padding reads as a chip, not as a state the whole card is
          in.
          One fill, where task-9's bar had two. The word carries the
          distinction now: `data-tone` keeps the precedence's verdict in the
          markup for anything that needs it, but nothing in the stylesheet
          reads it, because this design marks state by ink and never by accent
          (DESIGN.md §5, §8.3). */}
      {bar !== null && (
        <div className="board-card-live hatch" data-tone={bar.tone} title={bar.title}>
          {/* Either the run's own stage word (`reviewing`, `needs-answers`)
              or which skill a hand-run session holds the item with
              ('grooming' / 'executing') — see `liveBarFor` for the
              precedence, and item-progress.ts for why an empty phase falls
              back to the old generic wording instead of rendering nothing. */}
          <span>{bar.label}</span>
          {/* Absent rather than blank when the value cannot be aged: the words
              beside it already carry the fact, and half a marker beats a lie.
              The exact stored value is in the title above and spelled out in
              the drawer — the card never has room for it. */}
          {elapsed !== null && <span className="board-card-live-mark">{elapsed}</span>}
        </div>
      )}
      <div className="board-card-face">
        <div className="board-card-title">{item.title}</div>
        <div className="board-card-foot">
          {/* Both the dot and the text are the project: the card's column and
              the id's prefix beside the date already say which type this is, so
              this pair spends everything it has on the one thing position
              cannot tell you. The dot is `Dot`'s own `hue`, which resolves to a
              CLASS (never a style attribute), so a theme swap recolours every
              card for free — DESIGN.md §8.2's bargain, the same one the outline
              pill it replaces was already making. */}
          <span className="board-card-proj">
            <Dot hue={hues.hueFor(item.project)} />
            <span className="board-card-proj-name">{item.project}</span>
          </span>
          {/* Pushed right and `flex: none` (CSS). The date is short (`aug 20`,
              not `2026-08-20`) because this line is nowrap-with-ellipsis at the
              real column width, and the stored form left no room for the id
              beside it. The separator goes with the date when there is no date,
              so an undated item does not trail off into nothing. */}
          <span className="board-card-meta">
            {item.id}
            {created === '' ? '' : ` · ${created}`}
          </span>
        </div>
        {(markers.length > 0 || dispatchable) && (
          <div className="board-card-markers" data-testid="marker-row">
            {markers.map((m) => (
              <Marker key={m.tone} tone={m.tone}>
                {m.word}
              </Marker>
            ))}
            {/* Always drawn once the environment allows dispatch at all, never
                hover-revealed: a disabled control a user can click to re-ask
                its status (bug-13) has to be visible to be clicked, and this
                design marks nothing by hover. `dispatchable` above is the same
                predicate the control itself returns null on, so the row and the
                chip can never disagree about whether there is one. */}
            {onDispatch && <DispatchButton item={item} status={agents ?? null} onDispatch={onDispatch} runBlock={runBlock} reverify={reverify} />}
          </div>
        )}
      </div>
    </div>
  );
}
