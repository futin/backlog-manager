/**
 * @jest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { DashboardsPage } from '../client/src/components/settings/DashboardsPage';
import { resetClockText } from '../client/src/lib/dashboards';
import { MODELS } from '../shared/agent';
import type { AgentsStatus, DashboardsView, MachinesStatus, MachineStatus, MachineUsage } from '../shared/types';

/**
 * The zone every reading below is taken in (#241) — the global `TZ` pin (`test/helpers/global-setup.ts`), so the expected values written before the zone
 * became an argument still hold, and so a component mounted without `TimeZoneProvider` (whose default is the browser's zone) reads the same one.
 */
const ZONE = 'America/New_York';

/**
 * Settings › Dashboards (spec 2026-10-23): the page body under the band — the Suggest card, the machine list, the selected machine's detail and the footer.
 * Rendered bare: which page and which rail entry is `settings-view.test.tsx`'s. A stub answers `GET /api/dashboards` with `view`, `GET
 * /api/dashboards/machines` with `machines` (health and usage per machine), `GET /api/agents/status` with `agents`, and every POST with whatever the case
 * hands it, defaulting to the unchanged view. Every case of the old card's suite (multi-dashboard task 11) survives, moved to where the page draws it.
 */

// A secret the stub puts on the wire beside the fields the real payload has, to prove the page draws named fields and never an entry wholesale. The real
// server never sends one (`dashboards-routes.test.ts`); this is the page's own half of that promise.
const SECRET = 'tok-do-not-render-9f3a';

const HOME: DashboardsView['home'] = {
  label: 'Home',
  url: 'http://127.0.0.1:4310',
  account: null,
  models: ['opus', 'sonnet', 'haiku', 'fable'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  tokenVar: 'BM_AGENTS_TOKEN',
  tokenSet: true
};

const PRO: DashboardsView['dashboards'][number] = {
  name: 'Pro',
  url: 'http://pro.local:4310',
  bmUrl: 'http://pro.local:4322',
  host: 'pro-mac',
  account: 'Pro plan',
  models: ['sonnet', 'haiku'],
  efforts: ['low', 'medium'],
  tokenVar: 'BM_AGENTS_TOKEN_PRO',
  tokenSet: false
};

const MAX: DashboardsView['dashboards'][number] = {
  name: 'Max',
  url: 'http://max.local:4310',
  bmUrl: 'http://max.local:4322',
  host: 'max-mac',
  models: ['opus', 'sonnet', 'haiku', 'fable'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  tokenVar: 'BM_AGENTS_TOKEN_MAX',
  tokenSet: true
};

function viewOf(over: Partial<DashboardsView> = {}): DashboardsView {
  return {
    source: 'file',
    file: '/home/me/.backlog-manager/settings/dashboards.json',
    home: HOME,
    dashboards: [PRO, MAX],
    order: ['home', 'Pro', 'Max'],
    strategy: 'prefer',
    threshold: 80,
    ...over
  };
}

function usageOf(five: number, week: number, resets: { five?: string | null; week?: string | null } = {}): MachineUsage {
  return {
    fiveHour: { pct: five, resetsAt: resets.five ?? null },
    week: { pct: week, resetsAt: resets.week ?? null },
    projection: 'safe',
    exhaustAt: null,
    fetchedAt: '2026-10-24T10:00:00.000Z'
  };
}

function machineOf(machine: string, over: Partial<MachineStatus> = {}): MachineStatus {
  return {
    machine,
    enabled: true,
    reachable: true,
    remoteAnswer: true,
    spawnAvailable: true,
    spawnMaxPermission: 'auto',
    usage: null,
    usageAgeMs: null,
    ...over
  };
}

/**
 * Home and Pro healthy with distinct usage on each window, Max unreachable — the brief's default. Pro's ceiling differs from Home's so a line cannot pass
 * by reading the wrong one.
 */
const MACHINES: MachinesStatus = {
  machines: [
    machineOf('home', { usage: usageOf(12, 30), usageAgeMs: 4_000 }),
    machineOf('Pro', { spawnMaxPermission: 'acceptEdits', usage: usageOf(64, 81), usageAgeMs: 9_000 }),
    machineOf('Max', { reachable: false, error: 'connect ECONNREFUSED max.local', usage: null, usageAgeMs: null })
  ]
};

function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
}

type Answer = { status: number; body: unknown };

const HEALTHY: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: ['/a', '/b', '/c']
};

/**
 * `get` answers the read (`'reject'` for a failed one); `post` answers a write by route name and parsed body, defaulting to the same view; `machines`
 * answers the health/usage read (`'pending'` for one that never answers); `agents` answers Home's dispatch report.
 */
function stubFetch(
  opts: {
    get?: DashboardsView | 'reject';
    post?: (route: string, body: Record<string, unknown>) => Answer | undefined;
    agents?: AgentsStatus;
    machines?: MachinesStatus | 'pending';
  } = {}
): jest.Mock {
  const get = opts.get ?? viewOf();
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // The Home detail's dispatch line (`useAgents`), answered healthy unless a case says otherwise.
    if (url.endsWith('/api/agents/status')) return respond(200, opts.agents ?? HEALTHY);
    if (url.endsWith('/api/dashboards/machines')) {
      const machines = opts.machines ?? MACHINES;
      return machines === 'pending' ? new Promise<Response>(() => {}) : respond(200, machines);
    }
    const route = url.replace(/^.*\/api\/dashboards\/?/, '');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      const answer = opts.post?.(route, body) ?? { status: 200, body: get === 'reject' ? viewOf() : get };
      return respond(answer.status, answer.body);
    }
    if (get === 'reject') return Promise.reject(new Error('dashboards unreachable'));
    return respond(200, { ...get, dashboards: get.dashboards.map((d) => ({ ...d, token: SECRET })), home: { ...get.home, token: SECRET } });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const posts = (fn: jest.Mock) =>
  fn.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({
      route: String(url).replace(/^.*\/api\/dashboards\//, ''),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
    }));

const machineReads = (fn: jest.Mock) => fn.mock.calls.filter(([url]) => String(url).endsWith('/api/dashboards/machines')).length;

const listRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.dash-page-row')];

/** The machine names down the list, top to bottom. */
const names = () => listRows().map((r) => r.querySelector('.dash-page-name')?.textContent);

/** The list row whose name is `name`, so a case reads its pills and meters without matching another machine's. */
function rowOf(name: string): HTMLElement {
  const row = listRows().find((r) => r.querySelector('.dash-page-name')?.textContent === name);
  if (!row) throw new Error(`no machine row named ${name}`);
  return row;
}

function detail(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.dash-page-detail');
  if (!el) throw new Error('no detail drawn');
  return el;
}

const detailName = () => detail().querySelector('.dash-page-name')?.textContent;

/** The value cell of the detail's fact (or list) whose label is `label`. */
function factOf(label: string): HTMLElement {
  const dt = [...detail().querySelectorAll('dt')].find((el) => el.textContent === label);
  if (!dt) throw new Error(`no fact labelled ${label}`);
  return dt.nextElementSibling as HTMLElement;
}

const toneOf = (el: HTMLElement): string | null => {
  const dot = el.querySelector('.ui-dot');
  if (!dot) throw new Error('no dot');
  return [...dot.classList].find((c) => /^ui-dot-(live|paused|crashed)$/.test(c)) ?? null;
};

/** A meter's label and value, as `5 H 64%`. */
const metersOf = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.ui-meter')].map((m) => `${m.querySelector('.ui-meter-label')?.textContent} ${m.querySelector('.ui-meter-value')?.textContent}`);

async function select(name: string) {
  await userEvent.click(rowOf(name));
}

async function renderPage() {
  render(<DashboardsPage />);
  await screen.findByText('Prefer order');
}

/** The page once the machines read has landed too — Pro's 5 h figure is drawn on its row only then. */
async function renderSettled() {
  await renderPage();
  await waitFor(() => expect(metersOf(rowOf('Pro'))).toEqual(['5 H 64%', 'WEEK 81%']));
}

describe('DashboardsPage', () => {
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  describe('this machine’s dispatch report in Home’s detail (was the Claude Agents card)', () => {
    it('draws the dispatch line in Home’s detail and no setup steps while healthy', async () => {
      stubFetch();
      await renderPage();
      expect(detailName()).toBe('Home');
      expect(await within(detail()).findByText(/dispatch.*connected · spawn on · ceiling: auto · 3 projects/)).toBeInTheDocument();
      expect(screen.queryByText('Setting it up')).toBeNull();
    });
    it('opens the setup steps in Home’s detail when dispatch is off', async () => {
      stubFetch({ agents: { ...HEALTHY, enabled: false, reachable: false } });
      await renderPage();
      expect(await within(detail()).findByText(/off — dispatch is not enabled on the API/)).toBeInTheDocument();
      expect(within(detail()).getByText('Setting it up')).toBeInTheDocument();
      expect(screen.getByText(/BM_AGENTS=on/)).toBeInTheDocument();
    });
    // The three dot tones the old card's dispatch row drew (`dispatchDotTone`), now on Home's detail head — the same dot the list row reads.
    it('draws an unreachable dashboard as a crashed dot', async () => {
      stubFetch({ agents: { ...HEALTHY, reachable: false, remoteAnswer: false, spawnAvailable: false, spawnMaxPermission: null, projectPaths: [], error: 'ECONNREFUSED' } });
      await renderPage();
      expect(await within(detail()).findByText(/unreachable/)).toBeInTheDocument();
      expect(toneOf(detail())).toBe('ui-dot-crashed');
    });
    it('draws a reachable dashboard with no CLAUDE_BIN as a paused dot and shows the setup steps', async () => {
      // The case the old three-colour dot drew green: every launch to this dashboard is a 404, and nothing on the row said so.
      stubFetch({ agents: { ...HEALTHY, spawnAvailable: false, projectPaths: ['/a'] } });
      await renderPage();
      expect(await within(detail()).findByText(/no CLAUDE_BIN/)).toBeInTheDocument();
      expect(toneOf(detail())).toBe('ui-dot-paused');
      expect(screen.getByText(/BM_AGENTS=on/)).toBeInTheDocument();
    });
    it('draws a healthy dashboard as a live dot, with the project count and the ceiling', async () => {
      stubFetch({ agents: { ...HEALTHY, projectPaths: ['/a', '/b'] } });
      await renderPage();
      expect(await within(detail()).findByText(/connected/)).toBeInTheDocument();
      expect(within(detail()).getByText(/ceiling: auto/)).toBeInTheDocument();
      expect(within(detail()).getByText(/2 projects/)).toBeInTheDocument();
      expect(toneOf(detail())).toBe('ui-dot-live');
      expect(screen.queryByText(/BM_AGENTS=on/)).not.toBeInTheDocument();
    });
    it('still reports dispatch while GET /api/dashboards fails', async () => {
      stubFetch({ get: 'reject' });
      render(<DashboardsPage />);
      expect(await screen.findByText(/connected · spawn on/)).toBeInTheDocument();
      expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    });
  });

  describe('the machines', () => {
    it('titles the Suggest card with its hint and lists every machine in the view’s order', async () => {
      stubFetch();
      await renderPage();
      expect(document.querySelector('.ui-sheet-title')).toHaveTextContent('Suggest');
      expect(document.querySelector('.ui-sheet-sub')).toHaveTextContent('Which machine a launch sheet starts on. You can still pick another there.');
      expect(names()).toEqual(['Home', 'Pro', 'Max']);
    });

    it('draws home read-only from env: BM_AGENTS_URL’s value, the token as set, and the models', async () => {
      stubFetch();
      await renderPage();
      expect(within(factOf('Dashboard')).getByText('BM_AGENTS_URL')).toBeInTheDocument();
      expect(factOf('Dashboard')).toHaveTextContent('http://127.0.0.1:4310');
      expect(factOf('Token')).toHaveTextContent(/^BM_AGENTS_TOKEN ✓ set$/);
      const on = (label: string) => [...factOf(label).querySelectorAll('.ui-pill:not(.ui-pill-off)')].map((p) => p.textContent);
      expect(on('Models')).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
      expect(on('Efforts')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      // Read-only: no field in the detail holds the URL, home has no Board or Machine name fact, and there is no Remove for home.
      expect(within(detail()).queryByRole('textbox')).toBeNull();
      expect([...detail().querySelectorAll('dt')].map((d) => d.textContent)).not.toContain('Board');
      expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    });

    it('draws a remote’s URLs, machine name, account and lists, and says an unset token is not set and when it is needed', async () => {
      stubFetch();
      await renderPage();
      await select('Pro');
      expect(factOf('Dashboard')).toHaveTextContent(/^http:\/\/pro\.local:4310$/);
      expect(factOf('Board')).toHaveTextContent(/^http:\/\/pro\.local:4322$/);
      expect(factOf('Machine name')).toHaveTextContent(/^pro-mac$/);
      expect(within(rowOf('Pro')).getByText('Pro plan')).toHaveClass('ui-pill');
      expect(within(detail()).getByText('Pro plan')).toHaveClass('ui-pill');
      expect([...factOf('Models').querySelectorAll('.ui-pill:not(.ui-pill-off)')].map((p) => p.textContent)).toEqual(['sonnet', 'haiku']);
      expect(factOf('Token')).toHaveTextContent(
        /^BM_AGENTS_TOKEN_PRO not set — needed only if that dashboard does not trust this machine; then add it to \.env and restart$/
      );
      await select('Max');
      expect(factOf('Token')).toHaveTextContent(/^BM_AGENTS_TOKEN_MAX ✓ set$/);
      // A machine with no account says so, muted, rather than drawing an empty pill.
      expect(within(rowOf('Max')).getByText('no account set')).not.toHaveClass('ui-pill');
    });

    it('never renders a token value, whatever else the payload carries', async () => {
      stubFetch();
      await renderSettled();
      await select('Pro');
      await userEvent.click(screen.getByRole('button', { name: 'Edit Pro' }));
      expect(document.body.innerHTML).not.toContain(SECRET);
      // Nor the value of any input — a form field holding a token would not show in `innerHTML`.
      for (const input of document.querySelectorAll('input')) expect((input as HTMLInputElement).value).not.toContain(SECRET);
    });

    it('shows no machines and an unavailable line when the first read fails', async () => {
      stubFetch({ get: 'reject' });
      render(<DashboardsPage />);
      expect(await screen.findByText('Unavailable')).toBeInTheDocument();
      expect(screen.getByText(/dashboards unreachable/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add dashboard' })).toBeNull();
      expect(listRows()).toHaveLength(0);
    });

    it('says the page, not the card, will fill in once the read answers again', async () => {
      stubFetch({ get: 'reject' });
      render(<DashboardsPage />);
      expect(
        await screen.findByText(
          'Could not read the dashboards — dashboards unreachable. This page will fill in once the API answers GET /api/dashboards again.'
        )
      ).toBeInTheDocument();
    });
  });

  describe('the list and the selection', () => {
    it('draws one row per machine in machineIds order, numbered from 1', async () => {
      const TEAM = { ...MAX, name: 'Team', host: 'team-mac', tokenVar: 'BM_AGENTS_TOKEN_TEAM' };
      // Max placed before home, and Team absent from the order — drawn last rather than hidden.
      stubFetch({ get: viewOf({ dashboards: [PRO, MAX, TEAM], order: ['Max', 'home', 'Pro'] }) });
      await renderPage();
      expect(names()).toEqual(['Max', 'Home', 'Pro', 'Team']);
      expect(listRows().map((r) => r.querySelector('.dash-page-order')?.textContent)).toEqual(['1', '2', '3', '4']);
      expect(within(rowOf('Home')).getByText('this machine')).toHaveClass('ui-pill');
      expect(within(rowOf('Max')).queryByText('this machine')).toBeNull();
    });

    it('selects the first machine on load, and a click selects another and draws its facts', async () => {
      stubFetch();
      await renderPage();
      expect(rowOf('Home')).toHaveAttribute('aria-pressed', 'true');
      expect(rowOf('Pro')).toHaveAttribute('aria-pressed', 'false');
      expect(detailName()).toBe('Home');
      await select('Pro');
      expect(rowOf('Pro')).toHaveAttribute('aria-pressed', 'true');
      expect(rowOf('Home')).toHaveAttribute('aria-pressed', 'false');
      expect(detailName()).toBe('Pro');
      expect(factOf('Board')).toHaveTextContent('http://pro.local:4322');
      expect(factOf('Machine name')).toHaveTextContent('pro-mac');
      await select('Max');
      expect(factOf('Board')).toHaveTextContent('http://max.local:4322');
      expect(factOf('Machine name')).toHaveTextContent('max-mac');
    });

    it('draws each machine’s own usage on its row, and none on a machine without a figure', async () => {
      stubFetch();
      await renderSettled();
      expect(metersOf(rowOf('Home'))).toEqual(['5 H 12%', 'WEEK 30%']);
      expect(metersOf(rowOf('Pro'))).toEqual(['5 H 64%', 'WEEK 81%']);
      expect(metersOf(rowOf('Max'))).toEqual([]);
      // Home's detail draws its own two windows full width, lower-case.
      expect(metersOf(detail())).toEqual(['5 h 12%', 'week 30%']);
      await select('Pro');
      expect(metersOf(detail())).toEqual(['5 h 64%', 'week 81%']);
    });

    it('draws an unreachable machine red, with the error in the server’s words and no usage', async () => {
      stubFetch();
      await renderSettled();
      expect(toneOf(rowOf('Max'))).toBe('ui-dot-crashed');
      await select('Max');
      expect(toneOf(detail())).toBe('ui-dot-crashed');
      expect(within(detail()).getByText(/unreachable — connect ECONNREFUSED max\.local/)).toBeInTheDocument();
      expect(within(detail()).getByText('unreachable', { selector: '.dash-page-usage *' })).toBeInTheDocument();
      expect(metersOf(detail())).toEqual([]);
    });

    it('draws a remote that cannot take a launch amber and names why, and a healthy one green', async () => {
      stubFetch({
        machines: {
          machines: [
            machineOf('home', { usage: usageOf(12, 30) }),
            machineOf('Pro', { remoteAnswer: false, spawnMaxPermission: 'acceptEdits' }),
            machineOf('Max', { spawnAvailable: false, spawnMaxPermission: null })
          ]
        }
      });
      await renderPage();
      await waitFor(() => expect(toneOf(rowOf('Pro'))).toBe('ui-dot-paused'));
      expect(toneOf(rowOf('Home'))).toBe('ui-dot-live');
      expect(toneOf(rowOf('Max'))).toBe('ui-dot-paused');
      await select('Pro');
      expect(within(detail()).getByText(/connected — remote answers off · ceiling: acceptEdits/)).toBeInTheDocument();
      await select('Max');
      expect(within(detail()).getByText(/connected — no CLAUDE_BIN · ceiling: unknown/)).toBeInTheDocument();
      // A remote's line never counts projects — the machines read does not carry them.
      expect(detail().textContent).not.toMatch(/projects/);
    });

    it('draws a healthy remote’s line as spawn on with its own ceiling', async () => {
      stubFetch();
      await renderSettled();
      expect(toneOf(rowOf('Pro'))).toBe('ui-dot-live');
      await select('Pro');
      expect(within(detail()).getByText(/connected · spawn on · ceiling: acceptEdits/)).toBeInTheDocument();
    });

    it('reads Home’s dot from useAgents, not from the machines answer', async () => {
      stubFetch({ machines: { machines: [machineOf('home', { reachable: false, error: 'nope' }), machineOf('Pro'), machineOf('Max')] } });
      await renderPage();
      await waitFor(() => expect(toneOf(rowOf('Pro'))).toBe('ui-dot-live'));
      expect(toneOf(rowOf('Home'))).toBe('ui-dot-live');
    });

    it('draws every model and effort as a pill, the ones a machine may not run off', async () => {
      stubFetch({ get: viewOf({ dashboards: [{ ...PRO, models: ['opus'] }, MAX] }) });
      await renderPage();
      await select('Pro');
      const pills = [...factOf('Models').querySelectorAll('.ui-pill')];
      expect(pills.map((p) => p.textContent)).toEqual([...MODELS]);
      for (const p of pills) {
        if (p.textContent === 'opus') {
          expect(p).not.toHaveClass('ui-pill-off');
          expect(p).not.toHaveAttribute('title');
        } else {
          expect(p).toHaveClass('ui-pill-off');
          expect(p).toHaveAttribute('title', 'not run on Pro');
        }
      }
      expect([...factOf('Efforts').querySelectorAll('.ui-pill-off')].map((p) => p.textContent)).toEqual(['high', 'xhigh', 'max']);
    });

    it('draws an empty list as every member allowed', async () => {
      stubFetch({ get: viewOf({ dashboards: [{ ...PRO, models: [], efforts: [] }, MAX] }) });
      await renderPage();
      await select('Pro');
      expect(detail().querySelectorAll('.ui-pill-off')).toHaveLength(0);
    });

    it('puts each window’s reset under it as a local clock time', async () => {
      // Local noon, so two hours on is the same local day under every TZ the suite might run in.
      const now = new Date(2026, 9, 24, 12, 0, 0).getTime();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const five = new Date(now + 2 * 3_600_000).toISOString();
      const week = new Date(now + 3 * 86_400_000 + 5 * 60_000).toISOString();
      stubFetch({
        machines: { machines: [machineOf('home'), machineOf('Pro', { usage: usageOf(64, 81, { five, week }), usageAgeMs: 9_000 }), machineOf('Max')] }
      });
      await renderPage();
      await select('Pro');
      const fiveText = resetClockText(five, now, ZONE) as string;
      const weekText = resetClockText(week, now, ZONE) as string;
      expect(fiveText).toMatch(/^resets \d\d:\d\d$/);
      expect(weekText).toMatch(/^resets [A-Z][a-z]{2} \d\d:\d\d$/);
      expect(await within(detail()).findByText(fiveText)).toBeInTheDocument();
      expect(within(detail()).getByText(weekText)).toBeInTheDocument();
      // Home's windows carry no reset time, so no reset line is drawn for them.
      await select('Home');
      expect(within(detail()).queryByText(/^resets/)).toBeNull();
    });

    it('says a stale figure’s age rather than drawing it', async () => {
      stubFetch({ machines: { machines: [machineOf('home'), machineOf('Pro', { usage: null, usageAgeMs: 14 * 60_000 }), machineOf('Max')] } });
      await renderPage();
      await select('Pro');
      expect(await within(detail()).findByText('no fresh figure · usage 14 min ago')).toBeInTheDocument();
    });

    it('draws the list, the facts and every control while the machines read never answers', async () => {
      stubFetch({ machines: 'pending' });
      await renderPage();
      expect(names()).toEqual(['Home', 'Pro', 'Max']);
      // Home's dot is left out on purpose: it reads `useAgents`, which answered here, not the machines read that never does.
      expect(toneOf(rowOf('Pro'))).toBeNull();
      expect(toneOf(rowOf('Max'))).toBeNull();
      expect(metersOf(rowOf('Pro'))).toEqual([]);
      expect(within(detail()).getByText('checking…', { selector: '.dash-page-usage *' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add dashboard' })).toBeEnabled();
      await select('Pro');
      expect(factOf('Board')).toHaveTextContent('http://pro.local:4322');
      expect(toneOf(detail())).toBeNull();
      expect(within(detail()).getByText('checking…', { selector: '.dash-page-status *' })).toBeInTheDocument();
      expect(within(detail()).getByText('checking…', { selector: '.dash-page-usage *' })).toBeInTheDocument();
      for (const name of ['Move Pro up', 'Move Pro down', 'Edit Pro', 'Remove Pro']) expect(screen.getByRole('button', { name })).toBeEnabled();
      for (const r of screen.getAllByRole('radio')) expect(r).toBeEnabled();
    });

    it('ignores a machine the view lacks, and reads a view machine the answer lacks as checking', async () => {
      stubFetch({ machines: { machines: [machineOf('home'), machineOf('Pro', { usage: usageOf(64, 81) }), machineOf('Ghost', { usage: usageOf(5, 6) })] } });
      await renderPage();
      await waitFor(() => expect(metersOf(rowOf('Pro'))).toEqual(['5 H 64%', 'WEEK 81%']));
      expect(names()).toEqual(['Home', 'Pro', 'Max']);
      expect(screen.queryByText('Ghost')).toBeNull();
      expect(toneOf(rowOf('Max'))).toBeNull();
      await select('Max');
      expect(within(detail()).getByText('checking…', { selector: '.dash-page-status *' })).toBeInTheDocument();
      expect(within(detail()).getByText('checking…', { selector: '.dash-page-usage *' })).toBeInTheDocument();
    });

    it('keeps the selection on a machine moved up, by id', async () => {
      stubFetch({ post: () => ({ status: 200, body: viewOf({ order: ['Pro', 'home', 'Max'] }) }) });
      await renderPage();
      await select('Pro');
      await userEvent.click(screen.getByRole('button', { name: 'Move Pro up' }));
      await waitFor(() => expect(names()).toEqual(['Pro', 'Home', 'Max']));
      expect(rowOf('Pro')).toHaveAttribute('aria-pressed', 'true');
      expect(detailName()).toBe('Pro');
      expect(detail().querySelector('.dash-page-order')).toHaveTextContent('1');
    });

    it('keeps the default selection on the first machine moved down with no click at all', async () => {
      stubFetch({ post: () => ({ status: 200, body: viewOf({ order: ['Pro', 'home', 'Max'] }) }) });
      await renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Move Home down' }));
      await waitFor(() => expect(names()).toEqual(['Pro', 'Home', 'Max']));
      expect(rowOf('Home')).toHaveAttribute('aria-pressed', 'true');
      expect(rowOf('Home').querySelector('.dash-page-order')).toHaveTextContent('2');
      expect(detailName()).toBe('Home');
    });

    it('falls back to the first machine once the selected one is removed', async () => {
      stubFetch({ post: () => ({ status: 200, body: viewOf({ dashboards: [MAX], order: ['home', 'Max'] }) }) });
      await renderPage();
      await select('Pro');
      await userEvent.click(screen.getByRole('button', { name: 'Remove Pro' }));
      await userEvent.click(screen.getByTestId('dashboard-delete-Pro-accept'));
      await waitFor(() => expect(names()).toEqual(['Home', 'Max']));
      expect(rowOf('Home')).toHaveAttribute('aria-pressed', 'true');
      expect(detailName()).toBe('Home');
    });

    it('follows a rename made through Edit', async () => {
      const PRO2 = { ...PRO, name: 'Pro2', tokenVar: 'BM_AGENTS_TOKEN_PRO2' };
      stubFetch({ post: () => ({ status: 200, body: viewOf({ dashboards: [PRO2, MAX], order: ['home', 'Pro2', 'Max'] }) }) });
      await renderPage();
      await select('Pro');
      await userEvent.click(screen.getByRole('button', { name: 'Edit Pro' }));
      const name = screen.getByRole('textbox', { name: 'Name' });
      await userEvent.clear(name);
      await userEvent.type(name, 'Pro2');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(names()).toEqual(['Home', 'Pro2', 'Max']));
      expect(rowOf('Pro2')).toHaveAttribute('aria-pressed', 'true');
      expect(detailName()).toBe('Pro2');
    });

    it('selects a machine once Add stores it', async () => {
      const LINUX = { ...MAX, name: 'Linux', url: 'http://linux:4310', host: 'linux-box', tokenVar: 'BM_AGENTS_TOKEN_LINUX' };
      stubFetch({ post: () => ({ status: 200, body: viewOf({ dashboards: [PRO, MAX, LINUX], order: ['home', 'Pro', 'Max', 'Linux'] }) }) });
      await renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add dashboard' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Linux');
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'http://linux:4310');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(names()).toEqual(['Home', 'Pro', 'Max', 'Linux']));
      expect(rowOf('Linux')).toHaveAttribute('aria-pressed', 'true');
      expect(factOf('Machine name')).toHaveTextContent('linux-box');
    });

    it('asks for the machines again after every successful write, and not after a refused one', async () => {
      let refuse = false;
      const fn = stubFetch({ post: () => (refuse ? { status: 400, body: { error: 'threshold must be an integer 1–100' } } : undefined) });
      await renderSettled();
      const before = machineReads(fn);
      await userEvent.click(screen.getByRole('radio', { name: 'Most headroom' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      await waitFor(() => expect(machineReads(fn)).toBe(before + 1));

      await select('Pro');
      await userEvent.click(screen.getByRole('button', { name: 'Move Pro down' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(2));
      await waitFor(() => expect(machineReads(fn)).toBe(before + 2));

      refuse = true;
      const field = screen.getByRole('spinbutton', { name: 'Threshold' });
      await userEvent.clear(field);
      await userEvent.type(field, '101');
      await userEvent.tab();
      expect(await screen.findByRole('alert')).toHaveTextContent('threshold must be an integer 1–100');
      expect(machineReads(fn)).toBe(before + 2);
    });

    it('draws every machine quiet and without usage while BM_AGENTS is off', async () => {
      const off = { enabled: false, reachable: false, remoteAnswer: false, spawnAvailable: false, spawnMaxPermission: null };
      stubFetch({
        agents: { ...HEALTHY, enabled: false, reachable: false },
        machines: { machines: [machineOf('home', off), machineOf('Pro', off), machineOf('Max', off)] }
      });
      await renderPage();
      await waitFor(() => expect(within(detail()).getByText('no usage figure')).toBeInTheDocument());
      for (const n of ['Home', 'Pro', 'Max']) expect(toneOf(rowOf(n))).toBeNull();
      await select('Pro');
      expect(within(detail()).getByText('no usage figure')).toBeInTheDocument();
      expect(within(detail()).getByText(/off — dispatch is not enabled on the API/)).toBeInTheDocument();
    });
  });

  describe('home’s own presentation', () => {
    it('edits label, account, models and efforts and posts a patch to /home, ticking every box as null', async () => {
      const fn = stubFetch({
        post: () => ({ status: 200, body: viewOf({ home: { ...HOME, label: 'Studio', account: 'Max 20x', models: ['opus', 'sonnet'] } }) })
      });
      await renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Home' }));

      const label = screen.getByRole('textbox', { name: 'Label' });
      expect(label).toHaveValue('Home');
      await userEvent.clear(label);
      await userEvent.type(label, 'Studio');
      await userEvent.type(screen.getByRole('textbox', { name: 'Account' }), 'Max 20x');
      for (const m of ['haiku', 'fable']) await userEvent.click(within(screen.getByRole('group', { name: 'Models' })).getByRole('checkbox', { name: m }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({
        route: 'home',
        body: { label: 'Studio', account: 'Max 20x', models: ['opus', 'sonnet'], efforts: null }
      });
      // The page draws the server's answer and closes the form.
      await waitFor(() => expect(names()).toEqual(['Studio', 'Pro', 'Max']));
      expect(screen.queryByRole('textbox', { name: 'Label' })).toBeNull();
      expect(detailName()).toBe('Studio');
      expect([...factOf('Models').querySelectorAll('.ui-pill:not(.ui-pill-off)')].map((p) => p.textContent)).toEqual(['opus', 'sonnet']);
      expect(within(rowOf('Studio')).getByText('Max 20x')).toHaveClass('ui-pill');
    });

    it('sends null for an emptied label and account so the server goes back to its defaults', async () => {
      const fn = stubFetch({ get: viewOf({ home: { ...HOME, label: 'Studio', account: 'Max' } }) });
      render(<DashboardsPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Studio' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Label' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Account' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0].body).toEqual({ label: null, account: null, models: null, efforts: null });
    });

    it('disables Save, with the reason, while no model is ticked', async () => {
      const fn = stubFetch();
      await renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Home' }));
      for (const m of ['opus', 'sonnet', 'haiku', 'fable']) await userEvent.click(screen.getByRole('checkbox', { name: m }));
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(screen.getByText('tick at least one model')).toBeInTheDocument();
      expect(posts(fn)).toHaveLength(0);
    });

    it('puts no hint beside home’s models that suggests they narrow its launch sheets', async () => {
      stubFetch();
      await renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Home' }));
      expect(screen.getByRole('dialog', { name: 'Edit Home' }).textContent ?? '').not.toMatch(/narrow|limit|restrict|only offer/i);
      // Nor does the page's own Home detail.
      expect(detail().textContent ?? '').not.toMatch(/narrow|limit|restrict|only offer/i);
    });
  });

  describe('adding a dashboard', () => {
    async function openAdd() {
      await userEvent.click(screen.getByRole('button', { name: 'Add dashboard' }));
    }

    it('opens a form with Name, Dashboard URL, Board URL, Machine name (naming BM_MACHINE_NAME) and model and effort checkboxes, all ticked', async () => {
      stubFetch();
      await renderPage();
      await openAdd();
      for (const f of ['Name', 'Dashboard URL', 'Board URL', 'Machine name']) expect(screen.getByRole('textbox', { name: f })).toHaveValue('');
      expect(screen.getByText('BM_MACHINE_NAME')).toBeInTheDocument();
      const models = within(screen.getByRole('group', { name: 'Models' })).getAllByRole('checkbox');
      const efforts = within(screen.getByRole('group', { name: 'Efforts' })).getAllByRole('checkbox');
      expect(models.map((c) => (c as HTMLInputElement).checked)).toEqual([true, true, true, true]);
      expect(efforts.map((c) => (c as HTMLInputElement).checked)).toEqual([true, true, true, true, true]);
    });

    it('names the token the new entry will read as the name is typed', async () => {
      stubFetch();
      await renderPage();
      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      expect(screen.getByText('BM_AGENTS_TOKEN_TEAM')).toBeInTheDocument();
    });

    it('keeps Save disabled until Name and Dashboard URL hold something — Board URL and Machine name are optional', async () => {
      stubFetch();
      await renderPage();
      await openAdd();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'http://team:4310');
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('shows the defaults as placeholders and leaves blank optional fields out of the POST', async () => {
      const fn = stubFetch();
      await renderPage();
      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'http://team.tail1.ts.net:4173/');
      expect(screen.getByRole('textbox', { name: 'Board URL' })).toHaveAttribute('placeholder', 'http://team.tail1.ts.net:5177');
      expect(screen.getByRole('textbox', { name: 'Machine name' })).toHaveAttribute('placeholder', 'Team');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({ route: 'entries', body: { entry: { name: 'Team', url: 'http://team.tail1.ts.net:4173/' } } });
    });

    it('posts the entry with no lists when every box is ticked, and with the ticked ones when not', async () => {
      const fn = stubFetch();
      await renderPage();
      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' Team ');
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'http://team:4310');
      await userEvent.type(screen.getByRole('textbox', { name: 'Board URL' }), 'http://team:4322');
      await userEvent.type(screen.getByRole('textbox', { name: 'Machine name' }), 'team-mac');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({
        route: 'entries',
        body: { entry: { name: 'Team', url: 'http://team:4310', bmUrl: 'http://team:4322', host: 'team-mac' } }
      });

      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Lite');
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'http://lite:4310');
      await userEvent.type(screen.getByRole('textbox', { name: 'Board URL' }), 'http://lite:4322');
      await userEvent.type(screen.getByRole('textbox', { name: 'Machine name' }), 'lite-mac');
      await userEvent.type(screen.getByRole('textbox', { name: 'Account' }), 'Pro');
      await userEvent.click(within(screen.getByRole('group', { name: 'Models' })).getByRole('checkbox', { name: 'opus' }));
      await userEvent.click(within(screen.getByRole('group', { name: 'Efforts' })).getByRole('checkbox', { name: 'max' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(2));
      expect(posts(fn)[1].body).toEqual({
        entry: {
          name: 'Lite',
          url: 'http://lite:4310',
          bmUrl: 'http://lite:4322',
          host: 'lite-mac',
          account: 'Pro',
          models: ['sonnet', 'haiku', 'fable'],
          efforts: ['low', 'medium', 'high', 'xhigh']
        }
      });
    });

    it('shows a 400’s message inline, keeps the form and what was typed, and changes nothing else', async () => {
      const fn = stubFetch({ post: () => ({ status: 400, body: { error: 'url must be an http(s) origin' } }) });
      await renderPage();
      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'ftp://team');
      await userEvent.type(screen.getByRole('textbox', { name: 'Board URL' }), 'http://team:4322');
      await userEvent.type(screen.getByRole('textbox', { name: 'Machine name' }), 'team-mac');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('url must be an http(s) origin');
      expect(screen.getByRole('textbox', { name: 'Dashboard URL' })).toHaveValue('ftp://team');
      expect(names()).toEqual(['Home', 'Pro', 'Max']);
      expect(rowOf('Home')).toHaveAttribute('aria-pressed', 'true');
      expect(posts(fn)).toHaveLength(1);
      // The refusal frees the guard: a corrected Save can go out.
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('holds a new name that repeats an existing one at the form, because the server would update that row instead', async () => {
      const fn = stubFetch();
      await renderPage();
      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Pro');
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'http://x:4310');
      await userEvent.type(screen.getByRole('textbox', { name: 'Board URL' }), 'http://x:4322');
      await userEvent.type(screen.getByRole('textbox', { name: 'Machine name' }), 'x');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(screen.getByText('a dashboard named "Pro" already exists')).toBeInTheDocument();
      expect(posts(fn)).toHaveLength(0);
    });

    it('cancels without posting', async () => {
      const fn = stubFetch();
      await renderPage();
      await openAdd();
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
      expect(posts(fn)).toHaveLength(0);
    });

    it('opens as a dialog over the page, and Escape and the scrim close it without posting', async () => {
      const fn = stubFetch();
      await renderPage();
      await openAdd();
      expect(screen.getByRole('dialog', { name: 'Add dashboard' })).toBeInTheDocument();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();

      await openAdd();
      // Re-opened, it starts empty: what was typed before the Escape went with the sheet.
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
      await userEvent.click(document.querySelector('.ui-form-sheet-scrim') as HTMLElement);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(posts(fn)).toHaveLength(0);
    });

    it('closes the sheet once the server stores the entry, and draws the answer', async () => {
      const TEAM = { ...MAX, name: 'Team', url: 'http://team:4310', host: 'Team', tokenVar: 'BM_AGENTS_TOKEN_TEAM' };
      stubFetch({ post: () => ({ status: 200, body: viewOf({ dashboards: [PRO, MAX, TEAM], order: ['home', 'Pro', 'Max', 'Team'] }) }) });
      await renderPage();
      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'http://team:4310');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(names()).toEqual(['Home', 'Pro', 'Max', 'Team']));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('disables Add dashboard at eight remotes, saying why', async () => {
      const eight = Array.from({ length: 8 }, (_, i) => ({ ...MAX, name: `M${i}`, host: `m${i}` }));
      stubFetch({ get: viewOf({ dashboards: eight, order: ['home', ...eight.map((d) => d.name)] }) });
      await renderPage();
      expect(screen.getByRole('button', { name: 'Add dashboard' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Add dashboard' })).toHaveAttribute('title', 'at most 8 dashboards');
    });
  });

  describe('editing and removing a dashboard', () => {
    it('edits in a sheet, pre-filled, and posts the entry with `replaces` naming the row it came from', async () => {
      const fn = stubFetch();
      await renderPage();
      await select('Pro');
      await userEvent.click(screen.getByRole('button', { name: 'Edit Pro' }));

      const name = screen.getByRole('textbox', { name: 'Name' });
      expect(name).toHaveValue('Pro');
      expect(screen.getByRole('textbox', { name: 'Machine name' })).toHaveValue('pro-mac');
      expect(screen.getByRole('textbox', { name: 'Account' })).toHaveValue('Pro plan');
      expect((screen.getByRole('checkbox', { name: 'opus' }) as HTMLInputElement).checked).toBe(false);
      expect((screen.getByRole('checkbox', { name: 'sonnet' }) as HTMLInputElement).checked).toBe(true);
      // A sheet over the page, titled with the row it edits — not a form in place inside the detail.
      expect(screen.getByRole('dialog', { name: 'Edit dashboard Pro' })).toBeInTheDocument();
      expect(detail().querySelector('input[type="text"]')).toBeNull();

      await userEvent.clear(name);
      await userEvent.type(name, 'Pro2');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({
        route: 'entries',
        body: {
          entry: {
            name: 'Pro2',
            url: 'http://pro.local:4310',
            bmUrl: 'http://pro.local:4322',
            host: 'pro-mac',
            account: 'Pro plan',
            models: ['sonnet', 'haiku'],
            efforts: ['low', 'medium']
          },
          replaces: 'Pro'
        }
      });
    });

    it('asks before removing, posts entries/delete only on Remove, and keeps the row on Keep', async () => {
      const fn = stubFetch({ post: () => ({ status: 200, body: viewOf({ dashboards: [MAX], order: ['home', 'Max'] }) }) });
      await renderPage();
      await select('Pro');

      await userEvent.click(screen.getByRole('button', { name: 'Remove Pro' }));
      expect(screen.getByTestId('dashboard-delete-Pro')).toHaveTextContent('Remove Pro? Launches can no longer go there; its token stays in .env.');
      // The question stands in place of the head's controls.
      expect(screen.queryByRole('button', { name: 'Edit Pro' })).toBeNull();
      await userEvent.click(screen.getByTestId('dashboard-delete-Pro-dismiss'));
      expect(posts(fn)).toHaveLength(0);
      expect(names()).toEqual(['Home', 'Pro', 'Max']);

      await userEvent.click(screen.getByRole('button', { name: 'Remove Pro' }));
      await userEvent.click(screen.getByTestId('dashboard-delete-Pro-accept'));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({ route: 'entries/delete', body: { name: 'Pro' } });
      await waitFor(() => expect(names()).toEqual(['Home', 'Max']));
    });

    it('shows a refused remove’s message and keeps the row', async () => {
      stubFetch({ post: () => ({ status: 404, body: { error: 'no dashboard named "Pro"' } }) });
      await renderPage();
      await select('Pro');
      await userEvent.click(screen.getByRole('button', { name: 'Remove Pro' }));
      await userEvent.click(screen.getByTestId('dashboard-delete-Pro-accept'));
      // In the detail, under its head — the `list` scope.
      expect(await within(detail()).findByRole('alert')).toHaveTextContent('no dashboard named "Pro"');
      expect(names()).toEqual(['Home', 'Pro', 'Max']);
      expect(rowOf('Pro')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('the prefer order', () => {
    it('moves a machine down by posting the whole new order, home included', async () => {
      const fn = stubFetch({ post: () => ({ status: 200, body: viewOf({ order: ['Pro', 'home', 'Max'] }) }) });
      await renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Move Home down' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({ route: 'settings', body: { order: ['Pro', 'home', 'Max'] } });
      // Drawn from the answer.
      await waitFor(() => expect(names()).toEqual(['Pro', 'Home', 'Max']));
    });

    it('moves a machine up', async () => {
      const fn = stubFetch();
      await renderPage();
      await select('Max');
      await userEvent.click(screen.getByRole('button', { name: 'Move Max up' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0].body).toEqual({ order: ['home', 'Max', 'Pro'] });
    });

    it('cannot move the first machine up or the last one down', async () => {
      stubFetch();
      await renderPage();
      expect(screen.getByRole('button', { name: 'Move Home up' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move Home down' })).toBeEnabled();
      await select('Max');
      expect(screen.getByRole('button', { name: 'Move Max down' })).toBeDisabled();
      await select('Pro');
      expect(screen.getByRole('button', { name: 'Move Pro up' })).toBeEnabled();
    });
  });

  describe('the suggestion', () => {
    it('draws three strategies as a radio group with the stored one chosen and a line each', async () => {
      stubFetch({ get: viewOf({ strategy: 'headroom' }) });
      await renderPage();
      const group = screen.getByRole('radiogroup', { name: 'Suggestion strategy' });
      const radios = within(group).getAllByRole('radio');
      expect(radios.map((r) => r.getAttribute('aria-labelledby') && document.getElementById(r.getAttribute('aria-labelledby') as string)?.textContent)).toEqual(
        ['Prefer order', 'Most headroom', 'Least likely to run out']
      );
      expect(screen.getByRole('radio', { name: 'Most headroom' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Prefer order' })).not.toBeChecked();
      // One short line each, tied to its radio.
      for (const r of radios) {
        const line = document.getElementById(r.getAttribute('aria-describedby') as string)?.textContent ?? '';
        expect(line.length).toBeGreaterThan(0);
        expect(line.length).toBeLessThan(90);
      }
    });

    it('words the order as the prefer order, since the list is no longer above the strategies', async () => {
      stubFetch();
      await renderPage();
      const lines = within(screen.getByRole('radiogroup', { name: 'Suggestion strategy' }))
        .getAllByRole('radio')
        .map((r) => document.getElementById(r.getAttribute('aria-describedby') as string)?.textContent);
      expect(lines).toEqual([
        'The first in the prefer order that is under the threshold on both windows',
        'The lowest used figure — the higher of its 5 h and weekly percent',
        'One projected to last past its weekly reset; ties go to the prefer order'
      ]);
    });

    it('posts the strategy picked and draws the answer', async () => {
      const fn = stubFetch({ post: () => ({ status: 200, body: viewOf({ strategy: 'runway' }) }) });
      await renderPage();
      await userEvent.click(screen.getByRole('radio', { name: 'Least likely to run out' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({ route: 'settings', body: { strategy: 'runway' } });
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Least likely to run out' })).toBeChecked());
    });

    it('posts the threshold on commit, and not when it did not change', async () => {
      const fn = stubFetch({ post: () => ({ status: 200, body: viewOf({ threshold: 90 }) }) });
      await renderPage();
      const field = screen.getByRole('spinbutton', { name: 'Threshold' });
      expect(field).toHaveValue(80);
      await userEvent.click(field);
      await userEvent.tab();
      expect(posts(fn)).toHaveLength(0);

      await userEvent.clear(field);
      await userEvent.type(field, '90');
      await userEvent.tab();
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({ route: 'settings', body: { threshold: 90 } });
      await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Threshold' })).toHaveValue(90));
    });

    it('shows the server’s 400 for an out-of-range threshold and puts the stored value back in the field', async () => {
      const fn = stubFetch({ post: () => ({ status: 400, body: { error: 'threshold must be an integer 1–100' } }) });
      await renderPage();
      const field = screen.getByRole('spinbutton', { name: 'Threshold' });
      await userEvent.clear(field);
      await userEvent.type(field, '101');
      await userEvent.tab();

      expect(await screen.findByRole('alert')).toHaveTextContent('threshold must be an integer 1–100');
      expect(posts(fn)[0].body).toEqual({ threshold: 101 });
      await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Threshold' })).toHaveValue(80));
    });
  });

  describe('the footer', () => {
    it('names the file and carries the lead line, once', async () => {
      stubFetch();
      await renderPage();
      expect(screen.getByText('/home/me/.backlog-manager/settings/dashboards.json').closest('.dash-page-foot')).not.toBeNull();
      expect(
        screen.getAllByText('Listed in prefer order — move a machine with ↑ ↓. Tokens are never entered here: each is an environment variable, set in .env.')
      ).toHaveLength(1);
    });
  });

  describe('an unreadable file', () => {
    it('disables every control and names the file and the fix', async () => {
      stubFetch({ get: viewOf({ source: 'unreadable', dashboards: [], order: ['home'] }) });
      await renderPage();

      const hint = screen.getByText(/cannot be read/);
      expect(hint).toHaveTextContent(/dashboards\.json.*cannot be read.*by hand/);
      expect(names()).toEqual(['Home']);
      expect(screen.getByRole('button', { name: 'Add dashboard' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Edit Home' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move Home up' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move Home down' })).toBeDisabled();
      for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
      expect(screen.getByRole('spinbutton', { name: 'Threshold' })).toBeDisabled();
    });

    it('sends nothing when the threshold is typed into the disabled field', async () => {
      const fn = stubFetch({ get: viewOf({ source: 'unreadable', dashboards: [], order: ['home'] }) });
      await renderPage();
      await userEvent.type(screen.getByRole('spinbutton', { name: 'Threshold' }), '9');
      await userEvent.tab();
      expect(posts(fn)).toHaveLength(0);
    });
  });
});
