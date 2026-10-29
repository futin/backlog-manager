/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { TickMonitor } from '../client/src/components/runs/TickMonitor';
import type { TickProject, TickRecentEntry, TicksPayload } from '../shared/types';

/**
 * `TickMonitor` (tick-breaker spec, "Client") driven standalone: it owns `useTicks({ live: true })` and takes no props, so the only seam is `fetch`. The stub
 * rejects every url but the two it knows, so a request to anything else is a bug in the component, not in the fixture. The clock is pinned with fake timers
 * and every fixture time is `NOW − n`, never a literal date (the repo's jsdom-fixture rule): the 24 h figure reads the same clock the assertion runs under.
 */

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

function entry(over: Partial<TickRecentEntry> = {}): TickRecentEntry {
  return { at: ago(10 * MIN), id: 'task-1', kind: 'execute', outcome: 'ok', reason: 'merged fine', ...over };
}

function project(over: Partial<TickProject> = {}): TickProject {
  return { root: '/abs/alpha', name: 'alpha', streak: 0, halted: false, lock: null, recent: [entry()], ...over };
}

function payload(projects: TickProject[], config: Partial<TicksPayload['config']> = {}): TicksPayload {
  return { config: { haltAfter: 3, maxPlans: 3, maxPrs: 2, source: 'default', ...config }, projects };
}

/** One halted project, one quiet one with a lock and one that has never ticked — `recent` newest first, as the server sends it. */
const HALTED = project({
  root: '/abs/zeta',
  name: 'zeta',
  streak: 3,
  halted: true,
  haltedSince: ago(3 * HOUR),
  recent: [
    entry({ at: ago(1 * HOUR), id: 'bug-9', outcome: 'failed', reason: 'verify red' }),
    entry({ at: ago(2 * HOUR), id: 'bug-9', outcome: 'failed', reason: 'verify red' }),
    entry({ at: ago(3 * HOUR), id: 'bug-9', outcome: 'failed', reason: 'verify red' })
  ]
});
const QUIET = project({
  root: '/abs/beta',
  name: 'beta',
  streak: 1,
  lock: { kind: 'execute', id: 'task-4', host: 'mac', at: ago(1 * MIN) },
  recent: [entry({ at: ago(5 * MIN), id: 'task-3', outcome: 'failed', reason: 'flaky' }), entry({ at: ago(2 * HOUR), id: 'task-2', outcome: 'ok' })]
});
const NEVER = project({ root: '/abs/alpha', name: 'alpha', streak: 0, recent: [] });

const realFetch = global.fetch;

type Reply = TicksPayload | 'reject';

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
}

/** `get` answers GET /api/ticks; `post` answers each POST /api/ticks/reset in turn (a function so a case can hold one open). */
function stubFetch(get: Reply, post?: (body: { project: string }) => Promise<Response>): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/ticks/reset')) {
      if (!post) return Promise.reject(new Error('tick-monitor.test.tsx: unexpected reset'));
      return post(JSON.parse(String(init?.body)) as { project: string });
    }
    if (url.endsWith('/api/ticks')) return get === 'reject' ? Promise.reject(new Error('ticks unreachable')) : ok(get);
    return Promise.reject(new Error(`tick-monitor.test.tsx: unexpected fetch ${url}`));
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

async function renderMonitor(get: Reply, post?: (body: { project: string }) => Promise<Response>): Promise<jest.Mock> {
  const fetchMock = stubFetch(get, post);
  render(<TickMonitor />);
  await flush();
  return fetchMock;
}

const rowsOf = (): HTMLElement[] => screen.getAllByTestId('tick-row');

describe('TickMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: false });
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it('draws the halted project first, then the one that ticked last, then the one that never has', async () => {
    await renderMonitor(payload([NEVER, QUIET, HALTED]));

    expect(rowsOf().map((r) => within(r).getByTestId('tick-row-name').textContent)).toEqual(['zeta', 'beta', 'alpha']);
  });

  it('states the halted count and the projects with history in the band, and drops the halted half at zero', async () => {
    await renderMonitor(payload([HALTED, QUIET]));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Runs · Ticks');
    expect(screen.getByTestId('tick-band-sub')).toHaveTextContent('1 halted · 2 with tick history');
    expect(screen.getByTestId('tick-policy-link')).toHaveTextContent('Policy in Settings ›');
    expect(screen.getByTestId('tick-policy-link')).toHaveAttribute('title', 'Settings › Backlog tick');
  });

  it('prints no halted half in the band when nothing is halted', async () => {
    await renderMonitor(payload([QUIET, NEVER]));
    expect(screen.getByTestId('tick-band-sub').textContent).toBe('1 with tick history');
  });

  it('says what a halted row and a ticking row each mean, and draws Reset on the halted one only', async () => {
    await renderMonitor(payload([HALTED, QUIET, NEVER]));
    const [halted, quiet, never] = rowsOf();

    expect(within(halted).getByText('halted')).toBeInTheDocument();
    expect(halted).toHaveTextContent('3 failures in a row since');
    expect(halted).toHaveTextContent('last: verify red on bug-9');
    expect(within(halted).getByRole('button', { name: 'Reset' })).toBeEnabled();

    expect(within(quiet).getByText('ticking')).toBeInTheDocument();
    expect(quiet).toHaveTextContent('last tick');
    expect(quiet).toHaveTextContent('execute task-3 → failed · 1 failures in a row');
    expect(within(quiet).queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();

    // No lock, so no `ticking` pill — and nothing to say about a tick that never happened beyond that.
    expect(within(never).queryByText('ticking')).not.toBeInTheDocument();
    expect(within(never).queryByRole('button')).not.toBeInTheDocument();
  });

  it('draws an unreadable project muted, with its error and no Reset', async () => {
    const broken: TickProject = { root: '/abs/gamma', name: 'gamma', lock: null, recent: [], error: 'state.json: unexpected token' };
    await renderMonitor(payload([broken]));
    const [row] = rowsOf();

    expect(row).toHaveTextContent('state.json: unexpected token');
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(row).toHaveClass('tick-row-error');
  });

  it('draws the three figures from the payload', async () => {
    await renderMonitor(payload([HALTED, QUIET, NEVER], { haltAfter: 4, source: 'file' }));

    const breaker = screen.getByTestId('tick-figure-breaker');
    expect(breaker).toHaveTextContent('1 halted'.replace(' ', ''));
    expect(breaker).toHaveTextContent('zeta');

    // Three failed (zeta) + one failed (beta) and one ok inside 24 h, relative to the pinned clock.
    const day = screen.getByTestId('tick-figure-24h');
    expect(day).toHaveTextContent('5ticks');
    expect(day).toHaveTextContent('1 ok · 4 failed');

    const policy = screen.getByTestId('tick-figure-policy');
    expect(policy).toHaveTextContent('halt after4 failures');
    expect(policy).toHaveTextContent('history on2 projects');
    expect(policy).toHaveTextContent('a reset clears the count, not the item records');
  });

  it('says none halted, and the threshold, when nothing is halted', async () => {
    await renderMonitor(payload([QUIET], { haltAfter: 5 }));
    const breaker = screen.getByTestId('tick-figure-breaker');
    expect(breaker).toHaveTextContent('nonehalted');
    expect(breaker).toHaveTextContent('after 5 failures in a row');
  });

  it('names tick.json in the policy line when the file cannot be read, and still draws every figure', async () => {
    await renderMonitor(payload([QUIET], { source: 'unreadable', error: '/x/tick.json unreadable' }));

    expect(screen.getByTestId('tick-figure-policy')).toHaveTextContent('tick.json cannot be read — showing the default');
    expect(screen.getByTestId('tick-figure-breaker')).toBeInTheDocument();
    expect(screen.getByTestId('tick-figure-24h')).toBeInTheDocument();
  });

  it('replaces the sheets with one sentence for an empty payload and keeps the band and all three figures', async () => {
    await renderMonitor(payload([]));

    expect(screen.getByTestId('tick-empty')).toHaveTextContent('No project has ticked yet. A tick starts from a scheduled job running /backlog-tick.');
    expect(screen.queryByTestId('tick-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tick-events')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Runs · Ticks');
    expect(screen.getByTestId('tick-figure-breaker')).toHaveTextContent('nonehalted');
    expect(screen.getByTestId('tick-figure-24h')).toHaveTextContent('0ticks');
    expect(screen.getByTestId('tick-figure-policy')).toHaveTextContent('halt after3 failures');
  });

  it('draws only the band and the unreachable sheet when the GET rejects', async () => {
    await renderMonitor('reject');

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Runs · Ticks');
    expect(screen.getByTestId('tick-unreachable').textContent).toBe(
      'Could not reach the tick history — ticks unreachable. This page will fill in once the API answers GET /api/ticks again.'
    );
    expect(screen.queryByTestId('tick-figure-breaker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tick-row')).not.toBeInTheDocument();
  });

  it('lists activity newest first across projects, in the six columns, with ✓ ok and ✕ failed', async () => {
    await renderMonitor(payload([HALTED, QUIET]));

    const table = screen.getByTestId('tick-events');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['time', 'outcome', 'project', 'did', 'item', 'what happened']);

    const body = within(table).getAllByRole('row').slice(1);
    // beta 5 min, zeta 1 h, zeta 2 h, beta 2 h (ties keep project order: HALTED is listed first), zeta 3 h
    expect(body.map((r) => within(r).getAllByRole('cell')[4].textContent)).toEqual(['task-3', 'bug-9', 'bug-9', 'task-2', 'bug-9']);
    const first = within(body[0]).getAllByRole('cell');
    expect(first[1].textContent).toBe('✕ failed');
    expect(first[2].textContent).toBe('beta');
    expect(first[3].textContent).toBe('execute');
    expect(first[5].textContent).toBe('flaky');
    expect(within(body[3]).getAllByRole('cell')[1].textContent).toBe('✓ ok');
  });

  it('posts that row\'s root on Reset and redraws from the answer, so the row loses halted', async () => {
    const after = payload([project({ ...HALTED, streak: 0, halted: false, haltedSince: undefined }), QUIET]);
    const fetchMock = await renderMonitor(payload([HALTED, QUIET]), () => ok(after));

    await userEvent.setup({ advanceTimers: jest.advanceTimersByTime }).click(within(rowsOf()[0]).getByRole('button', { name: 'Reset' }));
    await flush();

    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/ticks/reset')) as [string, RequestInit];
    expect(JSON.parse(String(post[1].body))).toEqual({ project: '/abs/zeta' });
    expect(screen.queryByText('halted', { selector: '.ui-pill' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    expect(screen.getByTestId('tick-figure-breaker')).toHaveTextContent('nonehalted');
  });

  it('disables Reset while its POST is pending, and a second click sends nothing', async () => {
    let release: (r: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = await renderMonitor(payload([HALTED]), () => held);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const button = within(rowsOf()[0]).getByRole('button', { name: 'Reset' });

    await user.click(button);
    await user.click(button);
    await flush();

    expect(button).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/ticks/reset'))).toHaveLength(1);

    release({ ok: true, status: 200, json: () => Promise.resolve(payload([project({ ...HALTED, halted: false, streak: 0 })])) } as unknown as Response);
    await flush();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });

  it('shows a failed Reset\'s error under that row only, and keeps the row halted and Reset usable', async () => {
    const other = project({ root: '/abs/eta', name: 'eta', streak: 4, halted: true, haltedSince: ago(5 * HOUR), recent: [entry({ at: ago(30 * MIN), outcome: 'failed' })] });
    await renderMonitor(payload([HALTED, other]), () =>
      Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'tick.json unreadable — fix it by hand' }) } as unknown as Response)
    );
    const rows = rowsOf();
    const names = rows.map((r) => within(r).getByTestId('tick-row-name').textContent);
    const target = rows[names.indexOf('zeta')];

    await userEvent.setup({ advanceTimers: jest.advanceTimersByTime }).click(within(target).getByRole('button', { name: 'Reset' }));
    await flush();

    expect(within(target).getByRole('alert')).toHaveTextContent('tick.json unreadable — fix it by hand');
    const untouched = rows[1 - names.indexOf('zeta')];
    expect(within(untouched).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(target).getByRole('button', { name: 'Reset' })).toBeEnabled();
    expect(target).toHaveClass('tick-row-halted');
  });

  /* #367 — the caps the last `decide` recorded, the one place an `idle` tick says it is waiting on review. The clock reads through `formatClock` in the
     board's zone, so the assertion matches the shape around it rather than a zone-dependent HH:MM. */
  describe('last decide caps (#367)', () => {
    const caps = (planReview: number, maxPlans: number, openPrs: number | null): Partial<TickProject> => ({
      lastDecide: { at: ago(30 * MIN), verdict: 'idle', caps: { openPrs, maxPrs: 3, planReview, maxPlans } }
    });

    it('prints plans and PRs against their caps, and says grooming is blocked at the plan cap', async () => {
      await renderMonitor(payload([project(caps(2, 2, 1))]));
      expect(screen.getByTestId('tick-row-caps').textContent).toMatch(/^plans awaiting review 2\/2 · open PRs 1\/3 · as of \d{2}:\d{2} · grooming blocked$/);
    });

    it('says nothing about grooming under the cap, and prints ? for a PR count the tick could not take', async () => {
      await renderMonitor(payload([project(caps(1, 2, null))]));
      expect(screen.getByTestId('tick-row-caps').textContent).toMatch(/^plans awaiting review 1\/2 · open PRs \?\/3 · as of \d{2}:\d{2}$/);
    });

    it('draws no caps line before a tick has recorded them, nor on an errored row', async () => {
      await renderMonitor(payload([project(), project({ root: '/abs/err', name: 'err', error: 'state.json unreadable', ...caps(2, 2, 1) })]));
      expect(screen.queryByTestId('tick-row-caps')).toBeNull();
    });
  });
});
