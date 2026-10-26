import { Chip } from '../../ui/Chip';
import type { StepProps } from './types';

/**
 * OrderStep — the Orchestrate sheet's step 2, `order` (.claude/DESIGN.md §8.7 Overlays): the selection in run order, moved a row at a time, and the reset
 * that hands the run back to whatever the gate finds. Presentational over the `OrchestrateDraft` it is handed (#306), like its two siblings; `arranged` and
 * `move` are `arrangeOrder`/`moveRow` (`lib/orchestrate-draft.ts`) by way of the hook.
 */
export function OrderStep({ draft }: StepProps) {
  const { arranged, order, byId, move, resetOrder } = draft;
  return (
    <div className="orchestrate-step-body" data-testid="orchestrate-step-order">
      {/* Two notes, two different facts. The first is what an order
          COSTS: it forces an explicit id list into the request even
          with nothing deselected, so the run is pinned to exactly
          these items and an item groomed a minute from now will not
          join it (§7.3, and `narrowed`'s own comment above). Saying
          it here rather than on the last screen is deliberate — this
          is the step that causes it, and the reset control that
          undoes it is on this screen too. */}
      <div className="sheet-note">
        arranging the queue pins this run to these items — anything groomed after now will not join it. Reset to leave the run draining whatever the
        gate finds.
      </div>

      <div className="orchestrate-select-actions">
        <span className="sheet-note">{arranged.length} in this order</span>
        <Chip
          size={28}
          onClick={resetOrder}
          /* The only control that can return `order` to `null`, and
             therefore the only way back to the whole-queue request —
             the same asymmetry "select all" has against "select
             none". Disabled while there is nothing to undo. */
          disabled={order === null}
        >
          reset order
        </Chip>
      </div>

      {/* No `uncommitted` chip on these rows, and that is a decision
          rather than an omission (task-32): the flag is a step 1 fact
          about membership — "should this be in the run at all" — and
          step 1 is where the control that acts on it lives. This step
          answers a different question, in what order, and repeating
          the chip here would invite acting on it from a screen that
          has no checkbox to act with. */}
      <div className="run-drawer-queue" data-testid="orchestrate-order">
        {arranged.map((id, i) => {
          const item = byId.get(id);
          if (item === undefined) return null;
          return (
            <div key={item.path} className="run-drawer-item" data-testid="orchestrate-order-row" data-id={id}>
              <div className="run-drawer-item-head">
                <span className="run-drawer-item-id">{item.id}</span>
                <span className="run-drawer-item-title">{item.title}</span>
                {/* ↑/↓ rather than drag-and-drop (§7.5):
                    keyboard-accessible by construction, assertable
                    under jsdom, and consistent with an app whose
                    every control is a select or a button. Labelled
                    by id for the reason step 1's checkboxes are —
                    the accessible name names the row being moved
                    rather than describing the arrow. */}
                <span className="orchestrate-move">
                  <Chip size={28} aria-label={`move ${id} up`} onClick={() => move(i, -1)} disabled={i === 0}>
                    ↑
                  </Chip>
                  <Chip size={28} aria-label={`move ${id} down`} onClick={() => move(i, 1)} disabled={i === arranged.length - 1}>
                    ↓
                  </Chip>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {arranged.length === 0 && <div className="drawer-empty">nothing to arrange — this run will drain whatever the gate finds</div>}

      {/* §7.4. The note must NOT claim to know which item hoists:
          this preview is client-side off `BacklogItem`, which carries
          no `runnerFix` at all, and the marker's authority is the
          blob at `<base>` rather than the working copy — so a derived
          badge would be confidently wrong for an item marked but not
          yet committed. Same posture as the preview disclaimer on
          step 1: honest that this screen is an approximation. */}
      <div className="sheet-note">
        an item marked <code>runner-fix:</code> is still hoisted to the front, above this order. This screen cannot tell you which one — the marker is
        read from the committed item, not the copy on disk.
      </div>
    </div>
  );
}
