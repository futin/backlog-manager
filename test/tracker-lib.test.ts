import {
  accessReason,
  apiUsage,
  claimControl,
  hasTracker,
  pollAge,
  pollProgress,
  queuedReading,
  resetClock,
  sweepProgress,
  TRACKER_CYCLE_MS,
  trackerLine
} from '../client/src/lib/tracker';
import { remoteAsLive } from '../client/src/lib/remote-run';
import { CLAIM_STALE_MS, RUN_STALE_MS } from '../shared/types';
import type { ItemHolder, OrchestratorRun, ProjectSummary, RemoteRun, TrackerProjectRow } from '../shared/types';

/**
 * The board's tracker derivations (task-45). Pure functions with the clock
 * passed in, so every case here is a table row rather than a render — the same
 * shape `item-age.test.ts` and `item-stale.test.ts` have, and the reason
 * `lib/` exists at all.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z');

function project(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    name: 'tracker',
    path: '/abs/tracker',
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
    source: 'github',
    repo: 'futin/x',
    polledAt: '2026-09-18T11:59:48Z',
    access: 'ok',
    detail: null,
    interval: null,
    ...over
  };
}

describe('pollAge', () => {
  it('reads seconds under a minute and delegates above it', () => {
    // The seconds rung is this function's own: the server polls every fifteen
    // seconds, so a minutes-only ladder would print one word for four cycles.
    expect(pollAge('2026-09-18T11:59:48Z', NOW)).toBe('12 s');
    expect(pollAge('2026-09-18T11:56:00Z', NOW)).toBe('4m');
    expect(pollAge('2026-09-18T09:00:00Z', NOW)).toBe('3h');
  });

  it('answers null for no poll and for an unparseable stamp', () => {
    // `null` and "0 s" are opposite claims: one says nothing has been read,
    // the other says it was read just now.
    expect(pollAge(null, NOW)).toBeNull();
    expect(pollAge('', NOW)).toBeNull();
    expect(pollAge('not a date', NOW)).toBeNull();
  });

  it('clamps a stamp from the future rather than going negative', () => {
    expect(pollAge('2026-09-18T12:00:30Z', NOW)).toBe('0 s');
  });
});

/** A `/api/trackers` row — the shape the strip chip reads, as distinct from the board's `ProjectSummary`. */
function row(over: Partial<TrackerProjectRow> = {}): TrackerProjectRow {
  return { name: 'x', path: '/abs/x', source: 'github', repo: 'futin/x', polledAt: null, access: 'ok', detail: null, interval: null, connect: null, ...over };
}

const stamp = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

describe('pollProgress', () => {
  it('reads the fraction of the cycle elapsed and the whole seconds left', () => {
    const p = pollProgress(stamp(5_000), NOW);
    expect(p).not.toBeNull();
    expect(p!.fraction).toBeCloseTo(0.294, 3);
    expect(p!.leftS).toBe(12);
    expect(p!.overdue).toBe(false);
  });

  it('is null for no stamp, an empty string and an unparseable one', () => {
    expect(pollProgress(null, NOW)).toBeNull();
    expect(pollProgress('', NOW)).toBeNull();
    expect(pollProgress('yesterday', NOW)).toBeNull();
  });

  it('clamps a stamp from the future to the start of the cycle', () => {
    expect(pollProgress(stamp(-60_000), NOW)).toEqual({ fraction: 0, leftS: 17, overdue: false });
  });

  it('fills the bar and reads 0 s once the cycle has passed, without yet being overdue', () => {
    expect(pollProgress(stamp(17_000), NOW)).toEqual({ fraction: 1, leftS: 0, overdue: false });
    expect(pollProgress(stamp(33_999), NOW)).toEqual({ fraction: 1, leftS: 0, overdue: false });
  });

  it('is overdue at exactly two cycles', () => {
    expect(pollProgress(stamp(34_000), NOW)).toEqual({ fraction: 1, leftS: 0, overdue: true });
    // The threshold is the constant, not a second literal: the fetch schedule and the bar read the same cycle.
    expect(2 * TRACKER_CYCLE_MS).toBe(34_000);
  });
});

describe('sweepProgress', () => {
  it('follows the newest stamp among github rows', () => {
    const rows = [row({ polledAt: stamp(15_000) }), row({ polledAt: stamp(3_000) }), row({ polledAt: stamp(9_000) })];
    expect(sweepProgress(rows, NOW)).toEqual(pollProgress(stamp(3_000), NOW));
  });

  it('ignores rows that are not github, whatever their stamp', () => {
    const rows = [row({ source: 'files', polledAt: stamp(1_000) }), row({ polledAt: stamp(10_000) })];
    expect(sweepProgress(rows, NOW)?.leftS).toBe(7);
  });

  it('is null when no github row has polled', () => {
    expect(sweepProgress([row(), row(), row({ source: 'files', polledAt: stamp(1_000) })], NOW)).toBeNull();
    expect(sweepProgress([], NOW)).toBeNull();
  });
});

describe('apiUsage', () => {
  it('is null while the platform has no limit', () => {
    expect(apiUsage({ limit: null, remaining: null, reset: null })).toBeNull();
  });

  it('floors a use under one percent to <1%', () => {
    const u = apiUsage({ limit: 5000, remaining: 4986, reset: null });
    expect(u!.label).toBe('<1%');
    expect(u!.fraction).toBeCloseTo(0.0028, 4);
    expect(u!.left).toBe(4986);
  });

  it('reads one decimal from one percent up', () => {
    expect(apiUsage({ limit: 5000, remaining: 4950, reset: null })!.label).toBe('1.0%');
    expect(apiUsage({ limit: 5000, remaining: 4930, reset: null })!.label).toBe('1.4%');
    expect(apiUsage({ limit: 5000, remaining: 500, reset: null })!.label).toBe('90.0%');
  });

  it('formats the reset as a local wall clock', () => {
    const reset = Math.floor(Date.parse('2026-09-18T12:00:00Z') / 1000);
    expect(apiUsage({ limit: 5000, remaining: 4930, reset })!.resetsAt).toBe(
      new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
    expect(apiUsage({ limit: 5000, remaining: 4930, reset: null })!.resetsAt).toBeNull();
  });

  it('is null for a zero limit and clamps a remaining above the limit to nothing used', () => {
    // Review Focus 1: a platform answering before its first rate-limit header, or a reset landing mid-read.
    expect(apiUsage({ limit: 0, remaining: 0, reset: null })).toBeNull();
    const u = apiUsage({ limit: 5000, remaining: 5100, reset: null });
    expect(u!.fraction).toBe(0);
    expect(u!.label).toBe('<1%');
    expect(u!.left).toBe(5100);
  });
});

describe('resetClock', () => {
  it('is the same clock TrackersGroup used to draw', () => {
    expect(resetClock(0)).toBe(new Date(0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  });
});

describe('accessReason', () => {
  it('names the fix for the one state an operator can clear', () => {
    expect(accessReason({ access: 'no-token', detail: null })).toContain('BM_GITHUB_TOKEN');
  });

  it('carries the detail where it adds something and drops it where it does not', () => {
    expect(accessReason({ access: 'rate-limited', detail: 'resets 14:32' })).toBe('resets 14:32');
    // GitHub's own message for these two is usually "Not Found", which says
    // less than the state does.
    expect(accessReason({ access: 'not-found', detail: 'Not Found' })).toContain('not visible to this token');
    expect(accessReason({ access: 'forbidden', detail: 'Not Found' })).toContain('cannot read that repo');
  });

  it('is null for a healthy connection and for a project that has none', () => {
    expect(accessReason({ access: 'ok', detail: null })).toBeNull();
    expect(accessReason({ access: null, detail: null })).toBeNull();
  });
});

describe('trackerLine', () => {
  it('prints the repo and the age while access is ok', () => {
    expect(trackerLine(project(), NOW)).toBe('futin/x · polled 12 s ago');
  });

  it('replaces the age with the access reason, never printing both', () => {
    const line = trackerLine(project({ access: 'rate-limited', detail: 'resets 14:32' }), NOW);
    expect(line).toBe('futin/x · resets 14:32');
    expect(line).not.toContain('polled');
  });

  it('says connecting before the first successful poll', () => {
    // Not `polled 0 s ago`, which would claim a read that has not happened.
    expect(trackerLine(project({ polledAt: null }), NOW)).toBe('futin/x · connecting…');
  });

  it('is null for every non-tracker project, which is what the caller filters on', () => {
    expect(trackerLine(project({ source: 'files', repo: null, access: null, polledAt: null }), NOW)).toBeNull();
    expect(trackerLine(project({ source: null }), NOW)).toBeNull();
    expect(trackerLine(project({ source: 'unsupported' }), NOW)).toBeNull();
  });
});

describe('hasTracker', () => {
  it('answers the board’s “should I keep re-reading this” question', () => {
    expect(hasTracker(null)).toBe(false);
    expect(hasTracker([])).toBe(false);
    expect(hasTracker([project({ source: 'files' })])).toBe(false);
    expect(hasTracker([project({ source: 'files' }), project()])).toBe(true);
  });

  it('accepts the trackers payload rows as well as project summaries', () => {
    expect(hasTracker([row()])).toBe(true);
    expect(hasTracker([row({ source: 'files' })])).toBe(false);
  });
});

describe('queuedReading', () => {
  // Stamps relative to the clock the assertion runs under (the jsdom suites'
  // convention, followed here too): `runIsLive` ages `updatedAt` against the
  // `now` handed in, so a literal date would only pin the arithmetic.
  const now = Date.now();
  const ago = (ms: number): string => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  type RunPick = Pick<OrchestratorRun, 'project' | 'status' | 'updatedAt'>;
  const run = (over: Partial<RunPick> = {}): RunPick => ({ project: '/abs/tracker', status: 'running', updatedAt: ago(MIN), ...over });
  const queued = { queued: true as const, projectPath: '/abs/tracker' };

  it('is null for an item with no label, whatever the runs', () => {
    expect(queuedReading({ projectPath: '/abs/tracker' }, [], now)).toBeNull();
    expect(queuedReading({ projectPath: '/abs/tracker' }, [run()], now)).toBeNull();
  });

  it('is live while a fresh local run holds the project', () => {
    expect(queuedReading(queued, [run()], now)).toBe('live');
  });

  it('is live for a paused run, however old its heartbeat — a paused run still plans its items', () => {
    // `runIsLive` alone answers false here (it is `running`-only), which is
    // the plan's Review Focus 1: the derivation has to accept `paused` itself.
    expect(queuedReading(queued, [run({ status: 'paused', updatedAt: ago(3 * HOUR) })], now)).toBe('live');
  });

  it('is stale for a crashed run — `running`, heartbeat past RUN_STALE_MS', () => {
    expect(queuedReading(queued, [run({ updatedAt: ago(RUN_STALE_MS + MIN) })], now)).toBe('stale');
  });

  it('is live for a fresh remote run, through the same adapter the Runs page uses', () => {
    // A remote run carries THIS machine's registry path for its repo
    // (`RemoteRunsService.list`), so the path match needs no translation.
    const remote = { ...run(), fresh: true, remote: true, repo: 'futin/x' } as unknown as RemoteRun;
    expect(queuedReading(queued, [remoteAsLive(remote)], now)).toBe('live');
  });

  it('is stale when the only live run belongs to another project', () => {
    expect(queuedReading(queued, [run({ project: '/abs/alpha' })], now)).toBe('stale');
  });

  it('is stale when the project’s run has finished', () => {
    expect(queuedReading(queued, [run({ status: 'done', updatedAt: ago(MIN) })], now)).toBe('stale');
    expect(queuedReading(queued, [], now)).toBe('stale');
  });
});

/* #225 — the item modal's claim control. The server re-decides every case at click time; this is only whether the click is offered. */
describe('claimControl', () => {
  const beat = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
  const tracker = (holder?: ItemHolder) => ({ source: 'github' as const, ...(holder === undefined ? {} : { holder }) });

  it('offers Stop & release for a live claim the board dispatched', () => {
    expect(claimControl(tracker({ session: 's', heartbeat: beat(60_000), dispatched: true }), NOW)).toBe('stop-release');
  });

  it('offers Release claim for any other live claim', () => {
    expect(claimControl(tracker({ session: 's', host: 'laptop', heartbeat: beat(60_000) }), NOW)).toBe('release');
  });

  it('offers nothing for a files item, whatever it carries', () => {
    expect(claimControl({ source: 'files', holder: { session: 's', heartbeat: beat(0), dispatched: true } }, NOW)).toBeNull();
  });

  it('offers nothing for an unheld item', () => {
    expect(claimControl(tracker(), NOW)).toBeNull();
  });

  it('offers nothing for a run-held claim, dispatched or not', () => {
    expect(claimControl(tracker({ session: 's', heartbeat: beat(0), run: 'run-9' }), NOW)).toBeNull();
    expect(claimControl(tracker({ session: 's', heartbeat: beat(0), run: 'run-9', dispatched: true }), NOW)).toBeNull();
  });

  it('offers nothing once the heartbeat reaches CLAIM_STALE_MS, and still offers it one millisecond short', () => {
    expect(claimControl(tracker({ session: 's', heartbeat: beat(CLAIM_STALE_MS) }), NOW)).toBeNull();
    expect(claimControl(tracker({ session: 's', heartbeat: beat(CLAIM_STALE_MS - 1) }), NOW)).toBe('release');
  });

  it('offers nothing for a heartbeat it cannot read', () => {
    expect(claimControl(tracker({ session: 's', heartbeat: 'not a date' }), NOW)).toBeNull();
  });
});
