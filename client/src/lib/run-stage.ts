import type { RunStage } from '../../../shared/types';

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
  // The one success exit, per RunStage's own doc comment. Green: it used to
  // share the active tone, which made "finished" and "still running" the same
  // colour in a list whose whole job is telling those two apart.
  merged: 'done',
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
