import { elapsedSince, formatCreated } from '../../lib/item-age';
import { isInProgress, progressLabel } from '../../lib/item-progress';
import type { ProjectHues } from '../../lib/project-hue';
import { DispatchButton } from './DispatchButton';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';

/**
 * guide-manager's .guides-card, ported: title on top, footer pinned to the
 * bottom with a project pill and a mono meta line. Keyboard added (the original
 * was pointer-only): the whole card is the target, so it needs to be reachable.
 */
export function ItemCard(
  { item, hues, onOpen, agents, onDispatch, now }: {
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
            {item.section === 'bugs' && item.groomed ? (
              <span className="board-card-groomed">groomed</span>
            ) : null}
            {item.status === 'done' ? <span className="board-card-done">done</span> : null}
          </div>
        </div>
      </div>
      {/* Outside the face, as the card's right edge. Renders nothing at all
          when the item has no next step, so a done card is a plain strip. */}
      {onDispatch && (
        <DispatchButton
          item={item} status={agents ?? null} onDispatch={onDispatch} variant="tab"
        />
      )}
    </div>
  );
}
