import { StartingRunsService } from '../server/src/orchestrator/starting-runs.service';
import { RUN_STALE_MS } from '../shared/types';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun } from '../shared/types';

// Same cast every other suite reading this fixture makes: plain JSON widens
// its string fields to `string`, so without it `{ ...fixture, project }`
// would not type-check as an OrchestratorRun.
const fixture = rawFixture as OrchestratorRun;

/** A real run for `project` whose own `startedAt` is exactly `startedAt` —
 *  the only two fields this service's eviction rule ever reads off a run.
 *  Built off the shared fixture rather than a hand-rolled object literal so
 *  a future required field on OrchestratorRun fails to compile here rather
 *  than making these cases silently test a shape the reader never sees. */
function runAt(project: string, startedAt: string): OrchestratorRun {
  return { ...fixture, project, startedAt };
}

describe('StartingRunsService', () => {
  let svc: StartingRunsService;

  beforeEach(() => {
    svc = new StartingRunsService();
  });

  it('lists a marked project with an ISO requestedAt naming the marked instant', () => {
    const before = Date.now();
    svc.mark('/p');
    const after = Date.now();

    const listed = svc.list([], after);
    expect(listed).toHaveLength(1);
    expect(listed[0].project).toBe('/p');
    const parsed = Date.parse(listed[0].requestedAt);
    // Millisecond-exact equality would pin an implementation detail
    // (whether the ISO string round-trips ms); the real contract is that it
    // names the instant `mark` was called, so bracket it.
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it('drops the entry once a real run for that project started AFTER it was marked', () => {
    svc.mark('/p');
    const now = Date.now();
    const landed = runAt('/p', new Date(now + 1_000).toISOString());

    expect(svc.list([landed], now + 2_000)).toEqual([]);
  });

  it('keeps the entry when the only run for that project started BEFORE it was marked', () => {
    // The case a naive implementation gets wrong. `cmdInit` archives the
    // previous run.json and writes a new one, so a project that has ever
    // run always HAS a run file — "a file exists" would evict the
    // placeholder instantly, on every project but a first-ever run. Only a
    // run whose own startedAt is at or after the mark can be the run this
    // spawn asked for.
    svc.mark('/p');
    const now = Date.now();
    const previous = runAt('/p', new Date(now - 60_000).toISOString());

    expect(svc.list([previous], now)).toHaveLength(1);
  });

  it('keeps the entry when a run for that project has an unparseable startedAt', () => {
    svc.mark('/p');
    const now = Date.now();

    expect(svc.list([runAt('/p', 'not-a-date')], now)).toHaveLength(1);
  });

  it('keeps the entry when the only landed run belongs to a different project', () => {
    svc.mark('/p');
    const now = Date.now();

    expect(svc.list([runAt('/other', new Date(now).toISOString())], now)).toHaveLength(1);
  });

  it('drops the entry once it is older than RUN_STALE_MS, and keeps it right up to the boundary', () => {
    svc.mark('/p');
    const at = Date.parse(svc.list([], Date.now())[0].requestedAt);

    // Both directions: a one-sided assertion passes for an implementation
    // that evicts everything, and equally for one that evicts nothing.
    expect(svc.list([], at + RUN_STALE_MS - 1)).toHaveLength(1);
    expect(svc.list([], at + RUN_STALE_MS + 1)).toEqual([]);
  });

  it('evicts only the project whose run landed, leaving the other marked project alone', () => {
    svc.mark('/a');
    svc.mark('/b');
    const now = Date.now();

    const listed = svc.list([runAt('/a', new Date(now).toISOString())], now);
    expect(listed.map((s) => s.project)).toEqual(['/b']);
  });

  it('keeps one entry per project, carrying the later requestedAt when marked twice', () => {
    svc.mark('/p');
    const first = Date.parse(svc.list([], Date.now())[0].requestedAt);
    // A real second POST is separated by at least a network round trip; this
    // suite only needs the two stamps to be distinguishable.
    jest.spyOn(Date, 'now').mockReturnValue(first + 5_000);
    try {
      svc.mark('/p');
    } finally {
      jest.spyOn(Date, 'now').mockRestore();
    }

    const listed = svc.list([], first + 6_000);
    expect(listed).toHaveLength(1);
    expect(Date.parse(listed[0].requestedAt)).toBe(first + 5_000);
  });

  it('list is pure: an entry a landed run has superseded is still in the map afterwards', () => {
    // The half of the pure/mutating split that `runs()` depends on — it
    // calls `list` and must not mutate. `sweep` (next case) is what
    // actually deletes, from the controller.
    svc.mark('/p');
    const now = Date.now();
    const landed = [runAt('/p', new Date(now).toISOString())];

    expect(svc.list(landed, now)).toEqual([]);
    // Same map, asked a question the landed run does not answer: with
    // nothing landed the entry is still there, so `list` deleted nothing.
    expect(svc.list([], now)).toHaveLength(1);
  });

  it('sweep deletes exactly what list filtered out', () => {
    svc.mark('/p');
    const now = Date.now();

    svc.sweep([runAt('/p', new Date(now).toISOString())], now);
    expect(svc.list([], now)).toEqual([]);
  });

  it('sweep leaves an entry list would have kept', () => {
    svc.mark('/p');
    const now = Date.now();

    svc.sweep([runAt('/p', new Date(now - 60_000).toISOString())], now);
    expect(svc.list([], now)).toHaveLength(1);
  });

  it('sweep drops an entry past RUN_STALE_MS even with no runs at all', () => {
    svc.mark('/p');
    const at = Date.parse(svc.list([], Date.now())[0].requestedAt);

    svc.sweep([], at + RUN_STALE_MS + 1);
    // Asked back at an instant the entry would otherwise still be live, so
    // this proves the sweep deleted rather than the filter re-hiding it.
    expect(svc.list([], at + 1)).toEqual([]);
  });
});
