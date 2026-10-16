import { STATUS_ORDER, groupByDay, mergeRuns, parseStartedAt, queueCounts, runKey, sortByStartedAtDesc, splitLive } from '../client/src/lib/runs-list';
import { dayKey, dayLabel } from '../client/src/lib/run-stats';
import type { LiveRun, MergedRun } from '../client/src/lib/runs-list';
import type { OrchestratorArchiveRun, OrchestratorRun, RemoteRun, RunStage } from '../shared/types';

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
    const groups = groupByDay([a, b, c]);
    expect(groups).toEqual([
      { key: dayKey(a.run.startedAt), label: dayLabel(a.run.startedAt), rows: [a, b] },
      { key: dayKey(c.run.startedAt), label: dayLabel(c.run.startedAt), rows: [c] }
    ]);
    expect(groups[0].key).not.toBe(groups[1].key);
  });

  it("gives an unparseable startedAt its own 'unknown' group rather than dropping it", () => {
    const good = row(localIso(2, 15));
    const bad = row('garbage');
    const groups = groupByDay([good, bad]);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toEqual({ key: 'unknown', label: 'unknown', rows: [bad] });
  });

  it('returns no groups for no rows', () => {
    expect(groupByDay([])).toEqual([]);
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
