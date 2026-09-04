import type { OrchestratorRun, RunStage } from '../../../shared/types';

/**
 * The visual register a run stage is read in. Six tones, not fourteen: a
 * reader scanning a queue wants "is this done / working / waiting / blocked /
 * broken / never-ran", and the stage word itself — which is always printed
 * beside the tone, never replaced by it — carries the finer detail.
 *
 * Why a full `Record<RunStage, Tone>` rather than the if-ladder this
 * replaces: `RunStage` is a type-only union, so nothing at runtime can
 * enumerate it, and the ladder's `return 'board-card-stage'` fallback meant
 * every stage nobody had thought about rendered as the ACTIVE tone. That is
 * the worst possible default — a new terminal failure state would have
 * announced itself as progress. A Record makes the compiler refuse a stage
 * added to the union and left out here, which is the check the ladder could
 * not give.
 */
export type StageTone = 'active' | 'done' | 'bad' | 'warn' | 'idle' | 'muted';

export const STAGE_TONE: Record<RunStage, StageTone> = {
  // The six the orchestrator moves through with no human involved. Cyan,
  // deliberately not green (a groomed card is already green for an unrelated
  // fact) and not amber (that reads "a person is needed", the opposite).
  dispatched: 'active',
  inspecting: 'active',
  reviewing: 'active',
  fixing: 'active',
  verifying: 'active',
  merging: 'active',
  // The two success exits, one per MergeMode, per RunStage's own doc comment
  // — `merged` when the run merged to main, `branched` when it was told to
  // stop at a reviewed branch instead. Both green: it used to be a single
  // stage sharing the active tone, which made "finished" and "still running"
  // the same colour in a list whose whole job is telling those two apart,
  // and the two exits read identically here on purpose — the tone is about
  // the outcome (this item is done, cleanly), not which mode produced it.
  merged: 'done',
  branched: 'done',
  failed: 'bad',
  // Blocked on a person. `parked` joins `needs-answers` because both mean the
  // pipeline has stopped and will not restart on its own.
  'needs-answers': 'warn',
  parked: 'warn',
  // Not started yet, and not a problem. Quiet grey so a long tail of pending
  // rows recedes behind the handful that are actually doing something.
  pending: 'idle',
  preflight: 'idle',
  // Never worked and never will be, this run. Dimmer still than idle: these
  // are rows the reader can skip entirely.
  skipped: 'muted',
  ungroomed: 'muted'
};

/**
 * One glyph per tone, so colour is never the only carrier of state — the
 * same rule the board already follows for the live bar (the words beside it
 * always say what the colour says). Monochrome text glyphs rather than emoji:
 * they inherit the chip's own colour and font metrics, where an emoji would
 * bring its own palette and blow the chip's 9.5px line box open.
 */
const TONE_GLYPH: Record<StageTone, string> = {
  active: '●',  // ● — filled: something is happening
  done: '✓',    // ✓
  bad: '✕',     // ✕
  warn: '⚠',    // ⚠
  idle: '○',    // ○ — hollow: the same dot, not yet filled in
  muted: '–'    // – — an en dash: nothing happened here
};

export function stageGlyph(stage: RunStage): string {
  return TONE_GLYPH[STAGE_TONE[stage]];
}

/**
 * The chip's class list. `active` returns the bare base class rather than a
 * `-active` modifier, and `warn`/`bad` keep the exact names they already had:
 * both the card suite and the strip suite assert on those literal strings
 * (test/orchestrator-strip.test.tsx), and this change is a restyle, not a
 * rename.
 */
export function stageChipClass(stage: RunStage): string {
  const tone = STAGE_TONE[stage];
  return tone === 'active' ? 'board-card-stage' : `board-card-stage board-card-stage-${tone}`;
}

/**
 * ---- RUN status vs. ITEM stage — two vocabularies that share one file on
 * purpose, and must never share one map ----
 *
 * `RUN_STATUS_GLYPH`/`RUN_STATUS_CLASS` below look like they could just be
 * `stageGlyph`/`stageChipClass` again, and that similarity is exactly the
 * trap: they answer a different question about a different value. Every
 * export above this comment keys on `RunStage` — the fourteen-member,
 * per-ITEM pipeline union (`pending`, `reviewing`, `merged`, ...). These two
 * key on `OrchestratorRun['status']` — the whole RUN's own four-member
 * lifecycle (`running | done | aborted | failed`), which shares only one
 * spelling (`failed`) with `RunStage` and means something different even
 * there: an item's `failed` is one queue entry that could not be fixed, a
 * run's `failed` is the whole orchestrator process dying. Calling
 * `stageGlyph(run.status)` would not compile without a cast, and with one it
 * would silently read `undefined` out of `STAGE_TONE` for `running`, `done`
 * and `aborted` — none of which are `RunStage` members at all.
 *
 * So this is a second, small, total map over a different four-word union,
 * not a variant of `STAGE_TONE` and not mergeable into it without
 * conflating two different things a reader could be asking about a run (its
 * OWN status, vs. the status of one item inside it). The tone VOCABULARY it
 * reuses — cyan-for-live, green-for-success, amber-for-needs-a-look,
 * red-for-broken — is deliberately the same one `STAGE_TONE` uses, so a
 * colour never means one thing on an item chip and another on a run chip;
 * only the KEY the colour is looked up by differs.
 *
 * Lives here, beside `STAGE_TONE`, rather than in either component that
 * reads it (`RunsView.tsx`'s run-list rows, `RunDetail.tsx`'s header) for
 * the reason this whole section exists: two components independently
 * needing "the run status's glyph and class" is exactly the shape that
 * produces a silently-drifting duplicate if each one owns its own copy —
 * which is what happened here once already (Task 7 first duplicated this
 * pair into `RunDetail.tsx` rather than reaching for a shared home, reading
 * "don't import RunsView.tsx, that would cycle" as "there is no shared
 * home" instead of "the shared home is a third file"). `lib/run-stage.ts` is
 * that third file: both components already import from it for `RunStage`'s
 * own vocabulary, and it cannot cycle with either — a plain data module,
 * with no import of its own pointing back at either component.
 */
export const RUN_STATUS_GLYPH: Record<OrchestratorRun['status'], string> = {
  running: '●',
  done: '✓',
  aborted: '⚠',
  failed: '✕'
};

/** The run-status chip's class list — `.runs-status-*` (styles.css),
 *  deliberately NOT `stageChipClass`'s `.board-card-stage-*` family: the two
 *  chip designs (a run-list row's status word vs. a queue item's stage
 *  badge) were built as separate visual components with their own CSS, and
 *  reusing one's classes for the other's markup would apply padding/shape
 *  rules tuned for a different chip shape. */
export const RUN_STATUS_CLASS: Record<OrchestratorRun['status'], string> = {
  running: 'runs-status-live',
  done: 'runs-status-done',
  aborted: 'runs-status-warn',
  failed: 'runs-status-bad'
};
