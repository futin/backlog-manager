import { RUN_STALE_MS } from '../shared/types';
import type { OrchestratorRun } from '../shared/types';
import rawFixture from './fixtures/orchestrator-run.json';

// The fixture is authored as plain JSON (it is also loaded by the standalone
// orchestrate.mjs tool and by a later jest suite — see the fixture's own
// header comment once shared/types.ts exists), so TypeScript infers its
// shape from the literal JSON rather than from OrchestratorRun — string
// fields come back as `string`, not as the narrower `RunStage` etc. The
// assertion below is that translation, not a way to dodge real checking:
// every property this test or a consumer actually reads is still the real
// parsed JSON value, and case (2) below is what catches a typo'd stage
// string that the assertion alone could never catch.
const fixture = rawFixture as OrchestratorRun;

describe('RUN_STALE_MS', () => {
  it('is fifteen minutes, in milliseconds', () => {
    expect(RUN_STALE_MS).toBe(900000);
  });
});

describe('the orchestrator-run fixture', () => {
  // Written out by hand, not derived from the RunStage union: deriving it
  // would make this test pass no matter how a stage string in the fixture
  // (or a future member added to RunStage) drifted from the type, which is
  // exactly the failure this test exists to catch.
  const KNOWN_STAGES = [
    'pending', 'preflight', 'dispatched', 'inspecting', 'reviewing', 'fixing',
    'verifying', 'merging', 'merged', 'failed', 'skipped', 'needs-answers',
    'ungroomed', 'parked'
  ];

  it('gives every queue item a stage from the known RunStage set', () => {
    expect(fixture.queue.length).toBeGreaterThan(0);
    for (const item of fixture.queue) {
      expect(KNOWN_STAGES).toContain(item.stage);
    }
  });

  // Plain JSON round-trips through JSON.parse(JSON.stringify(...)) with no
  // loss (no Dates, no undefined, no NaN) precisely because it is plain
  // JSON — asserting that here is what guarantees the fixture is actually
  // fit to be the cross-language schema pin the standalone .mjs tool (which
  // only ever sees it after a real parse/stringify round trip) will load.
  it('round-trips through JSON.parse(JSON.stringify(...)) unchanged', () => {
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
  });
});
