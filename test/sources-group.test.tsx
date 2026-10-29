/**
 * @jest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { SourcesGroup } from '../client/src/components/settings/SourcesGroup';
import { JiraContext } from '../client/src/hooks/JiraContext';
import { ProjectsContext } from '../client/src/hooks/ProjectsContext';
import type { DrawnSources } from '../client/src/lib/sources';
import type { JiraState } from '../client/src/hooks/useJira';
import { TrackersProvider } from '../client/src/hooks/TrackersContext';
import type { JiraBoardStatus, JiraStatusPayload, TrackerPlatform, TrackerProjectRow, TrackersPayload } from '../shared/types';

/**
 * Settings › Shared's `Sources · this machine` card (source-sections spec): one read-only row per source — Files, GitHub, Jira — saying
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

let onOpenGithubPage: jest.Mock;
let onOpenJiraPage: jest.Mock;

/*
 * `drawn` is the shell's projects answer, handed in through `ProjectsContext` the way `settings-view.test.tsx` does — the GitHub link's gate reads THAT, the
 * rail's own fact, and never the tracker payload's counts, so the two are set independently here and a case can make them disagree.
 */
async function renderCard(jira: JiraStatusPayload | null = UNCONFIGURED, drawn: DrawnSources | null = { files: true, github: true }): Promise<void> {
  stubFetch();
  const state: JiraState = { data: jira, loading: jira === null, error: false, reload: () => {} };
  render(
    <JiraContext.Provider value={state}>
      <ProjectsContext.Provider value={{ data: null, drawn, reload: () => {} }}>
        <TrackersProvider>
          <SourcesGroup onOpenGithubPage={onOpenGithubPage} onOpenJiraPage={onOpenJiraPage} />
        </TrackersProvider>
      </ProjectsContext.Provider>
    </JiraContext.Provider>
  );
  await waitFor(() => expect(linesOf('GitHub')[0]).not.toBe('checking…'));
}

/** One source row, by its name. */
const rowOf = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll('.set-row')].find((r) => r.querySelector('.set-name')?.textContent === name);
  if (!found) throw new Error(`no row named ${name}`);
  return found as HTMLElement;
};
/** That row's hint, line by line — each line is its own element so a swapped or merged line reads differently. */
const linesOf = (name: string): string[] => [...rowOf(name).querySelectorAll('.set-hint-line')].map((el) => el.textContent ?? '');
const rowNames = (): string[] => [...document.querySelectorAll('.set-row .set-name')].map((el) => el.textContent ?? '');

beforeEach(() => {
  payload = { platforms: [TOKEN], projects: [row(), beta, gamma] };
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
    expect(rowNames()).toEqual(['Files', 'GitHub', 'Jira']);
  });
});

describe('the Files row', () => {
  it('counts every project the Files section draws — a files and an unsupported one — and carries each files project’s connect command', async () => {
    await renderCard();
    const lines = linesOf('Files');
    expect(lines[0]).toBe('2 projects');
    expect(lines).toContain(`beta · ${CONNECT}`);
    // The command is a `code` element, selectable text — not a button (the card has no control but its links).
    expect(within(rowOf('Files')).getByText(CONNECT).tagName).toBe('CODE');
    // An unsupported marker is a Files project (display grouping only) and says why it cannot be read.
    expect(lines).toContain('gamma · a source marker this build cannot read — see the board’s warnings');
  });

  it('says `1 project` for one, and draws no line for a files project with nothing to connect', async () => {
    payload = { platforms: [TOKEN], projects: [row(), { ...beta, connect: null }] };
    await renderCard();
    expect(linesOf('Files')).toEqual(['1 project']);
  });
});

describe('the GitHub row', () => {
  it('reads `as <login>` and the rate-limit budget, the project count, and one reach line per repo — each with its own state', async () => {
    payload = {
      platforms: [TOKEN],
      projects: [row(), row({ name: 'delta', path: '/abs/delta', repo: 'futin/y', access: 'not-found' }), beta]
    };
    await renderCard();
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

  it('links to GitHub › Settings through the shell’s pair', async () => {
    await renderCard();
    await userEvent.click(within(rowOf('GitHub')).getByRole('button', { name: /GitHub › Settings/ }));
    expect(onOpenGithubPage).toHaveBeenCalledWith('settings');
    expect(onOpenJiraPage).not.toHaveBeenCalled();
  });

  it('draws no link while the GitHub row is not drawn — the section it would open is not there', async () => {
    payload = { platforms: [TOKEN], projects: [beta] };
    await renderCard(UNCONFIGURED, { files: true, github: false });
    expect(within(rowOf('GitHub')).queryByRole('button')).toBeNull();
  });

  it('gates the link on the rail`s drawn answer, not the tracker counts (final review M3)', async () => {
    // A github marker with an invalid repo: `/api/trackers` calls it `unsupported` (counted under Files, `0 projects` here) while `/api/projects` — the
    // rail — calls it `github` and draws the row. The link follows the rail, because the rail is what it lands on.
    payload = { platforms: [TOKEN], projects: [beta] };
    await renderCard(UNCONFIGURED, { files: true, github: true });
    expect(within(rowOf('GitHub')).getByRole('button', { name: /GitHub › Settings/ })).toBeInTheDocument();
    cleanup();

    // And the other way: tracker rows that count a github project, under a rail that does not draw GitHub (or has not answered yet), draw no link.
    payload = { platforms: [TOKEN], projects: [row(), beta, gamma] };
    await renderCard(UNCONFIGURED, { files: true, github: false });
    expect(within(rowOf('GitHub')).queryByRole('button')).toBeNull();
    cleanup();

    await renderCard(UNCONFIGURED, null);
    expect(within(rowOf('GitHub')).queryByRole('button')).toBeNull();
  });
});

describe('the Jira row', () => {
  it('reads `configured · <site> · n boards` and links to Jira › Setup through the shell’s pair', async () => {
    await renderCard(jiraStatus());
    expect(linesOf('Jira')).toEqual(['configured · acme.atlassian.net · 2 boards']);
    await userEvent.click(within(rowOf('Jira')).getByRole('button', { name: /Jira › Setup/ }));
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
      <JiraContext.Provider value={{ data: UNCONFIGURED, loading: false, error: false, reload: () => {} }}>
        <TrackersProvider>
          <SourcesGroup onOpenGithubPage={onOpenGithubPage} onOpenJiraPage={onOpenJiraPage} />
        </TrackersProvider>
      </JiraContext.Provider>
    );
    expect(linesOf('Files')).toEqual(['checking…']);
    expect(linesOf('GitHub')).toEqual(['checking…']);
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
    expect(linesOf('Files')[0]).toBe('2 projects');
  });
});
