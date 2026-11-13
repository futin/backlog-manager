/**
 * @jest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { SourcesGroup } from '../client/src/components/settings/SourcesGroup';
import { GitlabContext } from '../client/src/hooks/GitlabContext';
import { JiraContext } from '../client/src/hooks/JiraContext';
import { ProjectsContext } from '../client/src/hooks/ProjectsContext';
import type { DrawnSources } from '../client/src/lib/sources';
import type { JiraState } from '../client/src/hooks/useJira';
import { TrackersProvider } from '../client/src/hooks/TrackersContext';
import type { GitlabPayload, GitlabStatus, JiraBoardStatus, JiraStatusPayload, TrackerPlatform, TrackerProjectRow, TrackersPayload } from '../shared/types';

/**
 * Settings › Shared's `Sources · this machine` card (source-sections spec): one read-only row per source — Files, GitHub, Jira, GitLab — saying
 * what is connected on this machine and whether it works. It took the old Trackers card's reports (the token / login / rate-limit line, each github repo's
 * reach, each files project's `backlog.mjs connect` command, the Jira row); the sync pickers went to GitHub › Settings (`github-settings.test.tsx`).
 *
 * Mounted under the real `TrackersProvider`, so the card reads the shell's own `useTrackers` answer; Jira's status is handed in through its context.
 */

function row(over: Partial<TrackerProjectRow> = {}): TrackerProjectRow {
  return {
    name: 'alpha',
    path: '/abs/alpha',
    source: 'github',
    repo: 'futin/x',
    polledAt: null,
    access: 'ok',
    detail: null,
    interval: '1m',
    connect: null,
    ...over
  };
}

const CONNECT = 'node skills/backlog/tools/backlog.mjs connect github futin/beta';
const beta = row({ name: 'beta', path: '/abs/beta', source: 'files', repo: null, access: null, interval: null, connect: CONNECT });
const gamma = row({ name: 'gamma', path: '/abs/gamma', source: 'unsupported', repo: null, access: null, interval: null, connect: null });

const TOKEN: TrackerPlatform = { kind: 'github', hasToken: true, login: 'futin', limit: 5000, remaining: 4930, reset: null };

let payload: TrackersPayload;

function stubFetch(): void {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response)) as jest.Mock;
}

function jiraBoard(id: string): JiraBoardStatus {
  return { id, name: id, roots: ['PLAT-1'], queries: [], interval: '1m', polledAt: null, count: 0, truncated: false, failures: [] };
}

function jiraStatus(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: { accountId: 'a1', name: 'Ada' },
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [jiraBoard('b_00000001'), jiraBoard('b_00000002')],
    repos: {},
    repoDefaults: {},
    projects: [],
    skills: [],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: true,
    home: '/home/x',
    ...over
  };
}

const UNCONFIGURED = jiraStatus({ configured: false, site: null, me: null, access: 'unconfigured', boards: [], home: null });

function gitlabStatus(over: Partial<GitlabStatus> = {}): GitlabStatus {
  return {
    state: 'unconfigured',
    site: null,
    malformedSite: false,
    user: null,
    httpStatus: null,
    reason: null,
    armed: false,
    retryAt: null,
    mappedRepos: 0,
    foundHosts: [],
    problems: [],
    ...over
  };
}

/** The GitLab answer the card reads, handed in through the raw context; `null` is "not answered yet". */
let gitlab: GitlabPayload | null;
let gitlabRefresh: jest.Mock;
const gitlabValue = () => ({ data: gitlab, error: null, refresh: gitlabRefresh });
const setGitlab = (status: GitlabStatus) => {
  gitlab = { status, jiraProjects: {}, mrs: [] };
};

let onOpenFilesPage: jest.Mock;
let projectsReload: jest.Mock;
let jiraReload: jest.Mock;
let onOpenGithubPage: jest.Mock;
let onOpenJiraPage: jest.Mock;

/*
 * `drawn` is the shell's projects answer, handed in through `ProjectsContext` the way `settings-view.test.tsx` does — the GitHub link's gate reads THAT, the
 * rail's own fact, and never the tracker payload's counts, so the two are set independently here and a case can make them disagree.
 */
async function renderCard(jira: JiraStatusPayload | null = UNCONFIGURED, drawn: DrawnSources | null = { files: true, github: true }): Promise<void> {
  stubFetch();
  const state: JiraState = { data: jira, loading: jira === null, error: false, reload: jiraReload };
  render(
    <GitlabContext.Provider value={gitlabValue()}>
      <JiraContext.Provider value={state}>
        <ProjectsContext.Provider value={{ data: null, drawn, reload: projectsReload }}>
          <TrackersProvider>
            <SourcesGroup onOpenFilesPage={onOpenFilesPage} onOpenGithubPage={onOpenGithubPage} onOpenJiraPage={onOpenJiraPage} />
          </TrackersProvider>
        </ProjectsContext.Provider>
      </JiraContext.Provider>
    </GitlabContext.Provider>
  );
  await waitFor(() => expect(linesOf('GitHub')[0]).not.toBe('checking…'));
}

/** One source row, by its name. */
const rowOf = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll('.set-row')].find((r) => r.querySelector('.set-name')?.textContent === name);
  if (!found) throw new Error(`no row named ${name}`);
  return found as HTMLElement;
};
/** That row's status pill word (`connected`, `2 projects`), or null when it draws none. */
const pillOf = (name: string): string | null => rowOf(name).querySelector('.ui-status-word')?.textContent ?? null;
const toneOf = (name: string): string | null => rowOf(name).querySelector('.ui-status-dot')?.getAttribute('data-tone') ?? null;
/** That row's hint, line by line — each line is its own element so a swapped or merged line reads differently. */
const linesOf = (name: string): string[] => [...rowOf(name).querySelectorAll('.set-hint-line')].map((el) => el.textContent ?? '');
/** Opens that row's `ⓘ more`, where the per-project lines live (spec §4.10), so `linesOf` reads the hint and the more text together. */
async function openMore(name: string): Promise<void> {
  await userEvent.click(within(rowOf(name)).getByRole('button', { name: 'ⓘ more' }));
}
const rowNames = (): string[] => [...document.querySelectorAll('.set-row .set-name')].map((el) => el.textContent ?? '');

beforeEach(() => {
  payload = { platforms: [TOKEN], projects: [row(), beta, gamma] };
  onOpenFilesPage = jest.fn();
  projectsReload = jest.fn();
  jiraReload = jest.fn();
  gitlabRefresh = jest.fn(() => Promise.resolve(null));
  setGitlab(gitlabStatus());
  onOpenGithubPage = jest.fn();
  onOpenJiraPage = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the Sources card', () => {
  it('is titled `Sources · this machine` and draws one row per source, Files then GitHub then Jira', async () => {
    await renderCard();
    expect(screen.getByText('Sources')).toHaveClass('ui-sheet-title');
    expect(screen.getByText('this machine')).toBeInTheDocument();
    expect(rowNames()).toEqual(['Files', 'GitHub', 'Jira', 'GitLab']);
  });
});

describe('the Files row', () => {
  it('counts every project the Files section draws — a files and an unsupported one — and carries each files project’s connect command', async () => {
    await renderCard();
    expect(linesOf('Files')).toEqual(['backlog/ folders in the registry']);
    await openMore('Files');
    const lines = linesOf('Files');
    expect(lines[0]).toBe('backlog/ folders in the registry');
    // The count is the pill's word now, green and ageless (no poll is served for files).
    expect(pillOf('Files')).toBe('2 projects');
    expect(toneOf('Files')).toBe('green');
    expect(rowOf('Files').querySelector('.ui-status-age')).toBeNull();
    expect(lines).toContain(`beta · ${CONNECT}`);
    // The command is a `code` element, selectable text — not a button (the card has no control but its links).
    expect(within(rowOf('Files')).getByText(CONNECT).tagName).toBe('CODE');
    // An unsupported marker is a Files project (display grouping only) and says why it cannot be read.
    expect(lines).toContain('gamma · a source marker this build cannot read — see the board’s warnings');
  });

  it('says `1 project` for one, and draws no line for a files project with nothing to connect', async () => {
    payload = { platforms: [TOKEN], projects: [row(), { ...beta, connect: null }] };
    await renderCard();
    expect(linesOf('Files')).toEqual(['backlog/ folders in the registry']);
    expect(within(rowOf('Files')).queryByRole('button', { name: 'ⓘ more' })).toBeNull();
    expect(pillOf('Files')).toBe('1 project');
  });

  it('links to the Files board through the shell’s pair, only while the Files section is drawn', async () => {
    await renderCard();
    await userEvent.click(within(rowOf('Files')).getByRole('button', { name: 'Open' }));
    expect(onOpenFilesPage).toHaveBeenCalledTimes(1);
    cleanup();

    await renderCard(UNCONFIGURED, { files: false, github: true });
    expect(within(rowOf('Files')).queryByRole('button', { name: 'Open' })).toBeNull();
  });
});

describe('the GitHub row', () => {
  it('reads `as <login>` and the rate-limit budget, the project count, and one reach line per repo — each with its own state', async () => {
    payload = {
      platforms: [TOKEN],
      projects: [row(), row({ name: 'delta', path: '/abs/delta', repo: 'futin/y', access: 'not-found' }), beta]
    };
    await renderCard();
    // The reach lines are behind `ⓘ more`; the hint itself is the budget and the count.
    expect(linesOf('GitHub')).toHaveLength(2);
    await openMore('GitHub');
    expect(linesOf('GitHub')).toEqual([
      `as futin · ${(4930).toLocaleString()} of ${(5000).toLocaleString()} left`,
      '2 projects',
      'futin/x · connecting…',
      'futin/y · repo not found, or not visible to this token'
    ]);
  });

  it('draws one reach line for two checkouts of one repo, and counts both projects', async () => {
    payload = { platforms: [TOKEN], projects: [row(), row({ name: 'alpha-twin', path: '/abs/alpha-twin' })] };
    await renderCard();
    await openMore('GitHub');
    expect(linesOf('GitHub').slice(1)).toEqual(['2 projects', 'futin/x · connecting…']);
  });

  it('says `token set`, never a login, when the token is set and no github project is registered', async () => {
    payload = { platforms: [{ ...TOKEN, login: null, limit: null, remaining: null }], projects: [beta] };
    await renderCard();
    expect(linesOf('GitHub')).toEqual(['token set', '0 projects']);
  });

  it('keeps the fix, not a bare `not set`, when there is no token', async () => {
    payload = { platforms: [{ kind: 'github', hasToken: false, login: null, limit: null, remaining: null, reset: null }], projects: [beta] };
    await renderCard();
    expect(linesOf('GitHub')[0]).toBe('no token — set BM_GITHUB_TOKEN in .env and restart');
  });

  it('links to the GitHub page through the shell’s pair', async () => {
    await renderCard();
    await userEvent.click(within(rowOf('GitHub')).getByRole('button', { name: 'GitHub page' }));
    expect(onOpenGithubPage).toHaveBeenCalledWith('settings');
    expect(onOpenJiraPage).not.toHaveBeenCalled();
  });

  it('draws no link while the GitHub row is not drawn — the section it would open is not there', async () => {
    payload = { platforms: [TOKEN], projects: [beta] };
    await renderCard(UNCONFIGURED, { files: true, github: false });
    expect(within(rowOf('GitHub')).queryByRole('button', { name: 'GitHub page' })).toBeNull();
  });

  it('gates the link on the rail`s drawn answer, not the tracker counts (final review M3)', async () => {
    // Two reads out of step: the counts come from `/api/trackers`, the rail from `/api/projects`, fetched separately. Here the tracker rows count no github
    // project (`0 projects`) while the rail still draws the row. The link follows the rail, because the rail is what it lands on.
    payload = { platforms: [TOKEN], projects: [beta] };
    await renderCard(UNCONFIGURED, { files: true, github: true });
    expect(within(rowOf('GitHub')).getByRole('button', { name: 'GitHub page' })).toBeInTheDocument();
    cleanup();

    // And the other way: tracker rows that count a github project, under a rail that does not draw GitHub (or has not answered yet), draw no link.
    payload = { platforms: [TOKEN], projects: [row(), beta, gamma] };
    await renderCard(UNCONFIGURED, { files: true, github: false });
    expect(within(rowOf('GitHub')).queryByRole('button', { name: 'GitHub page' })).toBeNull();
    cleanup();

    await renderCard(UNCONFIGURED, null);
    expect(within(rowOf('GitHub')).queryByRole('button', { name: 'GitHub page' })).toBeNull();
  });
});

describe('the Jira row', () => {
  it('reads `configured · <site> · n boards` and links to Jira setup through the shell’s pair', async () => {
    await renderCard(jiraStatus());
    expect(linesOf('Jira')).toEqual(['configured · acme.atlassian.net · 2 boards']);
    await userEvent.click(within(rowOf('Jira')).getByRole('button', { name: 'Jira setup' }));
    expect(onOpenJiraPage).toHaveBeenCalledWith('setup');
    expect(onOpenGithubPage).not.toHaveBeenCalled();
  });

  it('says `1 board` for one', async () => {
    await renderCard(jiraStatus({ boards: [jiraBoard('b_00000001')] }));
    expect(linesOf('Jira')).toEqual(['configured · acme.atlassian.net · 1 board']);
  });

  it('says `not configured`, with no link — the Jira section is not drawn on this machine', async () => {
    await renderCard(UNCONFIGURED);
    expect(linesOf('Jira')).toEqual(['not configured']);
    expect(within(rowOf('Jira')).queryByRole('button')).toBeNull();
  });

  it('says `checking…` before the first Jira answer', async () => {
    await renderCard(null);
    expect(linesOf('Jira')).toEqual(['checking…']);
  });
});

describe('before and after a failed read', () => {
  it('says `checking…` on the Files and GitHub rows before the trackers answer', async () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as jest.Mock;
    render(
      <GitlabContext.Provider value={gitlabValue()}>
        <JiraContext.Provider value={{ data: UNCONFIGURED, loading: false, error: false, reload: () => {} }}>
          <TrackersProvider>
            <SourcesGroup onOpenGithubPage={onOpenGithubPage} onOpenJiraPage={onOpenJiraPage} />
          </TrackersProvider>
        </JiraContext.Provider>
      </GitlabContext.Provider>
    );
    expect(linesOf('Files')).toEqual(['checking…']);
    expect(linesOf('GitHub')).toEqual(['checking…']);
    // Grey before the first answer, on every pill that is waiting on the trackers.
    expect([toneOf('Files'), toneOf('GitHub')]).toEqual(['grey', 'grey']);
    expect(pillOf('Files')).toBe('checking…');
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('keeps the previous answer and says so when a later read fails', async () => {
    await renderCard();
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText('the last read failed — showing the previous answer')).toBeInTheDocument();
    expect(pillOf('Files')).toBe('2 projects');
  });
});

describe('the status pills', () => {
  it('draws GitHub green `connected` once a repo has been polled on time, red `down` with no token', async () => {
    payload = { platforms: [TOKEN], projects: [row({ polledAt: new Date().toISOString() }), beta] };
    await renderCard();
    expect([pillOf('GitHub'), toneOf('GitHub')]).toEqual(['connected', 'green']);
    cleanup();

    payload = { platforms: [{ kind: 'github', hasToken: false, login: null, limit: null, remaining: null, reset: null }], projects: [beta] };
    await renderCard();
    expect([pillOf('GitHub'), toneOf('GitHub')]).toEqual(['down', 'red']);
  });

  it('draws GitHub grey before any repo has been polled', async () => {
    await renderCard();
    expect(toneOf('GitHub')).toBe('grey');
  });

  it('draws Jira green when configured and polled, grey `not configured` otherwise', async () => {
    const polled = jiraStatus({ boards: [{ ...jiraBoard('b_00000001'), polledAt: new Date().toISOString() }] });
    await renderCard(polled);
    expect([pillOf('Jira'), toneOf('Jira')]).toEqual(['connected', 'green']);
    cleanup();

    await renderCard(UNCONFIGURED);
    expect([pillOf('Jira'), toneOf('Jira')]).toEqual(['not configured', 'grey']);
  });
});

describe('the foot: Last read and Read again', () => {
  /** Every POST the card made, by URL, and how many times `/api/trackers` was read. */
  function stubRead(sweeps: { github?: number; jira?: number; gitlab?: number } = {}): { posts: () => string[]; trackerReads: () => number } {
    const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const status = init?.method === 'POST' ? (url.endsWith('/github/sweep') ? sweeps.github : url.endsWith('/gitlab/sweep') ? sweeps.gitlab : sweeps.jira) ?? 200 : 200;
      return Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(init?.method === 'POST' ? { message: 'nothing is being polled' } : payload) } as Response);
    });
    global.fetch = fn as unknown as typeof fetch;
    return {
      posts: () => fn.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST').map(([u]) => String(u)),
      trackerReads: () => fn.mock.calls.filter(([u, init]) => String(u).endsWith('/api/trackers') && (init as RequestInit | undefined)?.method !== 'POST').length
    };
  }

  async function renderWithStub(sweeps?: { github?: number; jira?: number; gitlab?: number }) {
    const probe = stubRead(sweeps);
    const state: JiraState = { data: jiraStatus(), loading: false, error: false, reload: jiraReload };
    render(
      <GitlabContext.Provider value={gitlabValue()}>
        <JiraContext.Provider value={state}>
          <ProjectsContext.Provider value={{ data: null, drawn: { files: true, github: true }, reload: projectsReload }}>
            <TrackersProvider>
              <SourcesGroup onOpenFilesPage={onOpenFilesPage} onOpenGithubPage={onOpenGithubPage} onOpenJiraPage={onOpenJiraPage} />
            </TrackersProvider>
          </ProjectsContext.Provider>
        </JiraContext.Provider>
      </GitlabContext.Provider>
    );
    await waitFor(() => expect(linesOf('GitHub')[0]).not.toBe('checking…'));
    return probe;
  }

  it('says how long ago the sources answered, in the client’s own time', async () => {
    await renderWithStub();
    expect(await screen.findByText(/^Last read \d+ s ago$/)).toBeInTheDocument();
  });

  it('posts all three sweeps once and reloads projects, trackers, Jira and GitLab', async () => {
    const probe = await renderWithStub();
    const readsBefore = probe.trackerReads();
    await userEvent.click(screen.getByRole('button', { name: 'Read again' }));

    await waitFor(() => expect(jiraReload).toHaveBeenCalledTimes(1));
    expect(probe.posts().sort()).toEqual(['/api/github/sweep', '/api/gitlab/sweep', '/api/jira/sweep']);
    expect(gitlabRefresh).toHaveBeenCalledTimes(1);
    expect(projectsReload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(probe.trackerReads()).toBeGreaterThan(readsBefore));
    expect(screen.queryByRole('alert')).toBeNull();
    // Enabled again once the round trip is over.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Read again' })).toBeEnabled());
  });

  it('still reloads all three, and shows no error, when a sweep answers 409', async () => {
    const probe = await renderWithStub({ github: 409 });
    await userEvent.click(screen.getByRole('button', { name: 'Read again' }));

    await waitFor(() => expect(jiraReload).toHaveBeenCalledTimes(1));
    expect(probe.posts()).toHaveLength(3);
    expect(projectsReload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so, and still reloads, when a sweep fails some other way', async () => {
    await renderWithStub({ jira: 500 });
    await userEvent.click(screen.getByRole('button', { name: 'Read again' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('nothing is being polled');
    expect(jiraReload).toHaveBeenCalledTimes(1);
  });

  it('adds no notice when only the GitLab sweep answers 409 (not armed)', async () => {
    await renderWithStub({ gitlab: 409 });
    await userEvent.click(screen.getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(gitlabRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the GitLab row (spec §5.2)', () => {
  const SITE = 'www.gitlab.timify.io';
  const ME = { username: 'andreja', name: 'Andreja J.' };
  const gitlabRow = (status: GitlabStatus) => {
    setGitlab(status);
    return renderCard();
  };

  it('unconfigured: grey `not configured` and the .env instruction', async () => {
    await gitlabRow(gitlabStatus());
    expect([pillOf('GitLab'), toneOf('GitLab')]).toEqual(['not configured', 'grey']);
    expect(linesOf('GitLab')).toEqual(['set BM_GITLAB_SITE and BM_GITLAB_TOKEN in .env and restart']);
  });

  it('a malformed site names the hostname rule instead', async () => {
    await gitlabRow(gitlabStatus({ malformedSite: true }));
    expect([pillOf('GitLab'), toneOf('GitLab')]).toEqual(['not configured', 'grey']);
    expect(linesOf('GitLab')).toEqual(['BM_GITLAB_SITE must be a hostname, like gitlab.example.com']);
  });

  it('before the first answer: grey `checking…`', async () => {
    gitlab = null;
    await renderCard();
    expect([pillOf('GitLab'), toneOf('GitLab'), linesOf('GitLab')]).toEqual(['checking…', 'grey', ['checking…']]);
  });

  it('checking: grey `checking…` and the site', async () => {
    await gitlabRow(gitlabStatus({ state: 'checking', site: SITE }));
    expect([pillOf('GitLab'), toneOf('GitLab'), linesOf('GitLab')]).toEqual(['checking…', 'grey', [SITE]]);
  });

  it('rejected: red `down`, the status and GitLab’s message; no message ends the line at the status', async () => {
    await gitlabRow(gitlabStatus({ state: 'rejected', site: SITE, httpStatus: 401, reason: '401 Unauthorized' }));
    expect([pillOf('GitLab'), toneOf('GitLab')]).toEqual(['down', 'red']);
    expect(linesOf('GitLab')).toEqual([`${SITE} refused the token (401) — 401 Unauthorized`]);
    cleanup();
    await gitlabRow(gitlabStatus({ state: 'rejected', site: SITE, httpStatus: 401, reason: null }));
    expect(linesOf('GitLab')).toEqual([`${SITE} refused the token (401)`]);
  });

  it('unreachable: red `down` and the short reason', async () => {
    await gitlabRow(gitlabStatus({ state: 'unreachable', site: SITE, reason: 'redirect refused (301)' }));
    expect([pillOf('GitLab'), toneOf('GitLab')]).toEqual(['down', 'red']);
    expect(linesOf('GitLab')).toEqual([`${SITE} did not answer — redirect refused (301)`]);
  });

  it('idle: grey `not polled yet`; the found hosts are named, and with none there is no suffix', async () => {
    await gitlabRow(gitlabStatus({ state: 'idle', site: SITE, user: ME, foundHosts: ['gitlab.timify.io'] }));
    expect([pillOf('GitLab'), toneOf('GitLab')]).toEqual(['not polled yet', 'grey']);
    expect(linesOf('GitLab')).toEqual([`andreja · ${SITE}`, `no mapped repository is on ${SITE} — found gitlab.timify.io`]);
    cleanup();
    await gitlabRow(gitlabStatus({ state: 'idle', site: SITE, user: ME, foundHosts: [] }));
    expect(linesOf('GitLab')).toEqual([`andreja · ${SITE}`, `no mapped repository is on ${SITE}`]);
  });

  const connected = (over: Partial<GitlabStatus> = {}) => gitlabStatus({ state: 'connected', site: SITE, user: ME, mappedRepos: 2, armed: true, ...over });

  it('connected: green `connected`, the identity, the count and one line per repo problem', async () => {
    await gitlabRow(
      connected({
        problems: [
          { kind: 'cannot-read', path: 'development/dev-api-graphql-proxy', status: 403 },
          { kind: 'origin', repo: 'proxy' },
          { kind: 'capped', path: 'development/backend/microservice', shown: 500 }
        ]
      })
    );
    expect([pillOf('GitLab'), toneOf('GitLab')]).toEqual(['connected', 'green']);
    expect(linesOf('GitLab')).toEqual([
      `andreja · ${SITE}`,
      '2 repos mapped via Jira › Setup › Repositories',
      'cannot read development/dev-api-graphql-proxy (403)',
      'proxy: could not read origin',
      'development/backend/microservice: first 500 shown'
    ]);
  });

  it('connected inside a 429 window: amber `late`, the connected lines, then the wait', async () => {
    await gitlabRow(connected({ retryAt: new Date(Date.now() + 90_000).toISOString() }));
    expect([pillOf('GitLab'), toneOf('GitLab')]).toEqual(['late', 'amber']);
    const lines = linesOf('GitLab');
    expect(lines.slice(0, 2)).toEqual([`andreja · ${SITE}`, '2 repos mapped via Jira › Setup › Repositories']);
    expect(lines[2]).toMatch(/^rate limited — next read in (8\d|90) s$|^rate limited — next read in 1m$/);
  });

  it('draws the live row shape: no `new` tag, no scope word', async () => {
    await gitlabRow(connected());
    expect(rowOf('GitLab').textContent).not.toMatch(/\bnew\b|read_api/);
  });
});
