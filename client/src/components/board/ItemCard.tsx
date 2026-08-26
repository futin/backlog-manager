import type { BacklogItem, Section } from '../../../../shared/types';

/** Pill class + label per section — the label is the id prefix, which is what
 *  the store's own filenames call the type. */
const PILL: Record<Section, { cls: string; label: string }> = {
  bugs: { cls: 'pill-bug', label: 'bug' },
  ideas: { cls: 'pill-idea', label: 'idea' },
  tasks: { cls: 'pill-task', label: 'task' },
  'out-of-scope': { cls: 'pill-oos', label: 'oos' }
};

/**
 * guide-manager's .guides-card, ported: title on top, footer pinned to the
 * bottom with a type pill and a mono meta line. Keyboard added (the original
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
        <span className={`pill ${PILL[item.section].cls}`}>{PILL[item.section].label}</span>
        <div className="board-card-meta">
          {item.id} · {item.project} · {item.created}
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
