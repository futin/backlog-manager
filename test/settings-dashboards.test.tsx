/**
 * @jest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { DashboardsGroup } from '../client/src/components/settings/DashboardsGroup';
import type { AgentsStatus, DashboardsView } from '../shared/types';

/**
 * Task 11 of multi-dashboard: the `Dashboards` card on Shared Settings. Rendered bare — the page-level question (which page, which column) is
 * `settings-view.test.tsx`'s. A stub answers `GET /api/dashboards` with `view` and every POST with whatever the case hands it, defaulting to the unchanged view.
 */

// A secret the stub puts on the wire beside the fields the real payload has, to prove the card draws named fields and never an entry wholesale. The real
// server never sends one (`dashboards-routes.test.ts`); this is the card's own half of that promise.
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

function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
}

type Answer = { status: number; body: unknown };

/** `get` answers the read (`'reject'` for a failed one); `post` answers a write by route name and parsed body, defaulting to the same view. */
const HEALTHY: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: ['/a', '/b', '/c']
};

function stubFetch(
  opts: { get?: DashboardsView | 'reject'; post?: (route: string, body: Record<string, unknown>) => Answer | undefined; agents?: AgentsStatus } = {}
): jest.Mock {
  const get = opts.get ?? viewOf();
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // The Home row's dispatch line (`useAgents`), answered healthy unless a case says otherwise.
    if (url.endsWith('/api/agents/status')) return respond(200, opts.agents ?? HEALTHY);
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

/** The machine row whose name is `name`, so a case reads its lines and controls without matching another machine's. */
function rowOf(name: string): HTMLElement {
  const label = [...document.querySelectorAll('.dash-machine .set-name')].find((el) => el.textContent === name);
  if (!label) throw new Error(`no machine row named ${name}`);
  return label.closest('.set-row') as HTMLElement;
}

const names = () => [...document.querySelectorAll('.dash-machine > .set-row .set-name')].map((el) => el.textContent);

async function renderCard() {
  render(<DashboardsGroup />);
  await screen.findByText('Prefer order');
}

describe('DashboardsGroup', () => {
  afterEach(() => cleanup());

  describe('this machine’s dispatch report on the Home row (was the Claude Agents card)', () => {
    it('draws the dispatch line as Home’s first line and no setup steps while healthy', async () => {
      stubFetch();
      await renderCard();
      const home = within(rowOf('Home'));
      expect(await home.findByText(/dispatch.*connected · spawn on · ceiling: auto · 3 projects/)).toBeInTheDocument();
      expect(screen.queryByText('Setting it up')).toBeNull();
    });
    it('opens the setup steps under the Home row when dispatch is off', async () => {
      stubFetch({ agents: { ...HEALTHY, enabled: false, reachable: false } });
      await renderCard();
      expect(await within(rowOf('Home')).findByText(/off — dispatch is not enabled on the API/)).toBeInTheDocument();
      expect(screen.getByText('Setting it up')).toBeInTheDocument();
      expect(screen.getByText(/BM_AGENTS=on/)).toBeInTheDocument();
    });
    it('still reports dispatch while GET /api/dashboards fails', async () => {
      stubFetch({ get: 'reject' });
      render(<DashboardsGroup />);
      expect(await screen.findByText(/connected · spawn on/)).toBeInTheDocument();
      expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    });
  });

  describe('the machines', () => {
    it('titles the card Dashboards, scoped to this machine, and lists every machine in the view’s order', async () => {
      stubFetch();
      await renderCard();
      expect(document.querySelector('.ui-sheet-title')).toHaveTextContent('Dashboards');
      expect(document.querySelector('.ui-sheet-sub')).toHaveTextContent('this machine');
      expect(names()).toEqual(['Home', 'Pro', 'Max']);
    });

    it('draws home read-only from env: BM_AGENTS_URL’s value, the token as set, and the models', async () => {
      stubFetch();
      await renderCard();
      const home = within(rowOf('Home'));
      expect(home.getByText('BM_AGENTS_URL')).toBeInTheDocument();
      expect(home.getByText(/http:\/\/127\.0\.0\.1:4310/)).toBeInTheDocument();
      expect(home.getByText('BM_AGENTS_TOKEN ✓ set')).toBeInTheDocument();
      expect(home.getByText('models: opus, sonnet, haiku, fable')).toBeInTheDocument();
      expect(home.getByText('efforts: low, medium, high, xhigh, max')).toBeInTheDocument();
      // Read-only: no field in the row holds the URL, and there is no Remove for home.
      expect(within(rowOf('Home')).queryByRole('textbox')).toBeNull();
      expect(home.queryByRole('button', { name: /^Remove/ })).toBeNull();
    });

    it('draws a remote’s URLs, machine name, account and lists, and says an unset token is not set and when it is needed', async () => {
      stubFetch();
      await renderCard();
      const pro = within(rowOf('Pro'));
      expect(pro.getByText('dashboard http://pro.local:4310')).toBeInTheDocument();
      expect(pro.getByText('board http://pro.local:4322')).toBeInTheDocument();
      expect(pro.getByText('machine name pro-mac')).toBeInTheDocument();
      expect(pro.getByText('account: Pro plan')).toBeInTheDocument();
      expect(pro.getByText('models: sonnet, haiku')).toBeInTheDocument();
      expect(
        pro.getByText('BM_AGENTS_TOKEN_PRO not set — needed only if that dashboard does not trust this machine; then add it to .env and restart')
      ).toBeInTheDocument();
      expect(within(rowOf('Max')).getByText('BM_AGENTS_TOKEN_MAX ✓ set')).toBeInTheDocument();
    });

    it('never renders a token value, whatever else the payload carries', async () => {
      stubFetch();
      await renderCard();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Pro' }));
      expect(document.body.innerHTML).not.toContain(SECRET);
      // Nor the value of any input — a form field holding a token would not show in `innerHTML`.
      for (const input of document.querySelectorAll('input')) expect((input as HTMLInputElement).value).not.toContain(SECRET);
    });

    it('shows no machines and an unavailable line when the first read fails', async () => {
      stubFetch({ get: 'reject' });
      render(<DashboardsGroup />);
      expect(await screen.findByText('Unavailable')).toBeInTheDocument();
      expect(screen.getByText(/dashboards unreachable/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add dashboard' })).toBeNull();
    });
  });

  describe('home’s own presentation', () => {
    it('edits label, account, models and efforts and posts a patch to /home, ticking every box as null', async () => {
      const fn = stubFetch({
        post: () => ({ status: 200, body: viewOf({ home: { ...HOME, label: 'Studio', account: 'Max 20x', models: ['opus', 'sonnet'] } }) })
      });
      await renderCard();
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
      // The card draws the server's answer and closes the form.
      expect(await screen.findByText('Studio')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Label' })).toBeNull();
      expect(within(rowOf('Studio')).getByText('models: opus, sonnet')).toBeInTheDocument();
      expect(within(rowOf('Studio')).getByText('account: Max 20x')).toBeInTheDocument();
    });

    it('sends null for an emptied label and account so the server goes back to its defaults', async () => {
      const fn = stubFetch({ get: viewOf({ home: { ...HOME, label: 'Studio', account: 'Max' } }) });
      render(<DashboardsGroup />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Studio' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Label' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Account' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0].body).toEqual({ label: null, account: null, models: null, efforts: null });
    });

    it('disables Save, with the reason, while no model is ticked', async () => {
      const fn = stubFetch();
      await renderCard();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Home' }));
      for (const m of ['opus', 'sonnet', 'haiku', 'fable']) await userEvent.click(screen.getByRole('checkbox', { name: m }));
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(screen.getByText('tick at least one model')).toBeInTheDocument();
      expect(posts(fn)).toHaveLength(0);
    });

    it('puts no hint beside home’s models that suggests they narrow its launch sheets', async () => {
      stubFetch();
      await renderCard();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Home' }));
      expect(screen.getByRole('dialog', { name: 'Edit Home' }).textContent ?? '').not.toMatch(/narrow|limit|restrict|only offer/i);
    });
  });

  describe('adding a dashboard', () => {
    async function openAdd() {
      await userEvent.click(screen.getByRole('button', { name: 'Add dashboard' }));
    }

    it('opens a form with Name, Dashboard URL, Board URL, Machine name (naming BM_MACHINE_NAME) and model and effort checkboxes, all ticked', async () => {
      stubFetch();
      await renderCard();
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
      await renderCard();
      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      expect(screen.getByText('BM_AGENTS_TOKEN_TEAM')).toBeInTheDocument();
    });

    it('keeps Save disabled until Name and Dashboard URL hold something — Board URL and Machine name are optional', async () => {
      stubFetch();
      await renderCard();
      await openAdd();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'http://team:4310');
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('shows the defaults as placeholders and leaves blank optional fields out of the POST', async () => {
      const fn = stubFetch();
      await renderCard();
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
      await renderCard();
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
      await renderCard();
      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'ftp://team');
      await userEvent.type(screen.getByRole('textbox', { name: 'Board URL' }), 'http://team:4322');
      await userEvent.type(screen.getByRole('textbox', { name: 'Machine name' }), 'team-mac');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('url must be an http(s) origin');
      expect(screen.getByRole('textbox', { name: 'Dashboard URL' })).toHaveValue('ftp://team');
      expect(names()).toEqual(['Home', 'Pro', 'Max']);
      expect(posts(fn)).toHaveLength(1);
      // The refusal frees the guard: a corrected Save can go out.
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('holds a new name that repeats an existing one at the form, because the server would update that row instead', async () => {
      const fn = stubFetch();
      await renderCard();
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
      await renderCard();
      await openAdd();
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
      expect(posts(fn)).toHaveLength(0);
    });

    it('opens as a dialog over the card, and Escape and the scrim close it without posting', async () => {
      const fn = stubFetch();
      await renderCard();
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
      await renderCard();
      await openAdd();
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Team');
      await userEvent.type(screen.getByRole('textbox', { name: 'Dashboard URL' }), 'http://team:4310');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(names()).toEqual(['Home', 'Pro', 'Max', 'Team']));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('disables Add dashboard at eight remotes', async () => {
      const eight = Array.from({ length: 8 }, (_, i) => ({ ...MAX, name: `M${i}`, host: `m${i}` }));
      stubFetch({ get: viewOf({ dashboards: eight, order: ['home', ...eight.map((d) => d.name)] }) });
      await renderCard();
      expect(screen.getByRole('button', { name: 'Add dashboard' })).toBeDisabled();
    });
  });

  describe('editing and removing a dashboard', () => {
    it('edits in a sheet, pre-filled, and posts the entry with `replaces` naming the row it came from', async () => {
      const fn = stubFetch();
      await renderCard();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Pro' }));

      const name = screen.getByRole('textbox', { name: 'Name' });
      expect(name).toHaveValue('Pro');
      expect(screen.getByRole('textbox', { name: 'Machine name' })).toHaveValue('pro-mac');
      expect(screen.getByRole('textbox', { name: 'Account' })).toHaveValue('Pro plan');
      expect((screen.getByRole('checkbox', { name: 'opus' }) as HTMLInputElement).checked).toBe(false);
      expect((screen.getByRole('checkbox', { name: 'sonnet' }) as HTMLInputElement).checked).toBe(true);
      // A sheet over the card, titled with the row it edits — not a form in place under the row.
      expect(screen.getByRole('dialog', { name: 'Edit dashboard Pro' })).toBeInTheDocument();
      expect(rowOf('Pro').parentElement?.querySelector('input[type="text"]')).toBeNull();

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
      await renderCard();

      await userEvent.click(screen.getByRole('button', { name: 'Remove Pro' }));
      expect(screen.getByTestId('dashboard-delete-Pro')).toHaveTextContent('Remove Pro?');
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
      await renderCard();
      await userEvent.click(screen.getByRole('button', { name: 'Remove Pro' }));
      await userEvent.click(screen.getByTestId('dashboard-delete-Pro-accept'));
      expect(await screen.findByRole('alert')).toHaveTextContent('no dashboard named "Pro"');
      expect(names()).toEqual(['Home', 'Pro', 'Max']);
    });
  });

  describe('the prefer order', () => {
    it('moves a machine down by posting the whole new order, home included', async () => {
      const fn = stubFetch({ post: () => ({ status: 200, body: viewOf({ order: ['Pro', 'home', 'Max'] }) }) });
      await renderCard();
      await userEvent.click(screen.getByRole('button', { name: 'Move Home down' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({ route: 'settings', body: { order: ['Pro', 'home', 'Max'] } });
      // Drawn from the answer.
      await waitFor(() => expect(names()).toEqual(['Pro', 'Home', 'Max']));
    });

    it('moves a machine up', async () => {
      const fn = stubFetch();
      await renderCard();
      await userEvent.click(screen.getByRole('button', { name: 'Move Max up' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0].body).toEqual({ order: ['home', 'Max', 'Pro'] });
    });

    it('cannot move the first machine up or the last one down', async () => {
      stubFetch();
      await renderCard();
      expect(screen.getByRole('button', { name: 'Move Home up' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move Max down' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move Pro up' })).toBeEnabled();
    });
  });

  describe('the suggestion', () => {
    it('draws three strategies as a radio group with the stored one chosen and a line each', async () => {
      stubFetch({ get: viewOf({ strategy: 'headroom' }) });
      await renderCard();
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

    it('posts the strategy picked and draws the answer', async () => {
      const fn = stubFetch({ post: () => ({ status: 200, body: viewOf({ strategy: 'runway' }) }) });
      await renderCard();
      await userEvent.click(screen.getByRole('radio', { name: 'Least likely to run out' }));
      await waitFor(() => expect(posts(fn)).toHaveLength(1));
      expect(posts(fn)[0]).toEqual({ route: 'settings', body: { strategy: 'runway' } });
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Least likely to run out' })).toBeChecked());
    });

    it('posts the threshold on commit, and not when it did not change', async () => {
      const fn = stubFetch({ post: () => ({ status: 200, body: viewOf({ threshold: 90 }) }) });
      await renderCard();
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
      await renderCard();
      const field = screen.getByRole('spinbutton', { name: 'Threshold' });
      await userEvent.clear(field);
      await userEvent.type(field, '101');
      await userEvent.tab();

      expect(await screen.findByRole('alert')).toHaveTextContent('threshold must be an integer 1–100');
      expect(posts(fn)[0].body).toEqual({ threshold: 101 });
      await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Threshold' })).toHaveValue(80));
    });
  });

  describe('an unreadable file', () => {
    it('disables every control and names the file and the fix', async () => {
      stubFetch({ get: viewOf({ source: 'unreadable', dashboards: [], order: ['home'] }) });
      await renderCard();

      const hint = screen.getByText(/cannot be read/);
      expect(hint).toHaveTextContent(/dashboards\.json.*cannot be read.*by hand/);
      expect(screen.getByRole('button', { name: 'Add dashboard' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Edit Home' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move Home up' })).toBeDisabled();
      for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
      expect(screen.getByRole('spinbutton', { name: 'Threshold' })).toBeDisabled();
    });

    it('sends nothing when the threshold is typed into the disabled field', async () => {
      const fn = stubFetch({ get: viewOf({ source: 'unreadable', dashboards: [], order: ['home'] }) });
      await renderCard();
      await userEvent.type(screen.getByRole('spinbutton', { name: 'Threshold' }), '9');
      await userEvent.tab();
      expect(posts(fn)).toHaveLength(0);
    });
  });
});
