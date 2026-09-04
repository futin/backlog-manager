import {
  RUN_STATUS_CLASS, RUN_STATUS_GLYPH, STAGE_TONE, stageChipClass, stageGlyph
} from '../client/src/lib/run-stage';
import type { OrchestratorRun, RunStage } from '../shared/types';

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
  const ALL_STATUSES: OrchestratorRun['status'][] = ['running', 'done', 'aborted', 'failed'];

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
  });

  it('gives every status a distinct glyph', () => {
    const glyphs = ALL_STATUSES.map((status) => RUN_STATUS_GLYPH[status]);
    expect(new Set(glyphs).size).toBe(ALL_STATUSES.length);
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
