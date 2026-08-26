import type { BacklogItem, Section } from '../../../../shared/types';

/** Pill class per section. The pill wears the section's hue but *reads* the
 *  project name: the card already sits in the section's own column, so a label
 *  spelling out "idea" repeats what the column heading said, while the project
 *  is the one thing a card on this cross-project board can't get from its
 *  position. Colour keeps the type, text carries the project. */
const PILL: Record<Section, string> = {
  bugs: 'pill-bug',
  ideas: 'pill-idea',
  tasks: 'pill-task',
  'out-of-scope': 'pill-oos'
};

/**
 * guide-manager's .guides-card, ported: title on top, footer pinned to the
 * bottom with a project pill and a mono meta line. Keyboard added (the original
 * was pointer-only): the whole card is the target, so it needs to be reachable.
 */
export function ItemCard({ item, onOpen }: { item: BacklogItem; onOpen: () => void }) {
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
        <span className={`pill ${PILL[item.section]}`}>{item.project}</span>
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
