import { useState } from 'react';

import { POLL_MS } from '../../hooks/useOrchestratorRuns';
import { ApiError, resumeOrchestrate } from '../../lib/agents';
import { elapsedSince } from '../../lib/item-age';
import { projectLabel } from '../../lib/project-label';
import { mergeModeLabel, stageChipClass, stageGlyph } from '../../lib/run-stage';
import { formatSpanCompact, isTerminalStage, lastReportedEntry, runElapsedMs } from '../../lib/run-time';
import { isCrashed, watchdogClause } from '../../lib/run-watchdog';
import { inFlightItemId } from '../RunControls';
import { watchdogStoodDown } from '../../../../shared/agent';
import { RUN_IN_PROGRESS_CODE } from '../../../../shared/types';
import type { OrchestratorRun, RunQueueItem, RunWatchdog } from '../../../../shared/types';

/**
 * `RunStage`'s own doc comment (shared/types.ts) states the shape "current"
 * below is defined against: `merged` and `branched` are the pipeline's two
 * success exits — one per `MergeMode`, sharing the same terminal position —
 * and `failed`, `skipped`, `needs-answers`, `ungroomed`, and `parked` are the
 * five ways an item leaves it without merging. Together those seven are
 * every stage a run has let go of; `isTerminalStage` (lib/run-time.ts) is
 * that set, derived as the complement of `RUN_CLAIMED_STAGES`
 * (shared/types.ts) rather than restated here as a bare array of strings —
 * which is what this file used to do, and which is exactly how it went
 * seven-of-seven instead of the whole set: a hand-written `RunStage[]`
 * compiles whether or not it lists every member, so the omission of
 * `branched` (added by this same feature) went unnoticed until a
 * branch-mode run's own FINISHED item kept reading as "current" — this
 * strip's own progress claim calling a done run's last item still in
 * flight. `isTerminalStage` is backed by a `Record<RunStage, true>` pin
 * (`test/agents-shared.test.ts`) that forces a compiler error the day a
 * future `RunStage` member goes unclassified, which a plain array never
 * could.
 *
 * The first item NOT terminal is either genuinely mid-pipeline right now, or
 * (if the run has not dispatched anything yet) the next one due to be,
 * either of which is an honest answer to "what is this run doing".
 */

/**
 * How young a run's heartbeat (`updatedAt`) has to be to read as the word
 * "live" outright rather than as an aged reading ("3m", "1h", ...) off the
 * same `elapsedSince` ladder the card's own in-progress bar uses. Equal to
 * `useOrchestratorRuns`' own POLL_MS, imported rather than restated (fix
 * round 1 — the two used to just happen to share a value): that hook only
 * learns anything new about a fresh run once per poll, so a heartbeat
 * younger than one poll's worth of time is, from this board's vantage
 * point, as current as information gets — and that IS the reason for the
 * number, not a coincidence next to it, so importing it means a future
 * change to the poll interval carries this reading with it instead of
 * leaving it silently wrong.
 */
const LIVE_THRESHOLD_MS = POLL_MS;

type RunPayload = OrchestratorRun & {
  fresh: boolean; pastRuns: number; pauseRequested: boolean; watchdog?: RunWatchdog;
};

/**
 * The Resume click, shared by the crashed strip and the paused one (task-17).
 *
 * Hoisted the moment there were two callers, rather than copied: the 409
 * rule below is a genuine decision (a run that came back to life under the
 * click is the outcome the click wanted, not an error to render), and a
 * second hand-written copy of it is exactly the drift shape this file's own
 * `watchdogStoodDown` comment already records once.
 *
 * A factory rather than a component or a hook: both callers are plain
 * functions called conditionally, so neither may own `useState` (see
 * `renderCrashedStrip`'s doc comment) — the state lives in `RunStrip` and
 * is threaded through here.
 */
function makeAttemptResume({ run, blocked, onResumed, setResumeError }: {
  run: RunPayload;
  blocked: string | null;
  onResumed?: () => void;
  setResumeError: (err: string | null) => void;
}): () => void {
  return () => {
    if (blocked !== null) return;
    setResumeError(null);
    resumeOrchestrate(run.project)
      .then(() => {
        onResumed?.();
      })
      .catch((err: unknown) => {
        // A 409 run-in-progress answer means the run recovered under this
        // very click (design §6.1) — a success, not a failure, so it takes
        // the same path a clean 200 would rather than rendering an error
        // for something that just fixed itself.
        if (err instanceof ApiError && err.code === RUN_IN_PROGRESS_CODE) {
          onResumed?.();
          return;
        }
        setResumeError(err instanceof Error ? err.message : String(err));
      });
  };
}

/**
 * The paused strip (task-17) — the third rendering this component has, and
 * the one with a future.
 *
 * Same two-control shape as the crashed strip, and the same `<div>` root for
 * the same reason (see `renderCrashedStrip`'s long comment on why a
 * `<button>` may not contain another interactive element): the body opens
 * the drawer, Resume is a sibling button.
 *
 * Two deliberate differences from the crashed strip, both from the same
 * fact — the watchdog never watched this run:
 *
 *   - **No watchdog clause.** There is nothing to report: the sweeper only
 *     ever walks `running` runs, so a paused run has no attempt count, no
 *     verdict, and nothing pending.
 *   - **No `watchdogStoodDown` gate on Resume.** That gate exists to stop a
 *     board click and a sweep from both driving `--resume` into one
 *     `run.json`. Nothing is sweeping this run, so the environment half
 *     (`resumeGate`) is the whole gate. Do NOT "align" this with the crashed
 *     strip by adding the watchdog condition here — it would read a
 *     `watchdog` key that is absent by construction and hide the control on
 *     every paused run.
 */
function renderPausedStrip({
  run, onOpen, canResume, resumeBlockedReason, resuming, onResumed, resumeError, setResumeError
}: {
  run: RunPayload;
  onOpen: (run: RunPayload) => void;
  canResume?: boolean;
  resumeBlockedReason: string | null;
  resuming?: boolean;
  onResumed?: () => void;
  resumeError: string | null;
  setResumeError: (err: string | null) => void;
}) {
  const label = projectLabel(run.project);
  // Computed exactly as the fresh strip computes them, `ungroomed` excluded
  // from the denominator for the same reason — an item that was never
  // queueable work must not make a run read as permanently short of done.
  const total = run.queue.filter((q) => q.stage !== 'ungroomed').length;
  const completed = run.queue.filter((q) => q.stage === 'merged' || q.stage === 'branched').length;
  const modeLabel = mergeModeLabel(run.mergeMode, run.mergeModeEffective);
  const blocked = resumeBlockedReason;
  const attemptResume = makeAttemptResume({ run, blocked, onResumed, setResumeError });

  return (
    <div className="run-strip run-strip-paused" data-testid="run-strip">
      <button type="button" className="run-strip-open" onClick={() => onOpen(run)}>
        <span className="run-strip-dot" aria-hidden="true" />
        <span className="run-strip-project">{label}</span>
        <span className="run-strip-paused-label">paused</span>
        <span className="run-strip-count">paused · {completed} of {total} done</span>
        {modeLabel !== null && (
          <span className="run-mode-badge" data-testid="run-strip-mode">{modeLabel}</span>
        )}
        {resumeError !== null && <span className="run-strip-error">{resumeError}</span>}
        <span className="run-strip-mark" aria-hidden="true">▸</span>
      </button>
      {resuming === true ? (
        <span className="run-strip-resuming" data-testid="run-strip-resuming">Resuming…</span>
      ) : (
        canResume === true && (
          <button
            type="button"
            className="run-strip-resume"
            aria-disabled={blocked !== null || undefined}
            title={blocked ?? undefined}
            onClick={attemptResume}
          >
            Resume run
          </button>
        )
      )}
    </div>
  );
}

/**
 * The crashed strip's own render, called from `RunStrip` once `isCrashed`
 * is true. A plain function rather than a second component: the hooks rule
 * this file's own comment on `resumeError` explains is why that state has
 * to live in `RunStrip` itself and simply pass through here, not a reason
 * to duplicate it — a genuinely separate component would need its OWN
 * `useState`, which is the one thing a conditionally-called function must
 * not do.
 *
 * **Fix round 1 (review finding, Critical): a `<button>` cannot contain
 * another interactive element.** The first cut of this function kept the
 * strip's root as one `<button>` and rendered Resume as a nested
 * `<span role="button" tabIndex={0}>` inside it — which satisfies neither
 * half of the HTML content model for `button` ("no interactive content
 * descendant, and no descendant with a `tabindex` attribute"): the span is
 * interactive by ARIA role AND separately carries `tabIndex`. jsdom and
 * Testing Library never fail on this — both operate on the DOM tree, not on
 * HTML validity or the accessibility tree a real browser/AT combination
 * constructs from it — which is exactly why a green suite shipped it
 * anyway. `stopPropagation` fixed the click BEHAVIOUR (Resume no longer also
 * opened the drawer) but did nothing about the markup itself; which control
 * a screen reader's virtual cursor exposes, whether the nested one is even
 * reachable, and what a single-switch/voice-control "click" activates all
 * stay implementation-defined once that shape exists.
 *
 * **This is why the CRASHED strip's root is a `<div>` while the fresh
 * strip's stays a real `<button>` (`RunStrip`'s own return below) — do not
 * "unify" the two.** The fresh strip has exactly one control (open-the-
 * drawer), so a single `<button>` is the correct, simplest element for it.
 * The crashed strip has TWO independent controls — open-the-drawer over
 * most of the strip's body, and Resume, a genuinely separate action with
 * its own click target — and two controls cannot both be the same `button`
 * element, nor can one nest inside the other. The `<div>` root here carries
 * the `run-strip`/`run-strip-crashed` classes and the `run-strip` testid
 * (both consumed by every existing test and by this component's own CSS
 * selectors, unaffected by which element they're on); a real, focusable
 * `<button className="run-strip-open">` inside it covers the whole
 * informational area (project, "crashed", heartbeat, last-reported stage,
 * watchdog clause, any resume error) and is what `onOpen` binds to; Resume
 * is a second, SIBLING `<button>`, not a descendant of the open-button, so
 * neither is ever nested inside the other and the button-in-button defect
 * cannot recur here. Both being real buttons also means neither needs
 * hand-rolled Enter/Space handling — a native `<button>` gets that for
 * free — and Resume's click handler no longer needs `stopPropagation`
 * either: propagation only matters between an element and its ANCESTOR's
 * handler, and Resume has no ancestor with a click handler to escape now
 * that it is a sibling of the open-button rather than nested inside it.
 * `aria-disabled` + `title` (CLAUDE.md's own idiom, matching
 * DispatchButton) stays for the blocked case rather than the native
 * `disabled` attribute, for the same reason the first cut chose it: a
 * genuinely `disabled` button is pulled out of the tab order, which is
 * exactly the wrong outcome for a control whose whole point is to stay
 * inspectable ("why can't I resume this") by a keyboard user.
 */
function renderCrashedStrip({
  run, onOpen, canResume, resumeBlockedReason, onResumed, resumeError, setResumeError
}: {
  run: RunPayload;
  onOpen: (run: RunPayload) => void;
  canResume?: boolean;
  resumeBlockedReason: string | null;
  onResumed?: () => void;
  resumeError: string | null;
  setResumeError: (err: string | null) => void;
}) {
  const label = projectLabel(run.project);
  const age = elapsedSince(run.updatedAt);
  const reported = lastReportedEntry(run.queue);
  const clause = watchdogClause(run.watchdog);

  // The one hard constraint this task must not relax: the Resume control
  // renders ONLY once the watchdog itself has stood down — exhausted its
  // attempts, or been switched off — never while it might still be mid-cycle.
  // Those two states are exactly the ones in which the watchdog's own next
  // tick will NOT spawn a resume on its own, which is the only thing
  // preventing a board click and a sweep from both spawning `--resume` into
  // the same run at the same moment. Widening this to "whenever the board
  // allows it" would reintroduce that double-spawn race — and, until the
  // whole-branch review, that widening left every one of 1102 tests green,
  // because the rule lived in two hand-written expressions in two files and
  // in prose. It is now `watchdogStoodDown` (shared/agent.ts), the SAME
  // function `watchdog.service.ts`'s `visit()` returns on without spawning,
  // pinned from one table of states by `test/watchdog-coupling.test.tsx`.
  // Do not inline it back into an `||` here, however obvious it looks.
  //
  // `canResume` is the SEPARATE, board-side half of the same gate (CLAUDE.md's
  // "an environment-level block hides the dispatch control; the per-item ones
  // disable it" — applied here to a project-level control) — both halves
  // must agree before any control renders at all.
  const watchdogAllowsResume = run.watchdog !== undefined && watchdogStoodDown(run.watchdog);
  const showResume = canResume === true && watchdogAllowsResume;
  const blocked = resumeBlockedReason;

  const attemptResume = makeAttemptResume({ run, blocked, onResumed, setResumeError });

  return (
    <div className="run-strip run-strip-crashed" data-testid="run-strip">
      {/* The open-the-drawer control. Everything a person can currently
          learn about this crashed run from the strip lives inside it —
          project, "crashed", the heartbeat age, the last-reported stage
          (or "all items at rest"), the watchdog's own clause, and any
          resume error — so clicking anywhere across that whole body opens
          the drawer, matching a fresh strip's "click anywhere" behaviour
          (brief case 14) without hand-wiring a click handler onto every
          individual span. */}
      <button
        type="button"
        className="run-strip-open"
        onClick={() => onOpen(run)}
      >
        <span className="run-strip-dot" aria-hidden="true" />
        <span className="run-strip-project">{label}</span>
        <span className="run-strip-crashed-label">crashed</span>
        <span className="run-strip-heartbeat">no heartbeat for {age ?? '—'}</span>
        <span className="run-strip-current">
          {reported === null ? 'all items at rest' : `last reported ${reported.id} at ${reported.stage}`}
        </span>
        {clause !== '' && <span className="run-strip-watchdog">{clause}</span>}
        {resumeError !== null && <span className="run-strip-error">{resumeError}</span>}
        <span className="run-strip-mark" aria-hidden="true">▸</span>
      </button>
      {/* Resume: a genuine sibling `<button>`, never nested inside the
          open-button above — see this function's own doc comment for why
          that split is the fix, not `stopPropagation` on a nested control.
          Being a real button means Enter/Space activation and focusability
          come from the browser for free; `attemptResume` itself already
          no-ops while `blocked !== null`, so no keydown handler is needed
          here either. */}
      {showResume && (
        <button
          type="button"
          className="run-strip-resume"
          aria-disabled={blocked !== null || undefined}
          title={blocked ?? undefined}
          onClick={attemptResume}
        >
          Resume run
        </button>
      )}
    </div>
  );
}

/**
 * RunStrip — the board's one window onto an orchestrator run in progress,
 * live or crashed alike.
 *
 * Why this reads the RUN payload at all, rather than the items the columns
 * below it already render: an orchestrator run works each queued item
 * inside its own git worktree (see the plan's Task 3/5), and nothing about
 * that work reaches `main` — and so nothing reaches the item file this
 * board's own `/api/items` scan reads — until the item actually merges. A
 * bug or task can sit at `reviewing` for ten minutes with its item file on
 * `main` looking exactly as it did before the run started: no `started:`
 * stamp, no `phase:` key, nothing `isInProgress` (item-progress.ts) could
 * ever key off. The item, in other words, is not lying — it is telling the
 * truth about `main`, which genuinely has not changed yet. The only place
 * "this item is executing right now" exists at all is the run file
 * `useOrchestratorRuns` already polls for a completely different reason
 * (Task 10), so that payload — not the item — is this strip's only possible
 * source, and it is ItemCard's `run` prop's source too (see
 * BoardView's own comment on the id→entry lookup for the other half of
 * this).
 *
 * The flip side of that same fact is why the STAGE this strip prints, once
 * the heartbeat goes stale, gets prefixed "last reported" rather than
 * stated as a plain fact: once `fresh` goes false, this component has no
 * way to tell "the run is still exactly where it last reported" from "the
 * run moved on three more stages and we simply stopped hearing about it" —
 * RUN_STALE_MS (shared/types.ts) exists precisely because the watch loop
 * can go silent (crash, wedge) with no further writes to the run file at
 * all. Printing that stage as a plain, unqualified fact would be
 * presenting a guess as a fact.
 *
 * What this file used to conclude from that same reasoning — that the
 * whole strip must therefore render NOTHING once a run goes stale — is
 * exactly what let `run-20260903-112622` disappear from the board for four
 * hours on 2026-09-03 (design doc's own "Why this exists"): that run's
 * headless session quit believing it was waiting on a `sleep`, `run.json`
 * stayed frozen at `status: "running"`, staleness was detected right on
 * schedule, and the board's only window onto that run vanished at exactly
 * the moment a person most needed it to say something. This file was right
 * that it could not trust the STAGE; it was wrong to conclude from that it
 * could say NOTHING at all — "no heartbeat for 4h" is a fact this payload
 * has always been able to state, guess-free, the whole time.
 *
 * `isCrashed` (lib/run-watchdog.ts) is the split drawn instead:
 * `!fresh && status !== 'running'` (a run that finished, however long ago)
 * still renders nothing — that silence is not a fault, it is the ordinary
 * end of every run that ever ran, and dressing it up as one would be its
 * own kind of lie. `!fresh && status === 'running'` now renders a CRASHED
 * strip: every fact this component can still state honestly (the project,
 * how long the heartbeat has been silent, the last stage actually
 * reported, and — this feature's own addition — the watchdog's verdict on
 * what happens next), with the one thing it genuinely cannot vouch for,
 * the current stage, named as a guess ("last reported") rather than
 * dressed as one. Returning null for the finished-and-stale case is still
 * the same call DispatchButton makes for its own environment-level
 * blocks — render nothing, not a control that looks live but cannot be
 * trusted; it is simply no longer the ONLY call this component ever makes
 * about a quiet run.
 *
 * task-17 adds the THIRD rendering: `status === 'paused'`. It is un-fresh
 * like a finished run and, like a crashed one, still has a future — which is
 * why it draws rather than falls into the silence above. See
 * `renderPausedStrip` for the two ways it deliberately differs from the
 * crashed rendering (no watchdog clause, no `watchdogStoodDown` gate) and
 * why neither is an oversight.
 */
export function RunStrip({
  run, onOpen, canResume, resumeBlockedReason = null, resuming, onResumed
}: {
  run: RunPayload;
  onOpen: (run: RunPayload) => void;
  canResume?: boolean;
  resumeBlockedReason?: string | null;
  /** task-17: a resume this board asked for is on its way (the hook's own
   *  `resuming` set). The paused strip swaps its button for a placeholder
   *  rather than leaving a control that would spawn a SECOND `--resume`
   *  session into the same run — two of those reconcile, stage-write and
   *  merge against a file whose single-writer guarantee assumes one process. */
  resuming?: boolean;
  onResumed?: () => void;
}) {
  // Declared unconditionally, ahead of every early return below — React's
  // own rule for hooks, not a style preference — even though it is read
  // only by the crashed branch this component may or may not take on any
  // given render.
  const [resumeError, setResumeError] = useState<string | null>(null);

  // See this function's own doc comment above for why a run that finished
  // (however long ago) still gets silence, while a run that stopped
  // reporting mid-`running` gets a crashed rendering instead (`isCrashed`,
  // checked next).
  // task-17 widens this from two renderings to three. `paused` joins
  // `running` as a status worth drawing while un-fresh: a paused run has a
  // future, and a strip that went silent for it would be the same "the board
  // showed nothing and a click that failed looked identical to one that
  // worked" failure the crashed rendering was added to fix. Everything else
  // that is not fresh — a run that genuinely ended — still renders nothing,
  // and that silence is still not a fault.
  if (!run.fresh && run.status !== 'running' && run.status !== 'paused') return null;

  if (run.status === 'paused') {
    return renderPausedStrip({
      run, onOpen, canResume, resumeBlockedReason, resuming, onResumed, resumeError, setResumeError
    });
  }

  if (isCrashed(run)) {
    return renderCrashedStrip({ run, onOpen, canResume, resumeBlockedReason, onResumed, resumeError, setResumeError });
  }

  // total excludes `ungroomed`: a controller ruling this task exists to
  // honour (see the fixture comment in test/orchestrator-strip.test.tsx) —
  // an ungroomed item was never queueable work to begin with, so counting
  // it against the denominator would make a run that skipped it on sight
  // read as permanently short of "done".
  const total = run.queue.filter((q) => q.stage !== 'ungroomed').length;
  // Both of `RunStage`'s success exits count toward "done" here — `merged`
  // when the run kept its default mode, `branched` when it stopped at a
  // reviewed branch instead (`MergeMode`, shared/types.ts). Counting `merged`
  // alone was a controller-verified defect: a branch-mode run's own §9 never
  // reaches `merged` at all (design §5.3), so a run that finished every item
  // cleanly — the real overnight run this whole feature traces back to,
  // four green branches — read as 0% complete, which is exactly the
  // "a successful run must not look like a failure" bug the feature exists
  // to fix. `isTerminalStage` and this arithmetic are two different
  // questions asked of the same pair of stages (which stages are DONE, vs.
  // which one is the run's success exit) and cannot share one constant —
  // see this file's own comment above `isTerminalStage`'s import for why
  // the first question already has its own single home.
  const completed = run.queue.filter((q) => q.stage === 'merged' || q.stage === 'branched').length;
  const current = run.queue.find((q) => !isTerminalStage(q.stage));
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  // `null` for a plain merge-mode run — see `mergeModeLabel`'s own doc
  // comment (lib/run-stage.ts) for why that is the one fact that keeps a
  // merge-mode run's strip byte-identical to what it rendered before this
  // feature existed, rather than a conditional restated at this call site.
  const modeLabel = mergeModeLabel(run.mergeMode, run.mergeModeEffective);

  // `inFlightItemId`, not `current` above: the two answer different
  // questions. `current` is "the next queue entry the run has not let go
  // of", which includes a `pending` item and is right for the stage chip
  // (that chip prints the stage, and `pending` is a real one). This asks
  // "which item is the run WORKING", whose answer between items is nobody —
  // and it comes from `RunControls`' own exported implementation so the
  // strip's chip and the drawer's note can never name different items for
  // the same run.
  const pausingItem = inFlightItemId(run.queue);

  const heartbeatMs = Date.now() - Date.parse(run.updatedAt);
  const live = Number.isFinite(heartbeatMs) && heartbeatMs < LIVE_THRESHOLD_MS;
  // Reused from item-age.ts rather than a second age ladder: this is the
  // exact same problem (an ISO stamp aged into "now"/"20m"/"3h"/"11d" for a
  // human to read at a glance) the card's own in-progress bar already
  // solved. `null` here means `updatedAt` could not be parsed at all — a
  // malformed run file is not this component's problem to diagnose, just
  // one it must not crash or print "NaN" over.
  const age = elapsedSince(run.updatedAt);

  // How long the whole run has been going — a different question from the
  // heartbeat beside it, and the one people actually ask about an unattended
  // run they left going. `live`/`3m` says whether the board is still hearing
  // from the process; this says how long that process has been at it. Ticks
  // on its own because `useOrchestratorRuns` re-renders this every 5s while
  // the run is fresh, so no clock of its own is needed here (contrast
  // `useNow`, which exists precisely for the cards that get no such poll).
  //
  // `null` — an unparseable `startedAt` — renders NOTHING rather than a dash:
  // the heartbeat slot next to it already owns the "—" placeholder for its
  // own unparseable case, and two dashes in a row would read as one broken
  // field rather than as two separate readings, one of which is fine.
  const elapsed = runElapsedMs(run);

  // A label only — NOT the key anything is matched on. BoardView's own
  // lookup (see its comment on runStageFor) compares `run.project` to
  // `item.projectPath` directly, both already the same absolute registry
  // path; that comparison never touches this derivation. This component's
  // signature is fixed at `{ run, onOpen }`, so the one project-identifying
  // field it has is the path itself — see lib/project-label.ts (fix round 1)
  // for why it's the readable tail rather than the raw path that gets
  // printed here, and why that derivation now lives in one shared place.
  const label = projectLabel(run.project);

  return (
    <button
      type="button"
      className="run-strip"
      data-testid="run-strip"
      onClick={() => onOpen(run)}
    >
      {/* Decorative: the adjacent "live"/aged text is the actual answer for
          a screen reader, matching how the card's own live-bar dot-equivalent
          (its amber fill) is never the only carrier of that state — the words
          beside it always are. */}
      <span className={live ? 'run-strip-dot run-strip-dot-live' : 'run-strip-dot'} aria-hidden="true" />
      <span className="run-strip-project">{label}</span>
      {/* Design §7: "a branch-mode run says so." Absent entirely for a
          plain merge-mode run (`modeLabel` is `null` — see its own
          derivation above), which is what keeps that shape of run rendering
          byte-identically to before this feature existed. */}
      {modeLabel !== null && (
        <span className="run-mode-badge" data-testid="run-strip-mode">{modeLabel}</span>
      )}
      <span className="run-strip-heartbeat">{live ? 'live' : age ?? '—'}</span>
      {/* task-17: the run has been asked to stop and has not got there yet.
          Naming the item it will finish first is the fact a person watching
          a pause actually wants — "how long is this" — and `null` (the run is
          between items) prints the word alone rather than an empty phrase. */}
      {run.pauseRequested && (
        <span className="run-strip-pausing" data-testid="run-strip-pausing">
          {pausingItem === null ? 'pausing' : `pausing · finishes ${pausingItem}`}
        </span>
      )}
      {elapsed !== null && (
        <span className="run-strip-elapsed" data-testid="run-strip-elapsed">
          {formatSpanCompact(elapsed)}
        </span>
      )}
      <span className="run-strip-count">{completed}/{total}</span>
      {/* Purely a graphical restatement of the count just printed — hidden
          from the accessibility tree so a screen reader is not made to sit
          through the same fact twice in two forms. */}
      <span className="run-strip-bar" aria-hidden="true">
        <span className="run-strip-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      {/* The id stays plain text and the stage becomes a chip: they are two
          different kinds of fact sitting in one phrase — which item (stable,
          it is the item's name) and what it is doing (the most volatile thing
          on this strip). Chipping the stage with the same class the card and
          drawer use means the reader learns one visual language once. The
          `·` separator goes with it: a chip is its own delimiter. */}
      {current && (
        <span className="run-strip-current">
          {current.id}
          <span className={stageChipClass(current.stage)}>
            <span className="board-card-stage-glyph" aria-hidden="true">
              {stageGlyph(current.stage)}
            </span>
            {current.stage}
          </span>
        </span>
      )}
      {run.attention.length > 0 && (
        <span className="run-strip-attention">{run.attention.length} needs attention</span>
      )}
      {/* The same "there is more here" mark DispatchButton's own ▸ already
          is on every card (dispatch-mark) — aria-hidden for the identical
          reason: the accessible story is "this is a button", which the
          element's own role already says, not a glyph. Task 12's run drawer
          is what this mark promises; until it exists the click is real (see
          BoardView's own comment on why onOpen is still a no-op today) but
          this is the one honest way to say "there will be more to see". */}
      <span className="run-strip-mark" aria-hidden="true">▸</span>
    </button>
  );
}
