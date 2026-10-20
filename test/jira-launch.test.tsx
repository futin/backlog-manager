/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraLaunchSheet, PREVIEW_SETTLE_MS } from '../client/src/components/jira/JiraLaunchSheet';
import { JiraContext } from '../client/src/hooks/JiraContext';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { daysAgoStamp } from './helpers/dates';
import type {
  AgentsStatus,
  JiraAction,
  JiraDispatchResult,
  JiraIssue,
  JiraIssueDetail,
  JiraRefBranch,
  JiraRepoRefs,
  JiraStatusPayload
} from '../shared/types';

/*
  Jira › the launch sheet (Jira phase 5, Task 9; spec §7, §8; DESIGN.md §8.7 Sheet and §8.9) — the real sheet over a mocked `fetch`, rendered directly:
  the sheet is not mounted anywhere yet (Task 10 hosts it in `JiraBoardView`). What it owns: the action and the preview that follows it, the repository,
  the two Jira writes Start may ask for, the launch controls, the gate that decides whether Start is drawn at all, and the two exits — Start and Copy
  prompt.
*/

const ADA = { accountId: 'acc-ada', name: 'Ada Lovelace' };
const SKILL = { id: 's_0a1b2c3d', name: 'Groom ticket', prompt: '/jira-groom {key}' };

const CARD: JiraIssue = {
  key: 'PAY-131',
  id: '10131',
  url: 'https://acme.atlassian.net/browse/PAY-131',
  summary: 'Refund partial captures',
  project: { key: 'PAY', name: 'Payments' },
  type: { name: 'Story', level: 0, subtask: false },
  status: { name: 'To Do', category: 'new' },
  priority: 'High',
  assignee: null,
  reporter: 'Grace Hopper',
  parent: null,
  subtasks: 0,
  labels: [],
  sprint: null,
  created: daysAgoStamp(10),
  updated: daysAgoStamp(1),
  resolved: null
};

const TRANSITIONS: JiraIssueDetail['transitions'] = [
  { id: '31', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' } },
  { id: '41', name: 'Finish', to: { name: 'Done', category: 'done' } }
];

function detail(over: Partial<JiraIssueDetail> = {}): JiraIssueDetail {
  return { ...CARD, description: '', children: [], transitions: TRANSITIONS, boards: [], session: null, ...over };
}

function jiraStatus(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: ADA,
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [],
    repos: { PAY: ['/Users/ada/pay'] },
    repoDefaults: {},
    projects: [{ key: 'PAY', name: 'Payments' }],
    skills: [SKILL],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: true,
    home: '/Users/ada',
    ...over
  };
}

function agents(over: Partial<AgentsStatus> = {}): AgentsStatus {
  return {
    enabled: true,
    reachable: true,
    remoteAnswer: true,
    spawnAvailable: true,
    spawnMaxPermission: 'acceptEdits',
    projectPaths: ['/Users/ada/pay', '/Users/ada/pay-web'],
    ...over
  };
}

/** What a request answers. `prompt` is the text/plain preview, or a refusal; `dispatch` the POST. Each can be replaced per case. */
interface Server {
  agents: AgentsStatus;
  detail: JiraIssueDetail | { status: number; error: string };
  prompt: (url: URL) => { status: number; body: string };
  /** `GET /api/jira/refs`, per repository: refs, a refusal, or `'pending'` for a read that never answers (a slow git read held open). */
  refs: (repo: string) => { status: number; body: unknown } | 'pending';
  dispatch: { status: number; body: unknown };
  /** When set, the detail read answers only once this settles — a case's way to act before the detail lands. */
  detailGate?: Promise<void>;
}

let server: Server;
let calls: { url: string; init?: RequestInit }[];

function refBranch(name: string, over: Partial<JiraRefBranch> = {}): JiraRefBranch {
  return { name, local: true, remote: true, sync: 'same', committedAt: daysAgoStamp(3), worktree: null, ticket: false, ...over };
}

/** A readable repository: `develop` checked out in the mapped checkout and the default base, never fetched, plus whatever `branches` a case adds. */
function refsOf(repo: string, branches: JiraRefBranch[] = [], over: Partial<{ fetchedAt: string | null; defaultBase: string | null }> = {}): JiraRepoRefs {
  return {
    repo,
    available: true,
    fetchedAt: null,
    mainBranch: 'develop',
    defaultBase: 'develop',
    branches: [...branches, refBranch('develop', { worktree: repo })],
    ...over
  };
}

const okPrompt = (url: URL): { status: number; body: string } => ({
  status: 200,
  body: `prompt for ${url.searchParams.get('action')} in ${url.searchParams.get('repo')}`
});

function res(status: number, body: unknown, text?: string): Response {
  // A plain object, not `new Response`: jsdom has none (the other jira suites' mocks are this shape too).
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text ?? (typeof body === 'string' ? body : JSON.stringify(body)))
  } as Response;
}

const realFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  calls = [];
  server = {
    agents: agents(),
    detail: detail(),
    prompt: okPrompt,
    refs: (repo) => ({ status: 200, body: refsOf(repo) }),
    dispatch: {
      status: 200,
      body: {
        sessionId: 'sess-9',
        assigned: false,
        transitioned: null,
        session: { name: 'jira PAY-131', startedAt: daysAgoStamp(0), repo: '/Users/ada/pay' }
      } satisfies JiraDispatchResult
    }
  };
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input);
    calls.push({ url: raw, init });
    const url = new URL(raw, 'http://x');
    if (url.pathname === '/api/agents/status') return Promise.resolve(res(200, server.agents));
    if (url.pathname === '/api/jira/prompt') {
      const p = server.prompt(url);
      return Promise.resolve(p.status === 200 ? res(200, null, p.body) : res(p.status, { error: p.body }));
    }
    if (url.pathname === '/api/jira/refs') {
      const r = server.refs(url.searchParams.get('repo') ?? '');
      if (r === 'pending') return new Promise<Response>(() => undefined);
      return Promise.resolve(r.status === 200 ? res(200, r.body) : res(r.status, { error: r.body }));
    }
    if (url.pathname.startsWith('/api/jira/issue/')) {
      const d = server.detail;
      const answer = 'error' in d ? res(d.status, { error: d.error }) : res(200, d);
      return server.detailGate ? server.detailGate.then(() => answer) : Promise.resolve(answer);
    }
    if (url.pathname === '/api/agents/dispatch-jira') return Promise.resolve(res(server.dispatch.status, server.dispatch.body));
    return Promise.reject(new Error(`unexpected ${raw}`));
  }) as jest.Mock;
  setClipboard(undefined);
});

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

function setClipboard(value: { writeText: jest.Mock } | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

let onClose: jest.Mock;
let onStarted: jest.Mock;
let onWrote: jest.Mock;

function mount(opts: { initialAction?: JiraAction; status?: Partial<JiraStatusPayload>; issue?: JiraIssue } = {}) {
  onClose = jest.fn();
  onStarted = jest.fn();
  onWrote = jest.fn();
  const tree = (status?: Partial<JiraStatusPayload>) => (
    <SettingsProvider>
      <JiraContext.Provider value={{ data: jiraStatus(status), loading: false, error: false, reload: jest.fn() }}>
        <JiraLaunchSheet issue={opts.issue ?? CARD} initialAction={opts.initialAction ?? 'execute'} onClose={onClose} onStarted={onStarted} onWrote={onWrote} />
      </JiraContext.Provider>
    </SettingsProvider>
  );
  const view = render(tree(opts.status));
  /** The shell's status landing after the sheet is open — the same sheet, a new context value. */
  return { ...view, withStatus: (status: Partial<JiraStatusPayload>) => view.rerender(tree(status)) };
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const promptBox = (): HTMLTextAreaElement => within(dialog()).getByLabelText('Prompt') as HTMLTextAreaElement;
const startButton = (): HTMLElement => within(dialog()).getByRole('button', { name: 'Start' });
const copyButton = (): HTMLElement => within(dialog()).getByRole('button', { name: /^Copy prompt$|^Copied$/ });
const promptReads = (): URL[] => calls.filter((c) => c.url.startsWith('/api/jira/prompt')).map((c) => new URL(c.url, 'http://x'));
const dispatchBody = (): Record<string, unknown> => JSON.parse(String(calls.filter((c) => c.url === '/api/agents/dispatch-jira')[0].init?.body));

/** Mounted, the status answered and the preview landed — what nearly every case starts from. */
async function ready(opts: Parameters<typeof mount>[0] = {}): Promise<void> {
  mount(opts);
  await waitFor(() => expect(promptBox().value).not.toBe(''));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/status')).toBe(true));
}

describe('JiraLaunchSheet — the gate', () => {
  it('draws no Start while agents are off, and keeps Copy prompt', async () => {
    server.agents = agents({ enabled: false });
    setClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
    await ready();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument());
    expect(copyButton()).toBeEnabled();
  });

  it('draws no Start before the dashboard has answered, rather than a dead one', async () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    await waitFor(() => expect(startButton()).toBeInTheDocument());
  });

  it('draws no Start with agents off while several paths are mapped and none is picked, and keeps Copy prompt', async () => {
    server.agents = agents({ enabled: false });
    setClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
    mount({ status: { repos: { PAY: ['/Users/ada/pay', '/Users/ada/pay-web'] } } });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/status')).toBe(true));
    await within(dialog()).findByRole('combobox', { name: 'Repository' });
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(copyButton()).toBeInTheDocument();
  });

  it('disables Start with the choose-a-repository reason while agents are on, several paths are mapped and none is picked', async () => {
    mount({ status: { repos: { PAY: ['/Users/ada/pay', '/Users/ada/pay-web'] } } });
    await waitFor(() => expect(startButton()).toBeDisabled());
    expect(startButton()).toHaveAttribute('title', expect.stringContaining('choose a repository'));
  });

  it('disables Start with the gate\'s reason as its title when the dashboard does not list the repository', async () => {
    server.agents = agents({ projectPaths: [] });
    await ready();
    await waitFor(() => expect(startButton()).toBeDisabled());
    expect(startButton()).toHaveAttribute('title', expect.stringContaining('the dashboard does not list /Users/ada/pay'));
  });
});

describe('JiraLaunchSheet — the repository', () => {
  it('preselects the one mapped path, shown with ~, and previews against it', async () => {
    await ready();
    expect(within(dialog()).getByText('~/pay')).toBeInTheDocument();
    expect(within(dialog()).queryByRole('combobox', { name: 'Repository' })).not.toBeInTheDocument();
    expect(promptReads()[0].searchParams.get('repo')).toBe('/Users/ada/pay');
  });

  it('preselects a single mapped path whose mapping arrives after the sheet is open', async () => {
    const view = mount({ status: { repos: {} } });
    expect(within(dialog()).queryByText('~/pay')).not.toBeInTheDocument();
    expect(promptReads()).toHaveLength(0);
    view.withStatus({ repos: { PAY: ['/Users/ada/pay'] } });
    await waitFor(() => expect(promptBox().value).toBe('prompt for execute in /Users/ada/pay'));
    expect(promptReads()[0].searchParams.get('repo')).toBe('/Users/ada/pay');
    await waitFor(() => expect(startButton()).toBeEnabled());
  });

  it('offers a select for two paths and previews nothing until one is picked', async () => {
    mount({ status: { repos: { PAY: ['/Users/ada/pay', '/Users/ada/pay-web'] } } });
    const select = await within(dialog()).findByRole('combobox', { name: 'Repository' });
    expect(promptReads()).toHaveLength(0);
    await waitFor(() => expect(startButton()).toBeDisabled());
    await userEvent.selectOptions(select, '/Users/ada/pay-web');
    await waitFor(() => expect(promptBox().value).toContain('/Users/ada/pay-web'));
    await waitFor(() => expect(startButton()).toBeEnabled());
  });
});

describe('JiraLaunchSheet — the action and the preview', () => {
  it('seeds the action from initialAction and refetches the preview, stale answer dropped, when it changes', async () => {
    await ready({ initialAction: 'context' });
    expect((within(dialog()).getByRole('combobox', { name: 'Action' }) as HTMLSelectElement).value).toBe('context');
    expect(promptReads()[0].searchParams.get('action')).toBe('context');

    await userEvent.selectOptions(within(dialog()).getByRole('combobox', { name: 'Action' }), `skill:${SKILL.id}`);
    await waitFor(() => expect(promptBox().value).toBe(`prompt for skill:${SKILL.id} in /Users/ada/pay`));
    // The skill is treated as execute by the Branch section: no ticket branch here, so a New one from the default pattern, cut from `develop`.
    expect(calls.map((c) => c.url)).toContain(
      `/api/jira/prompt?key=PAY-131&action=skill%3A${SKILL.id}&repo=%2FUsers%2Fada%2Fpay&mode=new&branch=pay-131-refund-partial-captures&base=develop`
    );
  });

  it('ignores jiraDefaultAction — the menu reads it, and the sheet opens on exactly the action it was handed', async () => {
    localStorage.setItem('backlog-manager.settings', JSON.stringify({ jiraDefaultAction: 'context' }));
    await ready({ initialAction: 'execute' });
    expect((within(dialog()).getByRole('combobox', { name: 'Action' }) as HTMLSelectElement).value).toBe('execute');
    expect(promptReads()[0].searchParams.get('action')).toBe('execute');
  });

  it('shows a refusal in the preview\'s place and keeps Start disabled for a skill that is gone', async () => {
    server.prompt = () => ({ status: 400, body: 'unknown skill s_deadbeef' });
    mount({ initialAction: { skill: 's_deadbeef' } });
    expect(await within(dialog()).findByText('unknown skill s_deadbeef')).toBeInTheDocument();
    expect(within(dialog()).queryByLabelText('Prompt')).not.toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/status')).toBe(true));
    await waitFor(() => expect(startButton()).toBeDisabled());
  });

  it('makes the preview read-only', async () => {
    await ready();
    expect(promptBox()).toHaveAttribute('readonly');
  });
});

describe('JiraLaunchSheet — permissions', () => {
  const modeSelect = (): HTMLSelectElement => within(dialog()).getByRole('combobox', { name: 'Permissions' }) as HTMLSelectElement;

  it('offers only the modes up to the ceiling and seeds execute with acceptEdits', async () => {
    await ready();
    expect([...modeSelect().options].map((o) => o.value)).toEqual(['plan', 'acceptEdits']);
    expect(modeSelect().value).toBe('acceptEdits');
  });

  it('seeds context with plan', async () => {
    await ready({ initialAction: 'context' });
    expect(modeSelect().value).toBe('plan');
  });

  it('never seeds above the ceiling', async () => {
    server.agents = agents({ spawnMaxPermission: 'plan' });
    await ready();
    await waitFor(() => expect(modeSelect().value).toBe('plan'));
    expect([...modeSelect().options].map((o) => o.value)).toEqual(['plan']);
  });
});

describe('JiraLaunchSheet — assign and move', () => {
  const assign = (): HTMLElement => within(dialog()).getByRole('switch', { name: 'Assign to me' });
  const move = (): HTMLSelectElement => within(dialog()).getByRole('combobox', { name: 'Move to' }) as HTMLSelectElement;

  it('disables Assign to me, with a reason, when the ticket is already mine', async () => {
    server.detail = detail({ assignee: ADA });
    await ready({ issue: { ...CARD, assignee: ADA } });
    expect(assign()).toBeDisabled();
    expect(assign()).toHaveAttribute('title', 'already assigned to you');
  });

  it('disables Assign to me while the identity is unknown', async () => {
    await ready({ status: { me: null } });
    expect(assign()).toBeDisabled();
    expect(assign()).toHaveAttribute('title', expect.stringMatching(/identity/));
  });

  it('sends assign false when the detail lands as already mine after the switch was toggled', async () => {
    let land: () => void = () => undefined;
    server.detailGate = new Promise<void>((resolve) => (land = resolve));
    server.detail = detail({ assignee: ADA });
    await ready();
    await userEvent.click(assign());
    expect(assign()).toBeChecked();
    land();
    await waitFor(() => expect(assign()).toBeDisabled());
    expect(assign()).not.toBeChecked();
    await userEvent.click(startButton());
    await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/dispatch-jira')).toBe(true));
    expect(dispatchBody().assign).toBe(false);
  });

  it('names Move to like the modal does — by the status landed in — with leave as is first', async () => {
    await ready();
    await waitFor(() => expect(move()).toBeEnabled());
    expect([...move().options].map((o) => o.textContent)).toEqual(['leave as is', 'In Progress', 'Done']);
    expect(move().value).toBe('');
  });

  it('sends transitionId null for leave as is, assign false, and no model or effort flag', async () => {
    await ready();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await userEvent.click(startButton());
    await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/dispatch-jira')).toBe(true));
    expect(dispatchBody()).toEqual({
      key: 'PAY-131',
      repo: '/Users/ada/pay',
      action: 'execute',
      assign: false,
      transitionId: null,
      mode: 'new',
      branch: 'pay-131-refund-partial-captures',
      base: 'develop',
      openMr: false,
      permissionMode: 'acceptEdits',
      remoteControl: true
    });
  });

  it('sends the picked transition, the assign switch, the picked model and effort, and a skill action', async () => {
    await ready({ initialAction: { skill: SKILL.id } });
    await waitFor(() => expect(move()).toBeEnabled());
    await userEvent.click(assign());
    await userEvent.selectOptions(move(), '31');
    await userEvent.selectOptions(within(dialog()).getByRole('combobox', { name: 'Model' }), 'opus');
    await userEvent.selectOptions(within(dialog()).getByRole('combobox', { name: 'Effort' }), 'high');
    await userEvent.selectOptions(within(dialog()).getByRole('combobox', { name: 'Permissions' }), 'plan');
    await userEvent.click(within(dialog()).getByRole('switch', { name: 'Remote control' }));
    await userEvent.click(startButton());
    await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/dispatch-jira')).toBe(true));
    expect(dispatchBody()).toEqual({
      key: 'PAY-131',
      repo: '/Users/ada/pay',
      action: { skill: SKILL.id },
      assign: true,
      transitionId: '31',
      mode: 'new',
      branch: 'pay-131-refund-partial-captures',
      base: 'develop',
      openMr: false,
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
      remoteControl: false
    });
  });
});

describe('JiraLaunchSheet — Start', () => {
  it('shows the server\'s sentence on a 409 and keeps Copy prompt', async () => {
    server.dispatch = { status: 409, body: { error: 'PAY-131 already has a live Run session' } };
    setClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
    await ready();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await userEvent.click(startButton());
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('PAY-131 already has a live Run session');
    expect(copyButton()).toBeInTheDocument();
    expect(onStarted).not.toHaveBeenCalled();
  });

  // M1 (final review): the server does assign, then transition, THEN the spawn (jira-dispatch.service.ts), so a spawn refused after a landed write says the write
  // stands. The ticket has moved though the sheet shows a refusal: it must tell the board and drop the `Move to` pick (the next Start would be a 400
  // `transition not offered`, since the fresh read no longer offers it).
  it('a refusal that says the writes stand reloads the board and puts Move to back to leave as is, the sheet staying open on the refusal', async () => {
    server.dispatch = { status: 502, body: { error: 'dashboard unreachable — the Jira writes stand' } };
    await ready();
    const moveTo = within(dialog()).getByRole('combobox', { name: 'Move to' }) as HTMLSelectElement;
    await waitFor(() => expect(moveTo).toBeEnabled());
    await userEvent.selectOptions(moveTo, '31');
    expect(moveTo.value).toBe('31');
    await userEvent.click(startButton());
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('dashboard unreachable — the Jira writes stand');
    expect(onWrote).toHaveBeenCalledTimes(1);
    expect(onStarted).not.toHaveBeenCalled();
    expect(moveTo.value).toBe('');
    expect(startButton()).toBeInTheDocument();
  });

  it('a failed transition after a landed assign ("the assign stands") counts the same', async () => {
    server.dispatch = { status: 502, body: { error: 'transition: Jira refused — the assign stands' } };
    await ready();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await userEvent.click(startButton());
    await within(dialog()).findByRole('alert');
    expect(onWrote).toHaveBeenCalledTimes(1);
  });

  it('a refusal before any write (400) changes nothing: no reload, and Move to keeps its pick', async () => {
    server.dispatch = { status: 400, body: { error: 'transition not offered' } };
    await ready();
    const moveTo = within(dialog()).getByRole('combobox', { name: 'Move to' }) as HTMLSelectElement;
    await waitFor(() => expect(moveTo).toBeEnabled());
    await userEvent.selectOptions(moveTo, '31');
    await userEvent.click(startButton());
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('transition not offered');
    expect(onWrote).not.toHaveBeenCalled();
    expect(moveTo.value).toBe('31');
  });

  it('on success links to the session and calls onStarted once', async () => {
    await ready();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await userEvent.click(startButton());
    const link = await within(dialog()).findByRole('link', { name: /open in dashboard/ });
    expect(link).toHaveAttribute('href', 'http://127.0.0.1:5174/?session=sess-9');
    expect(onStarted).toHaveBeenCalledTimes(1);
    // The form is gone on purpose: a second Start would be a second session on the same ticket (409 server side, but never offered).
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('sends one request for two clicks inside one tick', async () => {
    await ready();
    await waitFor(() => expect(startButton()).toBeEnabled());
    const el = startButton();
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(calls.filter((c) => c.url === '/api/agents/dispatch-jira')).toHaveLength(1);
  });
});

describe('JiraLaunchSheet — the branch', () => {
  const TWO = { repos: { PAY: ['/Users/ada/pay', '/Users/ada/pay-web'] } };
  const modeButton = (name: string): HTMLElement => within(within(dialog()).getByRole('group', { name: 'Branch mode' })).getByRole('button', { name });
  const pressed = (): string | null =>
    within(within(dialog()).getByRole('group', { name: 'Branch mode' }))
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent ?? null;
  const field = (name: string): HTMLInputElement | HTMLSelectElement => within(dialog()).getByLabelText(name) as HTMLInputElement | HTMLSelectElement;
  const mrSwitch = (): HTMLElement | null => within(dialog()).queryByRole('switch', { name: 'Open MR when done' });

  it('puts A\'s defaults back after A → B → A, not B\'s, and asks refs for each repository it lands on', async () => {
    server.refs = (repo) =>
      repo === '/Users/ada/pay'
        ? { status: 200, body: refsOf(repo, [refBranch('pay-131-a', { ticket: true })]) }
        : { status: 200, body: refsOf(repo, [], { defaultBase: 'main' }) };
    mount({ status: TWO });
    const repoSelect = await within(dialog()).findByRole('combobox', { name: 'Repository' });
    expect(modeButton('New')).toBeDisabled();

    await userEvent.selectOptions(repoSelect, '/Users/ada/pay');
    await waitFor(() => expect(pressed()).toBe('Continue'));
    expect(field('Branch').value).toBe('pay-131-a');

    await userEvent.selectOptions(repoSelect, '/Users/ada/pay-web');
    await waitFor(() => expect(pressed()).toBe('New'));
    expect(field('Name').value).toBe('pay-131-refund-partial-captures');
    expect(field('Base').value).toBe('main');

    await userEvent.selectOptions(repoSelect, '/Users/ada/pay');
    await waitFor(() => expect(pressed()).toBe('Continue'));
    expect(field('Branch').value).toBe('pay-131-a');
    const asked = calls.filter((c) => c.url.startsWith('/api/jira/refs')).map((c) => new URL(c.url, 'http://x').searchParams.get('repo'));
    expect(asked).toEqual(['/Users/ada/pay', '/Users/ada/pay-web', '/Users/ada/pay']);
  });

  // I1 (Task 8 review): going back to A before B's refs answer is still a repo change — A's refs landing again re-seed, whatever the person typed in A.
  it('puts A\'s defaults back after an edit in A and a quick A → B → A, B\'s refs never answering', async () => {
    server.refs = (repo) => (repo === '/Users/ada/pay' ? { status: 200, body: refsOf(repo) } : 'pending');
    mount({ status: TWO });
    const repoSelect = await within(dialog()).findByRole('combobox', { name: 'Repository' });
    await userEvent.selectOptions(repoSelect, '/Users/ada/pay');
    await waitFor(() => expect(pressed()).toBe('New'));
    await userEvent.clear(field('Name'));
    await userEvent.type(field('Name'), 'pay-131-edited');
    await userEvent.selectOptions(repoSelect, '/Users/ada/pay-web');
    expect(within(dialog()).getByText('loading branches…')).toBeInTheDocument();
    await userEvent.selectOptions(repoSelect, '/Users/ada/pay');
    await waitFor(() => expect(field('Name').value).toBe('pay-131-refund-partial-captures'));
  });

  it('an action change while B is pending does not leave B\'s stored defaults on A', async () => {
    server.refs = (repo) => (repo === '/Users/ada/pay' ? { status: 200, body: refsOf(repo, [refBranch('pay-131-a', { ticket: true })]) } : 'pending');
    mount({ status: { ...TWO, repoDefaults: { '/Users/ada/pay-web': { base: 'main', namePattern: 'feature/{key}-{slug}' } } } });
    const repoSelect = await within(dialog()).findByRole('combobox', { name: 'Repository' });
    await userEvent.selectOptions(repoSelect, '/Users/ada/pay');
    await waitFor(() => expect(pressed()).toBe('Continue'));
    await userEvent.selectOptions(repoSelect, '/Users/ada/pay-web');
    await userEvent.selectOptions(within(dialog()).getByRole('combobox', { name: 'Action' }), `skill:${SKILL.id}`);
    await userEvent.selectOptions(repoSelect, '/Users/ada/pay');
    await waitFor(() => expect(pressed()).toBe('Continue'));
    expect(field('Branch').value).toBe('pay-131-a');
  });

  it('falls back to the unavailable form, seeded from the stored defaults, when the refs request fails', async () => {
    server.refs = () => ({ status: 500, body: 'boom' });
    await ready({ status: { repoDefaults: { '/Users/ada/pay': { base: 'main', namePattern: 'feature/{key}-{slug}' } } } });
    expect(await within(dialog()).findByText(/branches unavailable/)).toBeInTheDocument();
    expect(field('Name').value).toBe('feature/pay-131-refund-partial-captures');
    expect(field('Base')).toHaveAttribute('type', 'text');
    expect(field('Base').value).toBe('main');
  });

  it('execute with ticket branches continues on the newest', async () => {
    server.refs = (repo) => ({
      status: 200,
      body: refsOf(repo, [refBranch('feature/pay-131-newest', { ticket: true }), refBranch('pay-131-older', { ticket: true })])
    });
    await ready();
    await waitFor(() => expect(pressed()).toBe('Continue'));
    expect(field('Branch').value).toBe('feature/pay-131-newest');
    // Ticket branches first, in their own group, then the rest.
    const groups = [...(field('Branch') as HTMLSelectElement).querySelectorAll('optgroup')];
    expect(groups.map((g) => [...g.querySelectorAll('option')].map((o) => o.value))).toEqual([
      ['feature/pay-131-newest', 'pay-131-older'],
      ['develop']
    ]);
  });

  it('execute with no ticket branch opens New, named from the pattern and cut from develop', async () => {
    await ready();
    await waitFor(() => expect(pressed()).toBe('New'));
    expect(field('Name').value).toBe('pay-131-refund-partial-captures');
    expect(field('Base').value).toBe('develop');
  });

  it('context opens on No branch; execute offers no No branch at all', async () => {
    await ready({ initialAction: 'context' });
    await waitFor(() => expect(pressed()).toBe('No branch'));
    await userEvent.selectOptions(within(dialog()).getByRole('combobox', { name: 'Action' }), 'execute');
    await waitFor(() => expect(pressed()).toBe('New'));
    expect(within(within(dialog()).getByRole('group', { name: 'Branch mode' })).queryByRole('button', { name: 'No branch' })).not.toBeInTheDocument();
  });

  it('refuses a typed name without the key, disabling Start and Copy prompt', async () => {
    setClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
    await ready();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await userEvent.clear(field('Name'));
    await userEvent.type(field('Name'), 'fix-login');
    expect(await within(dialog()).findByText('branch must carry PAY-131')).toBeInTheDocument();
    expect(startButton()).toBeDisabled();
    expect(startButton()).toHaveAttribute('title', 'branch must carry PAY-131');
    expect(copyButton()).toBeDisabled();
  });

  it('a name that exists offers the switch to Continue on it', async () => {
    server.refs = (repo) => ({ status: 200, body: refsOf(repo, [refBranch('pay-131-x', { ticket: true })]) });
    await ready();
    await waitFor(() => expect(pressed()).toBe('Continue'));
    await userEvent.click(modeButton('New'));
    await userEvent.clear(field('Name'));
    await userEvent.type(field('Name'), 'pay-131-x');
    expect(await within(dialog()).findByText('pay-131-x exists')).toBeInTheDocument();
    await waitFor(() => expect(startButton()).toBeDisabled());
    await userEvent.click(within(dialog()).getByRole('button', { name: 'switch to Continue' }));
    expect(pressed()).toBe('Continue');
    expect(field('Branch').value).toBe('pay-131-x');
    await waitFor(() => expect(startButton()).toBeEnabled());
  });

  it('refuses Continue on the branch the mapped checkout holds', async () => {
    server.refs = (repo) => ({ status: 200, body: refsOf(repo, [refBranch('pay-131-x', { ticket: true })]) });
    await ready();
    await waitFor(() => expect(pressed()).toBe('Continue'));
    await userEvent.selectOptions(field('Branch'), 'develop');
    expect(await within(dialog()).findByText('develop is checked out in the mapped checkout /Users/ada/pay')).toBeInTheDocument();
    expect(startButton()).toBeDisabled();
  });

  it('says where it will work when a linked tree holds the branch, and marks a behind copy', async () => {
    server.refs = (repo) => ({
      status: 200,
      body: refsOf(repo, [refBranch('pay-131-x', { ticket: true, worktree: '/r/.worktrees/x', sync: 'behind' })])
    });
    await ready();
    expect(await within(dialog()).findByText('will work in /r/.worktrees/x')).toBeInTheDocument();
    expect(within(dialog()).getByText('behind')).toBeInTheDocument();
  });

  // M7 (final review): the card and the modal find a tree by the key its branch carries, so a Continue on a key-less branch is said, not refused.
  it('says a Continue on a branch without the key makes a tree only Setup lists — never beside a refusal, and Start still goes', async () => {
    const hint = "this tree won't show on the card — it's listed under the repo in Setup";
    server.refs = (repo) => ({ status: 200, body: refsOf(repo, [refBranch('pay-131-x', { ticket: true }), refBranch('release-2')]) });
    await ready();
    await waitFor(() => expect(pressed()).toBe('Continue'));
    expect(within(dialog()).queryByText(hint)).toBeNull();

    await userEvent.selectOptions(field('Branch'), 'release-2');
    expect(within(dialog()).getByText(hint)).toHaveClass('sheet-note');
    await waitFor(() => expect(startButton()).toBeEnabled());

    // `develop` carries no key either, but the mapped checkout holds it: the refusal is the one sentence drawn.
    await userEvent.selectOptions(field('Branch'), 'develop');
    expect(await within(dialog()).findByText('develop is checked out in the mapped checkout /Users/ada/pay')).toBeInTheDocument();
    expect(within(dialog()).queryByText(hint)).toBeNull();
  });

  it('unavailable refs: the warning sentence, two text fields, and Start enabled', async () => {
    server.refs = (repo) => ({ status: 200, body: { repo, available: false, reason: 'not mounted into the board' } });
    await ready({ status: { repoDefaults: { '/Users/ada/pay': { base: 'develop' } } } });
    expect(await within(dialog()).findByText('branches unavailable — ~/pay not mounted into the board')).toBeInTheDocument();
    expect(field('Name')).toHaveAttribute('type', 'text');
    expect(field('Base')).toHaveAttribute('type', 'text');
    expect(field('Base').value).toBe('develop');
    await waitFor(() => expect(startButton()).toBeEnabled());
  });

  it('an empty base in the unavailable form is refused before Start', async () => {
    server.refs = (repo) => ({ status: 200, body: { repo, available: false, reason: 'does not exist' } });
    mount();
    expect(await within(dialog()).findByText('base is required for a new branch')).toBeInTheDocument();
    await waitFor(() => expect(startButton()).toBeDisabled());
    // A refused choice asks for no preview: the server would refuse it with the same sentence.
    expect(promptReads()).toHaveLength(0);
    expect(within(dialog()).getByText('fix the branch above to see the prompt')).toBeInTheDocument();
  });

  it('prints how old the branch list is: never fetched, or the fetch age', async () => {
    await ready();
    expect(await within(dialog()).findByText('never fetched')).toBeInTheDocument();
  });

  it('prints the age of the last fetch', async () => {
    server.refs = (repo) => ({ status: 200, body: refsOf(repo, [], { fetchedAt: new Date(Date.now() - 7 * 60_000).toISOString() }) });
    await ready();
    expect(await within(dialog()).findByText('as of last fetch, 7 min ago')).toBeInTheDocument();
  });

  it('draws Open MR only for execute with a branch, and Target only with Continue', async () => {
    server.refs = (repo) => ({ status: 200, body: refsOf(repo, [refBranch('pay-131-x', { ticket: true })]) });
    await ready({ initialAction: 'context' });
    await waitFor(() => expect(pressed()).toBe('No branch'));
    expect(mrSwitch()).not.toBeInTheDocument();
    await userEvent.click(modeButton('New'));
    expect(mrSwitch()).not.toBeInTheDocument();

    await userEvent.selectOptions(within(dialog()).getByRole('combobox', { name: 'Action' }), 'execute');
    await waitFor(() => expect(pressed()).toBe('Continue'));
    await userEvent.click(modeButton('New'));
    expect(mrSwitch()).not.toBeChecked();
    await userEvent.click(mrSwitch() as HTMLElement);
    expect(within(dialog()).queryByLabelText('Target')).not.toBeInTheDocument();
    await userEvent.click(modeButton('Continue'));
    expect(field('Target').value).toBe('develop');
  });

  // M1 (Task 8 review): a default base the list does not hold by name is still what the Target select shows — displayed is what Start sends.
  it('shows a default target the list lacks rather than the first option', async () => {
    server.refs = (repo) => ({ status: 200, body: refsOf(repo, [refBranch('pay-131-x', { ticket: true })], { defaultBase: 'origin/develop' }) });
    await ready();
    await waitFor(() => expect(pressed()).toBe('Continue'));
    await userEvent.click(mrSwitch() as HTMLElement);
    expect(field('Target').value).toBe('origin/develop');
  });

  // M3 (Task 8 review): Continue on a repo with no ticket branch opens on `choose…`, and says so in those words rather than as Table A's `branch is empty`.
  it('asks for a branch to continue when none is chosen', async () => {
    await ready();
    await waitFor(() => expect(pressed()).toBe('New'));
    await userEvent.click(modeButton('Continue'));
    expect(within(dialog()).getByText('choose a branch to continue')).toBeInTheDocument();
    expect(startButton()).toBeDisabled();
  });

  it('Start sends the five flat fields, and the preview asked with the same choice', async () => {
    server.refs = (repo) => ({ status: 200, body: refsOf(repo, [refBranch('pay-131-x', { ticket: true })]) });
    await ready();
    await waitFor(() => expect(pressed()).toBe('Continue'));
    await userEvent.click(mrSwitch() as HTMLElement);
    await waitFor(() => expect(promptReads().at(-1)?.searchParams.get('openMr')).toBe('true'));
    const last = promptReads().at(-1) as URL;
    expect(Object.fromEntries(last.searchParams)).toEqual({
      key: 'PAY-131',
      action: 'execute',
      repo: '/Users/ada/pay',
      mode: 'continue',
      branch: 'pay-131-x',
      openMr: 'true',
      target: 'develop'
    });
    await waitFor(() => expect(startButton()).toBeEnabled());
    await userEvent.click(startButton());
    await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/dispatch-jira')).toBe(true));
    expect(dispatchBody()).toEqual({
      key: 'PAY-131',
      repo: '/Users/ada/pay',
      action: 'execute',
      assign: false,
      transitionId: null,
      mode: 'continue',
      branch: 'pay-131-x',
      openMr: true,
      target: 'develop',
      permissionMode: 'acceptEdits',
      remoteControl: true
    });
  });
});

/*
  I1 (final review): the preview is keyed on the branch choice, and every keystroke in Name, Base or Target used to be a fresh `GET /api/jira/prompt` — an
  issue read (three Jira calls) and a refs read (several git spawns) per character. A typed choice now settles for `PREVIEW_SETTLE_MS` before it is asked
  about, and Start stays gated on a prompt composed for the CURRENT choice. Fake timers from the moment the first preview has landed: the debounce is the
  clock under test, and `fireEvent.change` is five keystrokes inside one tick of it.
*/
describe('JiraLaunchSheet — the preview settles before it is asked', () => {
  const nameField = (): HTMLInputElement => within(dialog()).getByLabelText('Name') as HTMLInputElement;
  const modeButton = (name: string): HTMLElement => within(within(dialog()).getByRole('group', { name: 'Branch mode' })).getByRole('button', { name });
  const typeFast = (base: string, chars: string): void => {
    for (let i = 1; i <= chars.length; i++) fireEvent.change(nameField(), { target: { value: base + chars.slice(0, i) } });
  };
  /** Advances the fake clock and lets the mocked fetch's promise chain settle inside the same act. */
  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  };

  it('settles on a constant between 300 and 400 ms', () => {
    expect(PREVIEW_SETTLE_MS).toBeGreaterThanOrEqual(300);
    expect(PREVIEW_SETTLE_MS).toBeLessThanOrEqual(400);
  });

  it('typing five characters fast asks for exactly one preview, after the debounce, for the last value', async () => {
    await ready();
    await waitFor(() => expect(nameField().value).toBe('pay-131-refund-partial-captures'));
    const before = promptReads().length;
    jest.useFakeTimers();
    typeFast('pay-131-', 'abcde');
    await advance(PREVIEW_SETTLE_MS - 1);
    expect(promptReads()).toHaveLength(before);
    await advance(1);
    expect(promptReads()).toHaveLength(before + 1);
    expect(promptReads().at(-1)?.searchParams.get('branch')).toBe('pay-131-abcde');
    // Nothing else is queued behind it: a further wait asks nothing more.
    await advance(PREVIEW_SETTLE_MS * 4);
    expect(promptReads()).toHaveLength(before + 1);
  });

  it('keeps Start disabled through the debounce window and enables it once the preview answers', async () => {
    await ready();
    await waitFor(() => expect(startButton()).toBeEnabled());
    jest.useFakeTimers();
    typeFast('pay-131-', 'xy');
    // The previous preview was for another name: Start never offers it, not even for the first frame.
    expect(startButton()).toBeDisabled();
    expect(startButton()).toHaveAttribute('title', 'the prompt has not loaded');
    await advance(1);
    expect(startButton()).toBeDisabled();
    await advance(PREVIEW_SETTLE_MS - 2);
    expect(startButton()).toBeDisabled();
    await advance(1);
    expect(startButton()).toBeEnabled();
    expect(promptBox().value).toBe('prompt for execute in /Users/ada/pay');
  });

  it('Start sends exactly the choice the preview was composed for', async () => {
    await ready();
    jest.useFakeTimers();
    typeFast('pay-131-', 'fix');
    await advance(PREVIEW_SETTLE_MS);
    expect(startButton()).toBeEnabled();
    await act(async () => {
      fireEvent.click(startButton());
    });
    const previewed = Object.fromEntries((promptReads().at(-1) as URL).searchParams);
    const body = dispatchBody();
    expect(previewed).toEqual({ key: 'PAY-131', action: 'execute', repo: '/Users/ada/pay', mode: 'new', branch: 'pay-131-fix', base: 'develop' });
    expect({ key: body.key, action: body.action, repo: body.repo, mode: body.mode, branch: body.branch, base: body.base }).toEqual(previewed);
  });

  it('a mode switch is asked about at once — only typing waits', async () => {
    server.refs = (repo) => ({ status: 200, body: refsOf(repo, [refBranch('pay-131-x', { ticket: true })]) });
    await ready();
    await waitFor(() => expect(startButton()).toBeEnabled());
    const before = promptReads().length;
    jest.useFakeTimers();
    await act(async () => {
      fireEvent.click(modeButton('New'));
    });
    expect(promptReads()).toHaveLength(before + 1);
    expect(promptReads().at(-1)?.searchParams.get('mode')).toBe('new');
    expect(startButton()).toBeEnabled();
  });
});

describe('JiraLaunchSheet — Copy prompt', () => {
  it('copies the preview and reads Copied for two seconds', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await ready();
    jest.useFakeTimers();
    const text = promptBox().value;
    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect(writeText).toHaveBeenCalledWith(text);
    expect(within(dialog()).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(within(dialog()).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(2);
    });
    expect(within(dialog()).getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
  });

  it('is absent without a clipboard API, and the preview stays selectable text', async () => {
    await ready();
    expect(within(dialog()).queryByRole('button', { name: /Copy prompt|Copied/ })).not.toBeInTheDocument();
    expect(promptBox()).not.toBeDisabled();
  });

  it('is disabled while there is no prompt to copy', async () => {
    server.prompt = () => ({ status: 400, body: 'prompt too long' });
    setClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
    mount();
    await within(dialog()).findByText('prompt too long');
    expect(copyButton()).toBeDisabled();
  });
});
