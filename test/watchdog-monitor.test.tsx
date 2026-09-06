/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { WatchdogMonitor } from '../client/src/components/runs/WatchdogMonitor';
import { projectLabel } from '../client/src/lib/project-label';
import { formatClock, formatSpanCompact } from '../client/src/lib/run-time';
import {
  watchdogClause, WATCHDOG_KIND_GLYPH, WATCHDOG_KIND_TONE
} from '../client/src/lib/run-watchdog';
import { RUN_STALE_MS } from '../shared/types';
import { DEFAULT_WATCHDOG_CONFIG, WATCHDOG_EVENT_CAP } from '../shared/types';
import type {
  OrchestratorRunsPayload, RunQueueItem, RunStage, RunWatchdog, WatchdogEvent,
  WatchdogEventKind, WatchdogStatus
} from '../shared/types';

/**
 * `WatchdogMonitor` (task-18, spec §3) driven standalone on its own two
 * props, with only `GET /api/agents/watchdog` stubbed — the component owns
 * `useWatchdog` and takes the live runs array from `RunsView` rather than
 * fetching it, so a case that hits any OTHER url is a bug in the component,
 * not in the fixture. The stub asserts that directly by rejecting anything
 * else.
 *
 * The clock is pinned with fake timers for every case, not just the two that
 * advance it: the heartbeat ages below are computed against `useNow`'s
 * reading of the real `Date.now()`, so an unpinned clock would make `4s`
 * flake to `5s` on a slow machine.
 */

const NOW = Date.parse('2026-09-05T12:00:00.000Z');

function watchdogStatus(over: Partial<WatchdogStatus> = {}): WatchdogStatus {
  return {
    phase: 'idle',
    nextTickAt: null,
    config: DEFAULT_WATCHDOG_CONFIG,
    watching: [],
    events: [],
    ...over
  };
}

/** Inert but full — the monitor reads `id` and `stage` and nothing else. */
function queueItem(id: string, stage: RunStage): RunQueueItem {
  return {
    id,
    title: `${id} title`,
    stage,
    sessionId: null,
    worktree: null,
    branch: null,
    permissionMode: null,
    fixLoops: 0,
    stageAt: {},
    verification: [],
    questions: [],
    note: null,
    assumptions: []
  };
}

type LiveRun = OrchestratorRunsPayload['runs'][number];

function liveRun(over: Partial<LiveRun> = {}): LiveRun {
  return {
    runId: 'run-1',
    project: '/abs/alpha',
    status: 'running',
    startedAt: new Date(NOW - 600_000).toISOString(),
    updatedAt: new Date(NOW - 4_000).toISOString(),
    maxItems: null,
    mergeMode: 'merge',
    mergeModeEffective: 'merge',
    mergeModeNote: null,
    questionMode: 'park',
    queue: [],
    attention: [],
    fresh: true,
    pastRuns: 0,
    pauseRequested: false,
    ...over
  };
}

const realFetch = global.fetch;

function stubFetch(watchdog: WatchdogStatus | 'reject'): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/agents/watchdog')) {
      if (watchdog === 'reject') return Promise.reject(new Error('watchdog unreachable'));
      return Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve(watchdog)
      } as unknown as Response);
    }
    return Promise.reject(new Error(`watchdog-monitor.test.tsx: unexpected fetch ${url}`));
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** Settles the mount fetch's microtask chain under fake timers without
 *  advancing any fake time — the same idiom test/watchdog-hook.test.tsx uses. */
async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

async function renderMonitor(
  watchdog: WatchdogStatus | 'reject',
  runs: LiveRun[] = [],
  onSelectRun: (project: string, runId: string) => void = jest.fn()
): Promise<jest.Mock> {
  const fetchMock = stubFetch(watchdog);
  render(<WatchdogMonitor runs={runs} onSelectRun={onSelectRun} />);
  await flush();
  return fetchMock;
}

describe('WatchdogMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  // --- 1: the GET rejects — the notice alone, nothing that looks like data --

  it('renders only the unavailable notice when the watchdog cannot be reached', async () => {
    await renderMonitor('reject');

    expect(screen.getByText(/Could not reach the watchdog — watchdog unreachable/))
      .toBeInTheDocument();
    // A monitor whose whole job is to report on the watchdog must not fall
    // back to a default that looks like a reading — no state line, no rows,
    // no feed.
    expect(screen.queryByTestId('watchdog-state-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('watchdog-rows')).not.toBeInTheDocument();
    expect(screen.queryByTestId('watchdog-events')).not.toBeInTheDocument();
  });

  // --- 2: off — the state line and the config line, and no rows section -----

  it('names the off reason and prints the config, with no rows section at all', async () => {
    await renderMonitor(watchdogStatus({ phase: 'off', reason: 'BM_AGENTS off' }), []);

    expect(screen.getByTestId('watchdog-state-line')).toHaveTextContent('off — BM_AGENTS off');

    // Computed from the same formatter the component uses, never re-typed:
    // a test that hard-codes "1m" would go green against a component that
    // stopped using `formatSpanCompact` at all.
    // task-26: the one sentence became a three-row policy tile, so the
    // pairs are asserted individually — the vocabulary survived the shape
    // change, which is the whole point of keeping the same words.
    const { tickMs, graceMs, maxAttempts } = DEFAULT_WATCHDOG_CONFIG;
    const policy = screen.getByTestId('watchdog-config-line');
    expect(policy).toHaveTextContent(new RegExp(`check every\\s*${formatSpanCompact(tickMs)}`));
    expect(policy).toHaveTextContent(new RegExp(`leave alone for\\s*${formatSpanCompact(graceMs)}`));
    expect(policy).toHaveTextContent(new RegExp(`give up after\\s*${maxAttempts}`));
    expect(screen.getByText('Configure in Settings › Orchestrator watchdog.')).toBeInTheDocument();

    // Off has no timer at all, so there is no sweep to be partway through —
    // an empty bar would read as "a sweep is imminent".
    expect(screen.queryByTestId('watchdog-sweep')).not.toBeInTheDocument();
    expect(screen.getByTestId('watchdog-phase')).toHaveTextContent('off');
    // Nothing is watched while off, and the tile says so rather than
    // printing a 0 that would look like a healthy reading.
    expect(screen.getByTestId('watchdog-watching')).toHaveTextContent('—');
    expect(screen.getByText('nothing is watched while off')).toBeInTheDocument();

    // Nothing is being watched and the state line has already said why —
    // an empty-rows line here would be a second answer to a settled question.
    expect(screen.queryByTestId('watchdog-rows')).not.toBeInTheDocument();
    expect(screen.queryByTestId('watchdog-rows-empty')).not.toBeInTheDocument();
    // The feed is not part of that argument: it is history, and it renders.
    expect(screen.getByText('nothing since the server started')).toBeInTheDocument();
  });

  // --- 3/4: the two empty states, which say different things ----------------

  it('reads "no running run" when idle with nothing in the payload', async () => {
    await renderMonitor(watchdogStatus({ phase: 'idle' }), []);
    expect(screen.getByTestId('watchdog-rows-empty')).toHaveTextContent('no running run');
    // Idle has nothing to watch, so no next tick to be partway through.
    expect(screen.queryByTestId('watchdog-sweep')).not.toBeInTheDocument();
    expect(screen.getByTestId('watchdog-phase')).toHaveTextContent('idle');
  });

  it('reads the one-tick-skew line when armed with nothing in the payload', async () => {
    await renderMonitor(watchdogStatus({ phase: 'armed', watching: [] }), []);
    expect(screen.getByTestId('watchdog-rows-empty'))
      .toHaveTextContent('nothing running in the runs payload yet');
  });

  // --- 5: one fresh, watched run -------------------------------------------

  it('renders a fresh watched run with its project tail, item, heartbeat and ok verdict', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ queue: [queueItem('bug-16', 'dispatched'), queueItem('task-13', 'pending')] })]
    );

    const rows = screen.getAllByTestId('watchdog-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('alpha');
    expect(rows[0]).toHaveTextContent('run-1');
    expect(rows[0]).toHaveTextContent('bug-16 · dispatched');
    expect(rows[0]).toHaveTextContent('heartbeat 4s ago');
    // Exactly `ok`, read off the verdict element itself: the glyph beside it
    // is a SIBLING span precisely so this element's own text stays the one
    // word every existing case matches.
    expect(within(rows[0]).getByTestId('watchdog-verdict')).toHaveTextContent(/^ok$/);
    expect(rows[0]).not.toHaveTextContent('not yet watched');
    expect(rows[0]).toHaveClass('watchdog-row-ok');

    // task-26's meter: the reading the monitor could never state before —
    // how far this heartbeat has travelled toward the stale line. Asserted
    // through `aria-*` rather than a parsed `style`, which is also what makes
    // it readable to assistive tech.
    const meter = within(rows[0]).getByTestId('watchdog-meter');
    expect(meter).toHaveAttribute('aria-valuenow', '4');
    expect(meter).toHaveAttribute('aria-valuemax', String(RUN_STALE_MS / 1000));
    expect(meter).toHaveAttribute('aria-valuetext', 'heartbeat 4s ago');
    expect(rows[0]).toHaveTextContent(`stale at ${formatSpanCompact(RUN_STALE_MS)}`);

    expect(screen.getByTestId('watchdog-watching')).toHaveTextContent('1');
    const tile = screen.getByTestId('watchdog-watching').closest('.runs-tile') as HTMLElement;
    // `0 crashed` prints muted and glyphless — the tile must not cry wolf on
    // a healthy afternoon — but it prints, so the reading is never absent.
    expect(tile).toHaveTextContent('0 crashed');
    expect(tile).toHaveTextContent('1 fresh');
    expect(tile).not.toHaveTextContent('not yet watched');
  });

  // --- 6: nothing in flight -------------------------------------------------

  it('reads "between items" when every queue entry has exited or not started', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ queue: [queueItem('bug-16', 'merged'), queueItem('task-13', 'pending')] })]
    );

    expect(screen.getByTestId('watchdog-row')).toHaveTextContent('between items');
  });

  // --- 7: crashed, annotated ------------------------------------------------

  it('prints the strip\'s own watchdog clause for a crashed run', async () => {
    const annotation: RunWatchdog = {
      enabled: true,
      attempts: 1,
      maxAttempts: 2,
      // Two minutes ago, so the 10m grace window is still open and the card
      // has a "leave alone" line to print.
      lastSpawnAt: new Date(NOW - 120_000).toISOString(),
      lastSessionId: 'sess-1',
      lastError: null,
      exhausted: false
    };
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      // 17m: past the 15m stale line, so the meter reads full rather than
      // partway.
      [liveRun({ fresh: false, updatedAt: new Date(NOW - 1_020_000).toISOString(), watchdog: annotation })]
    );

    const row = screen.getByTestId('watchdog-row');
    expect(row).toHaveClass('watchdog-row-crashed');
    expect(row).toHaveTextContent('heartbeat 17m ago');
    expect(within(row).getByTestId('watchdog-verdict')).toHaveTextContent(/^crashed$/);
    // Asserted by CALLING `watchdogClause`, never by re-typing its sentence:
    // the whole reason the monitor reads that function is that the strip and
    // this surface must not be able to disagree, and a hand-copied string
    // here would let them. The `watchdog:` prefix stays for the same reason.
    expect(within(row).getByTestId('watchdog-clause'))
      .toHaveTextContent(watchdogClause(annotation, NOW));
    expect(within(row).getByTestId('watchdog-attempts'))
      .toHaveAttribute('aria-label', 'attempt 1 of 2');
    expect(within(row).getByTestId('watchdog-grace')).toHaveTextContent('leave alone 8m more');
    expect(row).toHaveTextContent('session sess-1');
    expect(row).toHaveTextContent(`past the ${formatSpanCompact(RUN_STALE_MS)} stale line`);

    const meter = within(row).getByTestId('watchdog-meter');
    expect(meter).toHaveAttribute('aria-valuenow', '1020');
  });

  // --- 7b: the grace window has closed --------------------------------------

  it('renders no grace line once the grace window has elapsed', async () => {
    const annotation: RunWatchdog = {
      enabled: true,
      attempts: 1,
      maxAttempts: 2,
      // 12m ago under a 10m grace: the window opened and has since closed,
      // which is a different fact from "no attempt has been made".
      lastSpawnAt: new Date(NOW - 720_000).toISOString(),
      lastSessionId: 'sess-1',
      lastError: null,
      exhausted: false
    };
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ fresh: false, updatedAt: new Date(NOW - 1_020_000).toISOString(), watchdog: annotation })]
    );

    const row = screen.getByTestId('watchdog-row');
    expect(within(row).getByTestId('watchdog-clause')).toBeInTheDocument();
    expect(within(row).queryByTestId('watchdog-grace')).not.toBeInTheDocument();
  });

  // --- 8: crashed, not yet annotated ---------------------------------------

  it('reads a bare "crashed" for a run the server has not annotated yet', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ fresh: false, updatedAt: new Date(NOW - 130_000).toISOString() })]
    );

    // Exactly `crashed`, with no dangling separator behind it — the empty
    // clause `watchdogClause(undefined)` returns must not print as `crashed ·`.
    expect(screen.getByTestId('watchdog-verdict')).toHaveTextContent(/^crashed$/);
    // And nothing from the annotation half of the card, since there is no
    // annotation: three absences rather than three empty elements.
    expect(screen.queryByTestId('watchdog-clause')).not.toBeInTheDocument();
    expect(screen.queryByTestId('watchdog-attempts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('watchdog-grace')).not.toBeInTheDocument();
  });

  // --- 9: the two payloads disagree, running side --------------------------

  it('marks a running run the sweeper has not picked up yet', async () => {
    await renderMonitor(watchdogStatus({ phase: 'armed', watching: [] }), [liveRun()]);
    expect(screen.getByTestId('watchdog-row')).toHaveTextContent('· not yet watched');
  });

  // --- 10: the two payloads disagree, watching side ------------------------

  it('renders a non-clickable placeholder for a watched id with no run behind it', async () => {
    await renderMonitor(watchdogStatus({ phase: 'armed', watching: ['run-9'] }), []);

    const missing = screen.getByTestId('watchdog-row-missing');
    expect(missing).toHaveTextContent('run-9 — not in the runs payload');
    // There is no run to select, so it must not look like something to click.
    expect(missing.tagName).not.toBe('BUTTON');
    // The disagreement IS the content — an empty-rows line beside it would
    // claim there is nothing to show.
    expect(screen.queryByTestId('watchdog-rows-empty')).not.toBeInTheDocument();
  });

  // --- 11: two projects, one runId -----------------------------------------

  it('renders one row per project when two runs share a runId', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ project: '/abs/alpha' }), liveRun({ project: '/abs/beta' })]
    );

    const rows = screen.getAllByTestId('watchdog-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('alpha');
    expect(rows[1]).toHaveTextContent('beta');
    // A join on the bare `runId` would have to either drop one of these or
    // annotate only one of them; `watching` annotates both because both are
    // `running`.
    rows.forEach((row) => expect(row).not.toHaveTextContent('not yet watched'));
  });

  // --- 12: only running runs are rows --------------------------------------

  it('ignores a finished run in the payload', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'idle' }),
      [liveRun({ status: 'done', fresh: false })]
    );
    expect(screen.queryAllByTestId('watchdog-row')).toHaveLength(0);
  });

  // --- 13: the click-through -----------------------------------------------

  it('calls onSelectRun with the row\'s own project and runId', async () => {
    const onSelectRun = jest.fn();
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ queue: [queueItem('bug-16', 'dispatched')] })],
      onSelectRun
    );

    // `userEvent` installs its own timer plumbing; under fake timers it has
    // to be told, or its internal delay never resolves.
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(screen.getByTestId('watchdog-row'));

    expect(onSelectRun).toHaveBeenCalledTimes(1);
    expect(onSelectRun).toHaveBeenCalledWith('/abs/alpha', 'run-1');
  });

  // --- 14: the activity feed, moved from Settings --------------------------

  it('renders every event newest-first with its clock, project tail and detail', async () => {
    const events: WatchdogEvent[] = [
      { at: '2026-09-05T09:59:00Z', project: '/abs/alpha', runId: 'run-a', kind: 'spawned', detail: 'resumed run-a (attempt 1/2)' },
      { at: '2026-09-05T09:30:00Z', project: '/abs/beta', runId: null, kind: 'idle', detail: 'no running run — standing down' },
      { at: '2026-09-05T09:00:00Z', project: null, runId: null, kind: 'armed', detail: 'watching for crashed runs' }
    ];
    await renderMonitor(watchdogStatus({ events }), []);

    // task-26: a `<table>`, because a log IS columns — time, actor, what —
    // and the `<ul>` printed `detail` while dropping `kind` entirely.
    const rows = within(screen.getByTestId('watchdog-events')).getAllByRole('row');
    expect(rows).toHaveLength(4);

    const headers = within(rows[0]).getAllByRole('columnheader').map((c) => c.textContent);
    expect(headers).toEqual(['time', 'kind', 'project', 'run', 'what the sweeper did']);

    const cells = (row: HTMLElement): (string | null)[] =>
      within(row).getAllByRole('cell').map((c) => c.textContent);

    expect(cells(rows[1])).toEqual([
      formatClock(events[0].at), `${WATCHDOG_KIND_GLYPH.spawned}${events[0].kind}`,
      projectLabel('/abs/alpha'), 'run-a', events[0].detail
    ]);
    expect(cells(rows[2])).toEqual([
      formatClock(events[1].at), `${WATCHDOG_KIND_GLYPH.idle}${events[1].kind}`,
      projectLabel('/abs/beta'), '—', events[1].detail
    ]);
    // A sweeper-level event (arming, which is about no one run) prints an
    // em dash in both keyed cells rather than leaving them blank — a blank
    // cell reads as missing data, a dash as "not applicable".
    expect(cells(rows[3])).toEqual([
      formatClock(events[2].at), `${WATCHDOG_KIND_GLYPH.armed}${events[2].kind}`,
      '—', '—', events[2].detail
    ]);
  });

  // --- 14b: the badge is the column the feed always carried and never drew --

  it('badges each event by kind, with its glyph and tone', async () => {
    const kinds: WatchdogEventKind[] = [
      'armed', 'idle', 'spawned', 'failed', 'exhausted', 'recovered', 'disabled'
    ];
    const events: WatchdogEvent[] = kinds.map((kind, i) => ({
      at: `2026-09-05T09:0${i}:00Z`,
      project: '/abs/alpha',
      runId: 'run-a',
      kind,
      detail: `${kind} happened`
    }));
    await renderMonitor(watchdogStatus({ events }), []);

    // Asserted THROUGH the records, never against retyped strings: they are
    // `Record`s over the union precisely so an eighth kind cannot be added
    // without being classified, and a hand-copied glyph here would let this
    // suite go green against a badge nobody had toned.
    // Scoped to the table: two of the kind words (`armed`, `idle`) are also
    // the sweeper's own phase, printed one tile up.
    const table = within(screen.getByTestId('watchdog-events'));
    for (const kind of kinds) {
      const badge = table.getByText(kind).closest('.watchdog-kind') as HTMLElement;
      expect(badge).toHaveClass(`watchdog-kind-${WATCHDOG_KIND_TONE[kind]}`);
      expect(badge.querySelector('[aria-hidden="true"]')).toHaveTextContent(WATCHDOG_KIND_GLYPH[kind]);
    }
  });

  // --- 14c: an unreadable stamp is still a row ------------------------------

  it('renders an unparsable event stamp as an em-dash clock', async () => {
    const events: WatchdogEvent[] = [
      { at: 'garbage', project: null, runId: null, kind: 'armed', detail: 'watching for crashed runs' }
    ];
    await renderMonitor(watchdogStatus({ events }), []);

    const rows = within(screen.getByTestId('watchdog-events')).getAllByRole('row');
    // The line still prints: a clock nobody can read is no reason to drop
    // what the sweeper actually did.
    expect(within(rows[1]).getAllByRole('cell')[0]).toHaveTextContent('—:—');
    expect(rows[1]).toHaveTextContent('watching for crashed runs');
  });

  // --- 14d: the hint is a preamble, not a footnote --------------------------

  it('keeps the hint above the table', async () => {
    const events: WatchdogEvent[] = [
      { at: '2026-09-05T09:00:00Z', project: null, runId: null, kind: 'armed', detail: 'watching' }
    ];
    await renderMonitor(watchdogStatus({ events }), []);

    const hint = screen.getByTestId('watchdog-events-hint');
    const table = screen.getByTestId('watchdog-events');
    // Both facts the hint carries — capped, lost on restart — have to be
    // read BEFORE the list they qualify, or a short feed reads as a quiet
    // watchdog.
    expect(hint.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // --- 15: empty feed, and the two facts its hint has to carry --------------

  it('says the feed is empty and names the cap it is bounded by', async () => {
    await renderMonitor(watchdogStatus({ events: [] }), []);

    expect(screen.getByText('nothing since the server started')).toBeInTheDocument();
    // The events are the server's own memory: capped, and lost on restart.
    // A reader who does not know both will misread a short list as a quiet
    // watchdog.
    expect(screen.getByTestId('watchdog-events-hint'))
      .toHaveTextContent(String(WATCHDOG_EVENT_CAP));
    expect(screen.getByTestId('watchdog-events-hint')).toHaveTextContent(/restart/i);
    // The empty copy REPLACES the table rather than heading an empty one:
    // a header row over nothing reads as a list that failed to load.
    expect(screen.queryByRole('table')).toBeNull();
  });

  // --- 16: the heartbeat is a clock, not a screenshot -----------------------

  it('ages the heartbeat on its own, with no new payload', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [liveRun({ queue: [queueItem('bug-16', 'dispatched')] })]
    );
    expect(screen.getByTestId('watchdog-row')).toHaveTextContent('heartbeat 4s ago');
    expect(screen.getByTestId('watchdog-meter')).toHaveAttribute('aria-valuenow', '4');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });

    // The fetch stub keeps answering the identical payload, so `updatedAt`
    // has not moved — `useNow` alone is what advanced this.
    expect(screen.getByTestId('watchdog-row')).toHaveTextContent('heartbeat 9s ago');
    // The meter is the same clock in a second form; a bar that stepped only
    // on a new payload would be a screenshot beside a live sentence.
    expect(screen.getByTestId('watchdog-meter')).toHaveAttribute('aria-valuenow', '9');
  });
  // --- 17: the countdown is a clock in the state a row cannot supply --------
  //
  // Review finding (Important): the clock used to be gated on `running.length
  // > 0` alone, on the reasoning that heartbeat ages are the only reading
  // that moves. They are not — `stateLine`'s own `next check in Ns` reads the
  // same `now`, and there is a state this component deliberately RENDERS
  // where the sweeper is armed with no running run in the payload at all
  // (cases 4 and 10 above). In exactly that state the countdown froze at
  // whatever it said on mount while the real next tick came and went.
  it('counts the next tick down while armed with nothing in the payload', async () => {
    await renderMonitor(
      watchdogStatus({
        phase: 'armed',
        watching: [],
        nextTickAt: new Date(NOW + 42_000).toISOString()
      }),
      []
    );
    expect(screen.getByTestId('watchdog-state-line')).toHaveTextContent('next check in 42s');
    // `Math.round`, matching `stateLine`'s own countdown: the bar and the
    // sentence beside it must agree to the second.
    expect(screen.getByTestId('watchdog-sweep')).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByTestId('watchdog-sweep'))
      .toHaveAttribute('aria-valuemax', String(DEFAULT_WATCHDOG_CONFIG.tickMs / 1000));
    // Premise of the case, stated so a future fixture edit cannot quietly
    // turn it into case 5 with extra steps: there is no row here to have
    // enabled the clock.
    expect(screen.queryAllByTestId('watchdog-row')).toHaveLength(0);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });

    // The stub keeps answering the identical payload, so `nextTickAt` has not
    // moved — the clock is what advanced.
    expect(screen.getByTestId('watchdog-state-line')).toHaveTextContent('next check in 37s');
    expect(screen.getByTestId('watchdog-sweep')).toHaveAttribute('aria-valuenow', '37');
  });

  // --- 18: the watching tile counts what the cards below it show ------------

  it('counts crashed, fresh and unwatched runs in the watching tile', async () => {
    await renderMonitor(
      watchdogStatus({ phase: 'armed', watching: ['run-1'] }),
      [
        liveRun(),
        liveRun({ runId: 'run-2', project: '/abs/beta', fresh: false, updatedAt: new Date(NOW - 1_020_000).toISOString() }),
        liveRun({ runId: 'run-3', project: '/abs/gamma' })
      ]
    );

    const tile = screen.getByTestId('watchdog-watching').closest('.runs-tile') as HTMLElement;
    expect(screen.getByTestId('watchdog-watching')).toHaveTextContent('3');
    expect(tile).toHaveTextContent('1 crashed');
    expect(tile).toHaveTextContent('2 fresh');
    // The skew, summed: `run-2` and `run-3` are running but absent from
    // `watching`, and the tile says so once rather than leaving a reader to
    // count the `· not yet watched` chips on the cards.
    expect(tile).toHaveTextContent('2 not yet watched');
  });
});
