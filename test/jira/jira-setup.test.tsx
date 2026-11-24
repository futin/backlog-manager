/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import JiraView from '../../client/src/components/jira/JiraView';
import { JiraConnectionGroup } from '../../client/src/components/jira/JiraConnectionGroup';
import { JiraProvider } from '../../client/src/hooks/JiraContext';
import { SettingsProvider } from '../../client/src/hooks/useSettings';
import { setJiraPage } from '../../client/src/hooks/useJiraPage';
import { JIRA_BOARD_KEY, JIRA_QUERY_PRESETS, accessPhrase, boardRowLine } from '../../client/src/lib/jira';
import { JIRA_PAGE_KEY } from '../../client/src/lib/jira-page';
import { SETTINGS_STORAGE_KEY } from '../../client/src/lib/settings';
import { GitlabContext, type GitlabContextValue } from '../../client/src/hooks/GitlabContext';
import type { GitlabPayload, GitlabStatus, JiraBoardStatus, JiraIssue, JiraSkill, JiraSkillGroup, JiraStatusPayload } from '../../shared/types';
import { NoGitlab } from '../helpers/no-gitlab';
import { readStyles, ruleBlocks } from '../helpers/css-rule';

/*
  Jira › Setup (Jira phase 2; spec §6.4; DESIGN.md §8.9.3) — the real page over a mocked `fetch`, in `jira-board.test.tsx`'s style: the Boards
  card (its order, its line per board, `Open board`, the filter field from the sixth board) and the board sheet (new and edit, the roots search, the four
  query chips, the debounced JQL check, Save and Delete, and Review Focus 2's unreadable `jira.json`).

  The page reads `GET /api/jira` through the real `JiraProvider`, and is mounted through the real `JiraView` with the real page store, so `Open board` and
  Escape are asserted against the same store the rail's tree writes. Every request is recorded with its init, because several cases are about a request that
  must NOT be made and the save cases are about the body. Fixture stamps are relative to the clock the assertion runs under (`test/guards/fixture-clock.test.ts`).

  The Repositories and Connection cases follow below (the last two describes).
*/

const ADA = { accountId: 'acc-ada', name: 'Ada Lovelace' };

/* Polled ten and a half minutes ago, so every row's age reads `10m` for the whole of a case rather than ticking through seconds between the render and the
   assertion's own `boardRowLine` call. Computed per call rather than at module load, so a suite-level fake clock would still agree with it. */
function board(over: Partial<JiraBoardStatus>): JiraBoardStatus {
  return {
    id: 'b_00000001',
    name: 'Alpha',
    roots: [],
    queries: [],
    interval: '1m',
    polledAt: new Date(Date.now() - 630_000).toISOString(),
    count: 0,
    truncated: false,
    failures: [],
    ...over
  };
}

function status(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: ADA,
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
    armed: true,
    home: '/home/ada',
    mentions: null,
    ...over
  };
}

function issue(key: string, summary: string): JiraIssue {
  return {
    key,
    id: key.replace(/\D/g, ''),
    url: `https://acme.atlassian.net/browse/${key}`,
    summary,
    project: { key: key.split('-')[0], name: 'Payments' },
    type: { name: 'Story', level: 0, subtask: false },
    status: { name: 'To Do', category: 'new' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: new Date(Date.now() - 86_400_000).toISOString(),
    updated: new Date(Date.now() - 3_600_000).toISOString(),
    resolved: null
  };
}

const ALPHA = board({
  id: 'b_000a1fa0',
  name: 'Alpha board',
  roots: ['PAY-120'],
  queries: [{ id: 'q_00000001', label: 'Mine', jql: 'assignee = currentUser()' }],
  count: 4
});

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

let statusAnswer: JiraStatusPayload;
let searchAnswer: (q: string) => Promise<Response>;
let checkAnswer: (jql: string) => Promise<Response>;
let saveAnswer: () => Promise<Response>;
/* `GET /api/jira/boards/:id/issues` — the board's cached list, which the edit sheet reads once for its roots' summaries. */
let boardIssuesAnswer: (id: string) => Promise<Response>;
/* `POST /api/jira/repos`. The default does what the server does — stores the project's list (an empty one removes the key) in the status the next
   `GET /api/jira` answers — so a case can watch the card follow its own save. A case that wants a refusal replaces it. */
let reposAnswer: (body: { project: string; paths: string[] }) => Promise<Response>;
/* `POST /api/jira/skills` and `/skills/delete`. The defaults do what the server does — store or drop one skill in the status the next `GET /api/jira`
   answers — so a case can watch the card follow its own save. A case that wants a refusal replaces them. */
let skillsAnswer: (body: { id?: string; name: string; prompt: string; group?: JiraSkillGroup }) => Promise<Response>;
let skillsDeleteAnswer: (body: { id: string }) => Promise<Response>;
/* `POST /api/jira/skills/order`. The default does what the server does — puts the stored skills in the order `ids` names — so a case can watch the card
   follow its own move. A case that wants a refusal replaces it. */
let skillsOrderAnswer: (body: { ids: string[] }) => Promise<Response>;
/* `GET /api/jira` normally answers `statusAnswer`; a case that needs to hold or fail ONE reload sets this, and the router clears it as it answers. */
let nextStatusRead: (() => Promise<Response>) | null;
/* `POST /api/jira/repo-defaults`. The default does what the server does — stores the path's two values in the status the next `GET /api/jira` answers (a
   `null` drops its key) — so a case can watch the row follow its own save. A case that wants a refusal replaces it. */
let defaultsAnswer: (body: { path: string; base: string | null; namePattern: string | null }) => Promise<Response>;
/* `GET /api/jira/refs?repo=…` — what each defaults row reads once on mount. The default is a readable repo; a case that wants the unavailable form
   replaces it. */
let refsAnswer: (repo: string) => Promise<Response>;
/* `GET /api/jira/worktrees` — every tree of every mapped path (M7). The default lists none; a case that wants rows replaces it. */
let worktreesAnswer: () => Promise<Response>;
let sent: Sent[];

const answer = (body: unknown, code = 200) =>
  Promise.resolve({ ok: code >= 200 && code < 300, status: code, json: () => Promise.resolve(body) } as Response);

beforeEach(() => {
  localStorage.clear();
  setJiraPage('setup');
  statusAnswer = status({ boards: [ALPHA] });
  searchAnswer = () => answer([]);
  checkAnswer = () => answer({ ok: true, count: 0 });
  saveAnswer = () => answer({ ...ALPHA });
  boardIssuesAnswer = () => answer({ issues: [], polledAt: null });
  reposAnswer = (body) => {
    const repos = { ...statusAnswer.repos };
    if (body.paths.length === 0) delete repos[body.project];
    else repos[body.project] = body.paths;
    statusAnswer = { ...statusAnswer, repos };
    return answer(body);
  };
  skillsAnswer = (body) => {
    // As the server does: a create without `group` stores run, an update without it keeps the stored one, and an update keeps the skill's place.
    const stored = statusAnswer.skills.find((k) => k.id === body.id);
    const skill: JiraSkill = { id: body.id ?? 's_00000001', name: body.name, prompt: body.prompt, group: body.group ?? stored?.group ?? 'run' };
    const skills = stored ? statusAnswer.skills.map((k) => (k.id === skill.id ? skill : k)) : [...statusAnswer.skills, skill];
    statusAnswer = { ...statusAnswer, skills };
    return answer(skill);
  };
  skillsDeleteAnswer = (body) => {
    statusAnswer = { ...statusAnswer, skills: statusAnswer.skills.filter((k) => k.id !== body.id) };
    return answer({ ok: true });
  };
  skillsOrderAnswer = (body) => {
    const stored = statusAnswer.skills;
    const ordered = body.ids.flatMap((id) => stored.filter((k) => k.id === id));
    statusAnswer = { ...statusAnswer, skills: [...ordered, ...stored.filter((k) => !body.ids.includes(k.id))] };
    return answer({ ok: true });
  };
  nextStatusRead = null;
  defaultsAnswer = (body) => {
    const repoDefaults = { ...statusAnswer.repoDefaults };
    const entry = { ...(body.base !== null && { base: body.base }), ...(body.namePattern !== null && { namePattern: body.namePattern }) };
    if (Object.keys(entry).length === 0) delete repoDefaults[body.path];
    else repoDefaults[body.path] = entry;
    statusAnswer = { ...statusAnswer, repoDefaults };
    return answer(body);
  };
  refsAnswer = (repo) =>
    answer({
      repo,
      available: true,
      fetchedAt: null,
      mainBranch: 'main',
      defaultBase: 'main',
      branches: [
        { name: 'main', local: true, remote: true, sync: 'same', committedAt: '2026-10-01T00:00:00Z', worktree: repo, ticket: false },
        { name: 'develop', local: true, remote: true, sync: 'same', committedAt: '2026-10-02T00:00:00Z', worktree: null, ticket: false }
      ]
    });
  worktreesAnswer = () => answer({ worktrees: [], unavailable: [] });
  sent = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url === '/api/jira') {
      const held = nextStatusRead;
      nextStatusRead = null;
      return held !== null ? held() : answer(statusAnswer);
    }
    if (url === '/api/jira/projects') {
      return answer([
        { key: 'OPS', name: 'Platform' },
        { key: 'PAY', name: 'Payments' }
      ]);
    }
    if (url.startsWith('/api/jira/search?q=')) return searchAnswer(new URLSearchParams(url.split('?')[1]).get('q') ?? '');
    if (url.startsWith('/api/jira/jql/check?jql=')) return checkAnswer(new URLSearchParams(url.split('?')[1]).get('jql') ?? '');
    if (url === '/api/jira/boards') return saveAnswer();
    if (url === '/api/jira/boards/delete') return answer({ ok: true });
    if (url === '/api/jira/repos') return reposAnswer(JSON.parse(String(init?.body)));
    if (url === '/api/jira/repo-defaults') return defaultsAnswer(JSON.parse(String(init?.body)));
    if (url === '/api/jira/worktrees') return worktreesAnswer();
    if (url.startsWith('/api/jira/refs?')) return refsAnswer(new URLSearchParams(url.split('?')[1]).get('repo') ?? '');
    if (url === '/api/jira/skills') return skillsAnswer(JSON.parse(String(init?.body)));
    if (url === '/api/jira/skills/delete') return skillsDeleteAnswer(JSON.parse(String(init?.body)));
    if (url === '/api/jira/skills/order') return skillsOrderAnswer(JSON.parse(String(init?.body)));
    const issuesOf = /^\/api\/jira\/boards\/([^/]+)\/issues$/.exec(url);
    if (issuesOf !== null) return boardIssuesAnswer(decodeURIComponent(issuesOf[1]));
    if (url.startsWith('/api/jira/boards/')) return answer({ issues: [], polledAt: null });
    return answer({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

const urls = (prefix: string): string[] => sent.map((s) => s.url).filter((u) => u.startsWith(prefix));
const posts = (url: string): Sent[] => sent.filter((s) => s.url === url && s.init?.method === 'POST');
const storedPage = (): unknown => JSON.parse(localStorage.getItem(JIRA_PAGE_KEY) ?? 'null');

let onOpenJiraPage: jest.Mock;

/* Mounted through the real `JiraView`, with `onOpenJiraPage` doing what `App`'s does for the page half — writing the store — so a case can assert that the
   page store moved and the page under it switched. */
async function renderSetup(): Promise<void> {
  onOpenJiraPage = jest.fn((p) => setJiraPage(p));
  render(
    <main>
      <SettingsProvider>
        <JiraProvider>
          <NoGitlab>
            <JiraView onOpenJiraPage={onOpenJiraPage} />
          </NoGitlab>
        </JiraProvider>
      </SettingsProvider>
    </main>
  );
  await screen.findByRole('heading', { name: 'Boards' });
}

const boardsCard = (): HTMLElement => screen.getByRole('heading', { name: 'Boards' }).closest('section') as HTMLElement;
const rowOf = (name: string): HTMLElement => within(boardsCard()).getByText(name).closest('.set-row') as HTMLElement;
const rowNames = (): string[] => Array.from(boardsCard().querySelectorAll('.set-row .set-name')).map((n) => n.textContent ?? '');
const sheet = (): HTMLElement => screen.getByRole('dialog', { name: /^(New board|Edit board)/ });

async function openNew(): Promise<HTMLElement> {
  await userEvent.click(within(boardsCard()).getByRole('button', { name: 'New board' }));
  return screen.getByRole('dialog', { name: 'New board' });
}

async function openEdit(name: string): Promise<HTMLElement> {
  await userEvent.click(within(rowOf(name)).getByRole('button', { name: `Edit ${name}` }));
  return screen.getByRole('dialog', { name: `Edit board ${name}` });
}

describe('the Boards card', () => {
  it('lists the boards in boardsForSetup’s order, each reading its boardRowLine', async () => {
    const zed = board({ id: 'b_0000000a', name: 'Zed', interval: '1m', roots: ['PAY-1'], count: 3 });
    const alpha = board({ id: 'b_0000000b', name: 'alpha', interval: 'off' });
    const beta = board({ id: 'b_0000000c', name: 'Beta', interval: '5m', queries: [{ id: 'q_0000000c', label: 'x', jql: 'y' }] });
    statusAnswer = status({ boards: [zed, alpha, beta] });
    await renderSetup();

    expect(rowNames()).toEqual(['Beta', 'Zed', 'alpha']);
    for (const b of [zed, alpha, beta]) {
      const line = boardRowLine(b, Date.now());
      for (const fact of line.facts) expect(within(rowOf(b.name)).getByText(fact)).toHaveClass('ui-pill');
      expect(within(rowOf(b.name)).getByText(line.age ?? 'not polled yet')).toBeInTheDocument();
    }
    expect(within(rowOf('Zed')).getByText('1 root')).toBeInTheDocument();
    expect(within(rowOf('Zed')).getByText('every 1m')).toBeInTheDocument();
    expect(within(rowOf('alpha')).getByText('sync off')).toBeInTheDocument();
    expect(within(rowOf('Zed')).getByRole('button', { name: 'Open board Zed' })).toHaveTextContent('Open');
  });

  it('draws a failing board’s failure in red beside its line', async () => {
    const failing = board({ name: 'Broken', failures: [{ kind: 'query', id: 'q_00000001', message: "Field 'sprnt' does not exist" }] });
    statusAnswer = status({ boards: [failing] });
    await renderSetup();

    const failure = within(rowOf('Broken')).getByText("Field 'sprnt' does not exist");
    expect(failure).toHaveClass('jira-setup-failure');
  });

  it('`Open board` stores the pick and switches the page store to board', async () => {
    const zed = board({ id: 'b_0000000a', name: 'Zed' });
    statusAnswer = status({ boards: [ALPHA, zed] });
    await renderSetup();

    await userEvent.click(within(rowOf('Zed')).getByRole('button', { name: 'Open board Zed' }));
    expect(JSON.parse(localStorage.getItem(JIRA_BOARD_KEY) ?? 'null')).toBe('b_0000000a');
    expect(onOpenJiraPage).toHaveBeenCalledWith('board');
    expect(storedPage()).toBe('board');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Boards' })).toBeNull());
  });

  it('five boards draw no filter field', async () => {
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
    statusAnswer = status({ boards: names.map((name, i) => board({ id: `b_0000000${i}`, name })) });
    await renderSetup();
    expect(within(boardsCard()).queryByRole('textbox', { name: 'Filter boards' })).toBeNull();
  });

  it('from the sixth board a filter field narrows the rows, case-insensitively, on a substring of the name', async () => {
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Omega'];
    statusAnswer = status({ boards: names.map((name, i) => board({ id: `b_0000000${i}`, name })) });
    await renderSetup();

    const filter = within(boardsCard()).getByRole('textbox', { name: 'Filter boards' });
    await userEvent.type(filter, 'MEG');
    expect(rowNames()).toEqual(['Omega']);
    await userEvent.clear(filter);
    await userEvent.type(filter, 'a');
    expect(rowNames()).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma', 'Omega']);
  });

  it('no boards → `No boards yet`', async () => {
    statusAnswer = status({ boards: [] });
    await renderSetup();
    expect(within(boardsCard()).getByText(/No boards yet/)).toBeInTheDocument();
  });

  it('an unreadable jira.json reads `jira.json cannot be read — <reason>` in the card', async () => {
    statusAnswer = status({ boards: [], configUnreadable: 'Unexpected token } in JSON at position 12' });
    await renderSetup();
    expect(within(boardsCard()).getByText('jira.json cannot be read — Unexpected token } in JSON at position 12')).toBeInTheDocument();
    expect(within(boardsCard()).queryByText(/No boards yet/)).toBeNull();
  });

  it('fetches /api/jira/projects once per mount, however often the sheet opens', async () => {
    await renderSetup();
    await openNew();
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Cancel' }));
    await openNew();
    expect(urls('/api/jira/projects')).toHaveLength(1);
  });

  it('draws no page switch inside main', async () => {
    await renderSetup();
    const main = document.querySelector('main') as HTMLElement;
    expect(within(main).queryByRole('button', { name: /^(Board|Setup)$/ })).toBeNull();
    expect(within(main).queryByRole('tab')).toBeNull();
    expect(within(main).queryByRole('tablist')).toBeNull();
  });
});

describe('the board sheet — new', () => {
  it('opens titled for a new board, interval 1m, `Create board` disabled until a name and a root', async () => {
    searchAnswer = (q) => answer(q === 'pay' ? [issue('PAY-1', 'Payments epic')] : []);
    await renderSetup();
    const dialog = await openNew();

    const interval = within(dialog).getByRole('group', { name: 'Sync interval' });
    expect(within(interval).getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'true');
    const create = within(dialog).getByRole('button', { name: 'Create board' });
    expect(create).toBeDisabled();

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Board name' }), 'Sprint 43');
    expect(create).toBeDisabled();

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Search issues' }), 'pay');
    const matches = await screen.findByRole('dialog', { name: 'Matches' });
    await userEvent.click(within(matches).getByRole('button', { name: /PAY-1/ }));

    expect(within(dialog).getByRole('button', { name: 'Remove PAY-1' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Matches' })).toBeNull();
    expect(create).toBeEnabled();
  });

  it('the search request carries the field’s text URL-encoded, and a blank field sends nothing', async () => {
    await renderSetup();
    const dialog = await openNew();
    const search = within(dialog).getByRole('textbox', { name: 'Search issues' });

    await userEvent.type(search, '   ');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(urls('/api/jira/search')).toEqual([]);

    await userEvent.clear(search);
    await userEvent.type(search, 'a b&c');
    await waitFor(() => expect(urls('/api/jira/search')).toContain('/api/jira/search?q=a%20b%26c'));
    // Debounced: the keystrokes before the last one asked for nothing.
    expect(urls('/api/jira/search')).toEqual(['/api/jira/search?q=a%20b%26c']);
  });

  it('a search error shows under the field', async () => {
    searchAnswer = () => answer({ error: 'Jira refused the search: reserved character' }, 409);
    await renderSetup();
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Search issues' }), 'pa[[y');
    expect(await within(dialog).findByText('Jira refused the search: reserved character')).toBeInTheDocument();
  });

  it('`+ Assigned to me` adds a row with the preset’s label and JQL', async () => {
    await renderSetup();
    const dialog = await openNew();
    await userEvent.click(within(dialog).getByRole('button', { name: '+ Assigned to me' }));

    expect(within(dialog).getByRole('textbox', { name: 'Query label' })).toHaveValue('Assigned to me');
    expect(within(dialog).getByRole('textbox', { name: 'JQL' })).toHaveValue(JIRA_QUERY_PRESETS[0].jql);
  });

  it('`+ Unresolved in a project…` reveals a project Select, and picking PAY adds `Unresolved in PAY`', async () => {
    await renderSetup();
    const dialog = await openNew();
    await userEvent.click(within(dialog).getByRole('button', { name: '+ Unresolved in a project…' }));

    const select = within(dialog).getByRole('combobox', { name: 'Project' });
    expect(within(select).getByRole('option', { name: 'PAY · Payments' })).toBeInTheDocument();
    await userEvent.selectOptions(select, 'PAY');

    expect(within(dialog).getByRole('textbox', { name: 'Query label' })).toHaveValue('Unresolved in PAY');
    expect(within(dialog).getByRole('textbox', { name: 'JQL' })).toHaveValue('project = "PAY" AND resolution = Unresolved');
    expect(within(dialog).queryByRole('combobox', { name: 'Project' })).toBeNull();
  });

  it('`+ Custom JQL` adds an empty row labelled `Custom query`', async () => {
    await renderSetup();
    const dialog = await openNew();
    await userEvent.click(within(dialog).getByRole('button', { name: '+ Custom JQL' }));
    expect(within(dialog).getByRole('textbox', { name: 'Query label' })).toHaveValue('Custom query');
    expect(within(dialog).getByRole('textbox', { name: 'JQL' })).toHaveValue('');
  });
});

describe('the check line', () => {
  async function customRow(): Promise<HTMLElement> {
    await renderSetup();
    const dialog = await openNew();
    await userEvent.click(within(dialog).getByRole('button', { name: '+ Custom JQL' }));
    // The clock is faked only now, once the page is up: everything before this point is the real page loading on real timers.
    jest.useFakeTimers();
    return within(dialog).getByRole('textbox', { name: 'JQL' });
  }

  async function typeThree(box: HTMLElement): Promise<void> {
    for (const text of ['p', 'pr', 'pro']) {
      fireEvent.change(box, { target: { value: text } });
      await act(async () => {
        jest.advanceTimersByTime(100);
      });
    }
  }

  it('fires ONE /api/jira/jql/check 500 ms after the last keystroke, and reads `4 issues match · checked 0 s ago`', async () => {
    checkAnswer = () => answer({ ok: true, count: 4 });
    const box = await customRow();
    await typeThree(box);
    // 100 ms have passed since the last keystroke; 399 more is still inside the debounce.
    await act(async () => {
      jest.advanceTimersByTime(399);
    });
    expect(urls('/api/jira/jql/check')).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(urls('/api/jira/jql/check')).toEqual(['/api/jira/jql/check?jql=pro']);
    expect(await screen.findByText('4 issues match · checked 0 s ago')).toBeInTheDocument();
  });

  it('Jira’s parse message reads in red', async () => {
    checkAnswer = () => answer({ ok: false, message: "Field 'sprnt' does not exist" });
    const box = await customRow();
    await typeThree(box);
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    const message = await screen.findByText("Field 'sprnt' does not exist");
    expect(message.closest('.jira-sheet-check')).toHaveClass('bad');
  });
});

describe('the board sheet — edit, save, delete', () => {
  it('Save POSTs the board as JSON with its id, and the stored query ids on the rows that came from it', async () => {
    await renderSetup();
    const dialog = await openEdit('Alpha board');
    const name = within(dialog).getByRole('textbox', { name: 'Board name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Alpha renamed');
    await userEvent.click(within(dialog).getByRole('button', { name: '+ Assigned to me' }));
    const statusReads = urls('/api/jira').filter((u) => u === '/api/jira').length;

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Edit board/ })).toBeNull());
    const [save] = posts('/api/jira/boards');
    expect(new Headers(save.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(save.init?.body))).toEqual({
      id: ALPHA.id,
      name: 'Alpha renamed',
      interval: '1m',
      roots: ['PAY-120'],
      queries: [
        { id: 'q_00000001', label: 'Mine', jql: 'assignee = currentUser()' },
        { id: null, label: 'Assigned to me', jql: JIRA_QUERY_PRESETS[0].jql }
      ]
    });
    // …and the status is read again, so the card reads the saved board without waiting for the next poll.
    await waitFor(() => expect(urls('/api/jira').filter((u) => u === '/api/jira').length).toBeGreaterThan(statusReads));
  });

  it('an edited board’s roots read their summaries from the board’s cached list — one read of it, and no Jira search', async () => {
    const pay7 = { ...issue('PAY-7', 'Ledger export'), parent: { key: 'PAY-120', summary: 'Refund flows', type: null, status: null } };
    boardIssuesAnswer = (id) => answer(id === ALPHA.id ? { issues: [issue('PAY-120', 'Refund flows'), pay7], polledAt: null } : { issues: [], polledAt: null });
    await renderSetup();
    const dialog = await openEdit('Alpha board');

    const row = within(dialog).getByRole('button', { name: 'Remove PAY-120' }).closest('.jira-sheet-root') as HTMLElement;
    await waitFor(() => expect(row).toHaveTextContent('Refund flows'));
    expect(urls(`/api/jira/boards/${ALPHA.id}/issues`)).toHaveLength(1);
    expect(urls('/api/jira/search')).toEqual([]);
  });

  it('a 200 with no issues array leaves the roots reading their keys, and says nothing', async () => {
    boardIssuesAnswer = () => answer({ issues: 'x' });
    await renderSetup();
    const dialog = await openEdit('Alpha board');
    await waitFor(() => expect(urls(`/api/jira/boards/${ALPHA.id}/issues`)).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });

    const known = within(dialog).getByRole('button', { name: 'Remove PAY-120' }).closest('.jira-sheet-root') as HTMLElement;
    expect(known.textContent).toBe('PAY-120×');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('a root the cached list does not hold reads its key alone, and a picked root reads the summary the search showed', async () => {
    searchAnswer = (q) => answer(q === 'PAY-9' ? [issue('PAY-9', 'Chargebacks')] : []);
    await renderSetup();
    const dialog = await openEdit('Alpha board');
    await waitFor(() => expect(urls(`/api/jira/boards/${ALPHA.id}/issues`)).toHaveLength(1));

    const known = within(dialog).getByRole('button', { name: 'Remove PAY-120' }).closest('.jira-sheet-root') as HTMLElement;
    expect(known.textContent).toBe('PAY-120×');

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Search issues' }), 'PAY-9');
    const matches = await screen.findByRole('dialog', { name: 'Matches' });
    await userEvent.click(within(matches).getByRole('button', { name: /PAY-9/ }));
    const picked = within(dialog).getByRole('button', { name: 'Remove PAY-9' }).closest('.jira-sheet-root') as HTMLElement;
    expect(picked).toHaveTextContent('Chargebacks');
  });

  it('a save that lands after the sheet was closed still reloads the status', async () => {
    let land: (r: Response) => void = () => undefined;
    saveAnswer = () => new Promise<Response>((resolve) => (land = resolve));
    await renderSetup();
    const dialog = await openEdit('Alpha board');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('button', { name: 'saving…' })).toBeDisabled();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /^Edit board/ })).toBeNull();
    const statusReads = urls('/api/jira').filter((u) => u === '/api/jira').length;

    await act(async () => {
      land({ ok: true, status: 200, json: () => Promise.resolve({ ...ALPHA }) } as Response);
    });
    await waitFor(() => expect(urls('/api/jira').filter((u) => u === '/api/jira').length).toBeGreaterThan(statusReads));
  });

  it('Review Focus 2: a 409 keeps the sheet open, every edit intact, the server’s sentence under the footer', async () => {
    const sentence = 'settings/jira.json does not parse as JSON — fix or delete it by hand; nothing was written';
    saveAnswer = () => answer({ error: sentence }, 409);
    await renderSetup();
    const dialog = await openEdit('Alpha board');
    const name = within(dialog).getByRole('textbox', { name: 'Board name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Kept edit');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(sentence)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Edit board Alpha board' })).toBe(dialog);
    expect(within(dialog).getByRole('textbox', { name: 'Board name' })).toHaveValue('Kept edit');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('`Delete board` asks through Confirm: dismiss POSTs nothing, accept POSTs boards/delete with the id and closes', async () => {
    await renderSetup();
    const dialog = await openEdit('Alpha board');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete board' }));
    await userEvent.click(screen.getByTestId('jira-board-delete-dismiss'));
    expect(posts('/api/jira/boards/delete')).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete board' }));
    await userEvent.click(screen.getByTestId('jira-board-delete-accept'));

    await waitFor(() => expect(posts('/api/jira/boards/delete')).toHaveLength(1));
    const [del] = posts('/api/jira/boards/delete');
    expect(new Headers(del.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(del.init?.body))).toEqual({ id: ALPHA.id });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Edit board/ })).toBeNull());
  });

  it('a new board has no `Delete board`', async () => {
    await renderSetup();
    const dialog = await openNew();
    expect(within(dialog).queryByRole('button', { name: 'Delete board' })).toBeNull();
  });
});

describe('Escape', () => {
  it('with the sheet open, closes the sheet only — the page stays on Setup', async () => {
    await renderSetup();
    await openNew();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'New board' })).toBeNull();
    expect(boardsCard()).toBeInTheDocument();
    expect(storedPage()).toBe('setup');
  });

  it('with the roots popover open over the sheet, closes the popover first', async () => {
    searchAnswer = () => answer([issue('PAY-1', 'Payments epic')]);
    await renderSetup();
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Search issues' }), 'pay');
    await screen.findByRole('dialog', { name: 'Matches' });

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Matches' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New board' })).toBeInTheDocument();
  });

  it('with the delete Confirm drawn, closes the Confirm first', async () => {
    await renderSetup();
    const dialog = await openEdit('Alpha board');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete board' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('jira-board-delete')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Edit board Alpha board' })).toBeInTheDocument();
  });
});

/* ── Repositories and Connection ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */

const PROJECTS = [
  { key: 'PAY', name: 'Payments' },
  { key: 'OPS', name: 'Platform' }
];

const reposCard = (): HTMLElement => screen.getByRole('heading', { name: 'Repositories' }).closest('section') as HTMLElement;
const connectionCard = (): HTMLElement => screen.getByRole('region', { name: 'Connection' });
const repoKeys = (): string[] => Array.from(reposCard().querySelectorAll('.jira-setup-repo-head > .ui-pill')).map((n) => n.textContent ?? '');
const repoNames = (): string[] => Array.from(reposCard().querySelectorAll('.set-row .set-name')).map((n) => n.textContent ?? '');
const repoHints = (): string[] => Array.from(reposCard().querySelectorAll('.set-row .set-hint')).map((n) => n.textContent ?? '');
const addField = (): HTMLInputElement => within(reposCard()).getByRole('textbox', { name: 'Repository path' }) as HTMLInputElement;
const repoPosts = (): { project: string; paths: string[] }[] => posts('/api/jira/repos').map((p) => JSON.parse(String(p.init?.body)));
const statusReads = (): number => sent.filter((s) => s.url === '/api/jira').length;

/* The project list is `JiraSetupView`'s one read, answered a tick after the heading draws, so a case that picks from the Select waits for its options. */
async function pickProject(project: string): Promise<void> {
  const select = within(reposCard()).getByRole('combobox', { name: 'Jira project' });
  await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
  await userEvent.selectOptions(select, project);
}

async function addRepo(project: string, path: string): Promise<void> {
  await pickProject(project);
  await userEvent.clear(addField());
  await userEvent.type(addField(), path);
  await userEvent.click(within(reposCard()).getByRole('button', { name: 'Add' }));
}

describe('the Repositories card', () => {
  it('draws one row per mapped path through displayPath, and × on the second POSTs the project\'s remaining list', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/Users/ada/pay', '/Users/ada/pay-2'] }, home: '/Users/ada' });
    await renderSetup();

    expect(repoHints().filter((h) => h.startsWith('~'))).toEqual(['~/pay', '~/pay-2']);
    expect(repoKeys()).toEqual(['PAY', 'PAY']);

    await userEvent.click(within(reposCard()).getByRole('button', { name: 'Remove ~/pay-2' }));
    await waitFor(() => expect(repoPosts()).toEqual([{ project: 'PAY', paths: ['/Users/ada/pay'] }]));
    expect(posts('/api/jira/repos')[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    // The status was asked for again, and the card follows it.
    await waitFor(() => expect(repoHints().filter((h) => h.startsWith('~'))).toEqual(['~/pay']));
  });

  it('titles each row\'s key Pill with the project\'s name, and draws the path as a code span', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'] } });
    await renderSetup();
    const pill = (await within(reposCard()).findAllByText('PAY'))[0];
    expect(pill).toHaveAttribute('title', 'Payments');
    expect(within(reposCard()).getByText('~/pay')).toHaveClass('jira-setup-code');
  });

  it('shows a path as stored while it is not under the home, and never rewrites one that only shares a prefix with it', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/Users/adam/pay'], OPS: ['/srv/ops'] }, home: '/Users/ada' });
    await renderSetup();
    expect(repoHints()).toEqual(expect.arrayContaining(['/Users/adam/pay', '/srv/ops']));
  });

  it('draws a warning row for each project with issues and no path, and none for a mapped one', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'] } });
    await renderSetup();
    const warnings = within(reposCard()).getAllByText(/^no repository yet/);
    expect(warnings.map((w) => w.textContent)).toEqual(['no repository yet — OPS cards cannot Start until a path is mapped']);
    expect(warnings[0]).toHaveClass('jira-setup-warn');
    expect(repoNames()).toContain('OPS · Platform');
  });

  it('removing a project\'s last path POSTs an empty list, and the project then reads as unmapped', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'], OPS: ['/home/ada/ops'] } });
    await renderSetup();
    await userEvent.click(within(reposCard()).getByRole('button', { name: 'Remove ~/pay' }));
    await waitFor(() => expect(repoPosts()).toEqual([{ project: 'PAY', paths: [] }]));
    await screen.findByText('no repository yet — PAY cards cannot Start until a path is mapped');
  });

  it('Add sends the typed path as typed (the server expands ~) with the project\'s whole list, then reloads the status and clears the field', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'] } });
    await renderSetup();
    const before = statusReads();

    await addRepo('OPS', '~/ops');
    await waitFor(() => expect(repoPosts()).toEqual([{ project: 'OPS', paths: ['~/ops'] }]));
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
    await waitFor(() => expect(addField().value).toBe(''));
    expect(within(reposCard()).queryByText(/^no repository yet/)).toBeNull();

    // A second path for a mapped project is appended to that project's list, not sent alone.
    await addRepo('PAY', '/home/ada/pay-2');
    await waitFor(() => expect(repoPosts()[1]).toEqual({ project: 'PAY', paths: ['/home/ada/pay', '/home/ada/pay-2'] }));
  });

  it('keeps the typed path and shows the server\'s sentence under the add row on a refusal', async () => {
    statusAnswer = status({ projects: PROJECTS });
    reposAnswer = () => answer({ error: 'path must be absolute and normalised: x/y' }, 400);
    await renderSetup();

    await addRepo('OPS', 'x/y');
    const message = await within(reposCard()).findByText('path must be absolute and normalised: x/y');
    expect(message).toHaveClass('set-error');
    expect(addField().value).toBe('x/y');
    // The refusal is a write that did not land: no status reload was asked for beyond the mount's own.
    expect(statusReads()).toBe(1);
  });

  it('says so when the answer has no sentence or the server does not answer, and a refused × removes nothing', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'] } });
    reposAnswer = () => answer(null, 502);
    await renderSetup();
    await userEvent.click(within(reposCard()).getByRole('button', { name: 'Remove ~/pay' }));
    expect(await within(reposCard()).findByText('the repositories were not saved (HTTP 502)')).toHaveClass('set-error');
    expect(repoHints()).toEqual(expect.arrayContaining(['~/pay']));

    reposAnswer = () => Promise.reject(new Error('down'));
    await addRepo('OPS', '/x');
    expect(await within(reposCard()).findByText('the repositories were not saved — the server did not answer')).toBeInTheDocument();
  });

  it('keeps Add disabled until a project and a path are both given', async () => {
    statusAnswer = status({ projects: PROJECTS });
    await renderSetup();
    const add = within(reposCard()).getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await pickProject('PAY');
    expect(add).toBeDisabled();
    await userEvent.type(addField(), '   ');
    expect(add).toBeDisabled();
    await userEvent.type(addField(), '/a');
    expect(add).toBeEnabled();
  });

  it('offers the whole /api/jira/projects list in the Select, `KEY · name`, and states the dispatch rule', async () => {
    await renderSetup();
    const select = within(reposCard()).getByRole('combobox', { name: 'Jira project' });
    await waitFor(() => expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['project…', 'OPS · Platform', 'PAY · Payments']));
    expect(within(reposCard()).getByText('a path the dashboard cannot see is refused at dispatch, not here')).toBeInTheDocument();
  });

  it('says why the Select is empty when the project list could not be read, and still lists the mapped paths', async () => {
    const real = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/jira/projects' ? answer({ error: 'Jira refused: forbidden' }, 502) : real(input, init)
    ) as unknown as typeof fetch;
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'] } });
    await renderSetup();
    await within(reposCard()).findByText('Jira refused: forbidden');
    expect(within(reposCard()).getByRole('combobox', { name: 'Jira project' })).toBeDisabled();
    expect(repoHints()).toEqual(expect.arrayContaining(['~/pay']));
  });

  // #600: the payload check is `fetchJiraProjects`'s now — a 200 that is not a list is a failed read, said under the picker, never an empty picker.
  it('says the project list is malformed when a 200 body is not a list, and disables the Select', async () => {
    const real = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/jira/projects' ? answer({}, 200) : real(input, init)
    ) as unknown as typeof fetch;
    await renderSetup();
    await within(reposCard()).findByText('the project list could not be read — malformed response');
    expect(within(reposCard()).getByRole('combobox', { name: 'Jira project' })).toBeDisabled();
  });

  it('fetches /api/jira/projects once per Setup mount, and not again when the status reloads', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'] } });
    await renderSetup();
    expect(urls('/api/jira/projects')).toHaveLength(1);

    await addRepo('OPS', '/home/ada/ops');
    await waitFor(() => expect(statusReads()).toBeGreaterThan(1));
    const reads = statusReads();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(statusReads()).toBeGreaterThan(reads));
    expect(urls('/api/jira/projects')).toHaveLength(1);
  });
});

/* Per-path defaults (Jira repo/branch, spec §5.1; DESIGN.md §8.9.3): one defaults line under a path's first row, saved through `/api/jira/repo-defaults`. */
describe('the Repositories card — a landed path write waits for the status (#587)', () => {
  // `reload()` is not awaited and `busy` clears first, so without the hold a second × or Add would build its list from the PRE-write status and overwrite
  // the first write on the server — resurrecting a just-removed path or dropping a just-added one.
  const removeButtons = (): HTMLElement[] => within(reposCard()).getAllByRole('button', { name: /^Remove / });
  const addButton = (): HTMLElement => within(reposCard()).getByRole('button', { name: 'Add' });

  function holdNextStatusRead(): (payload: Response | Promise<Response>) => void {
    let release: (r: Response | Promise<Response>) => void = () => {};
    nextStatusRead = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    return (r) => release(r);
  }

  it('after a landed × keeps every × and Add disabled, and Enter sends nothing, until the status answers anew', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay', '/home/ada/pay-2', '/home/ada/pay-3'] } });
    await renderSetup();
    await pickProject('OPS');
    await userEvent.type(addField(), '~/ops');
    const release = holdNextStatusRead();

    await userEvent.click(within(reposCard()).getByRole('button', { name: 'Remove ~/pay-2' }));
    await waitFor(() => expect(repoPosts()).toEqual([{ project: 'PAY', paths: ['/home/ada/pay', '/home/ada/pay-3'] }]));
    // The POST landed and the reload is out: the rows drawn are still the pre-write ones, so every path write waits.
    await waitFor(() => expect(addButton()).toBeDisabled());
    for (const b of removeButtons()) expect(b).toBeDisabled();
    expect(within(reposCard()).getByRole('combobox', { name: 'Jira project' })).toBeDisabled();
    expect(addField()).toBeDisabled();
    // Enter in the path field cannot slip past the disabled chip either (the field is disabled; `add()` returns early on its own too).
    addField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(repoPosts()).toHaveLength(1);

    await act(async () => release(answer(statusAnswer)));
    await waitFor(() => expect(addButton()).toBeEnabled());
    expect(repoHints().filter((h) => h.startsWith('~'))).toEqual(['~/pay', '~/pay-3']);
    for (const b of removeButtons()) expect(b).toBeEnabled();
  });

  it('a failed status read after a landed write re-enables the controls rather than locking them', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay', '/home/ada/pay-2'] } });
    await renderSetup();
    nextStatusRead = () => answer({ error: 'boom' }, 500);
    await userEvent.click(within(reposCard()).getByRole('button', { name: 'Remove ~/pay-2' }));
    await waitFor(() => expect(repoPosts()).toHaveLength(1));
    await waitFor(() => expect(removeButtons()[0]).toBeEnabled());
  });

  it('a path\'s defaults Save is not held: it posts one path\'s own values and cannot clobber the list', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay', '/home/ada/pay-2'] } });
    await renderSetup();
    holdNextStatusRead();
    await userEvent.click(within(reposCard()).getByRole('button', { name: 'Remove ~/pay-2' }));
    await waitFor(() => expect(repoPosts()).toHaveLength(1));
    await waitFor(() => expect(addButton()).toBeDisabled());
    expect(removeButtons()[0]).toBeDisabled();
    await userEvent.type(within(reposCard()).getByLabelText('Default base for ~/pay'), 'develop');
    expect(within(reposCard()).getByRole('button', { name: 'Save defaults for ~/pay' })).toBeEnabled();
  });
});

describe('the Repositories card — a path\'s defaults', () => {
  const defaultsPosts = (): { path: string; base: string | null; namePattern: string | null }[] =>
    posts('/api/jira/repo-defaults').map((p) => JSON.parse(String(p.init?.body)));
  const baseField = (shown = '~/pay'): HTMLInputElement => within(reposCard()).getByLabelText(`Default base for ${shown}`) as HTMLInputElement; // a `list`ed input is a combobox, not a textbox
  const patternField = (shown = '~/pay'): HTMLInputElement =>
    within(reposCard()).getByRole('textbox', { name: `Branch name pattern for ${shown}` }) as HTMLInputElement;
  const saveButton = (shown = '~/pay'): HTMLElement => within(reposCard()).getByRole('button', { name: `Save defaults for ${shown}` });
  const mapPay = (extra: Partial<JiraStatusPayload> = {}): void => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'] }, ...extra });
  };

  it('draws a base and a pattern field with their placeholders, seeded from the stored defaults, and Save stays off until one changes', async () => {
    mapPay({ repoDefaults: { '/home/ada/pay': { base: 'develop' } } });
    await renderSetup();
    expect(baseField().value).toBe('develop');
    // The placeholder says what an empty field means: the refs read's default base, else just `(default)`; the pattern's default is `{key}-{slug}`.
    await waitFor(() => expect(baseField().placeholder).toBe('main (default)'));
    expect(patternField().value).toBe('');
    expect(patternField().placeholder).toBe('{key}-{slug} (default)');
    expect(within(reposCard()).getByText('Base branch')).toBeInTheDocument();
    expect(within(reposCard()).getByText('Branch name')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.change(patternField(), { target: { value: '{key}/{slug}' } });
    expect(saveButton()).toBeEnabled();
  });

  it('reads `(default)` alone as the base placeholder while the refs read lists no default', async () => {
    mapPay();
    refsAnswer = (repo) => answer({ repo, available: false, reason: 'is not a git checkout' });
    await renderSetup();
    await within(reposCard()).findByText(/branches unavailable/);
    expect(baseField().placeholder).toBe('(default)');
  });

  it('saves both values for the PATH — an empty field as null — then reloads the status and reads as saved again', async () => {
    mapPay();
    await renderSetup();
    const before = statusReads();
    fireEvent.change(baseField(), { target: { value: ' develop ' } });
    await userEvent.click(saveButton());
    await waitFor(() => expect(defaultsPosts()).toEqual([{ path: '/home/ada/pay', base: 'develop', namePattern: null }]));
    expect(posts('/api/jira/repo-defaults')[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
    await waitFor(() => expect(saveButton()).toBeDisabled());
    expect(baseField().value).toBe('develop');

    // Clearing a stored value sends null for it, and the other one stays.
    fireEvent.change(patternField(), { target: { value: '{key}-{slug}' } });
    fireEvent.change(baseField(), { target: { value: '' } });
    await userEvent.click(saveButton());
    await waitFor(() => expect(defaultsPosts()[1]).toEqual({ path: '/home/ada/pay', base: null, namePattern: '{key}-{slug}' }));
  });

  it('hints at a pattern that cannot name a branch while it is typed, and still lets Save go — the server\'s sentence wins and is shown in the group\'s slot', async () => {
    mapPay();
    defaultsAnswer = () => answer({ error: 'namePattern renders as sample-slug, which does not carry ABC-1' }, 400);
    await renderSetup();
    fireEvent.change(patternField(), { target: { value: '{slug}' } });
    const hint = within(reposCard()).getByText('renders as sample-slug, which does not carry ABC-1');
    expect(hint).toHaveClass('jira-setup-warn');
    expect(saveButton()).toBeEnabled();

    await userEvent.click(saveButton());
    const message = await within(reposCard()).findByText('namePattern renders as sample-slug, which does not carry ABC-1');
    expect(message).toHaveClass('set-error');
    // A refusal changes nothing: the typed value stays, and no status reload was asked for beyond the mount's own.
    expect(patternField().value).toBe('{slug}');
    expect(statusReads()).toBe(1);

    fireEvent.change(patternField(), { target: { value: '{key}-{slug}' } });
    expect(within(reposCard()).queryByText(/^renders as/)).toBeNull();
  });

  // M1 (final review): the old `origin/HEAD` placeholder invited a value the tool refuses at every Start. The hint is instant; Save still goes, and the
  // server's sentence is the one shown in the group's error slot.
  it('hints at an origin/ base while it is typed, and still lets Save go — the server\'s sentence wins', async () => {
    mapPay();
    defaultsAnswer = () => answer({ error: 'base is a branch name, without origin/' }, 400);
    await renderSetup();
    fireEvent.change(baseField(), { target: { value: 'origin/develop' } });
    const hint = within(reposCard()).getByText('base is a branch name, without origin/');
    expect(hint).toHaveClass('jira-setup-warn');
    expect(saveButton()).toBeEnabled();

    await userEvent.click(saveButton());
    const shown = (): HTMLElement[] => within(reposCard()).queryAllByText('base is a branch name, without origin/');
    await waitFor(() => expect(shown().some((e) => e.classList.contains('set-error'))).toBe(true));
    expect(baseField().value).toBe('origin/develop');

    fireEvent.change(baseField(), { target: { value: 'develop' } });
    expect(shown().filter((e) => e.classList.contains('jira-setup-warn'))).toHaveLength(0);
  });

  it('says the server did not answer, or answered without a sentence, under the same slot', async () => {
    mapPay();
    defaultsAnswer = () => answer(null, 502);
    await renderSetup();
    fireEvent.change(baseField(), { target: { value: 'develop' } });
    await userEvent.click(saveButton());
    expect(await within(reposCard()).findByText('the defaults were not saved (HTTP 502)')).toHaveClass('set-error');

    defaultsAnswer = () => Promise.reject(new TypeError('Failed to fetch'));
    await userEvent.click(saveButton());
    expect(await within(reposCard()).findByText('the defaults were not saved — the server did not answer')).toBeInTheDocument();
  });

  it('reads the path\'s refs once on mount, not again when the status reloads, and offers the branch names on the base field', async () => {
    mapPay();
    await renderSetup();
    await waitFor(() => expect(urls('/api/jira/refs')).toEqual(['/api/jira/refs?repo=%2Fhome%2Fada%2Fpay']));
    const list = document.getElementById(baseField().getAttribute('list') ?? 'none');
    await waitFor(() => expect(Array.from(list?.querySelectorAll('option') ?? []).map((o) => o.getAttribute('value'))).toEqual(['main', 'develop']));
    expect(within(reposCard()).queryByText(/^branches unavailable/)).toBeNull();

    await addRepo('OPS', '/home/ada/ops');
    await waitFor(() => expect(statusReads()).toBeGreaterThan(1));
    expect(urls('/api/jira/refs').filter((u) => u.includes('pay'))).toHaveLength(1);
  });

  it('says why the branches cannot be listed, with the path as displayPath shows it, and keeps both fields usable', async () => {
    mapPay();
    refsAnswer = (repo) => answer({ repo, available: false, reason: 'does not exist' });
    await renderSetup();
    expect(await within(reposCard()).findByText('branches unavailable — ~/pay does not exist')).toBeInTheDocument();
    fireEvent.change(baseField(), { target: { value: 'develop' } });
    expect(saveButton()).toBeEnabled();
  });

  it('says so too when the refs request itself fails', async () => {
    mapPay();
    refsAnswer = () => answer({ error: 'down for lunch' }, 502);
    await renderSetup();
    expect(await within(reposCard()).findByText('branches unavailable — ~/pay: down for lunch')).toBeInTheDocument();
  });

  it('draws ONE defaults line for a path mapped to two projects — the defaults belong to the path', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/shared'], OPS: ['/home/ada/shared'] } });
    await renderSetup();
    // Awaited: the Repositories rows draw after the page's own `/api/jira/projects` read, which `renderSetup`'s Boards heading does not wait for. By label,
    // not role, as `baseField` does: the field is a textbox until the refs read lands and a combobox after (`list=`), so a role query raced that read.
    expect(await within(reposCard()).findAllByLabelText('Default base for ~/shared')).toHaveLength(1);
    expect(urls('/api/jira/refs')).toHaveLength(1);
    fireEvent.change(baseField('~/shared'), { target: { value: 'develop' } });
    await userEvent.click(saveButton('~/shared'));
    await waitFor(() => expect(defaultsPosts()).toEqual([{ path: '/home/ada/shared', base: 'develop', namePattern: null }]));
  });
});

// M7 (final review): a Continue on a key-less branch makes a tree no card or modal shows, so each path lists every tree it has open, ticket or not.
describe('the Repositories card — a path\'s worktrees', () => {
  const tree = (repo: string, path: string, branch: string | null, main = false) => ({ repo, path, branch, main });
  const treesUnder = (): HTMLElement[] => Array.from(reposCard().querySelectorAll('.jira-setup-trees'));
  const branchesOf = (row: HTMLElement): string[] => Array.from(row.querySelectorAll('.jira-wt-branch')).map((b) => b.textContent ?? '');
  const worktreeReads = (): number => sent.filter((x) => x.url === '/api/jira/worktrees').length;

  it('lists every non-main tree of each distinct path once — key-less and detached included — and Remove copies the command', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'], OPS: ['/home/ada/pay', '/home/ada/ops'] }, home: '/home/ada' });
    worktreesAnswer = () =>
      answer({
        worktrees: [
          tree('/home/ada/pay', '/home/ada/pay', 'main', true),
          tree('/home/ada/pay', '/home/ada/pay/.worktrees/pay-1-x', 'pay-1-x'),
          tree('/home/ada/pay', '/home/ada/pay/.worktrees/develop', 'develop'),
          tree('/home/ada/pay', '/home/ada/pay/.worktrees/detached', null),
          tree('/home/ada/ops', '/home/ada/ops', 'main', true)
        ],
        unavailable: []
      });
    await renderSetup();
    // Collapsed by default: one toggle under the path's first mapping only, `aria-expanded` false until it is pressed.
    const toggle = await within(reposCard()).findByRole('button', { name: '3 worktrees' });
    expect(within(reposCard()).getAllByRole('button', { name: /worktrees?$/ })).toHaveLength(1);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(treesUnder()).toHaveLength(0);
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(treesUnder()).toHaveLength(1));
    const [list] = treesUnder();
    expect(within(list).getByText('Open worktrees beside this checkout')).toBeInTheDocument();
    expect(branchesOf(list)).toEqual(['detached', 'develop', 'pay-1-x']);
    expect(within(list).getByText('~/pay/.worktrees/develop')).toBeInTheDocument();
    // The repository is the row above: the modal's repo column is not drawn again here.
    expect(list.querySelector('.jira-wt-repo')).toBeNull();

    await userEvent.click(within(list).getByRole('button', { name: 'Remove worktree develop' }));
    expect(writeText).toHaveBeenCalledWith("git -C '/home/ada/pay' worktree remove '/home/ada/pay/.worktrees/develop'");
    expect(await within(list).findByText('Copied')).toBeInTheDocument();
  });

  it('disables a tree a live session is on and names its key; a key-less tree keeps the warning title', async () => {
    statusAnswer = status({
      projects: PROJECTS,
      repos: { PAY: ['/home/ada/pay'] },
      live: { 'PAY-1': { sessionId: 's1', name: 'pay-1', startedAt: '2026-10-20T00:00:00Z', repo: '/home/ada/pay', starting: false } }
    });
    worktreesAnswer = () =>
      answer({
        worktrees: [tree('/home/ada/pay', '/home/ada/pay/.worktrees/pay-1-x', 'pay-1-x'), tree('/home/ada/pay', '/home/ada/pay/.worktrees/develop', 'develop')],
        unavailable: []
      });
    await renderSetup();
    await userEvent.click(await within(reposCard()).findByRole('button', { name: '2 worktrees' }));
    const live = await within(reposCard()).findByRole('button', { name: 'Remove worktree pay-1-x' });
    expect(live).toBeDisabled();
    expect(live).toHaveAttribute('title', 'a session is running on PAY-1');
    const free = within(reposCard()).getByRole('button', { name: 'Remove worktree develop' });
    expect(free).toBeEnabled();
    expect(free.getAttribute('title')).toMatch(/^Copies the command\./);
    // The state and ticket pills: a live key reads `session live` and the key the branch carries; the other tree is idle with no ticket pill.
    const rows = Array.from(reposCard().querySelectorAll('.jira-wt-row')) as HTMLElement[];
    const liveRow = rows.find((r) => r.textContent?.includes('pay-1-x')) as HTMLElement;
    const freeRow = rows.find((r) => r.textContent?.includes('develop')) as HTMLElement;
    expect(within(liveRow).getByText('session live')).toBeInTheDocument();
    expect(within(liveRow).getByText('PAY-1')).toBeInTheDocument();
    expect(within(freeRow).getByText('idle')).toBeInTheDocument();
    expect(freeRow.querySelectorAll('.ui-pill')).toHaveLength(1);
  });

  it('reads the trees once per set of mapped paths — a defaults save does not re-read — and a failed read draws no list', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'] } });
    worktreesAnswer = () => answer({ error: 'boom' }, 500);
    await renderSetup();
    await waitFor(() => expect(worktreeReads()).toBe(1));
    expect(treesUnder()).toHaveLength(0);

    fireEvent.change(within(reposCard()).getByRole('textbox', { name: 'Branch name pattern for ~/pay' }), { target: { value: '{key}-{slug}' } });
    await userEvent.click(within(reposCard()).getByRole('button', { name: 'Save defaults for ~/pay' }));
    await waitFor(() => expect(statusReads()).toBeGreaterThan(1));
    expect(worktreeReads()).toBe(1);

    worktreesAnswer = () => answer({ worktrees: [tree('/home/ada/pay', '/home/ada/pay/.worktrees/develop', 'develop')], unavailable: [] });
    await pickProject('OPS');
    fireEvent.change(addField(), { target: { value: '/home/ada/ops' } });
    await userEvent.click(within(reposCard()).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(worktreeReads()).toBe(2));
    await userEvent.click(await within(reposCard()).findByRole('button', { name: '1 worktree' }));
    await waitFor(() => expect(treesUnder()).toHaveLength(1));
  });
});

describe('the Connection banner', () => {
  const figure = (label: string): HTMLElement => within(connectionCard()).getByText(label).parentElement as HTMLElement;

  it('says who is connected, the site and token kind, and that the server owns the change; no scopes are drawn', async () => {
    statusAnswer = status({ me: { accountId: 'acc-ada', name: 'Ada Lovelace' }, tokenKind: 'scoped', armed: true, calls: { sweep: 12, last429At: null } });
    await renderSetup();
    const banner = connectionCard();
    expect(within(banner).getByText('Connected as Ada Lovelace')).toBeInTheDocument();
    expect(within(banner).getByText('acme.atlassian.net · scoped')).toBeInTheDocument();
    expect(banner.textContent).not.toContain('read:jira-work');
    expect(within(banner).getByText('restart the server to change it')).toBeInTheDocument();
    expect(within(banner).getByText('AL')).toHaveClass('jira-setup-av');
    expect(within(banner).getByText('Healthy')).toHaveClass('ui-pill-live');
  });

  it('draws no health pill before the first status read: Connecting… and no Healthy', () => {
    render(
      <main>
        <JiraProvider>
          <JiraConnectionGroup />
        </JiraProvider>
      </main>
    );
    const banner = connectionCard();
    expect(within(banner).getByText('Connecting…')).toBeInTheDocument();
    expect(within(banner).queryByText('Healthy')).toBeNull();
    expect(banner.querySelector('.ui-pill')).toBeNull();
  });

  it('draws the three figures: last sweep, every, calls', async () => {
    statusAnswer = status({
      armed: true,
      calls: { sweep: 12, last429At: null },
      boards: [board({ polledAt: new Date(Date.now() - 9_000).toISOString() })]
    });
    await renderSetup();
    expect(figure('Last sweep').textContent).toContain('9 s');
    expect(figure('Every').textContent).toBe('Every15 s');
    expect(figure('Calls').textContent).toBe('Calls12no 429 since start');
  });

  it('has no last sweep when no board was ever polled, and reads idle while the poller is not armed', async () => {
    statusAnswer = status({ armed: false, calls: { sweep: 12, last429At: null }, boards: [board({ polledAt: null })] });
    await renderSetup();
    expect(figure('Last sweep').textContent).toBe('Last sweep—');
    expect(figure('Every').textContent).toBe('Everyidle');
  });

  it('says no identity when Jira has not answered /myself, with a question-mark disc', async () => {
    statusAnswer = status({ me: null, tokenKind: 'classic' });
    await renderSetup();
    expect(within(connectionCard()).getByText('no identity')).toBeInTheDocument();
    expect(within(connectionCard()).getByText('?')).toHaveClass('jira-setup-av');
    expect(within(connectionCard()).getByText('acme.atlassian.net · classic')).toBeInTheDocument();
  });

  it('draws a last 429 as an age under the calls, red while it is inside the red window', async () => {
    statusAnswer = status({ calls: { sweep: 3, last429At: new Date(Date.now() - 4 * 60_000 - 5_000).toISOString() } });
    await renderSetup();
    expect(within(connectionCard()).getByText('last 429 4m ago')).toHaveClass('jira-setup-failure');
    expect(figure('Calls').textContent).toBe('Calls3last 429 4m ago');
  });

  it('draws an old 429 in the neutral colour', async () => {
    statusAnswer = status({ calls: { sweep: 3, last429At: new Date(Date.now() - 2 * 3_600_000 - 5_000).toISOString() } });
    await renderSetup();
    expect(within(connectionCard()).getByText('last 429 2h ago')).not.toHaveClass('jira-setup-failure');
  });

  it('turns the pill red with the access phrase for a refused credential, and the detail follows on a red line', async () => {
    statusAnswer = status({ access: 'unauthorized', detail: 'Jira answered 401' });
    await renderSetup();
    const pill = within(connectionCard()).getByText(accessPhrase('unauthorized') as string);
    expect(pill).toHaveClass('ui-pill-bad');
    expect(within(connectionCard()).queryByText('Healthy')).toBeNull();
    expect(within(connectionCard()).getByText('Jira answered 401')).toHaveClass('jira-setup-failure');
  });

  it('turns the pill amber for a rate limit or an unreachable site', async () => {
    statusAnswer = status({ access: 'rate-limited', detail: null });
    await renderSetup();
    expect(within(connectionCard()).getByText(accessPhrase('rate-limited') as string)).toHaveClass('ui-pill-warn');
  });

  it('draws nothing red while access is ok and no 429 is recent', async () => {
    await renderSetup();
    expect(connectionCard().querySelector('.jira-setup-failure')).toBeNull();
  });

  it('puts no e-mail address anywhere on the page for a payload that carries none', async () => {
    statusAnswer = status({ projects: PROJECTS, repos: { PAY: ['/home/ada/pay'] } });
    await renderSetup();
    expect(document.body.textContent).not.toContain('@');
  });

  /*
    #541: the banner is the one full-width card between the band and `.set-cols`, and `.set` has no gap of its own (the band's 16 px bottom margin spaces
    the first card on every other Settings page), so the banner has to carry its own 16 px or it sits flush on the Boards / Skills cards. jsdom computes no
    layout, so the rule is read from the sheet.
  */
  it('keeps 16 px between the banner and the cards under it (#541)', () => {
    expect(ruleBlocks(readStyles(), '.jira-setup-banner').some((b) => /(^|[;\s])margin-bottom:\s*16px\b/.test(b))).toBe(true);
  });
});

describe('accessPhrase', () => {
  it('has a sentence for every access except ok, and null for ok', () => {
    expect(accessPhrase('ok')).toBeNull();
    for (const a of ['unconfigured', 'unsupported', 'unauthorized', 'forbidden', 'rate-limited', 'unreachable'] as const) {
      expect(typeof accessPhrase(a)).toBe('string');
    }
  });
});

/* ── Skills (Jira phase 5; spec §6.4; DESIGN.md §8.9.3) ──────────────────────────────────────────────────────────────────────────────────────── */

const GROOM: JiraSkill = { id: 's_0123abcd', name: 'Groom ticket', prompt: '/jira-groom {key}', group: 'run' };
const SUMMARISE: JiraSkill = { id: 's_0123abce', name: 'Summarise changes', prompt: '/summarise-jira-ticket-changes {key}', group: 'run' };
const REVIEW: JiraSkill = { id: 's_0123abcf', name: 'Review MR', prompt: '/review {key}', group: 'run' };

const skillsCard = (): HTMLElement => screen.getByRole('heading', { name: 'Skills' }).closest('section') as HTMLElement;
const skillNames = (): string[] => Array.from(skillsCard().querySelectorAll('.jira-setup-skill .jira-run-label')).map((n) => n.textContent ?? '');
/** The skill row whose label reads `name` — by the label span, since a built-in's sub-line repeats its label. */
const labelIn = (name: string): HTMLElement =>
  Array.from(skillsCard().querySelectorAll('.jira-setup-skill')).find((r) => r.querySelector('.jira-run-label')?.textContent === name) as HTMLElement;
const skillPosts = (): { id?: string; name: string; prompt: string; group?: JiraSkillGroup }[] =>
  posts('/api/jira/skills').map((p) => JSON.parse(String(p.init?.body)));
const skillName = (): HTMLInputElement => within(skillsCard()).getByRole('textbox', { name: 'Skill name' }) as HTMLInputElement;
const skillPrompt = (): HTMLTextAreaElement => within(skillsCard()).getByRole('textbox', { name: 'Skill prompt template' }) as HTMLTextAreaElement;
const addSkillChip = (): HTMLElement => within(skillsCard()).getByRole('button', { name: 'Add' });

describe('the Skills card', () => {
  it('draws the built-ins under `Built in`, then `Your run skills · N` with a row per skill: its command sub-line and a ×', async () => {
    statusAnswer = status({ skills: [GROOM, SUMMARISE] });
    await renderSetup();

    expect(skillNames()).toEqual(['Work it end to end', 'Open with the ticket loaded', 'Groom ticket', 'Summarise changes']);
    expect(within(skillsCard()).getByText('Built in')).toBeInTheDocument();
    // The context row's sub-line differs from its label (ui-verify D12), as in the Run menu.
    expect(within(labelIn('Open with the ticket loaded') as HTMLElement).getByText('A session, you drive')).toBeInTheDocument();
    expect(within(skillsCard()).getByText('Your run skills · 2')).toBeInTheDocument();
    // A built-in is code, not a stored row: no ×.
    for (const name of ['Work it end to end', 'Open with the ticket loaded']) {
      const row = labelIn(name) as HTMLElement;
      expect(within(row).queryByRole('button', { name: /^Remove/ })).toBeNull();
    }
    const groom = labelIn('Groom ticket') as HTMLElement;
    expect(within(groom).getByText('/jira-groom')).toBeInTheDocument();
    expect(groom).toHaveAttribute('title', '/jira-groom {key}');
    expect(within(groom).getByRole('button', { name: 'Remove Groom ticket' })).toBeInTheDocument();
  });

  it('draws no `Your run skills` head at zero skills, and nothing extra in its place', async () => {
    await renderSetup();
    expect(within(skillsCard()).queryByText(/^Your run skills/)).toBeNull();
    expect(within(skillsCard()).queryByText(/^No .* skills yet\.$/)).toBeNull();
  });

  it('marks `default` on the row the setting resolves to and `Make default` on the others; a pick writes the setting', async () => {
    statusAnswer = status({ skills: [GROOM, SUMMARISE] });
    await renderSetup();
    const rowOf = (name: string): HTMLElement => labelIn(name) as HTMLElement;
    expect(within(rowOf('Work it end to end')).getByText('default')).toBeInTheDocument();
    expect(within(rowOf('Work it end to end')).queryByRole('button', { name: /^Make/ })).toBeNull();
    expect(within(rowOf('Groom ticket')).getByText('Make default')).toBeInTheDocument();

    await userEvent.click(within(rowOf('Groom ticket')).getByRole('button', { name: 'Make Groom ticket the default action' }));
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').jiraDefaultAction).toBe('s_0123abcd');
    expect(within(rowOf('Groom ticket')).getByText('default')).toBeInTheDocument();
    expect(within(rowOf('Work it end to end')).getByText('Make default')).toBeInTheDocument();

    await userEvent.click(within(rowOf('Open with the ticket loaded')).getByRole('button', { name: /^Make .* the default action$/ }));
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').jiraDefaultAction).toBe('context');
  });

  it('sits in the right-hand column, apart from the Boards card (the Connection banner is above both columns)', async () => {
    await renderSetup();
    const column = skillsCard().closest('.set-col') as HTMLElement;
    expect(within(column).queryByRole('region', { name: 'Connection' })).toBeNull();
    expect(within(column).queryByRole('heading', { name: 'Boards' })).toBeNull();
  });

  it('names the six placeholders, says how the key is added, and says the list only names the skill', async () => {
    await renderSetup();
    const text = skillsCard().textContent ?? '';
    for (const placeholder of ['{key}', '{url}', '{repo}', '{branch}', '{base}', '{worktree}']) expect(text).toContain(placeholder);
    // The ticket's own text is no placeholder any more: a skill reads the ticket itself.
    for (const gone of ['{summary}', '{description}']) expect(text).not.toContain(gone);
    expect(text).toContain('a template without {key} gets the ticket key on a line after it');
    expect(text).toContain('a skill has to exist in the repo or the Claude install; this list only names it');
  });

  it('says the {worktree} is the expected path and that the one `jira.mjs worktree` prints wins', async () => {
    await renderSetup();
    expect(skillsCard().textContent).toContain('{worktree} is the expected path; the one jira.mjs worktree prints wins');
  });

  it('keeps Add disabled until the name and the template are both non-empty after trim', async () => {
    await renderSetup();
    expect(addSkillChip()).toBeDisabled();
    await userEvent.type(skillName(), '   ');
    await userEvent.type(skillPrompt(), '/x');
    expect(addSkillChip()).toBeDisabled();
    await userEvent.clear(skillName());
    await userEvent.type(skillName(), 'Plan');
    expect(addSkillChip()).toBeEnabled();
    await userEvent.clear(skillPrompt());
    await userEvent.type(skillPrompt(), '  ');
    expect(addSkillChip()).toBeDisabled();
  });

  it('Add POSTs { name, prompt, group: run } trimmed, reloads the status, clears both fields and draws the new row', async () => {
    await renderSetup();
    const before = statusReads();
    // `{{` types a literal `{` — a bare `{key}` is user-event's own key descriptor, not text.
    await userEvent.type(skillName(), '  Draft test plan ');
    await userEvent.type(skillPrompt(), ' /test-plan {{key} — {{summary}\n');
    await userEvent.click(addSkillChip());

    await waitFor(() => expect(skillPosts()).toEqual([{ name: 'Draft test plan', prompt: '/test-plan {key} — {summary}', group: 'run' }]));
    expect(posts('/api/jira/skills')[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
    await within(skillsCard()).findByText('Draft test plan');
    await waitFor(() => expect(skillName().value).toBe(''));
    expect(skillPrompt().value).toBe('');
  });

  // M4 (final review): the guard is a ref, as `useAction`'s is (bug-19) — `busy` state is not yet true for a second click in the same tick, and each POST would
  // mint its own `s_` id, so two clicks made two identical skills.
  it('two clicks on Add inside one tick POST once', async () => {
    await renderSetup();
    await userEvent.type(skillName(), 'Plan');
    await userEvent.type(skillPrompt(), '/plan {{key}');
    const chip = addSkillChip();
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(skillPosts()).toHaveLength(1));
    await within(skillsCard()).findByText('Plan');
    expect(skillPosts()).toHaveLength(1);
  });

  it('× asks through Confirm first and posts nothing until it is accepted, then POSTs { id } to /skills/delete and reloads', async () => {
    statusAnswer = status({ skills: [GROOM, SUMMARISE] });
    await renderSetup();
    const before = statusReads();

    await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Remove Groom ticket' }));
    expect(posts('/api/jira/skills/delete')).toHaveLength(0);
    const confirm = within(skillsCard()).getByRole('group', { name: 'Remove Groom ticket' });
    expect(confirm).toHaveTextContent('Groom ticket');
    await userEvent.click(within(confirm).getByTestId('jira-skill-delete-s_0123abcd-accept'));

    await waitFor(() => expect(posts('/api/jira/skills/delete').map((p) => JSON.parse(String(p.init?.body)))).toEqual([{ id: 's_0123abcd' }]));
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
    await waitFor(() => expect(skillNames()).toEqual(['Work it end to end', 'Open with the ticket loaded', 'Summarise changes']));
  });

  it('keeping the skill puts the × back and sends nothing', async () => {
    statusAnswer = status({ skills: [GROOM] });
    await renderSetup();
    await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Remove Groom ticket' }));
    await userEvent.click(within(skillsCard()).getByTestId('jira-skill-delete-s_0123abcd-dismiss'));
    expect(within(skillsCard()).getByRole('button', { name: 'Remove Groom ticket' })).toBeInTheDocument();
    expect(posts('/api/jira/skills/delete')).toHaveLength(0);
  });

  it('renders a 400’s sentence under the add row, keeps the typed fields and reloads nothing', async () => {
    skillsAnswer = () => answer({ error: 'name must be at most 60 characters' }, 400);
    await renderSetup();
    await userEvent.type(skillName(), 'Plan');
    await userEvent.type(skillPrompt(), '/plan {{key}');
    await userEvent.click(addSkillChip());

    const message = await within(skillsCard()).findByText('name must be at most 60 characters');
    expect(message).toHaveClass('set-error');
    expect(skillName().value).toBe('Plan');
    expect(skillPrompt().value).toBe('/plan {key}');
    expect(statusReads()).toBe(1);
  });

  it('shows a refused delete’s sentence too (a 404 for a skill another tab removed), and falls back to a status line without one', async () => {
    statusAnswer = status({ skills: [GROOM] });
    skillsDeleteAnswer = () => answer({ error: 'unknown skill' }, 404);
    await renderSetup();
    await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Remove Groom ticket' }));
    await userEvent.click(within(skillsCard()).getByTestId('jira-skill-delete-s_0123abcd-accept'));
    expect(await within(skillsCard()).findByText('unknown skill')).toHaveClass('set-error');

    skillsAnswer = () => answer(null, 502);
    await userEvent.type(skillName(), 'Plan');
    await userEvent.type(skillPrompt(), '/plan');
    await userEvent.click(addSkillChip());
    expect(await within(skillsCard()).findByText('the skill was not saved (HTTP 502)')).toBeInTheDocument();

    skillsAnswer = () => Promise.reject(new Error('down'));
    await userEvent.click(addSkillChip());
    expect(await within(skillsCard()).findByText('the skill was not saved — the server did not answer')).toBeInTheDocument();
  });

  describe('↑/↓ order (2026-11-17 skill-order spec)', () => {
    const moveButton = (label: string): HTMLElement => within(skillsCard()).getByRole('button', { name: label });
    const moveButtons = (): HTMLElement[] => within(skillsCard()).queryAllByRole('button', { name: /^Move / });
    const orderPosts = (): { ids: string[] }[] => posts('/api/jira/skills/order').map((p) => JSON.parse(String(p.init?.body)));
    const STALE = 'the skill list changed since this page loaded — reload and try again; nothing was written';

    it('disables ↑ on the first skill and ↓ on the last, enables the rest, and gives the built-ins no arrows', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE, REVIEW] });
      await renderSetup();
      expect(moveButton('Move Groom ticket up')).toBeDisabled();
      expect(moveButton('Move Groom ticket down')).toBeEnabled();
      expect(moveButton('Move Summarise changes up')).toBeEnabled();
      expect(moveButton('Move Summarise changes down')).toBeEnabled();
      expect(moveButton('Move Review MR up')).toBeEnabled();
      expect(moveButton('Move Review MR down')).toBeDisabled();
      for (const name of ['Work it end to end', 'Open with the ticket loaded']) {
        expect(within(labelIn(name)).queryAllByRole('button', { name: /^Move / })).toHaveLength(0);
      }
      // The arrows and `Edit` sit before the default slot, so `Make default` and × keep their places.
      const order = Array.from(labelIn('Groom ticket').querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
      expect(order).toEqual([
        'Move Groom ticket up',
        'Move Groom ticket down',
        'Edit Groom ticket',
        'Make Groom ticket the default action',
        'Remove Groom ticket'
      ]);
    });

    it('↓ on the first skill POSTs the whole order with the two swapped, reloads, and draws what the server stored', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE, REVIEW] });
      await renderSetup();
      const before = statusReads();
      await userEvent.click(moveButton('Move Groom ticket down'));

      await waitFor(() => expect(orderPosts()).toEqual([{ ids: ['s_0123abce', 's_0123abcd', 's_0123abcf'] }]));
      expect(posts('/api/jira/skills/order')[0].init?.headers).toEqual({ 'content-type': 'application/json' });
      await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
      await waitFor(() => expect(skillNames().slice(2)).toEqual(['Summarise changes', 'Groom ticket', 'Review MR']));
    });

    it('↑ on the last skill swaps it with the one above', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE, REVIEW] });
      await renderSetup();
      await userEvent.click(moveButton('Move Review MR up'));
      await waitFor(() => expect(orderPosts()).toEqual([{ ids: ['s_0123abcd', 's_0123abcf', 's_0123abce'] }]));
      await waitFor(() => expect(skillNames().slice(2)).toEqual(['Groom ticket', 'Review MR', 'Summarise changes']));
    });

    it('after a landed move keeps every arrow disabled until the reload answers, so no move acts on the old list', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE, REVIEW] });
      await renderSetup();
      let release: () => void = () => {};
      nextStatusRead = () =>
        new Promise<Response>((resolve) => {
          release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(statusAnswer) } as Response);
        });
      await userEvent.click(moveButton('Move Groom ticket down'));
      await waitFor(() => expect(orderPosts()).toHaveLength(1));
      // `busy` has cleared (the add row is live again), yet the list drawn is still the pre-move one: every arrow waits.
      await waitFor(() => expect(skillName()).toBeEnabled());
      expect(skillNames().slice(2)).toEqual(['Groom ticket', 'Summarise changes', 'Review MR']);
      for (const b of moveButtons()) expect(b).toBeDisabled();

      await act(async () => release());
      await waitFor(() => expect(skillNames().slice(2)).toEqual(['Summarise changes', 'Groom ticket', 'Review MR']));
      expect(moveButton('Move Summarise changes down')).toBeEnabled();
      expect(moveButton('Move Groom ticket up')).toBeEnabled();
    });

    it('a failed reload after a landed move re-enables the arrows (error turns true) rather than locking them', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE, REVIEW] });
      await renderSetup();
      nextStatusRead = () => answer({ error: 'boom' }, 500);
      await userEvent.click(moveButton('Move Groom ticket down'));
      await waitFor(() => expect(orderPosts()).toHaveLength(1));
      await waitFor(() => expect(moveButton('Move Summarise changes down')).toBeEnabled());
      // The drawn list is still the pre-move one: the failed read changed nothing.
      expect(skillNames().slice(2)).toEqual(['Groom ticket', 'Summarise changes', 'Review MR']);
    });

    it('a refused move shows the server’s sentence and leaves the drawn order alone', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE, REVIEW] });
      skillsOrderAnswer = () => answer({ error: STALE }, 409);
      await renderSetup();
      const before = statusReads();
      await userEvent.click(moveButton('Move Groom ticket down'));
      expect(await within(skillsCard()).findByText(STALE)).toHaveClass('set-error');
      expect(skillNames().slice(2)).toEqual(['Groom ticket', 'Summarise changes', 'Review MR']);
      expect(statusReads()).toBe(before);
      expect(moveButton('Move Groom ticket down')).toBeEnabled();
    });

    it('a move the server never answers says the order was not saved', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE] });
      skillsOrderAnswer = () => Promise.reject(new Error('down'));
      await renderSetup();
      await userEvent.click(moveButton('Move Groom ticket down'));
      expect(await within(skillsCard()).findByText('the order was not saved — the server did not answer')).toBeInTheDocument();
    });

    it('a refusal without a sentence falls back to the status line', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE] });
      skillsOrderAnswer = () => answer(null, 502);
      await renderSetup();
      await userEvent.click(moveButton('Move Groom ticket down'));
      expect(await within(skillsCard()).findByText('the order was not saved (HTTP 502)')).toBeInTheDocument();
    });

    it('a hand-duplicated id is sent once, and its repeated row draws the same arrows as its first', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE, { ...GROOM, name: 'Groom again' }, REVIEW] });
      await renderSetup();
      expect(moveButton('Move Groom again up')).toBeDisabled();
      expect(moveButton('Move Groom again down')).toBeEnabled();
      await userEvent.click(moveButton('Move Groom ticket down'));
      await waitFor(() => expect(orderPosts()).toEqual([{ ids: ['s_0123abce', 's_0123abcd', 's_0123abcf'] }]));
    });

    it('a row whose remove Confirm is open has its arrows disabled; the other rows keep theirs', async () => {
      statusAnswer = status({ skills: [GROOM, SUMMARISE, REVIEW] });
      await renderSetup();
      await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Remove Summarise changes' }));
      expect(moveButton('Move Summarise changes up')).toBeDisabled();
      expect(moveButton('Move Summarise changes down')).toBeDisabled();
      expect(moveButton('Move Groom ticket down')).toBeEnabled();
      expect(moveButton('Move Review MR up')).toBeEnabled();
    });
  });
});

/* ── Skills, Run and Review apart (2026-11-20 review-skills spec §2; mock Review-Skills.dc.html) ─────────────────────────────────────────────────────── */

/* Interleaved on purpose and unequal (three run, two review): a per-group order must permute only its own slice of the WHOLE list the server stores. */
const SK_A: JiraSkill = { id: 's_000000a1', name: 'Plan the ticket', prompt: '/plan {key}', group: 'run' };
const SK_R1: JiraSkill = { id: 's_000000b1', name: 'Claude code review', prompt: '/code-review high {mr.url}', group: 'review' };
const SK_B: JiraSkill = { id: 's_000000a2', name: 'Investigate a bug', prompt: '/investigate {key}', group: 'run' };
const SK_R2: JiraSkill = { id: 's_000000b2', name: 'MR review loop', prompt: '/mr-review-loop {mr.url}', group: 'review' };
const SK_C: JiraSkill = { id: 's_000000a3', name: 'Research a spike', prompt: '/research {key}', group: 'run' };
const MIXED = [SK_A, SK_R1, SK_B, SK_R2, SK_C];

describe('the Skills card, Run and Review apart', () => {
  const groupSwitch = (): HTMLElement => within(skillsCard()).getByRole('group', { name: 'Skill group' });
  const segment = (label: RegExp): HTMLElement => within(groupSwitch()).getByRole('button', { name: label });
  const showReview = (): Promise<void> => userEvent.click(segment(/^Review/));
  /** The card's text with each `Chevron` read as the `▾` it draws, so the explainers compare against the spec's copy verbatim. */
  const card = (): string => {
    const copy = skillsCard().cloneNode(true) as HTMLElement;
    copy.querySelectorAll('svg.chev').forEach((mark) => mark.replaceWith('▾'));
    return copy.textContent ?? '';
  };
  const orderPosts = (): { ids: string[] }[] => posts('/api/jira/skills/order').map((p) => JSON.parse(String(p.init?.body)));
  const editName = (): HTMLInputElement => within(skillsCard()).getByRole('textbox', { name: 'Edited skill name' }) as HTMLInputElement;
  const editPrompt = (): HTMLTextAreaElement => within(skillsCard()).getByRole('textbox', { name: 'Edited skill prompt template' }) as HTMLTextAreaElement;
  const editGroup = (): HTMLElement => within(skillsCard()).getByRole('group', { name: 'Group' });
  const REVIEW_SUB = 'Review: shows on an open MR, works on its source branch';

  it("says what both menus start in the scope line, and the switch counts each group with Run pressed and Run's explainer under it", async () => {
    statusAnswer = status({ skills: MIXED });
    await renderSetup();
    expect(card()).toContain("this machine · the prompts a card's Run menu and an MR's Review menu can start a session with");
    expect(segment(/^Run/)).toHaveTextContent('Run 3');
    expect(segment(/^Review/)).toHaveTextContent('Review 2');
    expect(segment(/^Run/)).toHaveAttribute('aria-pressed', 'true');
    expect(segment(/^Review/)).toHaveAttribute('aria-pressed', 'false');
    expect(card()).toContain("Run skills show in a ticket's Run ▾.");
    expect(card()).not.toContain("Review skills show in an MR's Review ▾");

    await showReview();
    expect(segment(/^Review/)).toHaveAttribute('aria-pressed', 'true');
    expect(card()).toContain("Review skills show in an MR's Review ▾ and start on that MR's source branch, never a new one.");
    expect(card()).not.toContain("Run skills show in a ticket's Run ▾.");
  });

  it('Run draws the two built-ins, `Your run skills · 3` with the order hint, and A, B, C with ↑ off on A and ↓ off on C', async () => {
    statusAnswer = status({ skills: MIXED });
    await renderSetup();
    expect(skillNames()).toEqual(['Work it end to end', 'Open with the ticket loaded', 'Plan the ticket', 'Investigate a bug', 'Research a spike']);
    expect(within(skillsCard()).getByText('Built in')).toBeInTheDocument();
    expect(within(skillsCard()).getByText('Your run skills · 3')).toBeInTheDocument();
    expect(within(skillsCard()).getByText('↑↓ to reorder · order = menu order')).toBeInTheDocument();
    const move = (label: string): HTMLElement => within(skillsCard()).getByRole('button', { name: label });
    expect(move('Move Plan the ticket up')).toBeDisabled();
    expect(move('Move Plan the ticket down')).toBeEnabled();
    expect(move('Move Investigate a bug up')).toBeEnabled();
    expect(move('Move Investigate a bug down')).toBeEnabled();
    expect(move('Move Research a spike up')).toBeEnabled();
    expect(move('Move Research a spike down')).toBeDisabled();
    expect(within(labelIn('Plan the ticket')).getByText('Make default')).toBeInTheDocument();
  });

  it('Review draws the bot built-in without `Make default`, `Your review skills · 2`, R1 and R2 with no `Make default`, and the Fills-in hint', async () => {
    statusAnswer = status({ skills: MIXED });
    await renderSetup();
    await showReview();
    expect(skillNames()).toEqual(['Review bot', 'Claude code review', 'MR review loop']);
    expect(within(labelIn('Review bot')).getByText('request a review, or fix what it found')).toBeInTheDocument();
    for (const name of ['Review bot', 'Claude code review', 'MR review loop']) {
      expect(within(labelIn(name)).queryByText('Make default')).toBeNull();
      expect(within(labelIn(name)).queryByText('default')).toBeNull();
    }
    expect(within(labelIn('Review bot')).queryByRole('button', { name: /^(Remove|Edit|Move) / })).toBeNull();
    expect(within(skillsCard()).getByText('Built in')).toBeInTheDocument();
    expect(within(skillsCard()).getByText('Your review skills · 2')).toBeInTheDocument();
    expect(within(skillsCard()).getByText('↑↓ to reorder · order = menu order')).toBeInTheDocument();
    expect(within(skillsCard()).getByRole('button', { name: 'Move Claude code review up' })).toBeDisabled();
    expect(within(skillsCard()).getByRole('button', { name: 'Move MR review loop down' })).toBeDisabled();
    expect(card()).toContain(
      'Fills in: {key}, {mr.url}, {mr.iid}, {mr.source}, {mr.target}, {mr.project} · a template without {key} gets the ticket key on a line after it'
    );
    // Run's two placeholder rows are Run's alone.
    expect(card()).not.toContain('placeholders:');
    expect(card()).not.toContain('jira.mjs worktree');
  });

  it('↓ on R1 posts the WHOLE list with only the review slice permuted', async () => {
    statusAnswer = status({ skills: MIXED });
    await renderSetup();
    await showReview();
    await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Move Claude code review down' }));
    await waitFor(() => expect(orderPosts()).toEqual([{ ids: ['s_000000a1', 's_000000b2', 's_000000a2', 's_000000b1', 's_000000a3'] }]));
    await waitFor(() => expect(skillNames()).toEqual(['Review bot', 'MR review loop', 'Claude code review']));
  });

  it('an empty Review group says `No review skills yet.` under the bot row, with no head and no order hint', async () => {
    statusAnswer = status({ skills: [SK_A, SK_B] });
    await renderSetup();
    await showReview();
    expect(within(skillsCard()).getByText('No review skills yet.')).toBeInTheDocument();
    expect(within(skillsCard()).queryByText(/^Your review skills/)).toBeNull();
    expect(within(skillsCard()).queryByText('↑↓ to reorder · order = menu order')).toBeNull();
    expect(segment(/^Review/)).toHaveTextContent('Review 0');
    // The bot's built-in row still draws above the empty line.
    expect(skillNames()).toEqual(['Review bot']);
  });

  it('a group with one skill draws its head but no order hint', async () => {
    statusAnswer = status({ skills: [SK_A, SK_R1] });
    await renderSetup();
    expect(within(skillsCard()).getByText('Your run skills · 1')).toBeInTheDocument();
    expect(within(skillsCard()).queryByText('↑↓ to reorder · order = menu order')).toBeNull();
    await showReview();
    expect(within(skillsCard()).getByText('Your review skills · 1')).toBeInTheDocument();
    expect(within(skillsCard()).queryByText('↑↓ to reorder · order = menu order')).toBeNull();
  });

  it("the add row on Review takes the review placeholders and posts `group: 'review'`", async () => {
    await renderSetup();
    expect(skillName()).toHaveAttribute('placeholder', 'Groom ticket');
    expect(skillPrompt()).toHaveAttribute('placeholder', '/jira-groom {key}');
    await showReview();
    expect(skillName()).toHaveAttribute('placeholder', 'Claude code review');
    expect(skillPrompt()).toHaveAttribute('placeholder', '/code-review high {mr.url}');
    await userEvent.type(skillName(), 'Claude code review');
    await userEvent.type(skillPrompt(), '/code-review high {{mr.url}');
    await userEvent.click(addSkillChip());
    await waitFor(() => expect(skillPosts()).toEqual([{ name: 'Claude code review', prompt: '/code-review high {mr.url}', group: 'review' }]));
    await waitFor(() => expect(skillNames()).toEqual(['Review bot', 'Claude code review']));
  });

  it('the remove confirm names the menu that stops offering the skill, per group', async () => {
    statusAnswer = status({ skills: MIXED });
    await renderSetup();
    await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Remove Plan the ticket' }));
    expect(within(skillsCard()).getByRole('group', { name: 'Remove Plan the ticket' })).toHaveTextContent(
      "Remove Plan the ticket? A card's Run menu stops offering it."
    );
    await showReview();
    await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Remove Claude code review' }));
    expect(within(skillsCard()).getByRole('group', { name: 'Remove Claude code review' })).toHaveTextContent(
      "Remove Claude code review? An MR's Review menu stops offering it."
    );
  });

  describe('inline Edit', () => {
    it('swaps the row for its name and prompt pre-filled, Group with Review pressed and its sub-line, and Save / Cancel', async () => {
      statusAnswer = status({ skills: MIXED });
      await renderSetup();
      await showReview();
      await userEvent.click(within(labelIn('Claude code review')).getByRole('button', { name: 'Edit Claude code review' }));
      expect(labelIn('Claude code review')).toBeUndefined();
      expect(editName().value).toBe('Claude code review');
      expect(editPrompt().value).toBe('/code-review high {mr.url}');
      expect(within(editGroup()).getByRole('button', { name: 'Review' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(editGroup()).getByRole('button', { name: 'Run' })).toHaveAttribute('aria-pressed', 'false');
      expect(card()).toContain('Group');
      expect(card()).toContain(REVIEW_SUB);
      expect(within(skillsCard()).getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(within(skillsCard()).getByRole('button', { name: 'Cancel' })).toBeEnabled();
      // The add row is still there, under the group.
      expect(skillName().value).toBe('');
    });

    it('switching Group to Run hides the sub-line; Save posts { id, name, prompt, group: run }, closes, and the skill leaves the shown segment', async () => {
      statusAnswer = status({ skills: MIXED });
      await renderSetup();
      await showReview();
      await userEvent.click(within(labelIn('Claude code review')).getByRole('button', { name: 'Edit Claude code review' }));
      await userEvent.click(within(editGroup()).getByRole('button', { name: 'Run' }));
      expect(card()).not.toContain(REVIEW_SUB);
      await userEvent.clear(editName());
      await userEvent.type(editName(), ' Review as a run ');
      await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(skillPosts()).toEqual([{ id: 's_000000b1', name: 'Review as a run', prompt: '/code-review high {mr.url}', group: 'run' }])
      );
      // The shown segment does not follow the skill.
      await waitFor(() => expect(skillNames()).toEqual(['Review bot', 'MR review loop']));
      expect(segment(/^Review/)).toHaveAttribute('aria-pressed', 'true');
      expect(within(skillsCard()).queryByRole('textbox', { name: 'Edited skill name' })).toBeNull();
      expect(segment(/^Run/)).toHaveTextContent('Run 4');
      // id and list position kept: it sits where R1 sat, between A and B.
      await userEvent.click(segment(/^Run/));
      expect(skillNames().slice(2)).toEqual(['Plan the ticket', 'Review as a run', 'Investigate a bug', 'Research a spike']);
    });

    it('names the skill being edited, says Esc cancels, focuses the name field, and Cancel closes it', async () => {
      statusAnswer = status({ skills: MIXED });
      await renderSetup();
      await userEvent.click(within(labelIn('Investigate a bug')).getByRole('button', { name: 'Edit Investigate a bug' }));
      expect(within(skillsCard()).getByText('Editing Investigate a bug')).toBeInTheDocument();
      expect(within(skillsCard()).getByText('Esc cancels')).toBeInTheDocument();
      expect(editName()).toHaveFocus();
      // The head names the STORED skill: typing does not rewrite it.
      await userEvent.type(editName(), ' more');
      expect(within(skillsCard()).getByText('Editing Investigate a bug')).toBeInTheDocument();
      await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Cancel' }));
      expect(within(skillsCard()).queryByRole('textbox', { name: 'Edited skill name' })).toBeNull();
      expect(within(skillsCard()).queryByText('Esc cancels')).toBeNull();
    });

    it('a refusal shows in the alert row and keeps the editor open with what was typed', async () => {
      statusAnswer = status({ skills: MIXED });
      skillsAnswer = () => answer({ error: 'name must be at most 60 characters' }, 400);
      await renderSetup();
      await userEvent.click(within(labelIn('Plan the ticket')).getByRole('button', { name: 'Edit Plan the ticket' }));
      expect(within(editGroup()).getByRole('button', { name: 'Run' })).toHaveAttribute('aria-pressed', 'true');
      expect(card()).not.toContain(REVIEW_SUB);
      await userEvent.type(editName(), ' again');
      await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Save' }));
      const alert = await within(skillsCard()).findByRole('alert');
      expect(alert).toHaveTextContent('name must be at most 60 characters');
      expect(editName().value).toBe('Plan the ticket again');
    });

    it('Cancel puts the row back and posts nothing', async () => {
      statusAnswer = status({ skills: MIXED });
      await renderSetup();
      await userEvent.click(within(labelIn('Plan the ticket')).getByRole('button', { name: 'Edit Plan the ticket' }));
      await userEvent.type(editName(), ' x');
      await userEvent.click(within(skillsCard()).getByRole('button', { name: 'Cancel' }));
      expect(within(skillsCard()).queryByRole('textbox', { name: 'Edited skill name' })).toBeNull();
      expect(labelIn('Plan the ticket')).toBeDefined();
      expect(skillPosts()).toHaveLength(0);
    });

    it("one editor at a time: Edit on R2 closes R1's, and × on another row closes an open one", async () => {
      statusAnswer = status({ skills: MIXED });
      await renderSetup();
      await showReview();
      await userEvent.click(within(labelIn('Claude code review')).getByRole('button', { name: 'Edit Claude code review' }));
      await userEvent.click(within(labelIn('MR review loop')).getByRole('button', { name: 'Edit MR review loop' }));
      expect(within(skillsCard()).getAllByRole('textbox', { name: 'Edited skill name' })).toHaveLength(1);
      expect(editName().value).toBe('MR review loop');
      expect(labelIn('Claude code review')).toBeDefined();

      await userEvent.click(within(labelIn('Claude code review')).getByRole('button', { name: 'Remove Claude code review' }));
      expect(within(skillsCard()).queryByRole('textbox', { name: 'Edited skill name' })).toBeNull();
      expect(labelIn('MR review loop')).toBeDefined();
    });

    it('Escape closes the editor and nothing else', async () => {
      statusAnswer = status({ skills: MIXED });
      await renderSetup();
      await userEvent.click(within(labelIn('Plan the ticket')).getByRole('button', { name: 'Edit Plan the ticket' }));
      await userEvent.keyboard('{Escape}');
      expect(within(skillsCard()).queryByRole('textbox', { name: 'Edited skill name' })).toBeNull();
      expect(labelIn('Plan the ticket')).toBeDefined();
      expect(skillPosts()).toHaveLength(0);
    });
  });
});

/* ── the GitLab card (#527) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/* The page mounted as `renderSetup` mounts it, but under a GitLab context this case builds — `NoGitlab`'s raw-provider shape with a value of its own — so
   each case states exactly which answer the card is drawing from, and `refresh` is a mock a case can hold open to see the pill stay disabled. */
async function renderSetupWithGitlab(value: GitlabContextValue): Promise<void> {
  onOpenJiraPage = jest.fn((p) => setJiraPage(p));
  render(
    <main>
      <SettingsProvider>
        <JiraProvider>
          <GitlabContext.Provider value={value}>
            <JiraView onOpenJiraPage={onOpenJiraPage} />
          </GitlabContext.Provider>
        </JiraProvider>
      </SettingsProvider>
    </main>
  );
  await screen.findByRole('heading', { name: 'Boards' });
}

function gitlabStatus(over: Partial<GitlabStatus> = {}): GitlabStatus {
  return {
    state: 'connected',
    site: 'gitlab.example.com',
    malformedSite: false,
    user: { username: 'ada', name: 'Ada Lovelace' },
    httpStatus: 200,
    reason: null,
    armed: true,
    retryAt: null,
    mappedRepos: 2,
    foundHosts: [],
    problems: [],
    interval: '5m',
    ...over
  };
}

const gitlabPayload = (over: Partial<GitlabStatus> = {}): GitlabPayload => ({ status: gitlabStatus(over), jiraProjects: {}, mrs: [] });
const gitlabValue = (data: GitlabPayload | null, refresh: GitlabContextValue['refresh'] = jest.fn(() => Promise.resolve(data))): GitlabContextValue => ({
  data,
  error: null,
  refresh
});

const gitlabCard = (): HTMLElement | null => screen.queryByRole('heading', { name: 'GitLab' })?.closest('section') ?? null;
const gitlabPill = (): HTMLElement => within(gitlabCard() as HTMLElement).getByRole('group', { name: 'Sync interval' });
const pressed = (): string[] =>
  within(gitlabPill())
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent ?? '');
const syncPosts = (): Sent[] => posts('/api/gitlab/sync');

describe('the GitLab card', () => {
  let syncAnswer: (body: { interval: string }) => Promise<Response>;

  beforeEach(() => {
    syncAnswer = (body) => answer({ interval: body.interval });
    // The suite's fetch stub knows no GitLab route; this case's own answer sits in front of it, recorded in `sent` the same way.
    const inner = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/gitlab/sync') return inner(input, init);
      sent.push({ url: String(input), init });
      return syncAnswer(JSON.parse(String(init?.body)));
    }) as unknown as typeof fetch;
  });

  it('draws nothing while the GitLab answer has not arrived (case 27)', async () => {
    await renderSetupWithGitlab(gitlabValue(null));
    expect(gitlabCard()).toBeNull();
    expect(screen.queryByRole('group', { name: 'Sync interval' })).toBeNull();
  });

  it('draws nothing while GitLab is unconfigured — there is no poller to pace (case 28)', async () => {
    await renderSetupWithGitlab(gitlabValue(gitlabPayload({ state: 'unconfigured', site: null })));
    expect(gitlabCard()).toBeNull();
  });

  it('draws nothing for a status with no interval — an API older than this client — rather than a value the server never said (case 29)', async () => {
    const { interval: _omitted, ...older } = gitlabStatus();
    await renderSetupWithGitlab(gitlabValue({ status: older as GitlabStatus, jiraProjects: {}, mrs: [] }));
    expect(gitlabCard()).toBeNull();
  });

  it('draws the card: this machine, the four intervals in the shared order, the server’s value selected, the site in the hint (case 30)', async () => {
    await renderSetupWithGitlab(gitlabValue(gitlabPayload()));
    const card = gitlabCard() as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText('this machine')).toBeInTheDocument();
    expect(within(gitlabPill()).getAllByRole('button').map((b) => b.textContent)).toEqual(['15s', '1m', '5m', 'off']);
    expect(pressed()).toEqual(['5m']);
    expect(within(card).getByText('gitlab.example.com · every mapped repo, one sweep')).toBeInTheDocument();
  });

  it('posts nothing when the selected value is picked again (case 31)', async () => {
    const refresh = jest.fn(() => Promise.resolve(null));
    await renderSetupWithGitlab(gitlabValue(gitlabPayload(), refresh));
    await userEvent.click(within(gitlabPill()).getByRole('button', { name: '5m' }));
    expect(syncPosts()).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('posts the pick as JSON, holds the pill disabled through the post AND the refetch, then refreshes once (case 32)', async () => {
    let landPost!: () => void;
    syncAnswer = (body) => new Promise((resolve) => (landPost = () => resolve(answer({ interval: body.interval }) as unknown as Response)));
    let landRefresh!: () => void;
    const refresh = jest.fn(() => new Promise<GitlabPayload | null>((resolve) => (landRefresh = () => resolve(null))));
    await renderSetupWithGitlab(gitlabValue(gitlabPayload(), refresh));

    await userEvent.click(within(gitlabPill()).getByRole('button', { name: '15s' }));
    expect(syncPosts()).toHaveLength(1);
    const [post] = syncPosts();
    expect(JSON.parse(String(post.init?.body))).toEqual({ interval: '15s' });
    expect(new Headers(post.init?.headers).get('content-type')).toBe('application/json');
    const buttons = within(gitlabPill()).getAllByRole('button');
    buttons.forEach((b) => expect(b).toBeDisabled());

    await act(async () => landPost());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    buttons.forEach((b) => expect(b).toBeDisabled());

    await act(async () => landRefresh());
    await waitFor(() => buttons.forEach((b) => expect(b).toBeEnabled()));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the old value selected on a 409 and shows the server’s sentence in the hint (case 33)', async () => {
    const sentence = 'settings/gitlab-sync.json does not parse as JSON — fix or delete it by hand; nothing was written';
    syncAnswer = () => answer({ error: sentence }, 409);
    await renderSetupWithGitlab(gitlabValue(gitlabPayload()));
    await userEvent.click(within(gitlabPill()).getByRole('button', { name: '15s' }));
    expect(await within(gitlabCard() as HTMLElement).findByText(sentence)).toBeInTheDocument();
    expect(pressed()).toEqual(['5m']);
    expect(within(gitlabCard() as HTMLElement).queryByText('gitlab.example.com · every mapped repo, one sweep')).toBeNull();
  });

  it('says a request that never reached the server could not save, in its own words', async () => {
    syncAnswer = () => Promise.reject(new Error('Failed to fetch'));
    await renderSetupWithGitlab(gitlabValue(gitlabPayload()));
    await userEvent.click(within(gitlabPill()).getByRole('button', { name: 'off' }));
    expect(await within(gitlabCard() as HTMLElement).findByText('could not save — Failed to fetch')).toBeInTheDocument();
    expect(pressed()).toEqual(['5m']);
  });

  it('names both files the page writes in the band’s sub-line (case 34)', async () => {
    await renderSetupWithGitlab(gitlabValue(gitlabPayload()));
    const sub = screen.getByText(/the boards this machine follows/);
    expect(sub.textContent).toContain('jira.json');
    expect(sub.textContent).toContain('gitlab-sync.json');
  });
});
