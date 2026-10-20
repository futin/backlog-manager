/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import type { ComponentType } from 'react';

import { App } from '../client/src/App';
import { JiraProvider } from '../client/src/hooks/JiraContext';
import { JIRA_STATUS_FLOOR_MS } from '../client/src/hooks/useJira';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { JIRA_PAGE_KEY } from '../client/src/lib/jira-page';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';
import type { JiraStatusPayload } from '../shared/types';

/*
  The Jira section in the shell (Jira phase 2; spec §6.1; DESIGN.md §8.0 and §8.9): `jira` in `SECTIONS`, its rail row drawn only while
  `GET /api/jira` says `configured: true`, its Board/Setup tree, and the shell's hold-and-fall — a held `jira` section stays put while the status is unknown
  or failing, and only an answer that says `configured: false` moves the shell to `board`.

  Board and Settings are stubbed for `nav.test.tsx`'s reason: the subject is the shell, and the real views would bring their own fetches and clocks to
  assert nothing about it. The two Jira PAGES are stubbed too, for the same reason — this suite owns which page the section picks and that the section's
  own frame draws no page switch; what each page draws (and that IT draws no switch either) is `jira-board.test.tsx`'s and `jira-setup.test.tsx`'s.
  `JiraView` itself — the section, its loading and unavailable shapes — is real. The one Settings case that needs the real `Opens on` select reaches it
  through `jest.requireActual`.

  `/api/jira` is answered per case: a payload, a 500, a network error, or a promise that never settles. Every other URL gets a 200 that no hook accepts as
  its payload, which lands them on their own `error` path and nothing else.
*/
jest.mock('../client/src/components/board/BoardView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'board stub')
}));
jest.mock('../client/src/components/settings/SettingsView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'settings stub')
}));
jest.mock('../client/src/components/jira/JiraBoardView', () => ({
  __esModule: true,
  JiraBoardView: () => require('react').createElement('div', null, 'jira board stub')
}));
jest.mock('../client/src/components/jira/JiraSetupView', () => ({
  __esModule: true,
  JiraSetupView: () => require('react').createElement('div', null, 'jira setup stub')
}));

const SECTION_KEY = 'backlog-manager.section';
const storeSection = (raw: string): void => localStorage.setItem(SECTION_KEY, JSON.stringify(raw));
const storedSection = (): unknown => JSON.parse(localStorage.getItem(SECTION_KEY) ?? 'null');
const storedJiraPage = (): unknown => JSON.parse(localStorage.getItem(JIRA_PAGE_KEY) ?? 'null');

function status(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'x.atlassian.net',
    me: { accountId: 'a1', name: 'Ada' },
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [],
    repos: {},
    repoDefaults: {},
    projects: [],
    skills: [],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: false,
    home: '/home/x',
    ...over
  };
}

const UNCONFIGURED = status({ configured: false, site: null, me: null, tokenKind: null, access: 'unconfigured', home: null });

type JiraAnswer = JiraStatusPayload | 500 | 'network' | 'pending';
let jiraAnswer: JiraAnswer;

const answer = (body: unknown, ok = true, statusCode = 200) =>
  Promise.resolve({ ok, status: statusCode, json: () => Promise.resolve(body) } as Response);

beforeEach(() => {
  localStorage.clear();
  jiraAnswer = status();
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    if (String(input) === '/api/jira') {
      if (jiraAnswer === 'pending') return new Promise<Response>(() => {});
      if (jiraAnswer === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      if (jiraAnswer === 500) return answer({ error: 'boom' }, false, 500);
      return answer(jiraAnswer);
    }
    return answer({ ok: true });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

const rail = (): HTMLElement => screen.getByRole('navigation', { name: 'Sections' });
const railLinks = (): string[] =>
  within(rail())
    .getAllByRole('button')
    .filter((b) => b.classList.contains('rail-link'))
    .map((b) => b.textContent ?? '');
const main = (): HTMLElement => document.querySelector('main') as HTMLElement;

/** Lets the lazy chunk, the status fetch and its `.json()` settle without `findBy`, whose `waitFor` would advance a fake clock on its own. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

describe('the Jira rail entry', () => {
  it('is absent while the status says configured: false', async () => {
    jiraAnswer = UNCONFIGURED;
    render(<App />);
    await screen.findByText('board stub');
    await flush();
    expect(railLinks()).toEqual(['Board', 'Runs', 'Archive', 'Settings']);
  });

  it('is drawn between Archive and Settings while the status says configured: true', async () => {
    render(<App />);
    await screen.findByText('board stub');
    await flush();
    expect(railLinks()).toEqual(['Board', 'Runs', 'Archive', 'Jira', 'Settings']);
  });

  it('is absent while the status has not answered and Jira is not the section', async () => {
    jiraAnswer = 'pending';
    render(<App />);
    await screen.findByText('board stub');
    expect(railLinks()).toEqual(['Board', 'Runs', 'Archive', 'Settings']);
  });
});

describe('the Jira section and its tree', () => {
  it('opens on the Jira link, with the Board/Setup tree under it, and the tree alone switches pages', async () => {
    render(<App />);
    await screen.findByText('board stub');
    await flush();
    await userEvent.click(within(rail()).getByRole('button', { name: 'Jira' }));
    expect(await screen.findByText('jira board stub')).toBeInTheDocument();
    expect(storedSection()).toBe('jira');

    const tree = within(rail()).getByRole('group', { name: 'Jira pages' });
    expect(
      within(tree)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Board', 'Setup']);
    expect(within(tree).getByRole('button', { name: 'Board' })).toHaveAttribute('aria-current', 'true');

    await userEvent.click(within(tree).getByRole('button', { name: 'Setup' }));
    expect(await screen.findByText('jira setup stub')).toBeInTheDocument();
    expect(screen.queryByText('jira board stub')).toBeNull();
    expect(storedJiraPage()).toBe('setup');
    expect(within(tree).getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-current', 'true');

    // The section's own frame restates no page switch (the Runs/Settings rule).
    expect(within(main()).queryByRole('button', { name: 'Board' })).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Setup' })).toBeNull();
  });

  it('opens on the stored page', async () => {
    storeSection('jira');
    localStorage.setItem(JIRA_PAGE_KEY, JSON.stringify('setup'));
    render(<App />);
    expect(await screen.findByText('jira setup stub')).toBeInTheDocument();
  });
});

describe("the shell's hold-and-fall", () => {
  it('falls to the Board when the status says configured: false under a stored jira section', async () => {
    storeSection('jira');
    jiraAnswer = UNCONFIGURED;
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(storedSection()).toBe('board');
    expect(railLinks()).toEqual(['Board', 'Runs', 'Archive', 'Settings']);
  });

  it('holds Jira in its loading state while the status has not answered', async () => {
    storeSection('jira');
    jiraAnswer = 'pending';
    render(<App />);
    await flush();
    expect(screen.queryByText('board stub')).toBeNull();
    // JiraView's own loading line, not the shell's Suspense fallback (that one is a `role="status"` with a spinner): the chunk has loaded.
    const loading = within(main()).getByText('loading…');
    expect(loading).toHaveClass('board-empty');
    expect(loading).not.toHaveAttribute('role');
    // The held section keeps its rail row, marked current, so the reader can see where they are.
    expect(within(rail()).getByRole('button', { name: 'Jira' })).toHaveAttribute('aria-current', 'page');
    expect(storedSection()).toBe('jira');
  });

  // Review Focus 5.
  it('holds Jira in the unavailable shape through a 500 and a network error, and falls only on configured: false', async () => {
    jest.useFakeTimers();
    storeSection('jira');
    jiraAnswer = 500;
    render(<App />);
    await flush();
    expect(screen.queryByText('board stub')).toBeNull();
    expect(within(main()).getByText('Jira unavailable')).toHaveClass('board-empty');
    expect(within(rail()).getByRole('button', { name: 'Jira' })).toHaveAttribute('aria-current', 'page');
    expect(storedSection()).toBe('jira');

    jiraAnswer = 'network';
    await advance(JIRA_STATUS_FLOOR_MS);
    expect(screen.queryByText('board stub')).toBeNull();
    expect(within(main()).getByText('Jira unavailable')).toBeInTheDocument();
    expect(storedSection()).toBe('jira');

    jiraAnswer = UNCONFIGURED;
    await advance(JIRA_STATUS_FLOOR_MS);
    expect(screen.getByText('board stub')).toBeInTheDocument();
    expect(storedSection()).toBe('board');
    expect(within(rail()).queryByRole('button', { name: 'Jira' })).toBeNull();
  });

  it('keeps a configured section on its page through a later failed read', async () => {
    jest.useFakeTimers();
    storeSection('jira');
    render(<App />);
    await flush();
    expect(screen.getByText('jira board stub')).toBeInTheDocument();
    jiraAnswer = 500;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    // useJira keeps the last answer through a failure, so the page stays drawn and the rail row stays.
    expect(screen.getByText('jira board stub')).toBeInTheDocument();
    expect(within(rail()).getByRole('button', { name: 'Jira' })).toBeInTheDocument();
  });

  it('a pinned jira landing on a machine whose status says configured: false opens on the Board', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ landing: 'jira' }));
    storeSection('runs');
    jiraAnswer = UNCONFIGURED;
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(storedSection()).toBe('board');
  });

  it('a pinned jira landing on a configured machine opens on Jira', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ landing: 'jira' }));
    render(<App />);
    expect(await screen.findByText('jira board stub')).toBeInTheDocument();
  });
});

describe('Settings › Local › Opens on', () => {
  const RealSettingsView = (jest.requireActual('../client/src/components/settings/SettingsView') as { default: ComponentType }).default;

  function renderSettings(): void {
    render(
      <SettingsProvider>
        <JiraProvider>
          <RealSettingsView />
        </JiraProvider>
      </SettingsProvider>
    );
  }

  const options = (): string[] =>
    within(screen.getByLabelText('Opens on'))
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');

  it('offers Jira, in rail order, while the status says configured', async () => {
    renderSettings();
    await flush();
    expect(options()).toEqual(['Last used', 'Board', 'Runs', 'Archive', 'Jira', 'Settings']);
    await userEvent.selectOptions(screen.getByLabelText('Opens on'), 'jira');
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').landing).toBe('jira');
  });

  it('does not offer Jira while the status says configured: false, or before it answers', async () => {
    jiraAnswer = UNCONFIGURED;
    renderSettings();
    expect(options()).toEqual(['Last used', 'Board', 'Runs', 'Archive', 'Settings']);
    await flush();
    expect(options()).toEqual(['Last used', 'Board', 'Runs', 'Archive', 'Settings']);
  });

  it('keeps a stored jira landing visible on an unconfigured machine rather than drawing a blank select', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ landing: 'jira' }));
    jiraAnswer = UNCONFIGURED;
    renderSettings();
    await flush();
    expect(options()).toEqual(['Last used', 'Board', 'Runs', 'Archive', 'Jira', 'Settings']);
    expect(screen.getByLabelText('Opens on')).toHaveValue('jira');
  });
});
