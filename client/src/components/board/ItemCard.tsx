import type { ProjectHues } from '../../lib/project-hue';
import type { BacklogItem } from '../../../../shared/types';

/**
 * guide-manager's .guides-card, ported: title on top, footer pinned to the
 * bottom with a project pill and a mono meta line. Keyboard added (the original
 * was pointer-only): the whole card is the target, so it needs to be reachable.
 */
export function ItemCard(
  { item, hues, onOpen }: { item: BacklogItem; hues: ProjectHues; onOpen: () => void }
) {
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
      <div className="board-card-title">{item.title}</div>
      <div className="board-card-foot">
        {/* Both the text and the hue are the project: the card's column and the
            id's prefix below already say which type this is, so the pill spends
            everything it has on the one thing position can't tell you. */}
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
      </div>
    </div>
  );
}
