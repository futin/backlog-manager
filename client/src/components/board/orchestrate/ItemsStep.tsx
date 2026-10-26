import { actionLabel } from '../../../../../shared/agent';
import { Chip } from '../../ui/Chip';
import { Pill } from '../../ui/Pill';
import type { StepProps } from './types';

/**
 * ItemsStep — the Orchestrate sheet's step 1, `items` (.claude/DESIGN.md §8.7 Overlays): the queue preview, its selection controls and the uncommitted note.
 * Presentational over the `OrchestrateDraft` it is handed (#306) — no state, no fetch, no `useSettings`; every value and every action is the draft's, so the
 * step renders alone in `test/orchestrate-steps.test.tsx`. The words each comment below calls "above" or "this file" are the derivations' and the state's,
 * which live in `lib/orchestrate-draft.ts` and `hooks/useOrchestrateDraft.ts`.
 */
export function ItemsStep({ draft }: StepProps) {
  const {
    narrowed,
    selectedIds,
    queueIds,
    queue,
    base,
    uncommittedIds,
    absentCount,
    staleCount,
    uncommittedSelected,
    fateOf,
    isSelected,
    emptySelection,
    toggle,
    selectAll,
    selectNone,
    deselectUncommitted
  } = draft;
  return (
    <div className="orchestrate-step-body" data-testid="orchestrate-step-items">
      <div className="sheet-note">
        preview — the run re-gates every item itself the moment it starts, so this list is not the final word on what actually runs.
        {/* The disclaimer above promises the run may re-gate an item
            to a different VERDICT. It says nothing about the run
            skipping most of the list, so a narrowed selection needs
            its own sentence: an orchestrate run is a multi-hour
            unattended operation, and "I thought it was draining
            everything" is not something anyone finds out cheaply. */}
        {narrowed && selectedIds.length > 0 && (
          <>
            {' '}
            only the {selectedIds.length} selected {selectedIds.length === 1 ? 'item' : 'items'} will run.
          </>
        )}
      </div>

      {/* The uncommitted warning (task-32, per-fate since #235). Opens
          with the ONE fact that is true of every flagged row — the run
          reads main's copy, not the file on disk — and then states
          only the fates actually on screen, each with its own count.

          Every `main` in this comment reads as the picked base
          (#254): the note names `base`, since the lookup is asked at
          it. `uncommittedItemPaths` flags any item file whose working
          tree differs from main, which is deliberately broader than
          `buildGatedQueue`'s `not committed on ${base}` reason: that
          fires only when the path is ABSENT from main. A row that is
          present at main and merely edited since is flagged here and
          gated by the run — which then executes MAIN'S bytes, so a
          plan written after the last commit is not the plan that
          runs. Review round 1 caught this note calling every flagged
          row a skip; the server now says which fate each row has
          (`absent`), so the note states each as fact instead of
          hedging over both, and a fate whose count is 0 is not
          mentioned at all. (Any working-tree touch reaches the stale
          fate, `backlog.mjs start --as groom`'s own `updated:` stamp
          included.)

          The verdict string stays on screen VERBATIM in the absent
          sentence — `not committed on main` is what the run writes
          into the run file's reasons, so a person who finds the skip
          afterwards can match it up. `Groomed on disk only` is
          task-29's wording, said by the groom skill at the moment the
          state is created; both phrases earn their place, as two
          sentences to two readers at two times. It is offered as the
          NAME of the usual case rather than asserted of all N rows
          (review round 2, Minor): the queue preview deliberately lists
          ungroomed bugs and tasks too — see `queue` above — so a
          flagged-and-ungroomed row exists and "groomed on disk only"
          is false of it. Keeping the shared phrase and scoping it
          costs one parenthesis; dropping it would cost the one link
          between this screen's words and the groom skill's.

          Its own note rather than another clause on the preview
          disclaimer above: that one says the run may re-gate an item
          to a different VERDICT, which is not the same claim as "the
          bytes the run gates are not the bytes on this screen". */}
      {uncommittedIds.length > 0 && (
        <div className="sheet-note" data-testid="orchestrate-uncommitted-note">
          {uncommittedIds.length} {uncommittedIds.length === 1 ? 'item differs' : 'items differ'} from {base} — the run reads {base}'s copy rather
          than the file here ("groomed on disk only", in the usual case).
          {absentCount > 0 && (
            <>
              {' '}
              {absentCount} {absentCount === 1 ? 'is' : 'are'} missing from {base} altogether and will be skipped ("not committed on {base}").
            </>
          )}
          {staleCount > 0 && (
            <>
              {' '}
              {staleCount} {staleCount === 1 ? 'is' : 'are'} on {base} but stale there, so the run gates and executes {base}'s older copy — a plan
              written since the last commit is not the plan that runs.
            </>
          )}
        </div>
      )}

      {queue.length === 0 ? (
        <div className="drawer-empty">nothing groomed and open in this project</div>
      ) : (
        <>
          {/* Buttons rather than a tri-state header checkbox: an
              indeterminate checkbox has no accessible state a screen
              reader reads usefully without extra aria, and "all" and
              "none" are two different intentions here rather than two
              positions of one control — `selected === null` (no
              restriction) and a full explicit set are not the same
              request, and only "select all" can get back to the
              first. */}
          <div className="orchestrate-select-actions">
            <span className="sheet-note">
              {selectedIds.length} of {queueIds.length} selected
            </span>
            <Chip size={28} onClick={selectAll} disabled={!narrowed}>
              select all
            </Chip>
            <Chip size={28} onClick={selectNone} disabled={selectedIds.length === 0}>
              select none
            </Chip>
            {/* Rendered only when there is something to deselect, the
                same way the note above is: a permanently-disabled
                fourth button would put a question ("what does that
                mean?") on every launch screen in every project that
                has no such rows, which is most of them most of the
                time. The count is the still-SELECTED flagged rows, so
                pressing it once retires the control rather than
                leaving it claiming work it has already done. */}
            {uncommittedSelected.length > 0 && (
              <Chip size={28} onClick={deselectUncommitted}>
                deselect uncommitted ({uncommittedSelected.length})
              </Chip>
            )}
          </div>

          <div className="run-drawer-queue" data-testid="orchestrate-queue">
            {queue.map(({ item, action }) => (
              <div key={item.path} className="run-drawer-item" data-fate={fateOf(item.path) ?? undefined}>
                <div className="run-drawer-item-head">
                  {/* Labelled by id, which is both unique in this
                      list and the exact string the request carries —
                      so the accessible name names the thing being
                      selected rather than describing it. Never
                      disabled for an ungroomed row: the run really
                      will queue it, gate it and report it, and this
                      screen has no authority to decide otherwise
                      (see `queue` above). */}
                  <input
                    type="checkbox"
                    className="orchestrate-select"
                    aria-label={`select ${item.id}`}
                    checked={isSelected(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                  <span className="run-drawer-item-id">{item.id}</span>
                  <span className="run-drawer-item-title">{item.title}</span>
                  <span className={`orchestrate-preview-action ${action}`}>{actionLabel(item, action)}</span>
                  {/* Beside the action label, not instead of it: the
                      two say different things — what the run would DO
                      with this item, and whether the bytes it will do
                      that to are the ones on this screen — and the run
                      really will queue this row, gate it and report
                      it, which is why the checkbox stays enabled and
                      the row stays in the list. Same reasoning the
                      file already gives for never disabling an
                      ungroomed row: this screen has no authority to
                      decide otherwise.

                      The word stays `uncommitted` rather than forking
                      into one word per fate (review round 1, Minor;
                      re-decided in #235): one vocabulary across the
                      chip, the `deselect uncommitted (N)` button, the
                      endpoint and the docs is worth more than a second
                      visible word. The per-row fate rides in the
                      pill's `title` and the row's `data-fate` instead,
                      and the note directly above states each fate as
                      fact with its count. */}
                  {fateOf(item.path) === 'absent' && (
                    <Pill tone="warn" title={`missing from ${base} — the run skips it (not committed on ${base})`}>
                      uncommitted
                    </Pill>
                  )}
                  {fateOf(item.path) === 'stale' && (
                    <Pill tone="warn" title={`on ${base} but older there — the run executes ${base}'s copy, not this file`}>
                      uncommitted
                    </Pill>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Refused here as well as server-side, and the wording is why:
          the server's 400 is correct but arrives after a round trip
          and cannot say what this can — unticking everything means
          "run nothing", which is never what anyone wants and is
          emphatically not the same as "run everything". Since the
          sheet became a wizard this refuses `next` rather than
          `start`: the two are the same refusal one screen apart, and
          blocking it here means the state can never reach a screen
          that would have to explain itself all over again. */}
      {emptySelection && <div className="sheet-note">pick at least one item, or select all to drain the queue.</div>}
    </div>
  );
}
