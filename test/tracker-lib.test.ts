import {
  accessReason,
  apiUsage,
  claimControl,
  claimReading,
  hasSyncingTracker,
  hasTracker,
  itemSyncOff,
  pollAge,
  pollProgress,
  queuedReading,
  resetClock,
  staleTakeover,
  sweepProgress,
  syncCycleMs,
  syncOffReason,
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

/* #227 — whether a tracker item's holder is live, by the reader's clock. The one rule `claimControl`, the card's bar, the rank and `progressBlock` all
   read, and the rule the server's `isLive` applies: stale at exactly `CLAIM_STALE_MS`, and stale when the heartbeat cannot be read. */
describe('claimReading', () => {
  const beat = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
  const tracker = (holder?: ItemHolder) => ({ source: 'github' as const, ...(holder === undefined ? {} : { holder }) });

  it('is null for a files item, whatever it carries, and for an unheld issue', () => {
    expect(claimReading({ source: 'files', holder: { session: 's', heartbeat: beat(0) } }, NOW)).toBeNull();
    expect(claimReading(tracker(), NOW)).toBeNull();
  });

  it('is live one millisecond short of CLAIM_STALE_MS and stale at exactly it', () => {
    expect(claimReading(tracker({ session: 's', heartbeat: beat(CLAIM_STALE_MS - 1) }), NOW)).toBe('live');
    expect(claimReading(tracker({ session: 's', heartbeat: beat(CLAIM_STALE_MS) }), NOW)).toBe('stale');
  });

  it('is stale for a heartbeat it cannot read — nothing can call it fresh', () => {
    expect(claimReading(tracker({ session: 's', heartbeat: 'not a date' }), NOW)).toBe('stale');
  });
});

/* #225, widened by #227 — the item modal's claim control over {live, stale} × {dispatched, hand, run-held}. The server re-decides every case at click
   time; this is only whether the click is offered, and with which confirm. */
describe('claimControl', () => {
  const beat = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
  const tracker = (holder?: ItemHolder) => ({ source: 'github' as const, ...(holder === undefined ? {} : { holder }) });
  const LIVE = beat(60_000);
  const STALE = beat(CLAIM_STALE_MS + 60_000);

  it('offers Stop & release for a claim the board dispatched, live or stale', () => {
    expect(claimControl(tracker({ session: 's', heartbeat: LIVE, dispatched: true }), NOW)).toBe('stop-release');
    expect(claimControl(tracker({ session: 's', heartbeat: STALE, dispatched: true }), NOW)).toBe('stop-release');
  });

  it('offers Release claim for a live hand claim, and the stale release for a stale one', () => {
    expect(claimControl(tracker({ session: 's', host: 'laptop', heartbeat: LIVE }), NOW)).toBe('release');
    expect(claimControl(tracker({ session: 's', host: 'laptop', heartbeat: STALE }), NOW)).toBe('release-stale');
  });

  it('offers nothing for a run-held claim, live or stale, dispatched or not', () => {
    expect(claimControl(tracker({ session: 's', heartbeat: LIVE, run: 'run-9' }), NOW)).toBeNull();
    expect(claimControl(tracker({ session: 's', heartbeat: STALE, run: 'run-9' }), NOW)).toBeNull();
    expect(claimControl(tracker({ session: 's', heartbeat: LIVE, run: 'run-9', dispatched: true }), NOW)).toBeNull();
  });

  it('offers nothing for a files item, whatever it carries', () => {
    expect(claimControl({ source: 'files', holder: { session: 's', heartbeat: beat(0), dispatched: true } }, NOW)).toBeNull();
  });

  it('offers nothing for an unheld item', () => {
    expect(claimControl(tracker(), NOW)).toBeNull();
  });

  it('turns release into release-stale at exactly CLAIM_STALE_MS, and for a heartbeat it cannot read', () => {
    expect(claimControl(tracker({ session: 's', heartbeat: beat(CLAIM_STALE_MS - 1) }), NOW)).toBe('release');
    expect(claimControl(tracker({ session: 's', heartbeat: beat(CLAIM_STALE_MS) }), NOW)).toBe('release-stale');
    expect(claimControl(tracker({ session: 's', heartbeat: 'not a date' }), NOW)).toBe('release-stale');
  });
});

/* #227 — the dispatch sheet's line when a launch goes ahead over a stale hand claim: the spawned session's own `start` retires it. */
describe('staleTakeover', () => {
  const beat = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
  const tracker = (holder?: ItemHolder) => ({ source: 'github' as const, ...(holder === undefined ? {} : { holder }) });

  it('names the session, its host and the heartbeat age', () => {
    expect(staleTakeover(tracker({ session: 'b1c2d3e4-5555', host: 'aj_linux', heartbeat: beat(42 * 60_000) }), NOW)).toBe(
      'takes over a stale claim — session b1c2d3e4 on aj_linux, no heartbeat 42m'
    );
  });

  it('drops the host clause when the claim recorded none', () => {
    expect(staleTakeover(tracker({ session: 's', heartbeat: beat(42 * 60_000) }), NOW)).toBe('takes over a stale claim — session s, no heartbeat 42m');
  });

  it('is null for a live claim, a dispatched or run-held stale claim, an unheld issue and a files item', () => {
    expect(staleTakeover(tracker({ session: 's', heartbeat: beat(60_000) }), NOW)).toBeNull();
    expect(staleTakeover(tracker({ session: 's', heartbeat: beat(CLAIM_STALE_MS), dispatched: true }), NOW)).toBeNull();
    expect(staleTakeover(tracker({ session: 's', heartbeat: beat(CLAIM_STALE_MS), run: 'run-9' }), NOW)).toBeNull();
    expect(staleTakeover(tracker(), NOW)).toBeNull();
    expect(staleTakeover({ source: 'files', holder: { session: 's', heartbeat: beat(CLAIM_STALE_MS) } }, NOW)).toBeNull();
  });
});

/**
 * #17 — a repo's sync interval as the client reads it. `off` is a reading AND a block: the line says so, and dispatch refuses with the server's sentence.
 * A slowed repo needs no new words, but it does need its own clock — a `5m` repo is not overdue at 34 s.
 */
describe('sync interval readings (#17)', () => {
  const SENTENCE = 'sync is off for futin/x — turn it on in Settings › Shared › Trackers';

  it('syncOffReason is the server’s sentence, byte for byte, and only for off', () => {
    // The client cannot import the server's composer; both sides pin this literal (tracker-sync-interval.test.ts pins the server's), so a wording change
    // goes red on both.
    expect(syncOffReason({ repo: 'futin/x', interval: 'off' })).toBe(SENTENCE);
    expect(syncOffReason({ repo: 'futin/x', interval: '5m' })).toBeNull();
    expect(syncOffReason({ repo: 'futin/x', interval: null })).toBeNull();
    expect(syncOffReason({ repo: null, interval: 'off' })).toBeNull();
  });

  it('trackerLine says sync off beside the age, or never polled', () => {
    expect(trackerLine(project({ interval: 'off', polledAt: new Date(NOW - 3 * 3_600_000).toISOString() }), NOW)).toBe(
      `futin/x · sync off · polled ${pollAge(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)} ago`
    );
    expect(trackerLine(project({ interval: 'off', polledAt: null }), NOW)).toBe('futin/x · sync off · never polled');
  });

  it('lets an access reason win over sync off', () => {
    expect(trackerLine(project({ interval: 'off', access: 'no-token' }), NOW)).toBe('futin/x · no token — set BM_GITHUB_TOKEN and restart');
  });

  it('leaves a slowed repo’s line exactly as a 15s one reads', () => {
    expect(trackerLine(project({ interval: '1m' }), NOW)).toBe(trackerLine(project({ interval: '15s' }), NOW));
    expect(trackerLine(project({ interval: '1m' }), NOW)).toBe('futin/x · polled 12 s ago');
  });

  it('hasSyncingTracker is true only for a github project whose sync is not off', () => {
    const files = project({ source: 'files', repo: null, interval: null });
    expect(hasSyncingTracker([])).toBe(false);
    expect(hasSyncingTracker(null)).toBe(false);
    expect(hasSyncingTracker([project({ interval: 'off' })])).toBe(false);
    expect(hasSyncingTracker([project({ interval: 'off' }), project({ path: '/abs/y', interval: '5m' })])).toBe(true);
    expect(hasSyncingTracker([files])).toBe(false);
  });

  it('itemSyncOff looks the item’s project up by path', () => {
    const list = [project({ interval: 'off' }), project({ path: '/abs/y', repo: 'futin/y', interval: '15s' })];
    expect(itemSyncOff({ projectPath: '/abs/tracker' }, list)).toBe(SENTENCE);
    expect(itemSyncOff({ projectPath: '/abs/y' }, list)).toBeNull();
    expect(itemSyncOff({ projectPath: '/abs/unregistered' }, list)).toBeNull();
    expect(itemSyncOff({ projectPath: '/abs/tracker' }, null)).toBeNull();
  });

  // Final review M1: the server restamps a slow repo on its n-th TICK, and a tick is 15 s plus the sweep before it — so the slack scales with n. Interval
  // plus 2 s put a 5m repo's countdown at 0 s for ~20 s every cycle and hurried the fetch at 1 Hz through its due window.
  it('syncCycleMs is one client cycle per server tick the interval spans, and null for off', () => {
    expect(syncCycleMs('15s')).toBe(TRACKER_CYCLE_MS);
    expect(syncCycleMs(null)).toBe(TRACKER_CYCLE_MS);
    expect(syncCycleMs('1m')).toBe(4 * TRACKER_CYCLE_MS);
    expect(syncCycleMs('5m')).toBe(20 * TRACKER_CYCLE_MS);
    expect(syncCycleMs('off')).toBeNull();
  });

  it('pollProgress runs on the cycle it is given', () => {
    const stamp = new Date(NOW - 40_000).toISOString();
    expect(pollProgress(stamp, NOW)?.overdue).toBe(true);
    expect(pollProgress(stamp, NOW, 302_000)).toEqual({ fraction: 40_000 / 302_000, leftS: 262, overdue: false });
  });

  it('sweepProgress skips off rows, and runs on the fastest interval present', () => {
    const row = (over: Partial<TrackerProjectRow>): TrackerProjectRow => ({
      name: 'x',
      path: '/abs/x',
      source: 'github',
      repo: 'futin/x',
      polledAt: null,
      access: 'ok',
      detail: null,
      interval: '15s',
      connect: null,
      ...over
    });
    // An off repo's fresher stamp says nothing about the next sweep.
    expect(
      sweepProgress([row({ polledAt: new Date(NOW - 5_000).toISOString() }), row({ interval: 'off', polledAt: new Date(NOW - 1_000).toISOString() })], NOW)
        ?.leftS
    ).toBe(12);
    // Only 5m repos: the clock is five minutes long, and 40 s in is not overdue.
    expect(sweepProgress([row({ interval: '5m', polledAt: new Date(NOW - 40_000).toISOString() })], NOW)).toEqual({
      fraction: 40_000 / 340_000,
      leftS: 300,
      overdue: false
    });
    // A 15s repo beside a 5m one that synced a moment later: the chip follows the 15s one.
    expect(
      sweepProgress(
        [row({ polledAt: new Date(NOW - 5_000).toISOString() }), row({ path: '/abs/y', interval: '5m', polledAt: new Date(NOW - 4_000).toISOString() })],
        NOW
      )?.leftS
    ).toBe(12);
    expect(sweepProgress([row({ interval: 'off', polledAt: new Date(NOW - 1_000).toISOString() })], NOW)).toBeNull();
  });
});
