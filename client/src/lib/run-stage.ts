import { isCrashed } from './run-watchdog';
import type { MergeMode, OrchestratorRun, RunStage } from '../../../shared/types';

/**
 * The visual register a run stage is read in. Six tones, not fifteen: a
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
 * export above this comment keys on `RunStage` — the fifteen-member,
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
  failed: '✕',
  // A pause bar, the one glyph in this table that reads as "stopped, not
  // finished" — every other member is either motion or an ending.
  paused: '‖'
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
  failed: 'runs-status-bad',
  // Neutral ink rather than `warn`/`bad`: a paused run is a run someone
  // deliberately stopped, not one that went wrong.
  paused: 'runs-status-paused'
};

/**
 * The one label RunStrip, RunsView's row and RunDetail's header all print
 * for a run's `MergeMode` (Task 9, "surface a run's merge mode and any
 * downgrade") — `null` for a plain `merge`-mode run, so every one of those
 * three call sites renders NOTHING extra for the run shape that made up the
 * whole app before this feature existed. That `null` is what makes "a
 * merge-mode run renders byte-identically to today" true by construction
 * rather than by three separately-remembered conditionals: a stray `&&`
 * inverted at one call site would be caught by that surface's own
 * regression test, but a stray extra STRING (an empty badge, a bare "merge
 * mode" nobody asked to see) would not be, since `toBeEmptyDOMElement`-style
 * assertions only catch a NODE existing, not a word that was always going to
 * render anyway.
 *
 * One string, not two separate facts handed to each caller, because a
 * caller rendering "branch mode" and "(downgraded)" as two independently
 * placed pieces is exactly the kind of duplicate-decision this file's own
 * header warns about for `STAGE_TONE` vs `RUN_STATUS_GLYPH` — the same
 * caller-visible word has to come from the same place for a run whose mode
 * is read from three different components.
 *
 * The one asymmetry worth stating: this label answers "does this run's
 * OUTCOME need a person to finish it, and did that surprise the run itself"
 * — it does NOT carry `mergeModeNote`'s own prose (why the classifier
 * refused). Design §7 asks for both the mode and, where they differ, "the
 * note", but the note is free text meant to be read as its own sentence,
 * not folded into a badge a screen reader would run together with whatever
 * sits next to it. RunDetail (the one surface with room for prose) reads
 * `mergeModeNote` directly for that half; this function is only ever the
 * short badge word.
 */
export function mergeModeLabel(mergeMode: MergeMode, mergeModeEffective: MergeMode): string | null {
  if (mergeModeEffective !== 'branch') return null;
  return mergeMode === mergeModeEffective ? 'branch mode' : 'branch mode (downgraded)';
}

/**
 * bug-29. The one place "which word, glyph and class does this run's status
 * chip print" is decided, read by the Runs list row (`RunsView.tsx`) and the
 * detail pane's head (`RunDetail.tsx`) — the two sites that used to print
 * `authority.status` verbatim and so rendered the word `running`, in the
 * live cyan, for a run whose heartbeat had been silent for 46 minutes while
 * the Board strip one click away already said `crashed` off the very same
 * payload (observed on `run-20260906-185312`, beside a `34m elapsed` that
 * `runWallMs` had already correctly frozen).
 *
 * Three things about this function are deliberate and must not be undone:
 *
 * 1. **`crashed` is not a `RunStatus` and must never become one.** It is
 *    derived — `isCrashed` (lib/run-watchdog.ts), `running && !fresh` — the
 *    same posture CLAUDE.md's "Groomed is derived" and "`exhausted` is
 *    DERIVED" already state. `RUN_STATUS_GLYPH`/`RUN_STATUS_CLASS` stay
 *    exhaustive over the five WIRE statuses, so the substitution happens
 *    here, over the records' existing `running` entry, rather than by adding
 *    a sixth key that would put a word on the wire type no run file can ever
 *    contain.
 * 2. **The heartbeat comes from the LIVE entry, never from the authority.**
 *    A caller's `authority` may be an `OrchestratorArchiveRun`, which carries
 *    no `fresh` field at all — an archive-only row has no heartbeat to judge
 *    and must keep printing its recorded status unchanged, however long ago
 *    that run file said `running`. That is why `live` is a separate argument
 *    rather than something read off the status: it is the same split
 *    `MergedRun` draws between its data authority (`live`) and its
 *    presentation gate (`isLive`/`fresh`).
 * 3. **One function, not two agreeing expressions.** The row and the head
 *    are in separate files and would otherwise each re-derive
 *    `status === 'running' && !fresh` by hand — exactly the shape
 *    `watchdogStoodDown` and `isCrashed` itself exist to foreclose, and the
 *    shape that lets one site get fixed and the other quietly keep lying.
 *
 * `runs-status-warn` (amber) rather than a new `.runs-status-crashed`: it is
 * the list's existing amber slot and it is the same colour
 * `.run-strip-crashed-label` prints the identical word in, so the two
 * surfaces agree on tone as well as wording without a class that would have
 * to be kept in sync with it.
 */
export function runStatusChip(
  status: OrchestratorRun['status'],
  live: { status: OrchestratorRun['status']; fresh: boolean } | null | undefined
): { label: string; glyph: string; className: string } {
  if (live !== null && live !== undefined && isCrashed(live)) {
    // '⚠' is `aborted`'s glyph too, and that is not a collision worth
    // avoiding: both mean "this run did not end the way it meant to", and the
    // word beside the glyph is always the accessible answer (the same
    // "colour and glyph restate the word, never replace it" rule
    // `RUN_STATUS_GLYPH`'s own doc comment states).
    return { label: 'crashed', glyph: '⚠', className: 'runs-status-warn' };
  }
  return { label: status, glyph: RUN_STATUS_GLYPH[status], className: RUN_STATUS_CLASS[status] };
}
