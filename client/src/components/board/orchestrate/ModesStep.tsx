import { mergeAllowRules } from '../../../../../shared/agent';
import { MERGE_MODES, QUESTION_MODES } from '../../../../../shared/types';
import type { MergeMode, PermissionMode, QuestionMode } from '../../../../../shared/types';
import { prRequiredText } from '../../../lib/dashboards';
import { RunOn } from '../../ui/RunOn';
import { Select } from '../../ui/Select';
import type { StepProps } from './types';

/**
 * The question-mode picker's own words (design §7), built the same way
 * `mergeModeOptionLabels` (`lib/merge-mode.ts`) is and for the identical
 * reason: a `Record<QuestionMode, string>` stops this file compiling the day
 * `QuestionMode` gains a third member and nobody has decided what this
 * control calls it, which an ordered pair of literal strings would not.
 *
 * Both labels name what the RUN will do, never the flag a caller would type.
 * `park`'s in particular is written from the person's side — "skip the item
 * for me" — rather than the tool's `--question-mode park`, because the whole
 * decision this control asks for is what should happen to an item nobody is
 * there to answer a question about.
 */
const QUESTION_MODE_LABELS: Record<QuestionMode, string> = {
  decide: 'Decide and continue',
  park: 'Skip the item for me'
};

/**
 * The exact JSON the setup hint (§6) tells a reader to paste for `project`: `mergeAllowRules`, the pair `merge-check.util.ts` is tested against — one for the
 * preflight probe's `git merge --no-ff … HEAD`, one for the real merges' `git -C "<project>" merge --no-ff …`. Until #269 this was the single
 * `Bash(git merge:*)`, which matches the probe and no real merge: the sheet said "covered" while every merge still went to the classifier. Never the broader
 * `Bash(git:*)`, which grants every git subcommand, and never a `*` before `merge` (`mergeAllowRules` says why). `JSON.stringify(..., null, 2)` rather than a
 * hand-typed multi-line template so this can never drift from actually-valid JSON.
 */
function mergeAllowSnippet(project: string): string {
  return JSON.stringify({ permissions: { allow: mergeAllowRules(project) } }, null, 2);
}

/**
 * ModesStep — the Orchestrate sheet's step 3, `modes` (.claude/DESIGN.md §8.7 Overlays): where the run goes and how it runs — machine, permission, model,
 * effort, merge mode, question mode and base — with the notes and the setup hint those picks earn. Presentational over the `OrchestrateDraft` it is handed
 * (#306): the picks are the hook's state, the merge-check answer its read, and `error` is `start`'s, so the step renders alone in a test.
 */
export function ModesStep({ draft }: StepProps) {
  const {
    runOn,
    mode,
    setMode,
    allowedModes,
    mergeMode,
    setMergeMode,
    prOffered,
    mergeModeLabels,
    questionMode,
    setQuestionMode,
    base,
    setBase,
    branches,
    mergeCoverage,
    project,
    error
  } = draft;
  const { model, setModel, effort, setEffort } = runOn;
  return (
    <div className="orchestrate-step-body" data-testid="orchestrate-step-modes">
      {/* The picker leads the step (spec "The picker's look"): where the run goes decides what Merge mode, Model and Effort below can be. `RunOn` draws
          nothing below two machines, so a home-only board's step is unchanged. */}
      {runOn.offers !== null && <RunOn offers={runOn.offers} value={runOn.machine} onChange={runOn.pick} />}
      {runOn.note !== null && <div className="sheet-note">{runOn.note}</div>}

      {/* Same one-row grouping LaunchSheet's own `.sheet-row` uses for
          the identical three controls — "how should this run" is one
          decision there and stays one decision here. */}
      <div className="sheet-row">
        <label className="sheet-field">
          <span className="set-name">Permission mode</span>
          <Select<PermissionMode> label="Permission mode" value={mode} onChange={setMode} options={allowedModes.map((m) => ({ value: m, label: m }))} />
        </label>

        <label className="sheet-field">
          <span className="set-name">Model</span>
          <Select label="Model" value={model} onChange={setModel} options={runOn.modelOptions} />
        </label>

        <label className="sheet-field">
          <span className="set-name">Effort</span>
          <Select label="Effort" value={effort} onChange={setEffort} options={runOn.effortOptions} />
        </label>

        <label className="sheet-field">
          <span className="set-name">Merge mode</span>
          {/* bug-36: the labels are derived from `base` at the call
              site rather than read off a module constant, so picking
              a branch two fields below re-renders this option text
              with it. The picker and the note beneath the row are two
              statements of one fact, and what was filed was them
              disagreeing — the note named the picked branch while
              this read "Merge to main" whatever the base was. */}
          <Select<MergeMode>
            label="Merge mode"
            value={mergeMode}
            onChange={setMergeMode}
            disabled={runOn.lock.prOnly}
            options={MERGE_MODES.filter((m) => m !== 'pr' || prOffered || runOn.remote).map((m) => ({ value: m, label: mergeModeLabels[m] }))}
          />
          {runOn.remote && <span className="sheet-note">{prRequiredText(runOn.label!)}</span>}
        </label>

        <label className="sheet-field">
          <span className="set-name">Question mode</span>
          <Select<QuestionMode>
            label="Question mode"
            value={questionMode}
            onChange={setQuestionMode}
            options={QUESTION_MODES.map((q) => ({ value: q, label: QUESTION_MODE_LABELS[q] }))}
          />
        </label>

        {/* The base picker (task-44), beside its two neighbours
            because it answers the same "how should this run" question
            they do — but seeded from neither Settings nor the last
            launch; see the `base` state's own comment for why a
            remembered base is a worse failure than a re-picked one.
            Options come from the branch list this sheet fetched on
            open, which falls back to `['main']` alone and never
            blocks a launch. */}
        <label className="sheet-field">
          <span className="set-name">Base branch</span>
          <Select label="Base branch" value={base} onChange={setBase} options={branches.map((b) => ({ value: b, label: b }))} />
        </label>
      </div>

      {/* Shown only for a base that is not `main`, unlike the question-
          mode note above it, and the asymmetry is the point: that note
          is about a CHOICE and so is true of both its values, while
          this one is about a consequence only one value has. A `main`
          run behaves exactly as every run did before this picker
          existed, and a permanent line saying so would be noise on the
          screen almost every run passes through. */}
      {base !== 'main' && (
        <div className="sheet-note">
          this run gates, branches and merges on <code>{base}</code> — <code>main</code> is never written. Items not committed on <code>{base}</code> are
          skipped, and merging <code>{base}</code> into <code>main</code> afterwards stays yours to do by hand.
        </div>
      )}

      {/* The doctrine, in the third of the four places a reader can
          arrive at this feature first (the others are Settings' own
          hint, SKILL.md §3 and CLAUDE.md's invariants). It says what
          the picker cannot: the two modes are IDENTICAL whenever
          `AskUserQuestion` is reachable, so this control only ever
          takes effect in a headless run — which is the only kind this
          sheet can start. Rendered unconditionally, for both values,
          because the sentence is about the choice rather than about
          either option. */}
      <div className="sheet-note">
        what a run does with an item's open questions when nobody can answer them. Want control over a question, start the run from a harness that has{' '}
        <code>AskUserQuestion</code>; start it from here and you are choosing between skipping the item and letting the runner answer.
      </div>

      {/* The setup hint (§6) — shown only under `merge` mode, and only
          once the check has actually come back uncovered (brief cases
          4/5/6/7 above). States the missing path as FACT and the
          effect as a LIKELIHOOD, the same two-part shape
          `dispatchGate`'s own reason string uses (shared/agent.ts) and
          for the same reason: no reader of this sentence is closer to
          the auto-mode classifier than a settings file is, so it can
          say what is missing but never promise what adding it will
          do. It never offers to write the file — text and JSON to
          paste by hand, nothing clickable — an explicit non-goal of
          the design.

          Review fix round 1 (Minor): the choice of
          `settings.local.json` over the shared `settings.json` used to
          live only in this file's own top-of-file comment and
          `mergeAllowSnippet`'s — a reader of the rendered hint had
          no way to learn the alternative existed at all. One sentence
          below makes that tradeoff legible without touching either the
          FACT or the LIKELIHOOD sentence on either side of it:
          per-user takes effect immediately and never risks landing a
          permission grant in a file the whole team commits, and
          `settings.json` is named as the deliberate opposite choice
          for a reader who wants that instead. */}
      {mergeMode !== 'branch' && mergeCoverage !== null && !mergeCoverage.covered && (
        <div className="sheet-note orchestrate-merge-hint">
          <p>
            <code>{project}/.claude/settings.local.json</code> has no <code>git merge</code> allow rule. This is the per-user file, so the rule stays
            out of the shared <code>settings.json</code> your team commits — put it there instead if you want everyone to inherit it. The run may still
            merge without one, but not reliably — the auto-mode classifier's verdict on that exact command varies between runs. Add this to the file,
            creating it if it does not exist yet (or merge the two entries into an existing <code>permissions.allow</code> list rather than replacing
            it):
          </p>
          <pre className="orchestrate-merge-hint-json">{mergeAllowSnippet(project)}</pre>
        </div>
      )}

      {error !== null && <div className="sheet-error">{error}</div>}
    </div>
  );
}
