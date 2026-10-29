/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { App } from '../client/src/App';
import { FILES_PAGE_KEY, GITHUB_PAGE_KEY } from '../client/src/lib/source-page';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';

/*
  The shell's source sections (source-sections spec: "The rail after the change", Fallback, "Migrating stored values"): which section a stored value,
  a legacy name or a landing pin opens on, how that settles on the projects answer, and how a section whose row vanishes falls.

  The views are stubbed, as `nav.test.tsx` stubs them: the subject is which section and page the SHELL picks, and each stub's whole content is a findable
  string. GitHub › Settings is left real — it is this change's own page, and its landmark is its `Sync` card (each repo's sync interval).
  `/api/projects` is answered per case: an array, a 500, or a promise the case resolves by hand; `/api/jira` answers the unconfigured status only where a
  case asks for it, and every other URL a 200 no hook accepts as its payload.
*/
jest.mock('../client/src/components/board/BoardView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'board stub')
}));
jest.mock('../client/src/components/archive/ArchiveView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'archive stub')
}));
jest.mock('../client/src/components/runs/RunsView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'runs stub')
}));
jest.mock('../client/src/components/settings/SettingsView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'settings stub')
}));
jest.mock('../client/src/components/github/PullRequestsView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'prs stub')
}));

const SECTION_KEY = 'backlog-manager.section';
const store = (key: string, value: unknown): void => localStorage.setItem(key, JSON.stringify(value));
const stored = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? 'null');

const project = (name: string, source: 'files' | 'github') => ({
  name,
  path: `/abs/${name}`,
  createdAt: '2026-08-26T00:00:00.000Z',
  missing: false,
  counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
  source
});
const FILES = [project('alpha', 'files')];
const GITHUB = [project('beta', 'github')];
const BOTH = [...FILES, ...GITHUB];

const UNCONFIGURED_JIRA = {
  configured: false,
  configUnreadable: null,
  site: null,
  me: null,
  tokenKind: null,
  access: 'unconfigured',
  detail: null,
  boards: [],
  repos: {},
  repoDefaults: {},
  projects: [],
  skills: [],
  calls: { sweep: 0, last429At: null },
  live: {},
  armed: false,
  home: null
};

/** A promise the case settles by hand, for the "held unresolved first" cases. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let projectsAnswer: unknown[] | 500 | Promise<unknown[]>;
let jiraUnconfigured: boolean;

const answer = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);

beforeEach(() => {
  localStorage.clear();
  projectsAnswer = BOTH;
  jiraUnconfigured = false;
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/projects') {
      // Read at call time, so a case can change the answer between a mount read and a focus reload.
      const a = projectsAnswer;
      if (a === 500) return answer({ error: 'boom' }, false, 500);
      if (a instanceof Promise) return a.then((body) => answer(body));
      return answer(a);
    }
    if (url === '/api/jira' && jiraUnconfigured) return answer(UNCONFIGURED_JIRA);
    return answer({ ok: true });
  }) as unknown as typeof fetch;
});

const rail = (): HTMLElement => screen.getByRole('navigation', { name: 'Sections' });
const rows = (): string[] =>
  within(rail())
    .getAllByRole('button')
    .filter((b) => b.classList.contains('rail-link'))
    .map((b) => b.textContent ?? '');
const current = (): string | null =>
  within(rail())
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-current') === 'page')?.textContent ?? null;

/** Lets the lazy chunks, the fetches and their `.json()` settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('settling a provisional landing', () => {
  it('legacy board settles on Files when no github project', async () => {
    store(SECTION_KEY, 'board');
    const held = deferred<unknown[]>();
    projectsAnswer = held.promise;
    render(<App />);
    await flush();

    // The guess is GitHub, but no source row is drawn on a guess — not even GitHub's — and nothing is painted that the answer could take back.
    expect(rows()).not.toContain('GitHub');
    expect(rows()).not.toContain('Files');
    expect(screen.queryByText('board stub')).toBeNull();

    await act(async () => held.resolve(FILES));
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(current()).toBe('Files');
    expect(rows()).not.toContain('GitHub');
    expect(stored(SECTION_KEY)).toBe('files');
  });

  it('first load draws no source row until projects answer', async () => {
    const held = deferred<unknown[]>();
    projectsAnswer = held.promise;
    render(<App />);
    await flush();
    expect(rows()).toEqual(['Runs', 'Settings']);
    expect(screen.queryByText('board stub')).toBeNull();

    await act(async () => held.resolve(FILES));
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(current()).toBe('Files');
    expect(stored(SECTION_KEY)).toBe('files');
  });

  it('legacy archive settles on GitHub archive', async () => {
    store(SECTION_KEY, 'archive');
    projectsAnswer = GITHUB;
    render(<App />);
    expect(await screen.findByText('archive stub')).toBeInTheDocument();
    expect(current()).toBe('GitHub');
    expect(stored(SECTION_KEY)).toBe('github');
    expect(stored(GITHUB_PAGE_KEY)).toBe('archive');
  });

  it('legacy archive settles on Files archive when no github project', async () => {
    store(SECTION_KEY, 'archive');
    projectsAnswer = FILES;
    render(<App />);
    expect(await screen.findByText('archive stub')).toBeInTheDocument();
    expect(current()).toBe('Files');
    expect(stored(SECTION_KEY)).toBe('files');
    expect(stored(FILES_PAGE_KEY)).toBe('archive');
  });

  it('nothing registered opens on Runs', async () => {
    projectsAnswer = [];
    render(<App />);
    expect(await screen.findByText('runs stub')).toBeInTheDocument();
    expect(rows()).toEqual(['Runs', 'Settings']);
    expect(stored(SECTION_KEY)).toBe('runs');
  });

  /*
    A legacy `board` pin is provisional — `clampSettings` maps it to `github`, but the reader never chose GitHub — so it settles like a stored legacy
    section. A real `github` pin is a section the reader chose: held through an unknown answer, its row drawn, like a stored section (RF2).
  */
  it('legacy board pin settles; real github pin holds', async () => {
    store(SETTINGS_STORAGE_KEY, { landing: 'board' });
    projectsAnswer = FILES;
    const first = render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(current()).toBe('Files');
    first.unmount();

    localStorage.clear();
    store(SETTINGS_STORAGE_KEY, { landing: 'github' });
    projectsAnswer = 500;
    render(<App />);
    await flush();
    expect(screen.getByText('board stub')).toBeInTheDocument();
    expect(current()).toBe('GitHub');
    expect(rows()).toContain('GitHub');
  });
  /*
    The legacy pin is settled in Settings too, not only on screen: left as the `github` `clampSettings` maps it to, the first `update()` from anywhere would
    write that down as a real GitHub pin, and every later load on a files-only machine would draw a held GitHub row and board before the answer.
  */
  it('legacy board pin is rewritten to its settled source, so the next load draws no GitHub row', async () => {
    store(SETTINGS_STORAGE_KEY, { landing: 'board' });
    projectsAnswer = FILES;
    const first = render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    expect(current()).toBe('Files');
    await flush();
    expect((stored(SETTINGS_STORAGE_KEY) as { landing: unknown }).landing).toBe('files');
    first.unmount();

    const held = deferred<unknown[]>();
    projectsAnswer = held.promise;
    render(<App />);
    await flush();
    expect(rows()).not.toContain('GitHub');
    expect(current()).toBe('Files');

    await act(async () => held.resolve(FILES));
    await flush();
    expect(rows()).not.toContain('GitHub');
    expect(current()).toBe('Files');
  });
});

describe('holding and falling', () => {
  it('unknown projects answer holds the stored source section', async () => {
    store(SECTION_KEY, 'github');
    projectsAnswer = 500;
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    await flush();
    expect(current()).toBe('GitHub');
    expect(rows()).toContain('GitHub');
    expect(stored(SECTION_KEY)).toBe('github');
  });

  it('github row vanishing falls to the first drawn source', async () => {
    store(SECTION_KEY, 'github');
    projectsAnswer = GITHUB;
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    await flush();
    expect(current()).toBe('GitHub');

    projectsAnswer = FILES;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(current()).toBe('Files');
    expect(rows()).not.toContain('GitHub');
    expect(screen.getByText('board stub')).toBeInTheDocument();
    expect(stored(SECTION_KEY)).toBe('files');

    projectsAnswer = [];
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(await screen.findByText('runs stub')).toBeInTheDocument();
    expect(current()).toBe('Runs');
    expect(stored(SECTION_KEY)).toBe('runs');
  });

  it('jira fall uses the source fallback', async () => {
    store(SECTION_KEY, 'jira');
    jiraUnconfigured = true;
    projectsAnswer = GITHUB;
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    await flush();
    expect(current()).toBe('GitHub');
    expect(stored(SECTION_KEY)).toBe('github');
  });
});

describe('each source page renders its view', () => {
  it.each([
    ['files', FILES_PAGE_KEY, 'board', 'board stub'],
    ['files', FILES_PAGE_KEY, 'archive', 'archive stub'],
    ['github', GITHUB_PAGE_KEY, 'board', 'board stub'],
    ['github', GITHUB_PAGE_KEY, 'prs', 'prs stub'],
    ['github', GITHUB_PAGE_KEY, 'archive', 'archive stub'],
    ['github', GITHUB_PAGE_KEY, 'settings', 'Sync']
  ])('%s › %s', async (section, key, page, landmark) => {
    store(SECTION_KEY, section);
    store(key, page);
    render(<App />);
    expect(await screen.findByText(landmark)).toBeInTheDocument();
    await flush();
    const tree = screen.getByRole('group', { name: section === 'files' ? 'Files pages' : 'GitHub pages' });
    const marked = within(tree)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'true')
      .map((b) => b.textContent);
    expect(marked).toEqual([page === 'prs' ? 'PRs' : page[0].toUpperCase() + page.slice(1)]);
  });

  it('picking PRs in the GitHub tree renders the PRs view and stores the page', async () => {
    store(SECTION_KEY, 'github');
    store(GITHUB_PAGE_KEY, 'board');
    render(<App />);
    expect(await screen.findByText('board stub')).toBeInTheDocument();
    await flush();
    const tree = screen.getByRole('group', { name: 'GitHub pages' });
    act(() => {
      within(tree).getByRole('button', { name: 'PRs' }).click();
    });
    expect(await screen.findByText('prs stub')).toBeInTheDocument();
    expect(screen.queryByText('board stub')).toBeNull();
    expect(stored(GITHUB_PAGE_KEY)).toBe('prs');
  });
});
