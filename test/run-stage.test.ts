import { STAGE_TONE, stageChipClass, stageGlyph } from '../client/src/lib/run-stage';
import type { RunStage } from '../shared/types';

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
  'fixing', 'verifying', 'merging', 'merged',
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
