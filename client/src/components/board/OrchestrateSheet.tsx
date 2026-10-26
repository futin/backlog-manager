import { useState } from 'react';

import { useOrchestrateDraft } from '../../hooks/useOrchestrateDraft';
import { Chip } from '../ui/Chip';
import { FormSheet } from '../ui/FormSheet';
import { ItemsStep } from './orchestrate/ItemsStep';
import { ModesStep } from './orchestrate/ModesStep';
import { OrderStep } from './orchestrate/OrderStep';
import type { BacklogItem, PermissionMode, ProjectSummary } from '../../../../shared/types';

/**
 * The three steps, in order, with the word each one puts in the indicator.
 * A literal tuple rather than three hand-written spans so the indicator, the
 * `Step` type and the Back/Next arithmetic below all read off one list —
 * and so the indicator cannot silently disagree with what is rendered.
 */
const STEPS = ['items', 'order', 'modes'] as const;
type Step = 1 | 2 | 3;

/**
 * OrchestrateSheet — the toolbar's "drain this project's whole groomed
 * queue" control, opened by BoardView's own Orchestrate button.
 *
 * Sibling of LaunchSheet, not a mode grafted onto it — Task 13's brief asks
 * for that decision to be made by reading LaunchSheet first and judging how
 * deep its coupling to a single `BacklogItem` runs. It runs all the way
 * through:
 *   - LaunchSheet's one effect fetches a PER-ITEM plan by `item.path`
 *     (`POST /api/agents/plan`) and hangs the whole render on it (loading /
 *     blocked / ready). There is no such endpoint for a whole project, and
 *     brief context point 6 is explicit that there must not be one — the
 *     orchestrator tool's own gate (orchestrate.mjs) is the only truth, and
 *     the run re-gates itself when it starts. So this component's "preview"
 *     is a pure derivation over props BoardView already had in hand (see
 *     `orchestrateQueue`, lib/orchestrate-draft.ts), never a fetch. Task 8 added the first exception — a
 *     `GET /api/agents/merge-check` effect behind the merge-mode picker —
 *     and task-32 the second, a `GET /api/items/uncommitted` effect behind
 *     the queue preview's `uncommitted` chip. Neither one is a gate, which is
 *     the property that keeps them exceptions rather than a reversal: both
 *     are deliberately built so a failure renders nothing at all, and unlike
 *     a blocked LaunchSheet this sheet stays fully usable whether or not
 *     either request ever comes back. The queue itself is still a derivation
 *     over props and no fetch has any say in what it lists.
 *   - LaunchSheet's whole body is built around one editable `prompt`
 *     textarea for one item. Orchestrate has no prompt field, full stop —
 *     the server owns a constant one (`ORCHESTRATE_PROMPT`,
 *     agents.service.ts) and drops anything a caller sends, the same way
 *     dispatch's `action` is re-derived server-side rather than trusted.
 *   - LaunchSheet's dispatch body is keyed on `itemPath` + `action` and
 *     carries a `remoteControl` checkbox; `StartOrchestrateRequest`
 *     (lib/agents.ts) has neither — see agents.service.ts's own comment on
 *     why a board-started run deliberately never gets a remote-control
 *     channel.
 *   - LaunchSheet's success state replaces the form with a session link and
 *     stays open. This sheet closes immediately on success instead (see
 *     `start` in hooks/useOrchestrateDraft.ts) — the Runs section is the ongoing-progress surface for
 *     an orchestrate run, reached from the band's own run chip (task-37; the
 *     run strip, Task 11, was that surface until then), not this sheet, so
 *     there is no "launched" panel here to show at all.
 * All five state variables LaunchSheet holds (`plan`, `planError`, `prompt`,
 * `remoteControl`, `sessionId`) would therefore be either meaningless or
 * permanently unused in an "orchestrate mode" bolted onto it, and every
 * future edit to LaunchSheet would have to keep reasoning about a second,
 * unrelated flow sharing its state. A sibling avoids that;
 * what IS genuinely shared — `MODELS`/`EFFORTS`/`clampMode`/`modesUpTo`
 * (shared/agent.ts), `useSettings()`'s seeding, the `.sheet*` CSS vocabulary,
 * and `FormSheet`, the shell this sheet and LaunchSheet both wear since
 * task-40 — is imported or restated in the same shape those already use,
 * never copy-pasted out of LaunchSheet's own body. `FormSheet` is also where
 * `useDialogEscape` is called from, the one owner of the Escape key all three
 * dialogs this app now has share (the item modal and these two sheets — three
 * since task-37 took the run drawer off the Board). That hook is bug-23's fix:
 * each of the four dialogs this app had then used to bind its own unguarded
 * `window` listener, so a press with two of them open closed both.
 */
export function OrchestrateSheet({
  project,
  projectName,
  source,
  items,
  spawnMaxPermission,
  onClose,
  refresh
}: {
  /** Registry path — the same string `StartOrchestrateRequest.project` and
   *  `BacklogItem.projectPath` both use. */
  project: string;
  /** Display name for the header; the registry's own name, not a path. */
  projectName: string;
  /** The registered project's `ProjectSummary.source`, passed by `BoardView` — never read off `items[0]`, which is absent on an empty queue. It decides one
   *  thing: `pr` is offered iff it is `'github'`, the same rule the server enforces with a 400 (`resolveMergeMode`). `null` (no store) and `'unsupported'`
   *  (a marker this build cannot read) are NOT `files`, and neither is offered `pr`. */
  source: ProjectSummary['source'];
  /** This project's items, unfiltered by the board's own search/status/sort
   *  — the preview below applies its own, narrower filter (see `queue`). */
  items: BacklogItem[];
  /** `AgentsStatus.spawnMaxPermission` — just the one field this sheet
   *  actually reads, taken directly rather than the whole status object so
   *  this component cannot be tempted to re-run `dispatchGate`'s own
   *  checks a second time. Those checks already happened once to decide
   *  whether the toolbar button that opens this sheet was even clickable,
   *  and the server re-runs the same check (`projectDispatchGate`,
   *  shared/agent.ts — one implementation, shared with `dispatchGate` and
   *  BoardView's own toolbar gate since Task 13's fix round 1) the instant
   *  Start is pressed — a second client-side copy here would be one more
   *  place for the two to drift apart, buying nothing the submit's own
   *  error path doesn't already cover. */
  spawnMaxPermission: PermissionMode | null;
  onClose: () => void;
  /** `useOrchestratorRuns()`'s own refresh — called after both a
   *  successful start (so the strip has the new run before the next
   *  5s poll would have found it on its own) and a 409 conflict (so the
   *  strip has the run that WON the race, per `start`'s own comment). */
  refresh: () => void;
}) {
  // Every piece of the run's state but `step` — the picks, the three reads, the selection, the order and `start` — is the hook's (#306), and the step views
  // below are presentational over what it returns.
  const draft = useOrchestrateDraft({ project, source, items, spawnMaxPermission, refresh, onClose });
  const { busy, emptySelection, runOn, start } = draft;
  /**
   * Which of the three steps is on screen (design §7). Held here rather than
   * derived from anything, because it is the one piece of this sheet's state
   * that is genuinely about the screen and not about the run: pick, arrange,
   * configure, go.
   *
   * Order sits between the other two on purpose — next to the selection it
   * operates on, since reordering rows that are about to be unticked is
   * wasted work, and before the modes because Start must be the last control
   * on the last screen rather than sitting below a scroll region whose
   * length is the size of the project's queue.
   */
  const [step, setStep] = useState<Step>(1);

  // Escape is `FormSheet`'s, not this file's — see its header, and
  // hooks/useDialogEscape.ts for the stack it registers with.

  return (
    <FormSheet
      label={`orchestrate ${projectName}`}
      title={
        <>
          <span className="sheet-kicker">orchestrate</span>
          <span className="sheet-title">{projectName}</span>
        </>
      }
      /* The stepper is the shell's own slot (§8.7: a 13/500 stepper on a
         hairline), which is what puts the rule under it rather than under the
         first step's first paragraph. Read off `STEPS` so it cannot disagree
         with what is actually rendered below. An <ol> rather than a row of
         spans because that is what it is — three ordered stages, one of them
         current — and `aria-current="step"` is the attribute a screen reader
         already knows how to announce for exactly this. */
      steps={
        <ol className="orchestrate-steps" aria-label="orchestrate steps">
          {STEPS.map((word, i) => (
            <li key={word} className={`orchestrate-step${i + 1 === step ? ' current' : ''}`} aria-current={i + 1 === step ? 'step' : undefined}>
              {i + 1} · {word}
            </li>
          ))}
        </ol>
      }
      onClose={onClose}
      /* One actions row for all three steps rather than one per step: cancel
         is available throughout and Back/Next/Start are the same control in
         three positions, so a reader's eye never has to find a
         differently-placed button after each transition. In the shell's
         footer since task-40, which pins it under the scrolling body — the
         three-step flow is exactly the shape that could otherwise scroll its
         own Start out of reach. */
      footer={
        <>
          <Chip size={28} variant="flat" onClick={onClose}>
            cancel
          </Chip>
          {step > 1 && (
            <Chip size={28} onClick={() => setStep((s) => (s === 3 ? 2 : 1))}>
              back
            </Chip>
          )}
          {step < 3 && (
            <Chip
              size={28}
              onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
              /* The same refusal the old Start carried, one screen earlier.
                 An EMPTY QUEUE is deliberately not this state — there is
                 nothing to narrow, so the sheet keeps its pre-selector
                 behaviour and walks all the way to a live Start. */
              disabled={step === 1 && emptySelection}
            >
              next
            </Chip>
          )}
          {step === 3 && (
            <Chip size={28} variant="ink" onClick={start} disabled={busy || emptySelection || runOn.blocked}>
              {busy ? 'starting…' : runOn.remote ? `Start on ${runOn.label}` : 'start'}
            </Chip>
          )}
        </>
      }
    >
      {step === 1 && <ItemsStep draft={draft} />}
      {step === 2 && <OrderStep draft={draft} />}
      {step === 3 && <ModesStep draft={draft} />}
    </FormSheet>
  );
}
