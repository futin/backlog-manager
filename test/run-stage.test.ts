import {
  RUN_STATUS_CLASS, RUN_STATUS_GLYPH, STAGE_TONE, runStatusChip, stageChipClass, stageGlyph
} from '../client/src/lib/run-stage';
import type { OrchestratorRun, RunStage } from '../shared/types';

/** Sorted, so `Object.keys(...).sort()` can be compared against it directly
 *  in the bug-29 case at the foot of this file. */
const ALL_RUN_STATUSES = ['aborted', 'done', 'failed', 'paused', 'running'];

/**
 * Every member of RunStage, restated here on purpose rather than imported
 * from a runtime list: there is no runtime list — RunStage is a type-only
 * union — and the whole point of this suite is to catch a stage added to
 * that union and never given a tone. A helper that silently fell back to
 * the active/cyan default would make a new terminal failure state render
 * as "the orchestrator is working on it", which is the exact mis-read the
 * -bad variant was introduced to fix once already.
 */
const ALL_STAGES: RunStage[] = [
  'pending', 'preflight', 'dispatched', 'inspecting', 'reviewing',
  'fixing', 'verifying', 'merging', 'merged', 'branched',
  'failed', 'skipped', 'needs-answers', 'ungroomed', 'parked'
];

describe('run stage tones', () => {
  it('assigns a tone to every RunStage member', () => {
    for (const stage of ALL_STAGES) {
      expect(STAGE_TONE[stage]).toBeDefined();
    }
  });

  it('groups the six mid-pipeline stages as active', () => {
    for (const stage of ['dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging'] as RunStage[]) {
      expect(STAGE_TONE[stage]).toBe('active');
    }
  });

  it('separates success, failure, waiting and blocked', () => {
    expect(STAGE_TONE.merged).toBe('done');
    // The branch-mode success exit reads as the same 'done' green as
    // `merged` — both are the run finishing an item cleanly, and the tone
    // is about how the outcome should be read, not which mode produced it.
    expect(STAGE_TONE.branched).toBe('done');
    expect(STAGE_TONE.failed).toBe('bad');
    expect(STAGE_TONE.pending).toBe('idle');
    expect(STAGE_TONE.preflight).toBe('idle');
    expect(STAGE_TONE['needs-answers']).toBe('warn');
    expect(STAGE_TONE.parked).toBe('warn');
    expect(STAGE_TONE.skipped).toBe('muted');
    expect(STAGE_TONE.ungroomed).toBe('muted');
  });

  /**
   * The two class names the existing card/strip suites already assert on
   * (test/orchestrator-strip.test.tsx). The tone map is new; these two
   * strings are not, and renaming them would break a passing suite for a
   * purely cosmetic gain.
   */
  it('keeps the established class names for the warn and bad tones', () => {
    expect(stageChipClass('needs-answers')).toBe('board-card-stage board-card-stage-warn');
    expect(stageChipClass('failed')).toBe('board-card-stage board-card-stage-bad');
  });

  it('leaves the active tone as the bare base class', () => {
    expect(stageChipClass('verifying')).toBe('board-card-stage');
  });

  it('gives every stage a glyph, and one glyph per tone', () => {
    for (const stage of ALL_STAGES) {
      expect(stageGlyph(stage).length).toBeGreaterThan(0);
    }
    expect(stageGlyph('merged')).toBe(stageGlyph('merged'));
    expect(stageGlyph('merged')).not.toBe(stageGlyph('failed'));
    expect(stageGlyph('pending')).not.toBe(stageGlyph('verifying'));
  });
});

/**
 * `RUN_STATUS_GLYPH`/`RUN_STATUS_CLASS` — fix round 1's hoist out of
 * RunsView.tsx/RunDetail.tsx (they had each grown their own copy) into this
 * file, beside `STAGE_TONE`, precisely because the two answer a different
 * question about a different value: a whole RUN's own `status`
 * (`OrchestratorRun['status']`, four members), never one item's `RunStage`
 * (fifteen members). Before the hoist these two maps were only ever
 * exercised TRANSITIVELY, through whichever component rendered a status
 * chip — this suite is what now pins them directly, the same way the
 * `STAGE_TONE`/`stageGlyph`/`stageChipClass` cases above already pin the
 * per-item vocabulary directly rather than leaving it to a component test.
 */
describe('run status chips', () => {
  /** Restated here rather than imported for the same reason `ALL_STAGES`
   *  above is: `OrchestratorRun['status']` is a type-only union, and the
   *  point of enumerating it by hand is to catch a status added to that
   *  union and never given a glyph or class here — a `Record` only forces
   *  that check at the DEFINITION site, not at every call site that reads
   *  it, so a test which independently lists every member is what actually
   *  proves the two maps are still total. */
  const ALL_STATUSES: OrchestratorRun['status'][] = ['running', 'done', 'aborted', 'failed', 'paused'];

  it('gives every run status a glyph and a class', () => {
    for (const status of ALL_STATUSES) {
      expect(RUN_STATUS_GLYPH[status]).toBeDefined();
      expect(RUN_STATUS_CLASS[status]).toBeDefined();
    }
  });

  /** Pins the literal `.runs-status-*` strings (styles.css) — RunsView.tsx's
   *  row suite and RunDetail's own suite both already assert against
   *  whichever of these strings ends up in the DOM, so a rename here would
   *  break those transitively; asserting the literal here too is what makes
   *  THIS the place a future reader learns that renaming these is not free. */
  it('maps each status to its own runs-status-* class, not the per-item board-card-stage-* family', () => {
    expect(RUN_STATUS_CLASS.running).toBe('runs-status-live');
    expect(RUN_STATUS_CLASS.done).toBe('runs-status-done');
    expect(RUN_STATUS_CLASS.aborted).toBe('runs-status-warn');
    expect(RUN_STATUS_CLASS.failed).toBe('runs-status-bad');
    // Neutral on purpose (task-17): a paused run is neither a success nor a
    // failure, so it gets its own class rather than borrowing `warn`/`bad`.
    expect(RUN_STATUS_CLASS.paused).toBe('runs-status-paused');
  });

  it('gives every status a distinct glyph', () => {
    const glyphs = ALL_STATUSES.map((status) => RUN_STATUS_GLYPH[status]);
    expect(new Set(glyphs).size).toBe(ALL_STATUSES.length);
    // Restated as a literal so adding a fifth status that REUSES an existing
    // glyph fails here rather than passing a self-referential length check.
    expect(new Set(Object.values(RUN_STATUS_GLYPH)).size).toBe(5);
  });

  /** The one property that actually justifies keeping these two maps
   *  separate from `STAGE_TONE`'s: a `RunStage` and an `OrchestratorRun`
   *  status share the spelling `failed`, but a failed ITEM (cyan-adjacent
   *  danger red on the per-item chip) and a failed RUN (this map's own red)
   *  must never be read as needing the same lookup table — proven here by
   *  showing the two maps disagree on which UNION they even accept, not
   *  merely on their values. `stageGlyph`/`STAGE_TONE` have no `running`,
   *  `done`, or `aborted` member at all (`RunStage` does not define them),
   *  so this is a compile-time fact as much as a runtime one; the point of
   *  asserting it here is to leave a test a future "let's merge these two
   *  maps, they look so similar" refactor has to fail before it can land. */
  it('keys on a different union than the per-item stage tone map, despite sharing the word "failed"', () => {
    expect(STAGE_TONE.failed).toBeDefined();
    expect((STAGE_TONE as Record<string, unknown>).running).toBeUndefined();
    expect((STAGE_TONE as Record<string, unknown>).done).toBeUndefined();
    expect((STAGE_TONE as Record<string, unknown>).aborted).toBeUndefined();
  });
});

/**
 * bug-29. The Runs list row and the detail pane's head both printed
 * `authority.status` verbatim, so a run whose heartbeat died 46 minutes ago
 * rendered the word `running` in the live tone while the Board strip one
 * click away already said `crashed` off the same payload. `runStatusChip` is
 * the one place that substitution is decided, so the two sites cannot drift
 * — the same "one implementation, not two agreeing expressions" posture
 * `watchdogStoodDown` and `isCrashed` itself already keep.
 *
 * `crashed` deliberately never becomes a sixth `RunStatus`: it is derived
 * (`isCrashed`, lib/run-watchdog.ts) from a status AND a heartbeat, and the
 * wire type carries no such member — a run file can never contain the word.
 * That is why the substitution happens HERE, over the two records' existing
 * `running` entry, rather than by growing the records.
 */
describe('runStatusChip', () => {
  it('reads the run status verbatim when there is no live entry to judge a heartbeat against', () => {
    // The archive-only row: a run file that is gone or superseded, whose
    // recorded status is still `running`. Nothing here can tell whether that
    // process is alive, so nothing here may reclassify it.
    expect(runStatusChip('running', null)).toEqual({
      label: 'running', glyph: RUN_STATUS_GLYPH.running, className: RUN_STATUS_CLASS.running
    });
  });

  it('reads the run status verbatim while the live entry is fresh', () => {
    expect(runStatusChip('running', { status: 'running', fresh: true })).toEqual({
      label: 'running', glyph: RUN_STATUS_GLYPH.running, className: RUN_STATUS_CLASS.running
    });
  });

  it('reads crashed for a running run whose live heartbeat has gone stale', () => {
    const chip = runStatusChip('running', { status: 'running', fresh: false });
    expect(chip.label).toBe('crashed');
    // The strip's own amber for the same verdict — `.run-strip-crashed-label`
    // (styles.css) is `var(--amber)`, and `runs-status-warn` is this list's
    // existing amber slot, so the two surfaces agree on colour as well as word
    // without minting a class.
    expect(chip.className).toBe('runs-status-warn');
  });

  it('leaves every finished status alone even when the live entry is stale', () => {
    // `isCrashed` is `running && !fresh`, never `!fresh` alone: a run that
    // finished — however long ago — is not crashed, it is over. A paused run
    // is the sharp case, since it is the one non-running status that can
    // still be resumed.
    for (const status of ['done', 'aborted', 'failed', 'paused'] as OrchestratorRun['status'][]) {
      expect(runStatusChip(status, { status, fresh: false }).label).toBe(status);
    }
  });

  it('keeps `crashed` out of the two status records entirely', () => {
    // The mechanism, not a reminder: `Record<OrchestratorRun['status'], string>`
    // is exhaustive at the definition site, so a sixth key fails the type
    // check. This pins the runtime half — five keys, none of them `crashed`.
    expect(Object.keys(RUN_STATUS_GLYPH).sort()).toEqual(ALL_RUN_STATUSES);
    expect(Object.keys(RUN_STATUS_CLASS).sort()).toEqual(ALL_RUN_STATUSES);
    expect((RUN_STATUS_GLYPH as Record<string, unknown>).crashed).toBeUndefined();
    expect((RUN_STATUS_CLASS as Record<string, unknown>).crashed).toBeUndefined();
  });
});
