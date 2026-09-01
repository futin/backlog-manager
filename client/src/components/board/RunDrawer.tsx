import { useEffect } from 'react';

import { projectLabel } from '../../lib/project-label';
import { stageChipClass, stageGlyph } from '../../lib/run-stage';
import {
  formatClock, formatSpan, formatSpanCompact, inStageMs, isTerminalStage,
  itemDoneClock, itemDurationMs, runElapsedMs, stepperDots
} from '../../lib/run-time';
import { ACTIVE_RUN_STAGES } from './ItemCard';
import type { OrchestratorRun, RunQueueItem, RunStage, RunVerification } from '../../../../shared/types';

type RunPayload = OrchestratorRun & { fresh: boolean; pastRuns: number };

/**
 * The verify step's most recent row for one queue item, or null when it has
 * never reached verify. `RunVerification` documents its own array as kept
 * verbatim and in full (oldest first) rather than summarised — a resumed run
 * needs every prior attempt on disk — but a per-item DRAWER ROW does not; it
 * is read once, on the way past, the way a person skims a build log for the
 * last line that actually matters. Showing the whole array on every row
 * would turn a seven-item queue into a scroll of stale reruns for exactly
 * the items (like bug-14, two rows deep by the time it merged) most worth
 * reading at a glance.
 */
function lastVerification(item: RunQueueItem): RunVerification | null {
  return item.verification.length === 0 ? null : item.verification[item.verification.length - 1];
}

/**
 * Whole minutes since a run's last heartbeat, or null when `updatedAt`
 * cannot be parsed at all — a hand-edited or corrupted run file, not this
 * component's problem to diagnose, only one it must not crash or print NaN
 * over. Mirrors elapsedSince's own two-step shape (lib/item-age.ts): check
 * Number.isNaN on the PARSED instant before clamping the difference, because
 * `Math.max(0, NaN)` is itself NaN, not 0 — clamping first would silently
 * launder a bad timestamp into "0 minutes" instead of surfacing nothing.
 *
 * Deliberately whole minutes throughout, never promoted to elapsedSince's
 * hours/days rungs. That ladder exists because a card's `started` marker can
 * honestly be days old and still describe live work; a STALE run's heartbeat
 * is a fault being reported, not a duration being lived with, and
 * RUN_STALE_MS itself is fifteen minutes — the number read here is almost
 * always double digits, never the multi-day range the ladder was built for.
 */
function staleMinutes(updatedAt: string): number | null {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  return Math.floor(Math.max(0, Date.now() - then) / 60_000);
}

/**
 * The plain-words fault report for a run this board has stopped hearing
 * from, or null while the heartbeat is still good. `run.fresh` is
 * server-computed (RUN_STALE_MS against `updatedAt`, shared/types.ts) — the
 * same boolean RunStrip.tsx already trusts rather than re-deriving its own
 * clock-skew check here — so this returns null the instant the server says
 * the run is fine, with no threshold of its own to drift out of step with
 * that one.
 *
 * Why this has to be the FIRST thing the drawer says (see the render below,
 * ahead of the pipeline chips and every row): a run's own queue items never
 * touch this board's view of `main` while they run — the work happens
 * inside a per-item git worktree, and none of it reaches an item FILE until
 * a merge (RunStrip.tsx's own file-level comment has the full mechanism).
 * That makes the rows below this note the ONLY record of what is happening,
 * and once the heartbeat goes stale this component has no way left to tell
 * "the run is still exactly where it last reported" from "it moved three
 * more stages and this board simply stopped hearing about it." Rendering
 * those rows with nothing marking them suspect would present a guess as
 * fact, so this names the actual next step — the terminal, since a
 * read-only drawer has no resume/abort button of its own to offer instead.
 */
function staleNote(run: RunPayload): string | null {
  // Two clauses, not one, because `fresh` folds two unrelated facts together:
  // the server computes it as `status === 'running' && heartbeat is recent`
  // (orchestrator.service.ts), so `!fresh` means EITHER "a live run has gone
  // silent" — the fault this note exists to report — OR "this run ended",
  // which is the normal end state of every run ever started and no fault at
  // all. Reading "not fresh" as "stale" is exactly the trap (bug-6): a
  // finished run drew this banner telling a person to "resume or abort" one
  // line under a header already printing `done`, advice that was wrong twice
  // over — `--resume` reconciles a `running` run, and aborting a finished one
  // is not the no-op the wording implies. Gating on the run still CLAIMING to
  // be live is what tells the two apart; `status` is already on the payload
  // (OrchestratorRun, shared/types.ts) and the header renders it two lines
  // away, so nothing new is plumbed for it. A `running` run whose heartbeat
  // has genuinely gone quiet still gets the banner, unchanged.
  if (run.fresh || run.status !== 'running') return null;
  const minutes = staleMinutes(run.updatedAt);
  const age = minutes === null ? '' : ` for ${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `no heartbeat${age} — resume or abort from the terminal`;
}


/**
 * The stages a row prints no time at all for.
 *
 * `ungroomed` and `skipped` are the two exits where no work happened: the gate
 * turned the item away, or the run never got to it. A duration measured across
 * either is a measurement of nothing — the seconds the orchestrator spent
 * reading a file and deciding not to queue it — and printing one would put a
 * number in the same column where its neighbours carry real work, inviting the
 * comparison. Blank is the honest reading; the row's chip already says why.
 */
const TIMELESS_STAGES: readonly RunStage[] = ['ungroomed', 'skipped'];

/**
 * The row's right-hand time reading: what a person scanning the queue wants
 * without opening anything — how long each item took, and when the finished
 * ones finished.
 *
 * Three shapes, because a queue row is in one of three situations and they
 * answer different questions. A finished row gets `<duration> · <HH:MM>`: both
 * halves matter and neither implies the other — the duration is the cost, the
 * clock time is what lets a person line the item up against something else
 * that happened this morning. An active row gets `<duration> elapsed`, with
 * the word carrying the tense the finished rows do not need. A `pending` row
 * gets an em dash: not "0s", which claims a measurement, but the typographic
 * mark for a field with nothing in it yet.
 *
 * A `null` duration degrades to whichever half survives rather than blanking
 * the row: a terminal row with a stamp for its exit but nothing before it can
 * still honestly say WHEN it ended even when it cannot say how long it took.
 */
function RowTime({ item, now }: { item: RunQueueItem; now: number }): JSX.Element | null {
  if (TIMELESS_STAGES.includes(item.stage)) return null;

  if (item.stage === 'pending') {
    return <span className="run-drawer-item-time" data-testid={`run-drawer-time-${item.id}`}>—</span>;
  }

  const duration = itemDurationMs(item, now);
  const span = duration === null ? null : formatSpan(duration);
  const terminal = isTerminalStage(item.stage);
  const done = terminal ? itemDoneClock(item) : null;

  const text = terminal
    ? [span, done].filter((part) => part !== null).join(' · ')
    : span === null ? '' : `${span} elapsed`;

  if (text === '') return null;
  return <span className="run-drawer-item-time" data-testid={`run-drawer-time-${item.id}`}>{text}</span>;
}

/**
 * The seven-dot pipeline stepper under a queue row: where this item is, what
 * it has been through, and — the part no other element on the row carries —
 * what is still ahead of it.
 *
 * Rendered for every row but `ungroomed`, which never entered the pipeline at
 * all: seven hollow dots under it would draw a progress track for an item that
 * has no progress to make, where the absence of the track says exactly that.
 * A `pending` row DOES get one, hollow throughout, because it is going to
 * enter — the empty track is the promise.
 *
 * Each dot names its stage in a native `title` (hover) and the same text as an
 * `aria-label`, per the design: hover is mouse-only, and a dot that only a
 * mouse can identify is a dot half the readers cannot use. `role="img"` is
 * what makes that label actually reach a screen reader — `aria-label` on a
 * bare `<span>` sits on the `generic` role, which prohibits naming, so without
 * the role the attribute is present in the DOM and silently ignored by the
 * only readers it exists for. The cost is honest and worth stating: this is
 * seven more nodes in the accessibility tree per row. The row's stage chip
 * still prints the current stage in words for everyone, so nobody has to walk
 * the dots to learn the one fact that matters most.
 */
function RowStepper({ item }: { item: RunQueueItem }): JSX.Element | null {
  if (item.stage === 'ungroomed') return null;

  return (
    <div className="run-stepper" data-testid={`run-drawer-stepper-${item.id}`}>
      {stepperDots(item).map((dot) => (
        <span
          key={dot.stage}
          className={`run-stepper-dot run-stepper-dot-${dot.state}`}
          data-stage={dot.stage}
          role="img"
          title={dot.label}
          aria-label={dot.label}
        />
      ))}
    </div>
  );
}

/**
 * The caption under an active row: `now reviewing · 3m 20s in stage`.
 *
 * Answers the question the stepper's ringed dot raises but cannot answer —
 * "it is at reviewing, but has it been there ten seconds or forty minutes?" —
 * which is the whole difference between a run that is working and one that is
 * wedged. Terminal rows get nothing: their time reading is already final.
 *
 * Carries the same blur `inStageMs` documents: `stageAt` keeps first arrivals
 * only, so on a second pass through `reviewing` this measures from the first
 * pass. The row's own `N fix loops` line, rendered a few lines below whenever
 * that has happened, is the visible tell that this number spans more than the
 * current attempt.
 */
function RowStageCaption({ item, now }: { item: RunQueueItem; now: number }): JSX.Element | null {
  if (isTerminalStage(item.stage) || item.stage === 'pending') return null;
  const ms = inStageMs(item, now);
  if (ms === null) return null;
  return (
    <div className="run-drawer-item-stage-note" data-testid={`run-drawer-stage-note-${item.id}`}>
      now {item.stage} · {formatSpan(ms)} in stage
    </div>
  );
}

/**
 * The run drawer: the detail view behind a run strip (RunStrip.tsx), and the
 * only place a user can see WHY an item was skipped or parked rather than
 * just THAT a run is progressing. Read-only, deliberately — v1 has no
 * answer-from-the-UI path (see the attention section below); every write to
 * a queue item happens inside the orchestrator's own worktree, never here.
 *
 * Structure and behaviour below `.drawer-head` are ItemDrawer's, reused
 * rather than reinvented: a `.drawer-backdrop` behind a `role="dialog"`
 * `.drawer` aside, Escape bound on `window` (so it fires no matter where
 * focus happens to be — ItemDrawer does no other focus management, so
 * neither does this), and a `.drawer-close` button — the same three ways in,
 * so a keyboard-only user who already knows one drawer knows both. `.pill`
 * and the dispatch control are the only pieces of ItemDrawer's head this
 * does NOT carry over: there is no project-hue identity or dispatch action
 * for a run the way there is for one backlog item.
 */
export function RunDrawer({ run, onClose }: { run: RunPayload; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const label = projectLabel(run.project);
  const note = staleNote(run);

  // One clock read per render, threaded down to every row, rather than each
  // derivation calling Date.now() for itself: a drawer that measured its
  // seven rows against seven instants could render two of them a millisecond
  // apart and, at a rung boundary, print durations that do not add up against
  // each other. Re-read on every render rather than held in state, which is
  // what makes these readings tick — `useOrchestratorRuns` re-renders this
  // component every 5s while the run is fresh (BoardView keeps the open
  // drawer wired to the polled payload rather than to a snapshot taken at
  // click time), so the poll that refreshes the data refreshes the clock with
  // it and no interval of this component's own is needed.
  const now = Date.now();

  // `started HH:MM · 1h 04m elapsed` — the run-level answer to the two
  // questions the per-row readings below only answer item by item. Its own
  // span rather than an extension of the status line beside it: that line's
  // exact text is asserted character for character by the drawer suite, and
  // more to the point the two are different KINDS of fact — what this run is
  // and how many came before it, versus when it began and how long it has
  // been going.
  const elapsed = runElapsedMs(run, now);
  const startedClock = formatClock(run.startedAt);

  // Four counts, not a fifth "current item" pointer: the per-item rows below
  // already print every item's own stage, so a top-of-drawer pointer at
  // "the" current one would only restate a row a few lines down. These four
  // are the one thing no single row can say on its own — how the WHOLE
  // queue is distributed right now.
  const merged = run.queue.filter((q) => q.stage === 'merged').length;
  // ACTIVE_RUN_STAGES is ItemCard's own list (dispatched..merging) — "the
  // orchestrator running WITHOUT a human", per its own comment — imported
  // rather than re-typed a second time, the same reuse POLL_MS already gets
  // between useOrchestratorRuns.ts and RunStrip.tsx.
  const active = run.queue.filter((q) => ACTIVE_RUN_STAGES.includes(q.stage)).length;
  const queued = run.queue.filter((q) => q.stage === 'pending').length;
  const attentionCount = run.attention.length;

  return (
    <>
      <div className="drawer-backdrop" data-testid="run-drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`${label} run`}>
        <div className="drawer-head">
          <span className="drawer-title">{label} run</span>
          <button className="drawer-close" onClick={onClose}>close</button>
        </div>
        <div className="drawer-meta">
          <span data-testid="run-drawer-past">
            {run.status} · {run.pastRuns} past run{run.pastRuns === 1 ? '' : 's'}
          </span>
          {/* Each half appears only if its own stamp parsed: a run file with a
              readable `startedAt` and a corrupt `updatedAt` can still say when
              it began, and one with neither renders no node at all rather than
              an empty separator hanging in the meta line. */}
          {(startedClock !== null || elapsed !== null) && (
            <span data-testid="run-drawer-time">
              {[
                startedClock === null ? null : `started ${startedClock}`,
                elapsed === null ? null : `${formatSpanCompact(elapsed)} elapsed`
              ].filter((part) => part !== null).join(' · ')}
            </span>
          )}
        </div>
        <div className="drawer-body">
          {/* First, ahead of everything else: see staleNote's own comment
              for why a stale heartbeat has to be the first thing read, ahead
              of a pipeline that can no longer be trusted to be current. */}
          {note !== null && (
            <div className="run-drawer-note" data-testid="run-drawer-note">{note}</div>
          )}

          <div className="run-drawer-chips" data-testid="run-drawer-chips">
            <span className="run-drawer-chip" data-testid="run-drawer-chip-merged">
              <span className="run-drawer-chip-num">{merged}</span> merged
            </span>
            <span className="run-drawer-chip" data-testid="run-drawer-chip-active">
              <span className="run-drawer-chip-num">{active}</span> active
            </span>
            <span className="run-drawer-chip" data-testid="run-drawer-chip-queued">
              <span className="run-drawer-chip-num">{queued}</span> queued
            </span>
            <span className="run-drawer-chip" data-testid="run-drawer-chip-attention">
              <span className="run-drawer-chip-num">{attentionCount}</span> attention
            </span>
          </div>

          {/* A literal <h2>, not a bespoke label class: .drawer-body h2 (see
              styles.css) already styles a markdown-rendered item body's own
              ## headings as printed labels rather than document headings —
              the exact same descendant selector applies here for free
              because this section lives inside the same .drawer-body, which
              is the point: one "section header" look for the whole drawer
              family rather than a second one invented for this file. */}
          <h2>Queue</h2>
          <div className="run-drawer-queue" data-testid="run-drawer-queue">
            {run.queue.length === 0 ? (
              <div className="drawer-empty">no queued items</div>
            ) : (
              run.queue.map((q) => {
                const verify = lastVerification(q);
                return (
                  <div key={q.id} className="run-drawer-item" data-testid={`run-drawer-item-${q.id}`}>
                    <div className="run-drawer-item-head">
                      <span className="run-drawer-item-id">{q.id}</span>
                      <span className="run-drawer-item-title">{q.title}</span>
                      {/* Tone and glyph from lib/run-stage.ts, shared with
                          the card and the strip — six tones over RunStage's
                          fourteen members, with the stage word itself always
                          printed beside them for the finer detail. Unlike the
                          card, EVERY stage gets a chip here (the card only
                          chips seven of the fourteen — its six
                          ACTIVE_RUN_STAGES plus needs-answers — and renders
                          nothing for the other seven); the drawer's job is
                          the full picture, which is exactly why the tone map
                          had to become total: this is the one surface where
                          `merged`, `skipped` and `pending` are all on screen
                          at once, and the old cyan-by-default ladder painted
                          all three as work in progress.
                            The glyph is aria-hidden: the stage word beside it
                          is the accessible answer, matching how the strip's
                          own live dot defers to the word next to it. */}
                      <span className={stageChipClass(q.stage)}>
                        <span className="board-card-stage-glyph" aria-hidden="true">
                          {stageGlyph(q.stage)}
                        </span>
                        {q.stage}
                      </span>
                      {/* Last in the head, so it lands at the right margin
                          behind the title's own `flex: 1` — the column a
                          reader's eye runs down when the question is "which
                          of these took the longest", which is exactly the
                          question a row-by-row reading answers worst. */}
                      <RowTime item={q} now={now} />
                    </div>
                    <RowStepper item={q} />
                    <RowStageCaption item={q} now={now} />
                    {q.fixLoops > 0 && (
                      <div className="run-drawer-item-fixloops">
                        {q.fixLoops} fix loop{q.fixLoops === 1 ? '' : 's'}
                      </div>
                    )}
                    {verify !== null && (
                      // A <details>, not a state toggle, and it carries the
                      // wrapper's own class so the existing flex-row rule
                      // applies unchanged — no new stylesheet selector, which
                      // is what lets this and the tail-box task merge in
                      // either order.
                      //   `open={!verify.ok}` is a one-way seed, not control:
                      // React writes the attribute only when the prop's VALUE
                      // changes, so a tail someone expanded by hand survives
                      // the 5s poll re-render useOrchestratorRuns fires while
                      // a run is fresh. A useState toggle would have to
                      // re-derive that on every render and lose it.
                      //   Collapsed, never dropped: a green tail is still the
                      // proof the command actually ran. What must stay legible
                      // without expanding — what ran, and whether it passed —
                      // is exactly what the summary holds.
                      <details className="run-drawer-item-verify" open={!verify.ok}>
                        <summary className="run-drawer-item-verify-summary">
                          <span className="run-drawer-item-verify-cmd">{verify.cmd}</span>
                          <span className={verify.ok ? 'run-drawer-item-verify-ok' : 'run-drawer-item-verify-bad'}>
                            {verify.ok ? 'ok' : 'failed'}
                          </span>
                        </summary>
                        <span className="run-drawer-item-verify-tail">{verify.tail}</span>
                      </details>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <h2>Attention</h2>
          {run.attention.length === 0 ? (
            <div className="drawer-empty">nothing needs a look</div>
          ) : (
            // `i` (position) is part of the key, not just `a.id`+`a.kind`:
            // RunAttention's own doc comment (shared/types.ts) is explicit
            // that this list is "a log of what happened, not a live filter
            // over queue", so the SAME item can legitimately earn a second
            // entry of even the SAME kind later in the same run (parked,
            // resumed, parked again on a different conflict) — id+kind alone
            // would still collide on that case, and only the position is
            // guaranteed unique across every case (fix round 1: `key={a.id}`
            // alone collided whenever one item earned a second entry at all,
            // which orchestrate.mjs's own unguarded push onto `run.attention`
            // makes a real, not hypothetical, run shape).
            run.attention.map((a, i) => {
              const item = run.queue.find((q) => q.id === a.id);
              return (
                <div
                  key={`${a.id}-${a.kind}-${i}`}
                  className="run-drawer-attn"
                  data-testid={`run-drawer-attention-${a.id}`}
                >
                  <div className="run-drawer-attn-head">
                    <span className="run-drawer-item-id">{a.id}</span>
                    <span className="run-drawer-attn-kind">{a.kind}</span>
                  </div>
                  <div className="run-drawer-attn-detail">{a.detail}</div>
                  {/* Verbatim, not paraphrased — see this file's own doc
                      comment on why v1 has no answer-from-the-UI path.
                      RunQueueItem.questions is `[]` for every stage but
                      needs-answers (shared/types.ts), so this renders
                      nothing for a parked or fix-exhausted entry. */}
                  {item !== undefined && item.questions.length > 0 && (
                    <ul className="run-drawer-questions">
                      {item.questions.map((question) => <li key={question}>{question}</li>)}
                    </ul>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}
