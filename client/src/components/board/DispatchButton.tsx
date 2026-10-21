import { actionLabel, deriveAction, dispatchGate, inReviewBlock } from '../../../../shared/agent';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';
import { disabledReason } from '../../lib/gate-view';
import { progressBlock } from '../../lib/item-progress';
import { Chevron } from '../ui/Chevron';
import { GatedChip } from '../ui/GatedChip';

/**
 * Whether this item gets a dispatch control at all — the two "no control, not
 * a disabled one" rules below, in one predicate.
 *
 * Exported because `ItemCard` has to ask the same question before it draws the
 * marker row: DESIGN.md §8.3 puts the dispatch chip at the row's right end and
 * says the row "renders whenever dispatch is available, markers or not", so a
 * card with no markers and no dispatch must draw no row while a card with no
 * markers and a dispatch must. The card asking `deriveAction`/`dispatchGate`
 * itself would be a second copy of this component's own first two lines, free
 * to fall out of step with them; this is the one implementation, read by the
 * component that renders the control and the one that reserves the space.
 */
export function dispatchAvailable(item: BacklogItem, status: AgentsStatus | null): boolean {
  if (deriveAction(item) === null || status === null) return false;
  return dispatchGate(item, status).control !== 'hidden';
}

/**
 * DispatchButton — the click that hands this item to a Claude session.
 *
 * Three states, and the two absent ones matter most:
 *  - An item with no next step (archived, or out of scope) gets no control at
 *    all rather than a disabled one, because there is nothing here to enable.
 *  - A status that has not arrived yet is also nothing — otherwise every board
 *    load flashes a dead button.
 *  - And an ENVIRONMENT-level block (dispatch off, dashboard unreachable, no
 *    CLAUDE_BIN, remote answers off) renders nothing either: see
 *    `dispatchGate` in shared/agent.ts for why those four hide the control
 *    while the per-item ones disable it. The short version is that a control
 *    disabled on every single card, for a reason that is not about any of
 *    them, is noise; "BM_AGENTS is off" belongs in Settings, which reports it.
 *
 * There are THREE per-item blocks, not one: the dashboard cannot see this
 * item's project (derived here, from `status`), a local skill session already
 * holds this item (derived here too, by `progressBlock` — the only one of the
 * three the item file itself can answer, since `started:` is right there in
 * its frontmatter), and an orchestrator run has already claimed this item
 * (handed in as `runBlock`, because nothing in the item file or the status
 * payload can know it). All three disable with their reason; see the comment
 * above `gateBlock` below for why they read in that order.
 *
 * Exactly ONE of the three lets a click do something anyway, and that is
 * bug-13: a project-visibility block is the only one that can be silently
 * out of date, so clicking it RE-ASKS the status (`reverify`) and opens the
 * sheet if the block has cleared. The other two are refused as before — see
 * `reverify`'s own prop comment for why the asymmetry is the whole fix and
 * not an inconsistency.
 *
 * `status` is trusted here exactly as typed: making it honest at runtime is
 * `fetchAgentsStatus`'s job (`lib/agents.ts`), the one place a JSON body
 * actually becomes this type, not every leaf that consumes it — a guard here
 * would not follow `useAgents` to whatever consumes it next.
 *
 * The derivation is `shared/agent.ts`, the same module the server validates
 * with, so the label can never promise an action the API would refuse.
 *
 * ONE shape, where there used to be two (task-37). The card's tear-off `tab`
 * is gone with the card that had an edge to tear off: DESIGN.md §8.3 puts this
 * control at the right end of the card's marker row as a 28 px `Chip`, the
 * same chip the item modal's facts column draws, so the `variant` prop and the
 * `.dispatch-tab` family it selected have no second case left to distinguish.
 * The shell is now the primitive's; what stays this component's own is the
 * action tone on the word (DESIGN.md §8.2 keeps all three: groom `--mustard`,
 * execute `--cyan`, capture `--magenta`) — carried by the label's own class
 * rather than by a rule reaching into `.ui-chip`, which is the restatement
 * `test/design-guards.test.ts`'s guard 7 exists to refuse.
 */
export function DispatchButton({
  item,
  status,
  onDispatch,
  runBlock = null,
  reverify
}: {
  item: BacklogItem;
  status: AgentsStatus | null;
  onDispatch: () => void;
  /**
   * Why an orchestrator run forbids dispatching this item right now, or null.
   *
   * A prop rather than a derivation, unlike every other state this component
   * decides for itself: the answer lives in the run payload alone
   * (`GET /api/orchestrator/runs`), which this leaf has no access to and no
   * business fetching forty times per board. `runClaimBlock`
   * (shared/agent.ts) is what produces the string, once, from the run list
   * the board already holds — see its doc comment for why the item file
   * cannot carry this fact at all.
   *
   * Optional and defaulted so every caller that has no run data to give
   * (the older tests, any future read-only view) behaves exactly as before.
   *
   * Since #17 the board and the Archive also carry the sync-off block here
   * (`itemSyncOff`, lib/tracker.ts) when no run block speaks: the same kind of
   * fact — read off a payload this leaf does not hold, the project list — and
   * the same kind of block, a per-project one that DISABLES and never hides.
   * It is never re-asked (`gateView`'s `reverifiable`, lib/gate-view.ts) for
   * `runBlock`'s own reason: a status refetch cannot move it.
   */
  runBlock?: string | null;
  /**
   * Re-ask the dashboard status and resolve to the fresh answer — the board's
   * own `useAgents().reload`, threaded down.
   *
   * bug-13. `useAgents` refetches on mount and window focus only, and that
   * cadence is deliberate (see its own comment). It is also, for one of the
   * three per-item blocks, unrecoverable: a board whose window never loses
   * focus keeps whatever `projectPaths` it last fetched, and while a stale
   * *enable* self-corrects (the click opens the sheet, whose `plan()`
   * re-derives the block server-side), a stale *disable* cannot — the sheet
   * that would correct it sits behind the control the stale answer just
   * made inert. So the click asks the question itself.
   *
   * Scoped to the project-visibility block alone, and the two exclusions are
   * the reasons, not exceptions to them. `runBlock` is fed by
   * `useOrchestratorRuns`, which polls every 5s for as long as any run is
   * fresh, so it is never stale in this way — and a claimed item genuinely
   * must not be hand-dispatched. `progressBlock` is derived from the very
   * item file this board is rendering, so no status refetch could move it.
   *
   * Optional, like `runBlock`: a caller with no status to re-ask (the older
   * tests, any future read-only view) leaves the click inert exactly as it
   * was before this existed.
   */
  reverify?: () => Promise<AgentsStatus>;
}) {
  const action = deriveAction(item);
  /* The same two rules `dispatchAvailable` states, read through it rather than
     restated: this component and `ItemCard`'s marker row have to agree about
     when a control exists, and they agree by construction only while there is
     one predicate. The narrowing below is what the early return buys — TS
     cannot see through the helper, so `action`/`status` are re-checked here
     and the helper is what nobody else has to copy. */
  if (!dispatchAvailable(item, status) || action === null || status === null) return null;

  const gate = dispatchGate(item, status);

  /*
   * Order is the invariant, not a preference: ENVIRONMENT-level → per-item
   * project visibility → in progress → in review → run claim. The first still returns
   * `null` above (no control at all — see the file comment and `dispatchGate`
   * for why), and the other three disable with a reason. The run claim reads
   * LAST of the four because it is the most volatile and the least
   * fundamental: with dispatch off or the project invisible there is nothing
   * to say about a run, and a reason naming a stage would send the reader to
   * watch a queue when what needs fixing is the dashboard.
   *
   * The in-progress block slots in just ahead of it by that same logic: the
   * `started:` stamp is on the file this very board is rendering, while a run
   * claim is a fact about another worktree that the next poll can change. The
   * two coexist only pathologically — a run stamps `started:` on its own
   * worktree's copy, so the registry's copy of a claimed item normally carries
   * no stamp at all — and when they do, the file wins.
   */
  const gateBlock = disabledReason(gate);
  /* The two a click can never clear, in that same precedence — split out
     from the gate's own block rather than folded into one string because
     bug-13's re-ask has to know WHICH of the three is speaking. Kept as one
     value because the answer it feeds is the same for both: refuse, ask
     nothing. */
  /* The in-review rung (spec decision 9) sits between them: a tracker issue whose PR is open carries the flag on the item this board renders, so it
     outranks the volatile run claim, while a live session's stamp still names the more immediate fact. */
  const itemBlock = progressBlock(item, Date.now()) ?? inReviewBlock(item) ?? runBlock;

  return (
    <>
      {/*
        The wrapper exists for the two stopped events alone, and both were on
        the button itself until `Chip` took the shell over — the primitive's
        `onClick` is a bare `() => void`, deliberately (a chip that handed out
        its own event object would let a caller preventDefault its way into a
        second behaviour), so the stopping has to happen one level out. It
        still happens before the card's own handlers, because these fire on the
        way up and the card is further up.

        `stopPropagation` on click: the whole card is a role="button" that
        opens the drawer, and without this one click opens both.

        On keydown, bounded to the two keys the card's own handler acts on and
        no further. Same reasoning, keyboard path: the card's onKeyDown bubbles
        from ANY descendant and unconditionally calls preventDefault()+onOpen().
        Left unstopped, Enter on this button would have that handler fire first
        (preventDefault there cancels the button's own Enter-activates-click
        behaviour, so the drawer opens and the sheet does not), and Space would
        open the drawer on keydown while the button's own keyup click still
        fires — both open, the exact double-open the click half prevents, back
        again through the keyboard.

        Stopping EVERY key instead was a real bug, not a harmless over-reach:
        React 18 delegates keydown at the root, and a synthetic stopPropagation
        also stops the native event, so nothing at `window` ever saw it. With
        focus still on this button after the sheet opened — which is where
        focus is, since nothing in the sheet takes it — Escape never reached
        the sheet's own window listener and the sheet would not close. Same for
        the drawer's Escape while its head button held focus.
      */}
      <span
        className="dispatch-chip"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
      >
        {/* The disabled mechanics — the disabled flag, the described reason, the busy state and bug-13's re-ask — are `GatedChip`'s (#272); this
            component keeps the policy: its gate, re-run over the fresh status, and the two blocks a click can never clear. */}
        <GatedChip
          size={28}
          gateBlock={gateBlock}
          otherBlock={itemBlock}
          idleTitle={`dispatch ${action} to a Claude session`}
          reverify={reverify}
          // Through the same gate, so a status that came back with dispatch off or the dashboard gone opens nothing either. `itemBlock` cannot
          // have changed in the meantime: one half is on the item file this board is rendering, the other is a prop.
          recheck={(fresh) => dispatchGate(item, fresh).control === 'enabled'}
          onActivate={onDispatch}
        >
          {(blocked) => (
            <>
              {/* The action IS the tone class: `groom` and `execute` are the two
                  AgentAction values plus `capture`, so the palette can never drift
                  from the derivation. `blocked` replaces the tone rather than
                  joining it — a dimmed word is the disabled reading, and a
                  --mustard word at 45% opacity would be a third colour nobody
                  chose. */}
              <span className={blocked ? 'dispatch-word blocked' : `dispatch-word ${action}`}>{actionLabel(item, action)}</span>
              {/* `Chevron` is aria-hidden: the accessible name is the action word alone. */}
              <Chevron dir="right" className="dispatch-mark" />
            </>
          )}
        </GatedChip>
      </span>
    </>
  );
}
