import {
  STATUS_ORDER,
  freshRunKey,
  groupByDay,
  mergeRuns,
  parseStartedAt,
  pickSelected,
  queueCounts,
  runKey,
  scopeRuns,
  sortByStartedAtDesc,
  splitLive,
  windowHistory
} from '../client/src/lib/runs-list';
import { dayKey, dayLabel } from '../client/src/lib/run-stats';
import type { LiveRun, MergedRun } from '../client/src/lib/runs-list';
import type { OrchestratorArchiveRun, OrchestratorRun, RemoteRun, RemoteStarting, RunStage, StartingRun } from '../shared/types';

/**
 * The zone every reading below is taken in (#241) — the global `TZ` pin (`test/helpers/global-setup.ts`), so the expected values written before the zone
 * became an argument still hold, and so a component mounted without `TimeZoneProvider` (whose default is the browser's zone) reads the same one.
 */
const ZONE = 'America/New_York';

/**
 * The Runs page's run-list derivations (#284 moved them out of RunsView.tsx into lib/runs-list.ts), pinned directly rather than only through
 * runs-view.test.tsx's renders. Each fixture builder fills only the fields these functions read and casts the rest away — the functions are pure and
 * never look past `project`/`runId`/`startedAt`/`status`/`fresh`/`queue`, so a fully typed run would be noise that hides what each case is about.
 *
 * Day-grouping fixtures build `startedAt` from LOCAL date parts, because `dayKey` buckets by the local calendar day: a `Z` literal near midnight would
 * land on a different day in a different timezone and make the suite depend on the machine's TZ.
 */

function archive(over: Partial<OrchestratorArchiveRun> = {}): OrchestratorArchiveRun {
  return { project: '/p/a', runId: 'run-1', startedAt: '2026-09-01T10:00:00.000Z', status: 'done', queue: [], current: false, ...over } as OrchestratorArchiveRun;
}

function live(over: Partial<LiveRun> = {}): LiveRun {
  return { project: '/p/a', runId: 'run-1', startedAt: '2026-09-01T10:00:00.000Z', status: 'running', queue: [], fresh: true, ...over } as LiveRun;
}

function remote(over: Partial<RemoteRun> = {}): RemoteRun {
  return {
    project: '/p/r',
    runId: 'remote-1',
    startedAt: '2026-09-01T10:00:00.000Z',
    status: 'running',
    queue: [],
    fresh: true,
    remote: true,
    repo: 'o/r',
    ...over
  } as RemoteRun;
}

/** A merged row with an archive record and, optionally, the live entry backing it. */
function row(startedAt: string, liveEntry: LiveRun | null = null, status: OrchestratorRun['status'] = 'done'): MergedRun {
  return { run: archive({ runId: startedAt, startedAt, status }), live: liveEntry, isLive: liveEntry?.fresh === true, remote: false };
}

function localIso(day: number, hour: number): string {
  return new Date(2026, 8, day, hour).toISOString();
}

describe('runKey', () => {
  it('separates two projects that share a runId and joins the same pair to one string', () => {
    expect(runKey('a', '2026-09-01T10-00-00')).not.toBe(runKey('b', '2026-09-01T10-00-00'));
    expect(runKey('a', '2026-09-01T10-00-00')).toBe(runKey('a', '2026-09-01T10-00-00'));
  });
});

describe('mergeRuns', () => {
  it('turns an archive run with no live entry into one non-live row', () => {
    const run = archive();
    const rows = mergeRuns([run], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ run, live: null, isLive: false, remote: false });
    expect(rows[0].run).toBe(run);
  });

  it('attaches a fresh live entry and marks the row live', () => {
    const entry = live({ fresh: true });
    const [r] = mergeRuns([archive()], [entry], []);
    expect(r.live).toBe(entry);
    expect(r.isLive).toBe(true);
  });

  it('bug-29: keeps a stale running live entry as the row data while isLive stays false', () => {
    const entry = live({ fresh: false, status: 'running' });
    const [r] = mergeRuns([archive()], [entry], []);
    expect(r.live).toBe(entry);
    expect(r.isLive).toBe(false);
  });

  it('M3: keeps two projects with one runId apart and attaches a live entry to its own project only', () => {
    const entry = live({ project: '/p/b', runId: 'same' });
    const rows = mergeRuns([archive({ project: '/p/a', runId: 'same' }), archive({ project: '/p/b', runId: 'same' })], [entry], []);
    expect(rows).toHaveLength(2);
    expect(rows[0].live).toBeNull();
    expect(rows[1].live).toBe(entry);
  });

  it('keeps the FIRST of two archive entries with the same project and runId', () => {
    const first = archive({ status: 'done' });
    const rows = mergeRuns([first, archive({ status: 'failed' })], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].run).toBe(first);
  });

  it('draws no row for a live entry the archive does not list', () => {
    expect(mergeRuns([], [live()], [])).toEqual([]);
  });

  it('appends a remote run after every archive row, built by the remote adapters', () => {
    const r = remote({ fresh: false, queue: [{ id: '#1', stage: 'merged', verification: [{ cmd: 'x', ok: true, output: 'y' }] }] as unknown as RemoteRun['queue'] });
    const rows = mergeRuns([archive({ runId: 'a1' }), archive({ runId: 'a2' })], [], [r]);
    expect(rows).toHaveLength(3);
    const last = rows[2];
    expect(last.remote).toBe(true);
    expect(last.run.runId).toBe('remote-1');
    expect(last.run.current).toBe(false);
    // remoteAsArchive strips a verification entry down to cmd/ok.
    expect(last.run.queue[0].verification).toEqual([{ cmd: 'x', ok: true }]);
    // remoteAsLive adds the three local-only fields.
    expect(last.live).toMatchObject({ runId: 'remote-1', pastRuns: 0, pauseRequested: false, stopRequested: false });
    expect(last.isLive).toBe(last.live?.fresh);
    expect(last.isLive).toBe(false);
  });

  /*
    Multi-dashboard task 10: a remote row names the machine it ran on. `host` is what the claims carry; `labelByHost` is the caller's `machineLabelByHost` over
    the dashboards view, so this module stays a pure fold. A local row has no machine at all — the key is absent, not null, because a run on the machine you
    are looking at is never labelled.
  */
  it('carries the machine label on a remote row, the raw host when no remote owns it, and nothing when the run has no host', () => {
    const labelByHost = (host?: string): string | null => (host === 'pro-mac' ? 'Pro' : null);
    const rows = mergeRuns(
      [],
      [],
      [remote({ runId: 'r-1', host: 'pro-mac' }), remote({ runId: 'r-2', host: 'unmapped-box' }), remote({ runId: 'r-3', host: null })],
      labelByHost
    );
    expect(rows.map((r) => r.machine)).toEqual(['Pro', 'unmapped-box', null]);
  });

  it('leaves the machine off a local row, and off a remote row when no label function is passed', () => {
    const [local] = mergeRuns([archive()], [], []);
    expect('machine' in local).toBe(false);
    const [r] = mergeRuns([], [], [remote({ host: 'pro-mac' })]);
    expect(r.machine).toBe('pro-mac');
  });

  it('drops a remote run whose project and runId an archive row already holds', () => {
    const rows = mergeRuns([archive({ project: '/p/r', runId: 'remote-1' })], [], [remote()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].remote).toBe(false);
  });
});

describe('parseStartedAt / sortByStartedAtDesc', () => {
  it('reads an unparseable stamp as -Infinity and a valid one as its Date.parse value', () => {
    expect(parseStartedAt('not a date')).toBe(-Infinity);
    expect(parseStartedAt('2026-09-01T10:00:00.000Z')).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
  });

  it('sorts newest first, a corrupt startedAt last, without mutating the input', () => {
    const t1 = row('2026-09-01T10:00:00.000Z');
    const t2 = row('2026-09-02T10:00:00.000Z');
    const t3 = row('2026-09-03T10:00:00.000Z');
    const bad = row('garbage');
    const input = [t2, bad, t1, t3];
    const sorted = sortByStartedAtDesc(input);
    expect(sorted).toEqual([t3, t2, t1, bad]);
    expect(input).toEqual([t2, bad, t1, t3]);
  });
});

describe('splitLive', () => {
  it('puts a crashed run (running, stale) and a paused live run in live', () => {
    const crashed = row('2026-09-02T10:00:00.000Z', live({ status: 'running', fresh: false }));
    const paused = row('2026-09-01T10:00:00.000Z', live({ status: 'paused' }));
    const { live: going, history } = splitLive([crashed, paused]);
    expect(going).toEqual([crashed, paused]);
    expect(history).toEqual([]);
  });

  it('puts a not-yet-archived done/aborted/failed live entry in history', () => {
    const rows = (['done', 'aborted', 'failed'] as const).map((status, i) => row(`2026-09-0${i + 1}T10:00:00.000Z`, live({ status })));
    const { live: going, history } = splitLive(rows);
    expect(going).toEqual([]);
    expect(history).toHaveLength(3);
  });

  it('puts an archived paused run with no live entry in history', () => {
    const r = row('2026-09-01T10:00:00.000Z', null, 'paused');
    expect(splitLive([r])).toEqual({ live: [], history: [r] });
  });

  it('sorts each half on its own, so an old running run leads live while a newer finished run leads history', () => {
    const oldRunning = row('2026-09-01T10:00:00.000Z', live({ status: 'running' }));
    const newerDone = row('2026-09-04T10:00:00.000Z');
    const olderDone = row('2026-09-02T10:00:00.000Z');
    const { live: going, history } = splitLive([olderDone, oldRunning, newerDone]);
    expect(going[0]).toBe(oldRunning);
    expect(history).toEqual([newerDone, olderDone]);
  });
});

describe('groupByDay', () => {
  it('groups contiguous same-day rows in input order, keyed and labelled by dayKey/dayLabel', () => {
    const a = row(localIso(2, 15));
    const b = row(localIso(2, 9));
    const c = row(localIso(1, 20));
    const groups = groupByDay([a, b, c], ZONE);
    expect(groups).toEqual([
      { key: dayKey(a.run.startedAt, ZONE), label: dayLabel(a.run.startedAt, ZONE), rows: [a, b] },
      { key: dayKey(c.run.startedAt, ZONE), label: dayLabel(c.run.startedAt, ZONE), rows: [c] }
    ]);
    expect(groups[0].key).not.toBe(groups[1].key);
  });

  it("gives an unparseable startedAt its own 'unknown' group rather than dropping it", () => {
    const good = row(localIso(2, 15));
    const bad = row('garbage');
    const groups = groupByDay([good, bad], ZONE);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toEqual({ key: 'unknown', label: 'unknown', rows: [bad] });
  });

  it('returns no groups for no rows', () => {
    expect(groupByDay([], ZONE)).toEqual([]);
  });
});

describe('STATUS_ORDER', () => {
  it('reads in flight first, then the three endings', () => {
    expect(STATUS_ORDER).toEqual(['running', 'paused', 'done', 'aborted', 'failed']);
  });
});

describe('queueCounts', () => {
  it('counts both success exits as completed over the RAW queue length', () => {
    const stages: RunStage[] = ['merged', 'branched', 'failed', 'ungroomed', 'reviewing'];
    expect(queueCounts({ queue: stages.map((stage) => ({ stage })) })).toEqual({ completed: 2, total: 5 });
  });

  it('reads 0 of 0 for an empty queue', () => {
    expect(queueCounts({ queue: [] })).toEqual({ completed: 0, total: 0 });
  });
});

/*
 * #376: the composition RunsView strings the building blocks above into, moved out of the component so each of its ordering rules fails a test that names
 * it rather than only a render that happens to draw the right rows.
 */
describe('freshRunKey', () => {
  it('is the same string whichever order the fresh runs arrive in', () => {
    const a = live({ project: '/p/a', runId: 'r1' });
    const b = live({ project: '/p/b', runId: 'r2' });
    expect(freshRunKey([a, b])).toBe(freshRunKey([b, a]));
    expect(freshRunKey([a, b])).toBe([runKey('/p/a', 'r1'), runKey('/p/b', 'r2')].sort().join('\n'));
  });

  it('leaves a non-fresh run out', () => {
    const a = live({ project: '/p/a', runId: 'r1' });
    expect(freshRunKey([a, live({ project: '/p/b', runId: 'r2', fresh: false })])).toBe(freshRunKey([a]));
  });
});

describe('scopeRuns', () => {
  const NOW = new Date(2026, 8, 10, 15).getTime();
  const merged: MergedRun[] = [
    { run: archive({ project: '/p/a', runId: 'a-today', startedAt: new Date(2026, 8, 10, 9).toISOString() }), live: null, isLive: false, remote: false },
    { run: archive({ project: '/p/a', runId: 'a-old', startedAt: new Date(2026, 8, 2, 9).toISOString() }), live: null, isLive: false, remote: false },
    { run: archive({ project: '/p/b', runId: 'b-today', startedAt: new Date(2026, 8, 10, 10).toISOString() }), live: null, isLive: false, remote: false }
  ];
  const starting: StartingRun[] = [
    { project: '/p/a', requestedAt: new Date(2026, 8, 1).toISOString() } as StartingRun,
    { project: '/p/b', requestedAt: new Date(2026, 8, 10, 14).toISOString() } as StartingRun
  ];
  const remoteStarting: RemoteStarting[] = [
    { kind: 'orchestrate', project: '/p/a', machine: 'm1', itemId: null, requestedAt: new Date(2026, 8, 1).toISOString() },
    { kind: 'dispatch', project: '/p/a', machine: 'm1', itemId: 'bug-1', requestedAt: new Date(2026, 8, 10).toISOString() }
  ];
  const scope = scopeRuns({ merged, starting, remoteStarting, range: 'today', projectFilter: '/p/a', now: NOW, zone: ZONE });

  it('lists every project in the select, whatever the range and the filter leave', () => {
    expect(scope.projects).toEqual(['/p/a', '/p/b']);
  });

  it('drops a run of the filtered project that started outside the range', () => {
    expect(scope.filtered.map((m) => m.run.runId)).toEqual(['a-today']);
  });

  it('keeps a starting entry of the filtered project whatever the range, and drops another project’s', () => {
    expect(scope.startingRows.map((s) => s.project)).toEqual(['/p/a']);
    expect(scope.remoteStartingRows.map((e) => [e.project, e.kind])).toEqual([['/p/a', 'orchestrate']]);
  });

  it('splits Live from History after the filter', () => {
    const going = live({ project: '/p/b', runId: 'b-today', startedAt: new Date(2026, 8, 10, 10).toISOString() });
    const withLive = merged.map((m) => (m.run.project === '/p/b' ? { ...m, live: going, isLive: true } : m));
    const filteredA = scopeRuns({ merged: withLive, starting, remoteStarting, range: 'all', projectFilter: '/p/a', now: NOW, zone: ZONE });
    expect(filteredA.live).toEqual([]);
    expect(filteredA.history.map((m) => m.run.runId)).toEqual(['a-today', 'a-old']);
    const all = scopeRuns({ merged: withLive, starting, remoteStarting, range: 'all', projectFilter: 'all', now: NOW, zone: ZONE });
    expect(all.live.map((m) => m.run.runId)).toEqual(['b-today']);
    expect(all.startingRows).toHaveLength(2);
  });
});

describe('windowHistory', () => {
  it('groups only the window and counts the rest as hidden', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(localIso(1 + Math.floor(i / 5), 23 - (i % 5)))).reverse();
    const history = sortByStartedAtDesc(rows);
    const { groups, hiddenCount } = windowHistory(history, 25, ZONE);
    expect(hiddenCount).toBe(5);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(25);
    expect(groups.flatMap((g) => g.rows)).toEqual(history.slice(0, 25));
  });
});

describe('pickSelected', () => {
  const rows = [row('2026-09-03T10:00:00.000Z'), row('2026-09-02T10:00:00.000Z')];

  it('returns the row the selection names', () => {
    expect(pickSelected(rows, { project: '/p/a', runId: '2026-09-02T10:00:00.000Z' })).toBe(rows[1]);
  });

  it('falls back to the first row when the selection names nothing visible', () => {
    expect(pickSelected(rows, { project: '/p/b', runId: '2026-09-02T10:00:00.000Z' })).toBe(rows[0]);
    expect(pickSelected(rows, null)).toBe(rows[0]);
  });

  it('is undefined over an empty list', () => {
    expect(pickSelected([], { project: '/p/a', runId: 'x' })).toBeUndefined();
  });
});
