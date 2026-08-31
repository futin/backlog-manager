import { useEffect } from 'react';

import { ACTIVE_RUN_STAGES } from './ItemCard';
import type { OrchestratorRun, RunQueueItem, RunVerification } from '../../../../shared/types';

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
  if (run.fresh) return null;
  const minutes = staleMinutes(run.updatedAt);
  const age = minutes === null ? '' : ` for ${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `no heartbeat${age} — resume or abort from the terminal`;
}

/**
 * The readable tail of a registry path — "/Users/dev/code/example-app"
 * becomes "example-app". Duplicated from RunStrip.tsx's own inline
 * derivation rather than imported: unlike ACTIVE_RUN_STAGES below, a real
 * enumerated vocabulary worth keeping in exactly one place, this is one line
 * of stdlib string-splitting with nothing to drift out of sync.
 */
function projectLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
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
                      {/* Same two-tone system as the card's own runStage chip
                          (ItemCard.tsx) — cyan by default, amber specifically
                          for needs-answers, "the run is blocked on a person,
                          not progressing" — rather than a wider palette
                          invented just for this file. Unlike the card, EVERY
                          stage gets a chip here (the card only chips seven of
                          RunStage's fourteen members — its six ACTIVE_RUN_STAGES
                          plus needs-answers — and renders nothing for the
                          other seven); the drawer's job is the full picture. */}
                      <span className={
                        q.stage === 'needs-answers'
                          ? 'board-card-stage board-card-stage-warn'
                          : 'board-card-stage'
                      }>
                        {q.stage}
                      </span>
                    </div>
                    {q.fixLoops > 0 && (
                      <div className="run-drawer-item-fixloops">
                        {q.fixLoops} fix loop{q.fixLoops === 1 ? '' : 's'}
                      </div>
                    )}
                    {verify !== null && (
                      <div className="run-drawer-item-verify">
                        <span className="run-drawer-item-verify-cmd">{verify.cmd}</span>
                        <span className={verify.ok ? 'run-drawer-item-verify-ok' : 'run-drawer-item-verify-bad'}>
                          {verify.ok ? 'ok' : 'failed'}
                        </span>
                        <span className="run-drawer-item-verify-tail">{verify.tail}</span>
                      </div>
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
            run.attention.map((a) => {
              const item = run.queue.find((q) => q.id === a.id);
              return (
                <div key={a.id} className="run-drawer-attn" data-testid={`run-drawer-attention-${a.id}`}>
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
