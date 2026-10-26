import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runDetailModel } from '../client/src/lib/run-detail';
import type { RunDetailLive } from '../client/src/lib/run-detail';
import { mergeModeLabel } from '../client/src/lib/run-stage';
import { formatTurns, formatUsd } from '../client/src/lib/run-stats';
import { formatClock, runClockMs } from '../client/src/lib/run-time';
import type { ArchiveQueueItem, OrchestratorArchiveRun, OrchestratorRun, RunQueueItem, RunSessionUsage, RunStage } from '../shared/types';

/**
 * The zone every reading below is taken in (#241) — the global `TZ` pin (`test/helpers/global-setup.ts`), so the expected values written before the zone
 * became an argument still hold, and so a component mounted without `TimeZoneProvider` (whose default is the browser's zone) reads the same one.
 */
const ZONE = 'America/New_York';

/**
 * #271: `runDetailModel` is every header/summary reading of the Runs detail
 * sheet, derived without a render — so this suite runs under jest's default
 * `node` environment, and the absence of a jsdom docblock above is the point.
 * The render-level pins stay in `run-detail.test.tsx`, unchanged; these pin
 * each reading on its own.
 *
 * Every stamp is relative to one fixed `NOW`, passed to the model as its
 * `now` — never `Date.now()` (CLAUDE.md Conventions: a fixture date is
 * relative to the clock the assertion runs under).
 */
const NOW = Date.parse('2026-09-01T10:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const RUN_ID = 'run-20260901-090000';
const PROJECT = '/abs/proj';

function usageEntry(costUsd: number, turns: number): RunSessionUsage {
  return {
    sessionId: null,
    kind: 'execute',
    costUsd,
    turns,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    durationMs: null,
    model: null,
    endedAt: ago(MIN)
  };
}

function liveItem(id: string, stage: RunStage, over: Partial<RunQueueItem> = {}): RunQueueItem {
  return {
    id,
    title: `${id} title`,
    stage,
    sessionId: null,
    worktree: null,
    branch: null,
    pid: null,
    permissionMode: null,
    fixLoops: 0,
    stageAt: {},
    verification: [],
    questions: [],
    note: null,
    assumptions: [],
    ...over
  };
}

function archiveItem(id: string, stage: RunStage, over: Partial<ArchiveQueueItem> = {}): ArchiveQueueItem {
  const { verification, ...rest } = liveItem(id, stage);
  return { ...rest, verification: verification.map(({ cmd, ok }) => ({ cmd, ok })), ...over };
}

type RunOver = Partial<Omit<OrchestratorRun, 'queue'>>;

function run(queue: RunQueueItem[], over: RunOver = {}): OrchestratorRun {
  return {
    runId: RUN_ID,
    project: PROJECT,
    status: 'running',
    startedAt: ago(30 * MIN),
    updatedAt: ago(5_000),
    maxItems: null,
    mergeMode: 'merge',
    mergeModeEffective: 'merge',
    mergeModeNote: null,
    prTarget: null,
    prUrl: null,
    base: 'main',
    questionMode: 'park',
    attention: [],
    queue,
    ...over
  };
}

function live(queue: RunQueueItem[], over: RunOver & Partial<Pick<RunDetailLive, 'fresh' | 'pauseRequested' | 'stopRequested'>> = {}): RunDetailLive {
  return { fresh: true, pauseRequested: false, stopRequested: false, ...run(queue, over) };
}

function summary(queue: ArchiveQueueItem[], over: RunOver = {}): OrchestratorArchiveRun {
  return { ...run([], over), current: false, queue };
}

const SIX: RunStage[] = ['merged', 'merged', 'branched', 'skipped', 'pending', 'reviewing'];
const LOOPS = [1, 0, 2, 0, 0, 0];
const sixLive = (): RunQueueItem[] => SIX.map((stage, i) => liveItem(`task-${i + 1}`, stage, { fixLoops: LOOPS[i] }));
const sixArchive = (): ArchiveQueueItem[] => SIX.map((stage, i) => archiveItem(`task-${i + 1}`, stage, { fixLoops: LOOPS[i] }));

describe('runDetailModel — which tier the rows and the run come from', () => {
  it('1. a live entry wins over a fetched run', () => {
    const l = live([liveItem('a-1', 'merged', { verification: [{ cmd: 'pnpm test', ok: true, tail: 'T-live' }] })]);
    const fetched = run([liveItem('a-1', 'merged', { verification: [{ cmd: 'pnpm test', ok: true, tail: 'T-fetched' }] })]);
    const m = runDetailModel({ summary: summary([archiveItem('a-1', 'merged')]), live: l, fetchedRun: fetched }, NOW, ZONE);
    expect(m.rows[0].verify?.tail).toBe('T-live');
    expect(m.source).toBe(l);
  });

  it('2. with no live entry, the fetched run wins over the summary', () => {
    const fetched = run([liveItem('a-1', 'merged', { verification: [{ cmd: 'pnpm test', ok: true, tail: 'T-fetched' }] })]);
    const m = runDetailModel({ summary: summary([archiveItem('a-1', 'merged')]), live: null, fetchedRun: fetched }, NOW, ZONE);
    expect(m.rows[0].verify?.tail).toBe('T-fetched');
    expect(m.source).toBe(fetched);
  });

  it('3. with neither, the summary is the source and its rows carry no tail', () => {
    const s = summary([archiveItem('a-1', 'merged', { verification: [{ cmd: 'pnpm test', ok: true }] })]);
    const m = runDetailModel({ summary: s, live: null, fetchedRun: null }, NOW, ZONE);
    expect(m.rows[0].verify).toEqual({ cmd: 'pnpm test', ok: true, tail: null });
    expect(m.source).toBe(s);
  });
});

describe('runDetailModel — the chip row', () => {
  const attention = [{ id: 'task-4', kind: 'fix-exhausted' as const, detail: 'gave up' }];

  it('4. counts a fresh live run', () => {
    const l = live(sixLive(), { attention });
    const m = runDetailModel({ summary: summary(sixArchive()), live: l, fetchedRun: null }, NOW, ZONE);
    expect(m.merged).toBe(2);
    expect(m.branched).toEqual([m.rows[2]]);
    expect(m.branched[0].id).toBe('task-3');
    expect(m.skipped).toBe(1);
    expect(m.fixLoopsTotal).toBe(3);
    expect(m.attention).toHaveLength(1);
    expect(m.active).toBe(1);
    expect(m.queued).toBe(1);
    expect(m.liveFresh).toBe(true);
  });

  it('5. a stale running entry is crashed and counts nothing as current', () => {
    const updatedAt = ago(46 * MIN);
    const l = live(sixLive(), { attention, fresh: false, updatedAt });
    const m = runDetailModel({ summary: summary(sixArchive()), live: l, fetchedRun: null }, NOW, ZONE);
    expect(m.active).toBe(0);
    expect(m.queued).toBe(0);
    expect(m.liveFresh).toBe(false);
    expect(m.crashed).toBe(true);
    expect(m.lastHeartbeat).toBe(formatClock(updatedAt, ZONE));
    expect(m.statusNote).toBeNull();
  });

  it('6. an archived selection is never crashed and has nothing active', () => {
    const m = runDetailModel({ summary: summary(sixArchive(), { status: 'done' }), live: null, fetchedRun: null }, NOW, ZONE);
    expect(m.crashed).toBe(false);
    expect(m.lastHeartbeat).toBeNull();
    expect(m.active).toBe(0);
    expect(m.queued).toBe(0);
  });
});

describe('runDetailModel — the head and the facts strip', () => {
  it('7. a finished run reads wall, a finished stamp and its item count; a running one does not', () => {
    const updatedAt = ago(10 * MIN);
    const done = runDetailModel({ summary: summary(sixArchive(), { status: 'done', updatedAt }), live: null, fetchedRun: null }, NOW, ZONE);
    expect(done.finished).toBe(true);
    expect(done.finishedClock).toBe(formatClock(updatedAt, ZONE));
    expect(done.itemCount).toBe('6 items');
    expect(done.wallLabel).toBe('wall');
    expect(done.sub).toBe(`${RUN_ID} · 6 items`);

    const one = runDetailModel({ summary: summary([archiveItem('a-1', 'merged')], { status: 'done' }), live: null, fetchedRun: null }, NOW, ZONE);
    expect(one.itemCount).toBe('1 item');

    const running = runDetailModel({ summary: summary(sixArchive()), live: live(sixLive()), fetchedRun: null }, NOW, ZONE);
    expect(running.finished).toBe(false);
    expect(running.finishedClock).toBeNull();
    expect(running.itemCount).toBeNull();
    expect(running.wallLabel).toBe('elapsed');
    expect(running.sub).toBe(RUN_ID);
  });

  it('8. the status note takes the first rung that is true', () => {
    const inFlight = (): RunQueueItem[] => [liveItem('task-1', 'merged'), liveItem('task-3', 'reviewing'), liveItem('task-5', 'pending')];
    const between = (): RunQueueItem[] => [liveItem('task-1', 'merged'), liveItem('task-5', 'pending')];
    const note = (input: Parameters<typeof runDetailModel>[0]): string | null => runDetailModel(input, NOW, ZONE).statusNote;

    expect(note({ summary: summary([]), live: live(inFlight(), { pauseRequested: true }), fetchedRun: null })).toBe('pausing · finishes task-3');
    expect(note({ summary: summary([]), live: live(between(), { pauseRequested: true }), fetchedRun: null })).toBe('pausing · finishes the current item');
    expect(
      note({ summary: summary([archiveItem('task-1', 'merged'), archiveItem('task-3', 'reviewing')], { status: 'paused' }), live: null, fetchedRun: null })
    ).toBe('paused after task-3');
    expect(note({ summary: summary([archiveItem('task-1', 'merged')], { status: 'paused' }), live: null, fetchedRun: null })).toBe('paused at a boundary');
    expect(note({ summary: summary([]), live: live(inFlight()), fetchedRun: null })).toBe('heartbeat live');
  });

  it('9. the mode note appears only for a downgraded run, and the label only off merge mode', () => {
    const downgraded = runDetailModel(
      {
        summary: summary([]),
        live: live([], { mergeMode: 'merge', mergeModeEffective: 'branch', mergeModeNote: 'classifier denied the merge of task-4' }),
        fetchedRun: null
      },
      NOW, ZONE
    );
    expect(downgraded.modeNote).toBe('classifier denied the merge of task-4');
    expect(downgraded.modeLabel).toBe(mergeModeLabel('merge', 'branch'));

    const chosen = runDetailModel(
      { summary: summary([]), live: live([], { mergeMode: 'branch', mergeModeEffective: 'branch', mergeModeNote: 'left over' }), fetchedRun: null },
      NOW, ZONE
    );
    expect(chosen.modeNote).toBeNull();

    const plain = runDetailModel({ summary: summary([]), live: live([]), fetchedRun: null }, NOW, ZONE);
    expect(plain.modeLabel).toBeNull();
    expect(plain.modeNote).toBeNull();
  });

  it('10. question mode defaults to park, and decide earns the note that joins the mode note', () => {
    const absent = summary([]);
    delete (absent as Partial<OrchestratorArchiveRun>).questionMode;
    const park = runDetailModel({ summary: absent, live: null, fetchedRun: null }, NOW, ZONE);
    expect(park.questionMode).toBe('park');
    expect(park.questionNote).toBeNull();
    expect(park.noteLine).toBeNull();

    const decideNote = 'decide mode — a question nobody could answer was decided by the run, not parked';
    const decide = runDetailModel({ summary: summary([], { questionMode: 'decide' }), live: null, fetchedRun: null }, NOW, ZONE);
    expect(decide.questionMode).toBe('decide');
    expect(decide.questionNote).toBe(decideNote);

    const both = runDetailModel(
      {
        summary: summary([]),
        live: live([], { questionMode: 'decide', mergeModeEffective: 'branch', mergeModeNote: 'classifier denied the merge of task-4' }),
        fetchedRun: null
      },
      NOW, ZONE
    );
    expect(both.noteLine).toBe(`classifier denied the merge of task-4 · ${decideNote}`);
  });

  it('11. the cost line sums the queue, pluralises sessions, and is null with no usage at all', () => {
    const one = runDetailModel(
      { summary: summary([]), live: live([liveItem('a-1', 'merged', { usage: [usageEntry(1.25, 40)] }), liveItem('a-2', 'skipped')]), fetchedRun: null },
      NOW, ZONE
    );
    expect(one.usageLine).toBe([formatUsd(1.25), formatTurns(40), '1 session'].join(' · '));

    const two = runDetailModel(
      {
        summary: summary([]),
        live: live([liveItem('a-1', 'merged', { usage: [usageEntry(1, 30)] }), liveItem('a-2', 'merged', { usage: [usageEntry(0.25, 10)] })]),
        fetchedRun: null
      },
      NOW, ZONE
    );
    expect(two.usageLine).toBe([formatUsd(1.25), formatTurns(40), '2 sessions'].join(' · '));

    const none = runDetailModel({ summary: summary([]), live: live([liveItem('a-1', 'merged')]), fetchedRun: null }, NOW, ZONE);
    expect(none.runUsage).toBeNull();
    expect(none.usageLine).toBeNull();
  });

  it('12. the controls get the live entry by reference, or an honest stand-in without one', () => {
    const s = summary([archiveItem('task-1', 'merged')], { status: 'paused' });
    const stand = runDetailModel({ summary: s, live: null, fetchedRun: null }, NOW, ZONE);
    expect(stand.controlsRun).toEqual({
      status: 'paused',
      project: s.project,
      queue: stand.source.queue,
      fresh: false,
      pauseRequested: false,
      stopRequested: false
    });

    const l = live([liveItem('task-1', 'reviewing')]);
    expect(runDetailModel({ summary: s, live: l, fetchedRun: null }, NOW, ZONE).controlsRun).toBe(l);
  });

  it('13. the item clock is clamped for a run that is over, and now is not', () => {
    const m = runDetailModel({ summary: summary([], { status: 'aborted', updatedAt: ago(10 * MIN) }), live: null, fetchedRun: null }, NOW, ZONE);
    expect(m.clock).toBe(runClockMs(m.source, NOW));
    expect(m.clock).not.toBeNull();
    expect(m.clock as number).toBeLessThan(NOW);
    expect(m.runLive).toBe(false);
  });
});

describe('lib/run-detail.ts', () => {
  it('14. imports nothing from components/ and nothing from React', () => {
    const text = readFileSync(join(__dirname, '../client/src/lib/run-detail.ts'), 'utf8');
    expect(text).not.toMatch(/from '\.\.\/components/);
    expect(text).not.toMatch(/from 'react'/);
  });
});
