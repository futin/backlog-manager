import { daysSince } from '../../lib/item-age';
import type { ProjectHues } from '../../lib/project-hue';
import { DispatchButton } from './DispatchButton';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';

/**
 * guide-manager's .guides-card, ported: title on top, footer pinned to the
 * bottom with a project pill and a mono meta line. Keyboard added (the original
 * was pointer-only): the whole card is the target, so it needs to be reachable.
 */
export function ItemCard(
  { item, hues, onOpen, agents, onDispatch }: {
    item: BacklogItem;
    hues: ProjectHues;
    onOpen: () => void;
    /** null until the status probe answers; absent when the board is rendered
     *  without dispatch at all (older tests, and any future read-only view). */
    agents?: AgentsStatus | null;
    onDispatch?: () => void;
  }
) {
  // Two conditions, not one. `started` outlives the work: `move` never rewrites
  // an item's content, so an archived file keeps the date it was picked up as
  // history — worth having, and exactly why the date alone cannot mean "live",
  // or every item ever shipped would read as in progress forever.
  const inProgress = item.status === 'open' && item.started !== '';
  // null when `started` is not a date this can age (a hand-edited file — the CLI
  // only ever writes YYYY-MM-DD). The marker still renders; it just drops the
  // age rather than printing NaNd.
  const age = inProgress ? daysSince(item.started) : null;

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
      {/* The printed face. Everything but the tab lives in here now, because
          the tab has to reach the card's own top and bottom edges — see the
          .board-card / .board-card-main split in styles.css. */}
      <div className="board-card-main">
        <div className="board-card-title">{item.title}</div>
        <div className="board-card-foot">
          {/* Both the text and the hue are the project: the card's column and
              the id's prefix below already say which type this is, so the pill
              spends everything it has on the one thing position can't tell
              you. */}
          <span className={`pill ${hues.classFor(item.project)}`}>{item.project}</span>
          <div className="board-card-meta">
            {/* Project omitted here — the pill above it says it. */}
            {item.id} · {item.created}
            {/* Groomed only on bugs: tasks are groomed by construction, and a
                marker that is always on says nothing. Ungroomed is the default
                state of a fresh bug, not a warning — so silence, not red. */}
            {item.section === 'bugs' && item.groomed ? (
              <span className="board-card-groomed"> · groomed</span>
            ) : null}
            {item.status === 'done' ? <span className="board-card-done"> · done</span> : null}
          </div>
          {/* A sibling of the meta line, not a part of it: the meta is
              nowrap-with-ellipsis in about 118px at the real column width and
              already clips `· groomed`, so a marker appended there rendered
              239px of content into a 118px box and was never once visible. Out
              here it is unshrinkable (CSS) and takes the space the meta's
              ellipsis frees.
              Amber, where groomed is green — the theme's own legend reads amber
              as "a human must act", and the card someone is actively on is the
              one that is true of. It is also why the dispatch tab beside it is
              cyan or mustard and never amber.
              Terse because that is all the room there is: the age is the half
              that cannot be guessed from the amber edge, and three days versus
              three weeks is the whole reason a date is stored rather than a
              boolean. The words go in the title attribute and, in full, in the
              drawer. */}
          {inProgress ? (
            <span className="board-card-live-mark" title={`in progress since ${item.started}`}>
              ◍{age === null ? '' : ` ${age}d`}
            </span>
          ) : null}
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
