import { elapsedSince, formatCreated } from '../../lib/item-age';
import { isInProgress, progressLabel } from '../../lib/item-progress';
import type { ProjectHues } from '../../lib/project-hue';
import { DispatchButton } from './DispatchButton';
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
 * live bar, in cyan: "which of these twelve is being worked" is a question
 * asked of a whole column at once, and a 9.5px chip in a card's foot could no
 * more answer it than the 3px amber inset the hand-run bar replaced could.
 * The two stages below are the same claim's other half.
 *
 * Exported for the same reason REFACTOR_KINDS above is: so a test can
 * assert against the exact list the card renders from, not a restatement
 * of it. Also read by BoardView (the column rank) and RunDrawer (its own
 * active count) — one list, three readers, none of them restating it.
 */
export const ACTIVE_RUN_STAGES: readonly RunStage[] = [
  'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging'
];

/*
 * `ATTENTION_RUN_STAGES` — the two stages that mean the run has STOPPED and
 * will not restart until a person does something — used to be declared right
 * here, as the exact opposite claim to the six above. bug-11 moved it to
 * shared/types.ts beside `RUN_CLAIMED_STAGES`, where its own doc comment now
 * gives the reasoning; `client/src/lib/item-stale.ts` reads it to keep an
 * item a run is blocked on out of Archive, and a lib module cannot import a
 * React component.
 *
 * The card's use of it is unchanged and so is the rendering rule it encodes:
 * amber where the six above are cyan, because the theme's legend reads amber
 * as "a human is involved here" (the hand-run bar's own colour and rationale,
 * a few rules down in styles.css) — precisely true of a blocked run and
 * precisely false of a running one. `ACTIVE_RUN_STAGES` above stays here
 * because it really is only a rendering fact: nothing outside the board asks
 * which cards wear a cyan bar.
 */

/**
 * What this card needs from a fresh run's queue entry: the stage, and the
 * first-arrival stamps to age it against. A narrow pick rather than the whole
 * `RunQueueItem` because everything else on that shape (sessionId, worktree,
 * verification output, questions) belongs to RunDrawer, and a card that
 * accepted it would invite reading fields the card has no room to render.
 */
export type RunCardState = Pick<RunQueueItem, 'stage' | 'stageAt'>;

/** The bar's three volatile facts, in a shape a test can assert directly. */
export type LiveBar = {
  /** The word(s) the bar prints: a run stage, or `progressLabel`'s wording. */
  label: string;
  /** `run` → cyan (the orchestrator, unattended); `human` → amber. */
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
 *   1. an attention stage  → amber, labelled with the stage
 *   2. an active stage     → cyan, labelled with the stage
 *   3. `isInProgress(item)` → amber, labelled by `progressLabel` (unchanged)
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
  if (stage !== undefined
    && (ATTENTION_RUN_STAGES.includes(stage) || ACTIVE_RUN_STAGES.includes(stage))) {
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
 * guide-manager's .guides-card, ported: title on top, footer pinned to the
 * bottom with a project pill and a mono meta line. Keyboard added (the original
 * was pointer-only): the whole card is the target, so it needs to be reachable.
 */
export function ItemCard(
  { item, hues, onOpen, agents, onDispatch, now, stale, run, runBlock, reverify }: {
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
     * `runStage` already follow.
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
     * handed, the same discipline `now` above already follows, and RunStrip.tsx
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
     * `run` decides whether this card shows a live bar and reads
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
  }
) {
  const at = now ?? Date.now();
  /* One derivation for the whole marker — see `liveBarFor` above for the
     precedence and for why a run's stage outranks the item file's own stamp.
     `isInProgress` is no longer read directly here: it is row 3 of that
     precedence, and reading it separately is how a card ends up amber-bordered
     while its bar is cyan. */
  const bar = liveBarFor(item, run);
  /* null when the anchor is not a value this can age — a hand-edited `started`
     (the CLI writes a UTC timestamp, and older files a bare date), or a queue
     entry carrying no stamp for the stage it reports. The bar still renders; it
     just drops the reading rather than printing NaN into it. */
  const elapsed = bar === null || bar.anchor === null ? null : elapsedSince(bar.anchor, at);
  const created = formatCreated(item.created, at);

  return (
    <div
      className={
        bar === null ? 'board-card'
          : bar.tone === 'run' ? 'board-card board-card-live board-card-live-run'
            : 'board-card board-card-live'
      }
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
      {/* The printed face. Everything but the tab lives in here, because the tab
          has to reach the card's own top and bottom edges — see the
          .board-card / .board-card-main split in styles.css. It holds no padding
          of its own: that moved down to .board-card-face so the in-progress bar
          between them can be full-width. */}
      <div className="board-card-main">
        {/* The live marker, as a bar across the top of the face rather
            than a hairline down its edge. "Which of these twelve is anyone on"
            is a question asked of a whole column at once, and 3px of amber
            inset on one card could not answer it at a glance.
            Amber, where groomed is green: the theme's own legend reads amber as
            "a human is involved here", and the card someone is actively on is
            the one that is true of. It is also why the dispatch tab beside it
            is cyan or mustard and never amber.
            Task 9 gave the same bar a cyan tone for the orchestrator's own six
            working stages, reading that legend from the other side: no human is
            involved in those, which is exactly what makes cyan right for them
            and amber wrong. A run BLOCKED on a person keeps amber — see
            ATTENTION_RUN_STAGES. The stage word replaced the footer chip that
            used to carry it, rather than being added beside it: one card
            reading `reviewing` twice, two lines apart, in the same colour, is
            not twice as informative.
            The bar owns no padding of its own beyond its inline padding — it
            sits OUTSIDE .board-card-face precisely so it can reach the face's
            left and right edges. It stops at the tab's seam, which is correct:
            the tab is the item's next step and keeps its own identity. */}
        {bar !== null && (
          <div
            /* Two tones of one bar, not two bars: the base rule owns the
               padding, the --card-pad-x alignment, the --on-accent ink pairing
               and the compact-density retune, and the cyan modifier overrides
               nothing but the fill. A second bar would have had to re-derive
               all four. */
            className={bar.tone === 'run' ? 'board-card-live-bar board-card-live-bar-run' : 'board-card-live-bar'}
            title={bar.title}
          >
            {/* Either the run's own stage word (`reviewing`, `needs-answers`)
                or which skill a hand-run session holds the item with
                ('grooming' / 'executing') — see `liveBarFor` for the
                precedence, and item-progress.ts for why an empty phase falls
                back to the old generic wording instead of rendering nothing.
                The word is always printed, so the tone is never the only thing
                carrying the state — the same rule the run chips follow with
                their glyphs. */}
            <span>{bar.label}</span>
            {/* Absent rather than blank when the value cannot be aged: the words
                beside it already carry the fact, and half a marker beats a lie.
                The exact stored value is in the title above and spelled out in
                the drawer — the card never has room for it. */}
            {elapsed !== null && <span className="board-card-live-mark">{elapsed}</span>}
          </div>
        )}
        {/* The padded column the face used to be. Split out from
            .board-card-main so the bar above can be full-width; this rule is
            where every padding and gap the card has now lives, which is what
            keeps the compact-density override a single block. */}
        <div className="board-card-face">
          <div className="board-card-title">{item.title}</div>
          <div className="board-card-foot">
            {/* Both the text and the hue are the project: the card's column and
                the id's prefix below already say which type this is, so the pill
                spends everything it has on the one thing position can't tell
                you. */}
            <span className={`pill ${hues.classFor(item.project)}`}>{item.project}</span>
            <div className="board-card-meta">
              {/* Project omitted here — the pill above it says it. The date is
                  short (`aug 20`, not `2026-08-20`) because this line is
                  nowrap-with-ellipsis in about 118px at the real column width,
                  and the stored form left no room for the id beside it. The
                  separator goes with the date when there is no date, so an
                  undated item does not trail off into nothing. */}
              {item.id}{created === '' ? '' : ` · ${created}`}
            </div>
            {/* Siblings of the meta line, not children of it — the same
                unshrinkable trick the elapsed marker used to need here, and for
                the same measured reason: the meta line is nowrap-with-ellipsis
                in about 118px at the real column width, so a marker appended
                inside it rendered as `bug-7 · aug 27 · gr…` and told you
                nothing. Out here they are `flex: none` (CSS) and take the space
                the meta's ellipsis frees.
                Groomed only on bugs: tasks are groomed by construction, and a
                marker that is always on says nothing. Ungroomed is the default
                state of a fresh bug, not a warning — so silence, not red. */}
            {/* Before the lifecycle markers below, because a refactor's kind
                is what the item IS, not where it has got to. Gated on the
                section as well as the value: `kind` is meaningless on a bug or
                a task, and a hand-added `kind: debt` on one of those should
                not sprout a badge the rest of the system has no notion of.
                An unrecognised value renders nothing at all — it stays on disk
                (the CLI round-trips every unknown key) and is reported by the
                API verbatim, so the only thing a new kind needs is an entry in
                REFACTOR_KINDS above. Silence, not a fallback badge: a badge
                reading `kind: whatevr` would present a typo as a category. */}
            {item.section === 'refactors' && REFACTOR_KINDS.includes(item.kind) ? (
              <span className="board-card-kind">{item.kind}</span>
            ) : null}
            {item.section === 'bugs' && item.groomed ? (
              <span className="board-card-groomed">groomed</span>
            ) : null}
            {item.status === 'done' ? <span className="board-card-done">done</span> : null}
            {/* Task 5. After `done`, before the run chip, which is where it
                belongs on both counts: it is a fact derived from the file (so
                it sits with kind/groomed/done rather than with the volatile
                run chip), but it is the only one of those derived against a
                clock and a setting rather than read straight off a key, so it
                reads last among them.
                Nothing else on the card can say this. `created` in the meta
                line is the wrong date — an item filed in March and groomed
                last week is not stale — and the live bar is the opposite
                claim. Word rather than a glyph: `stale` is exactly what it
                means, and the footer already carries three other words in the
                same register. */}
            {stale ? <span className="board-card-stale">stale</span> : null}
            {/* Task 11's run-stage chip used to sit here, last among the
                footer markers. Task 9 did not move it or re-tone it — it
                DELETED it, and the deletion is the point rather than a
                side-effect: the chip's condition was the six ACTIVE_RUN_STAGES
                plus `needs-answers`, and every one of those seven now renders
                the live bar above instead. Keeping the chip behind a "unless
                the bar already said it" guard would have left a branch that
                provably cannot fire, which reads to the next person as working
                code and is the exact shape a stale rule takes.
                Nothing was lost with it. The bar prints the same stage word in
                the same legend's colours, with the elapsed the chip never had,
                across the card's whole width instead of 9.5px of its foot.
                `stageChipClass`/`stageGlyph` (lib/run-stage.ts) and every
                `.board-card-stage*` rule in styles.css stay exactly as they
                are — RunDrawer chips all fifteen stages and is now their only
                caller, which is why those names still read as the board's own
                and did not move with the chip. */}
          </div>
        </div>
      </div>
      {/* Outside the face, as the card's right edge. Renders nothing at all
          when the item has no next step, so a done card is a plain strip. */}
      {onDispatch && (
        <DispatchButton
          item={item} status={agents ?? null} onDispatch={onDispatch} variant="tab"
          runBlock={runBlock} reverify={reverify}
        />
      )}
    </div>
  );
}
