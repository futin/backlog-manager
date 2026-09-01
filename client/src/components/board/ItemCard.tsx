import { elapsedSince, formatCreated } from '../../lib/item-age';
import { isInProgress, progressLabel } from '../../lib/item-progress';
import type { ProjectHues } from '../../lib/project-hue';
import { stageChipClass, stageGlyph } from '../../lib/run-stage';
import { DispatchButton } from './DispatchButton';
import type { AgentsStatus, BacklogItem, RunStage } from '../../../../shared/types';

/**
 * The `RunStage` values that earn a card a chip at all — a literal list
 * rather than "everything not terminal and not pending", because that
 * broader formula would also catch `preflight`, and Task 11's own brief
 * enumerates exactly these six as "shown" without it. Preflight is a real
 * pipeline stage (it sits between `pending` and `dispatched` in RunStage's
 * own documented order — see shared/types.ts) but a usually-instant one for
 * an already-groomed item, and a card that flickered a chip on for the
 * fraction of a poll cycle preflight actually takes would read as noise
 * rather than as a state anyone could act on. `needs-answers` is handled as
 * its own case beside this list (a warning chip, not this one) rather than
 * folded in, because it means the opposite of "this is progressing" — see
 * the render below.
 *
 * Exported for the same reason REFACTOR_KINDS above is: so a test can
 * assert against the exact list the badge renders from, not a restatement
 * of it.
 */
export const ACTIVE_RUN_STAGES: readonly RunStage[] = [
  'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging'
];

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
  { item, hues, onOpen, agents, onDispatch, now, stale, runStage, runBlock }: {
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
     * This card's position in a fresh orchestrator run's queue, or undefined
     * when no such run currently says anything about it. Looked up by
     * BoardView, not derived here — this component stays a pure function of
     * whatever it is handed, the same discipline `now` above already follows,
     * and RunStrip.tsx carries the long version of why the source is a run
     * payload rather than anything on `item` itself.
     */
    runStage?: RunStage;
    /**
     * Why a run forbids dispatching this item, or null/undefined when none
     * does — passed straight through to `DispatchButton`.
     *
     * Deliberately a SECOND prop rather than something derived from `runStage`
     * beside it: the two answer different questions off the same payload.
     * `runStage` decides whether this card shows a live stage badge and reads
     * `ACTIVE_RUN_STAGES` above, which correctly excludes `pending` and
     * `preflight`; the block reads `RUN_CLAIMED_STAGES` (shared/types.ts),
     * which must INCLUDE them — a pending item is already claimed even though
     * a badge for it would be noise. Collapsing the two would break one rule
     * or the other. See `runClaimBlock` (shared/agent.ts) for who computes it.
     */
    runBlock?: string | null;
  }
) {
  const at = now ?? Date.now();
  // See item-progress.ts for why this is two conditions, not one: `started`
  // outlives the work, so `status` is what tells a live item apart from an
  // archived one that kept its stamp as history.
  const inProgress = isInProgress(item);
  // null when `started` is not a value this can age (a hand-edited file — the
  // CLI writes a UTC timestamp, and older files a bare date). The bar still
  // renders; it just drops the reading rather than printing NaN into it.
  const elapsed = inProgress ? elapsedSince(item.started, at) : null;
  const created = formatCreated(item.created, at);

  return (
    <div
      className={inProgress ? 'board-card board-card-live' : 'board-card'}
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
        {/* The in-progress marker, as a bar across the top of the face rather
            than a hairline down its edge. "Which of these twelve is anyone on"
            is a question asked of a whole column at once, and 3px of amber
            inset on one card could not answer it at a glance.
            Amber, where groomed is green: the theme's own legend reads amber as
            "a human is involved here", and the card someone is actively on is
            the one that is true of. It is also why the dispatch tab beside it
            is cyan or mustard and never amber.
            The bar owns no padding of its own beyond its inline padding — it
            sits OUTSIDE .board-card-face precisely so it can reach the face's
            left and right edges. It stops at the tab's seam, which is correct:
            the tab is the item's next step and keeps its own identity. */}
        {inProgress && (
          <div className="board-card-live-bar" title={`in progress since ${item.started}`}>
            {/* Names which skill actually holds the item ('grooming' /
                'executing') rather than the old generic wording every live
                card used to carry — see item-progress.ts for why an empty
                phase still falls back to it instead of rendering nothing.
                The title attribute above is unaffected: it keeps naming the
                stored `started` value regardless of which activity this is. */}
            <span>{progressLabel(item)}</span>
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
            {/* Last among the footer markers, deliberately: kind/groomed/done
                are all facts the item FILE holds, permanent until the next
                edit; this one is the most volatile thing on the card by far —
                sourced from a run payload that can go stale between one poll
                and the next (RunStrip.tsx has the long version) — so it reads
                last, after the stable facts, not ahead of them.
                `ACTIVE_RUN_STAGES` is the literal "shown" list Task 11's brief
                enumerates; `needs-answers` is its own warning-toned branch
                because it means the opposite of progress, not a fine-grained
                shade of it; anything else — terminal stages, `pending`,
                `preflight`, or no run mentioning this item at all — renders
                nothing, the same silence-is-correct rule the kind badge above
                already follows for a kind it does not recognise. */}
            {runStage !== undefined
              && (ACTIVE_RUN_STAGES.includes(runStage) || runStage === 'needs-answers') ? (
                /* Which stages get a chip is unchanged — the seven above, and
                   silence for the other seven. What the chip LOOKS like now
                   comes from lib/run-stage.ts, shared with the drawer and the
                   strip, so a stage never reads one way on a card and another
                   in the drawer behind it. For these seven that map produces
                   exactly the two tones this branch used to hardcode; the
                   condition stays a literal list rather than "does it have a
                   tone", because every stage has a tone now and the question
                   the card is asking is the narrower one Task 11 set: is this
                   item being worked on right this moment. */
                <span className={stageChipClass(runStage)}>
                  <span className="board-card-stage-glyph" aria-hidden="true">
                    {stageGlyph(runStage)}
                  </span>
                  {runStage}
                </span>
              ) : null}
          </div>
        </div>
      </div>
      {/* Outside the face, as the card's right edge. Renders nothing at all
          when the item has no next step, so a done card is a plain strip. */}
      {onDispatch && (
        <DispatchButton
          item={item} status={agents ?? null} onDispatch={onDispatch} variant="tab"
          runBlock={runBlock}
        />
      )}
    </div>
  );
}
