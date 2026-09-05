/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import SettingsView from '../client/src/components/settings/SettingsView';
import {
  ATTEMPT_LADDER, GRACE_LADDER, stateLine, TICK_LADDER
} from '../client/src/components/settings/WatchdogGroup';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { formatClock, formatSpanCompact } from '../client/src/lib/run-time';
import {
  DEFAULT_WATCHDOG_CONFIG, WATCHDOG_LIMITS
} from '../shared/types';
import type { AgentsStatus, WatchdogEvent, WatchdogStatus } from '../shared/types';

/**
 * task-7-brief.md's own table, Step 1 — `WatchdogGroup` rendered the same
 * way `test/settings-view.test.tsx` renders every other group: `SettingsView`
 * inside a real `SettingsProvider` (so `useSettings`'s localStorage path is
 * live rather than the no-op fallback it takes bare), `fetch` stubbed per
 * URL so the pre-existing `/api/agents/status` call `AgentsGroup` makes on
 * every mount and the new `/api/agents/watchdog` (+ `/config` POST) calls
 * `WatchdogGroup` makes can both be answered from one mock.
 */

const AGENTS_STATUS: AgentsStatus = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: []
};

/** A full `WatchdogStatus`, defaults everywhere a case does not care. */
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

type JsonResponse = { ok: true; status: 200; json: () => Promise<unknown> };

function jsonOk(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
}

/**
 * The one fetch stub every case below builds on. `watchdog: 'reject'`
 * reproduces case 11 — the GET itself rejecting, not a non-2xx response —
 * because that is the shape `useWatchdog`'s own suite (`test/watchdog-hook.test.tsx`,
 * case 14) already exercises for "the fetch rejects" and this group has to
 * degrade the same way. `onConfigPost` lets cases 7/8 hand back a
 * POST-specific response (the field the save actually changed) without
 * duplicating this whole routing switch per test.
 */
function stubFetch(opts: {
  watchdog: WatchdogStatus | 'reject';
  onConfigPost?: (patch: Record<string, unknown>) => WatchdogStatus;
}): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/agents/status')) {
      return jsonOk(AGENTS_STATUS);
    }

    if (url.endsWith('/api/agents/watchdog/config')) {
      const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (opts.onConfigPost) return jsonOk(opts.onConfigPost(patch));
      return jsonOk(opts.watchdog === 'reject' ? watchdogStatus() : opts.watchdog);
    }

    if (url.endsWith('/api/agents/watchdog')) {
      if (opts.watchdog === 'reject') return Promise.reject(new Error('watchdog unreachable'));
      return jsonOk(opts.watchdog);
    }

    return Promise.reject(new Error(`settings-watchdog.test.tsx: unexpected fetch ${url}`));
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function renderView(): void {
  render(
    <SettingsProvider>
      <SettingsView />
    </SettingsProvider>
  );
}

const GROUP_TITLE = 'Orchestrator watchdog · this server';

describe('WatchdogGroup', () => {
  afterEach(() => {
    // Unconditional: only the "armed" case below (#3) turns fake timers on,
    // but calling this when they are already real is a harmless no-op, and
    // forgetting it on the one case that DOES enable them would leak a fake
    // clock into whatever test file jest runs next.
    jest.useRealTimers();
  });

  // --- 1: idle, defaults — title, state row, and the "this server" hint ----

  it('renders the group titled, idle, and names the shared config file in its hint', async () => {
    stubFetch({ watchdog: watchdogStatus({ phase: 'idle' }) });
    renderView();

    // Waited on FIRST, deliberately: the group title renders on the very
    // first synchronous paint regardless of whether `useWatchdog`'s mount
    // fetch has resolved yet (both the loaded state and the `status===null`
    // fallback render it), so asserting on the title first would pass
    // before the fetch settles at all. The State row's text only exists
    // once `status` has actually landed, so waiting on IT is what actually
    // waits for the fetch.
    expect(await screen.findByText('idle — no running run')).toBeInTheDocument();
    expect(screen.getByText(GROUP_TITLE)).toBeInTheDocument();

    // The hint is read as running text — same pattern
    // test/settings-view.test.tsx already relies on for AgentsStatusLines'
    // mixed-child `.set-hint` (regex search across one element's full text
    // content, not a search for a single leaf node).
    expect(screen.getByText(/~\/\.backlog-manager\/settings\/watchdog\.json/)).toBeInTheDocument();
    expect(screen.getByText(/every device/i)).toBeInTheDocument();
  });

  // --- 2: off, controls not gated on phase -----------------------------------

  it('shows the off reason but still renders every control', async () => {
    stubFetch({
      watchdog: watchdogStatus({ phase: 'off', reason: 'BM_AGENTS off', nextTickAt: null })
    });
    renderView();

    expect(await screen.findByText('off — BM_AGENTS off')).toBeInTheDocument();
    expect(screen.getByLabelText('Enabled')).toBeInTheDocument();
    expect(screen.getByLabelText('Check every')).toBeInTheDocument();
    expect(screen.getByLabelText('Leave a resumed run alone for')).toBeInTheDocument();
    expect(screen.getByLabelText('Give up after')).toBeInTheDocument();
  });

  // --- 3: armed, watching + next-tick countdown + resume-disabled suffix ----

  it('reads watching run ids, the next-tick countdown, and the resume-disabled suffix', async () => {
    const now = new Date('2026-09-05T12:00:00.000Z').getTime();
    jest.useFakeTimers();
    jest.setSystemTime(now);

    stubFetch({
      watchdog: watchdogStatus({
        phase: 'armed',
        nextTickAt: new Date(now + 42_000).toISOString(),
        watching: ['run-a'],
        config: { ...DEFAULT_WATCHDOG_CONFIG, enabled: false }
      })
    });
    renderView();

    // Flushes the mount-time fetch's microtask chain under fake timers —
    // the identical idiom test/watchdog-hook.test.tsx's own `flush` uses,
    // inlined here since this is the only case in this file that needs it.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('armed — watching run-a, next check in 42s · resume disabled'))
      .toBeInTheDocument();
  });

  // Also exercises `stateLine` directly, pure, at the exact boundary the
  // rendered case above only samples once — this is what actually pins the
  // rounding and the suffix placement independent of React's render timing.
  it('stateLine: idle/armed suffix and armed countdown, as a pure function', () => {
    const now = Date.parse('2026-09-05T12:00:00.000Z');

    expect(stateLine(watchdogStatus({ phase: 'idle' }), now)).toBe('idle — no running run');
    expect(stateLine(
      watchdogStatus({ phase: 'idle', config: { ...DEFAULT_WATCHDOG_CONFIG, enabled: false } }),
      now
    )).toBe('idle — no running run · resume disabled');

    expect(stateLine(watchdogStatus({
      phase: 'off', reason: 'BM_WATCHDOG off'
    }), now)).toBe('off — BM_WATCHDOG off');

    expect(stateLine(watchdogStatus({
      phase: 'armed',
      watching: ['run-a', 'run-b'],
      nextTickAt: new Date(now + 42_000).toISOString(),
      config: { ...DEFAULT_WATCHDOG_CONFIG, enabled: false }
    }), now)).toBe('armed — watching run-a, run-b, next check in 42s · resume disabled');
  });

  // --- 4: every ladder value is inside its WATCHDOG_LIMITS clamp range ------

  it('keeps every ladder option inside its WATCHDOG_LIMITS floor/ceiling', () => {
    for (const v of TICK_LADDER) {
      expect(v).toBeGreaterThanOrEqual(WATCHDOG_LIMITS.tickMs.min);
      expect(v).toBeLessThanOrEqual(WATCHDOG_LIMITS.tickMs.max);
    }
    for (const v of GRACE_LADDER) {
      expect(v).toBeGreaterThanOrEqual(WATCHDOG_LIMITS.graceMs.min);
      expect(v).toBeLessThanOrEqual(WATCHDOG_LIMITS.graceMs.max);
    }
    for (const v of ATTEMPT_LADDER) {
      expect(v).toBeGreaterThanOrEqual(WATCHDOG_LIMITS.maxAttempts.min);
      expect(v).toBeLessThanOrEqual(WATCHDOG_LIMITS.maxAttempts.max);
    }
  });

  // RULING R8: the top grace option (3_600_000) is labelled by
  // `formatSpanCompact` exactly like every other option — it is NOT
  // hand-written as "60m". `formatSpanCompact` delegates to `formatSpan` at
  // or above one hour, and `formatSpan(3_600_000)` reads "1h 00m" (1 hour,
  // 0 minutes formatted to two digits), not "60m". Pinned here as its own
  // assertion so a future edit to either formatter's boundary is caught
  // here rather than only failing case 5/6's render assertions below.
  it('labels the top grace option "1h 00m", not "60m"', () => {
    expect(formatSpanCompact(3_600_000)).toBe('1h 00m');
    expect(GRACE_LADDER[GRACE_LADDER.length - 1]).toBe(3_600_000);
  });

  // --- 5: defaults render as 1m / 10m / 2 ------------------------------------

  it('shows the default tick/grace/attempts values through formatSpanCompact and a bare count', async () => {
    stubFetch({ watchdog: watchdogStatus({ phase: 'idle' }) });
    renderView();

    const tick = await screen.findByLabelText('Check every') as HTMLSelectElement;
    const grace = screen.getByLabelText('Leave a resumed run alone for') as HTMLSelectElement;
    const attempts = screen.getByLabelText('Give up after') as HTMLSelectElement;

    expect(tick.options[tick.selectedIndex].textContent).toBe('1m');
    expect(grace.options[grace.selectedIndex].textContent).toBe('10m');
    expect(attempts.options[attempts.selectedIndex].textContent).toBe('2');
  });

  // --- 6: an off-ladder value still renders as its own selected option ------

  it('shows an off-ladder tickMs as an extra selected option, never snapped to a neighbour', async () => {
    stubFetch({
      watchdog: watchdogStatus({ config: { ...DEFAULT_WATCHDOG_CONFIG, tickMs: 45_000 } })
    });
    renderView();

    const tick = await screen.findByLabelText('Check every') as HTMLSelectElement;
    expect(tick.options[tick.selectedIndex].textContent).toBe('45s');
    expect(tick.value).toBe('45000');
  });

  // --- 7: Give up after -> exactly one POST, redraw from the response ------

  it('posts exactly {maxAttempts} on a change and redraws the select from the response', async () => {
    const responded = watchdogStatus({
      config: { ...DEFAULT_WATCHDOG_CONFIG, maxAttempts: 3 }
    });
    const fetchMock = stubFetch({
      watchdog: watchdogStatus({ phase: 'idle' }),
      onConfigPost: () => responded
    });
    renderView();

    const attempts = await screen.findByLabelText('Give up after') as HTMLSelectElement;
    await userEvent.selectOptions(attempts, '3');

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/agents/watchdog/config'));
      expect(posts).toHaveLength(1);
    });
    const [, init] = fetchMock.mock.calls.find(
      ([u]) => String(u).endsWith('/api/agents/watchdog/config')
    ) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ maxAttempts: 3 });

    await waitFor(() => {
      expect((screen.getByLabelText('Give up after') as HTMLSelectElement).value).toBe('3');
    });
  });

  // --- 8: Enabled checkbox -> exactly one POST {enabled:false} --------------

  it('posts exactly {enabled:false} when the Enabled checkbox is unticked', async () => {
    const responded = watchdogStatus({
      config: { ...DEFAULT_WATCHDOG_CONFIG, enabled: false }
    });
    const fetchMock = stubFetch({
      watchdog: watchdogStatus({ phase: 'idle' }),
      onConfigPost: () => responded
    });
    renderView();

    const checkbox = await screen.findByLabelText('Enabled') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await userEvent.click(checkbox);

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/agents/watchdog/config'));
      expect(posts).toHaveLength(1);
    });
    const [, init] = fetchMock.mock.calls.find(
      ([u]) => String(u).endsWith('/api/agents/watchdog/config')
    ) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  // --- 9: Activity — three rows, newest-first order preserved --------------

  it('renders three Activity rows in order, each with a clock, project basename and detail', async () => {
    const events: WatchdogEvent[] = [
      { at: '2026-09-05T09:59:00Z', project: '/abs/alpha', runId: 'run-a', kind: 'spawned', detail: 'resumed run-a (attempt 1/2)' },
      { at: '2026-09-05T09:30:00Z', project: '/abs/beta', runId: null, kind: 'idle', detail: 'no running run — standing down' },
      { at: '2026-09-05T09:00:00Z', project: '/abs/gamma', runId: null, kind: 'armed', detail: 'watching for crashed runs' }
    ];
    stubFetch({ watchdog: watchdogStatus({ events }) });
    renderView();

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(3);

    const expectations: [string, string][] = [
      [formatClock(events[0].at) ?? '', 'alpha'],
      [formatClock(events[1].at) ?? '', 'beta'],
      [formatClock(events[2].at) ?? '', 'gamma']
    ];
    rows.forEach((row, i) => {
      expect(row).toHaveTextContent(expectations[i][0]);
      expect(row).toHaveTextContent(expectations[i][1]);
      expect(row).toHaveTextContent(events[i].detail);
    });
  });

  // --- 10: empty Activity ------------------------------------------------------

  it('shows the empty-history line when there are no events', async () => {
    stubFetch({ watchdog: watchdogStatus({ events: [] }) });
    renderView();

    expect(await screen.findByText('nothing since the server started')).toBeInTheDocument();
  });

  // --- 11: the GET rejects — a one-line notice, no thrown error --------------

  it('shows a one-line unavailable notice and renders no controls when the GET rejects', async () => {
    stubFetch({ watchdog: 'reject' });

    // The render call itself must not throw — this is the assertion that
    // matters most: a component that only handles the happy path would
    // throw inside `useWatchdog`'s effect chain or on a null-config
    // dereference the very first time the API is unreachable.
    expect(() => renderView()).not.toThrow();

    // A specific substring, not a bare /watchdog/i — the group TITLE also
    // contains the word "watchdog" and renders unconditionally, so a loose
    // regex matches two elements and the query itself throws.
    expect(await screen.findByText(/Could not reach the watchdog/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Check every')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Leave a resumed run alone for')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Give up after')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Enabled')).not.toBeInTheDocument();
  });
});
