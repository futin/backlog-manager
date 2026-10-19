/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraLaunchSheet } from '../client/src/components/jira/JiraLaunchSheet';
import { JiraContext } from '../client/src/hooks/JiraContext';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { daysAgoStamp } from './helpers/dates';
import type { AgentsStatus, JiraAction, JiraDispatchResult, JiraIssue, JiraIssueDetail, JiraStatusPayload } from '../shared/types';

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
  dispatch: { status: number; body: unknown };
  /** When set, the detail read answers only once this settles — a case's way to act before the detail lands. */
  detailGate?: Promise<void>;
}

let server: Server;
let calls: { url: string; init?: RequestInit }[];

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

function mount(opts: { initialAction?: JiraAction | null; status?: Partial<JiraStatusPayload>; issue?: JiraIssue } = {}) {
  onClose = jest.fn();
  onStarted = jest.fn();
  const tree = (status?: Partial<JiraStatusPayload>) => (
    <SettingsProvider>
      <JiraContext.Provider value={{ data: jiraStatus(status), loading: false, error: false, reload: jest.fn() }}>
        <JiraLaunchSheet issue={opts.issue ?? CARD} initialAction={opts.initialAction ?? null} onClose={onClose} onStarted={onStarted} />
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
  it('seeds the action from jiraDefaultAction and refetches the preview, stale answer dropped, when it changes', async () => {
    localStorage.setItem('backlog-manager.settings', JSON.stringify({ jiraDefaultAction: 'context' }));
    await ready();
    expect(promptReads()[0].searchParams.get('action')).toBe('context');

    await userEvent.selectOptions(within(dialog()).getByRole('combobox', { name: 'Action' }), `skill:${SKILL.id}`);
    await waitFor(() => expect(promptBox().value).toBe(`prompt for skill:${SKILL.id} in /Users/ada/pay`));
    expect(calls.map((c) => c.url)).toContain(`/api/jira/prompt?key=PAY-131&action=skill%3A${SKILL.id}&repo=%2FUsers%2Fada%2Fpay`);
  });

  it('seeds the action from initialAction ahead of the setting', async () => {
    await ready({ initialAction: 'context' });
    expect((within(dialog()).getByRole('combobox', { name: 'Action' }) as HTMLSelectElement).value).toBe('context');
    expect(promptReads()[0].searchParams.get('action')).toBe('context');
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
