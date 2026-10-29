/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import JiraView from '../client/src/components/jira/JiraView';
import { JiraProvider } from '../client/src/hooks/JiraContext';
import { setJiraPage } from '../client/src/hooks/useJiraPage';
import { JIRA_BOARD_KEY, JIRA_QUERY_PRESETS, accessPhrase, boardRowLine } from '../client/src/lib/jira';
import { JIRA_PAGE_KEY } from '../client/src/lib/jira-page';
import type { JiraBoardStatus, JiraIssue, JiraSkill, JiraStatusPayload } from '../shared/types';

/*
  Jira › Setup (Jira phase 2; spec §6.4; DESIGN.md §8.9.3) — the real page over a mocked `fetch`, in `jira-board.test.tsx`'s style: the Boards
  card (its order, its line per board, `Open board`, the filter field from the sixth board) and the board sheet (new and edit, the roots search, the four
  query chips, the debounced JQL check, Save and Delete, and Review Focus 2's unreadable `jira.json`).

  The page reads `GET /api/jira` through the real `JiraProvider`, and is mounted through the real `JiraView` with the real page store, so `Open board` and
  Escape are asserted against the same store the rail's tree writes. Every request is recorded with its init, because several cases are about a request that
  must NOT be made and the save cases are about the body. Fixture stamps are relative to the clock the assertion runs under (`test/fixture-clock.test.ts`).

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
let skillsAnswer: (body: { id?: string; name: string; prompt: string }) => Promise<Response>;
let skillsDeleteAnswer: (body: { id: string }) => Promise<Response>;
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
    const skill: JiraSkill = { id: body.id ?? 's_00000001', name: body.name, prompt: body.prompt };
    statusAnswer = { ...statusAnswer, skills: [...statusAnswer.skills.filter((k) => k.id !== skill.id), skill] };
    return answer(skill);
  };
  skillsDeleteAnswer = (body) => {
    statusAnswer = { ...statusAnswer, skills: statusAnswer.skills.filter((k) => k.id !== body.id) };
    return answer({ ok: true });
  };
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
    if (url === '/api/jira') return answer(statusAnswer);
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
      <JiraProvider>
        <JiraView onOpenJiraPage={onOpenJiraPage} />
      </JiraProvider>
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
      expect(within(rowOf(b.name)).getByText(boardRowLine(b, Date.now()).text)).toBeInTheDocument();
    }
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
    const pay7 = { ...issue('PAY-7', 'Ledger export'), parent: { key: 'PAY-120', summary: 'Refund flows' } };
    boardIssuesAnswer = (id) => answer(id === ALPHA.id ? { issues: [issue('PAY-120', 'Refund flows'), pay7], polledAt: null } : { issues: [], polledAt: null });
    await renderSetup();
    const dialog = await openEdit('Alpha board');

    const row = within(dialog).getByRole('button', { name: 'Remove PAY-120' }).closest('.jira-sheet-root') as HTMLElement;
    await waitFor(() => expect(row).toHaveTextContent('Refund flows'));
    expect(urls(`/api/jira/boards/${ALPHA.id}/issues`)).toHaveLength(1);
    expect(urls('/api/jira/search')).toEqual([]);
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
const connectionCard = (): HTMLElement => screen.getByRole('heading', { name: 'Connection' }).closest('section') as HTMLElement;
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
    expect(repoNames().slice(0, 2)).toEqual(['PAY · Payments', 'PAY']);

    await userEvent.click(within(reposCard()).getByRole('button', { name: 'Remove ~/pay-2' }));
    await waitFor(() => expect(repoPosts()).toEqual([{ project: 'PAY', paths: ['/Users/ada/pay'] }]));
    expect(posts('/api/jira/repos')[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    // The status was asked for again, and the card follows it.
    await waitFor(() => expect(repoHints().filter((h) => h.startsWith('~'))).toEqual(['~/pay']));
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
    expect(baseField().placeholder).toBe('e.g. develop');
    expect(patternField().value).toBe('');
    expect(patternField().placeholder).toBe('{key}-{slug}');
    expect(saveButton()).toBeDisabled();
    fireEvent.change(patternField(), { target: { value: '{key}/{slug}' } });
    expect(saveButton()).toBeEnabled();
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
    await waitFor(() => expect(treesUnder()).toHaveLength(1));
    const [list] = treesUnder();
    expect(branchesOf(list)).toEqual(['detached', 'develop', 'pay-1-x']);
    expect(within(list).getByText('3')).toBeInTheDocument();
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
      live: { 'PAY-1': { name: 'pay-1', startedAt: '2026-10-20T00:00:00Z', repo: '/home/ada/pay', starting: false } }
    });
    worktreesAnswer = () =>
      answer({
        worktrees: [tree('/home/ada/pay', '/home/ada/pay/.worktrees/pay-1-x', 'pay-1-x'), tree('/home/ada/pay', '/home/ada/pay/.worktrees/develop', 'develop')],
        unavailable: []
      });
    await renderSetup();
    const live = await within(reposCard()).findByRole('button', { name: 'Remove worktree pay-1-x' });
    expect(live).toBeDisabled();
    expect(live).toHaveAttribute('title', 'a session is running on PAY-1');
    const free = within(reposCard()).getByRole('button', { name: 'Remove worktree develop' });
    expect(free).toBeEnabled();
    expect(free.getAttribute('title')).toMatch(/^Copies the command\./);
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
    await waitFor(() => expect(treesUnder()).toHaveLength(1));
  });
});

describe('the Connection card', () => {
  const rowText = (name: string): string => (within(connectionCard()).getByText(name).closest('.set-row') as HTMLElement).textContent ?? '';

  it('reports the site, who is signed in, the token kind with the three scopes named, and the last sweep while armed', async () => {
    statusAnswer = status({ me: { accountId: 'acc-ada', name: 'Ada Lovelace' }, tokenKind: 'scoped', armed: true, calls: { sweep: 12, last429At: null } });
    await renderSetup();
    expect(rowText('Site')).toContain('acme.atlassian.net');
    expect(rowText('Signed in as')).toContain('Ada Lovelace');
    const token = rowText('Token');
    expect(token).toContain('scoped');
    for (const scope of ['read:jira-work', 'write:jira-work', 'read:jira-user']) expect(token).toContain(scope);
    expect(rowText('Last sweep')).toContain('every 15 s · 12 calls · no 429 since start');
    expect(within(connectionCard()).getByText('restart the server to change it')).toBeInTheDocument();
  });

  it('reads idle while the poller is not armed', async () => {
    statusAnswer = status({ armed: false, calls: { sweep: 12, last429At: null } });
    await renderSetup();
    expect(rowText('Last sweep')).toContain('idle · 12 calls · no 429 since start');
  });

  it('says no identity when Jira has not answered /myself, and draws a classic token as classic', async () => {
    statusAnswer = status({ me: null, tokenKind: 'classic' });
    await renderSetup();
    expect(rowText('Signed in as')).toContain('no identity');
    expect(rowText('Token')).toContain('classic');
  });

  it('draws a last 429 as an age, red while it is inside the red window', async () => {
    statusAnswer = status({ calls: { sweep: 3, last429At: new Date(Date.now() - 4 * 60_000 - 5_000).toISOString() } });
    await renderSetup();
    expect(within(connectionCard()).getByText('last 429 4m ago')).toHaveClass('jira-setup-failure');
    expect(rowText('Last sweep')).toContain('every 15 s · 3 calls · last 429 4m ago');
  });

  it('draws an old 429 in the neutral colour', async () => {
    statusAnswer = status({ calls: { sweep: 3, last429At: new Date(Date.now() - 2 * 3_600_000 - 5_000).toISOString() } });
    await renderSetup();
    expect(within(connectionCard()).getByText('last 429 2h ago')).not.toHaveClass('jira-setup-failure');
  });

  it('names a refused credential in red on the Signed in as row, with the server\'s detail', async () => {
    statusAnswer = status({ access: 'unauthorized', detail: 'Jira answered 401' });
    await renderSetup();
    const row = within(connectionCard()).getByText('Signed in as').closest('.set-row') as HTMLElement;
    expect(within(row).getByText(accessPhrase('unauthorized') as string)).toHaveClass('jira-setup-failure');
    expect(row.textContent).toContain('Jira answered 401');
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

const GROOM: JiraSkill = { id: 's_0123abcd', name: 'Groom ticket', prompt: '/jira-groom {key}' };
const SUMMARISE: JiraSkill = { id: 's_0123abce', name: 'Summarise changes', prompt: '/summarise-jira-ticket-changes {key}' };

const skillsCard = (): HTMLElement => screen.getByRole('heading', { name: 'Skills' }).closest('section') as HTMLElement;
const skillNames = (): string[] => Array.from(skillsCard().querySelectorAll('.set-row .set-name')).map((n) => n.textContent ?? '');
const skillPosts = (): { id?: string; name: string; prompt: string }[] => posts('/api/jira/skills').map((p) => JSON.parse(String(p.init?.body)));
const skillName = (): HTMLInputElement => within(skillsCard()).getByRole('textbox', { name: 'Skill name' }) as HTMLInputElement;
const skillPrompt = (): HTMLTextAreaElement => within(skillsCard()).getByRole('textbox', { name: 'Skill prompt template' }) as HTMLTextAreaElement;
const addSkillChip = (): HTMLElement => within(skillsCard()).getByRole('button', { name: 'Add' });

describe('the Skills card', () => {
  it('draws the two built-ins as locked rows with no ×, then one row per skill with its template and a ×', async () => {
    statusAnswer = status({ skills: [GROOM, SUMMARISE] });
    await renderSetup();

    expect(skillNames()).toEqual(['Work it end to end', 'Open with the ticket loaded', 'Groom ticket', 'Summarise changes']);
    for (const name of ['Work it end to end', 'Open with the ticket loaded']) {
      const row = within(skillsCard()).getByText(name).closest('.set-row') as HTMLElement;
      expect(within(row).getByText('built-in')).toBeInTheDocument();
      expect(within(row).queryByRole('button')).toBeNull();
    }
    const groom = within(skillsCard()).getByText('Groom ticket').closest('.set-row') as HTMLElement;
    expect(within(groom).getByText('/jira-groom {key}')).toBeInTheDocument();
    expect(within(groom).getByRole('button', { name: 'Remove Groom ticket' })).toBeInTheDocument();
  });

  it('sits in the right-hand column under Connection', async () => {
    await renderSetup();
    const column = skillsCard().closest('.set-col') as HTMLElement;
    expect(within(column).getByRole('heading', { name: 'Connection' })).toBeInTheDocument();
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

  it('Add POSTs { name, prompt } trimmed, reloads the status, clears both fields and draws the new row', async () => {
    await renderSetup();
    const before = statusReads();
    // `{{` types a literal `{` — a bare `{key}` is user-event's own key descriptor, not text.
    await userEvent.type(skillName(), '  Draft test plan ');
    await userEvent.type(skillPrompt(), ' /test-plan {{key} — {{summary}\n');
    await userEvent.click(addSkillChip());

    await waitFor(() => expect(skillPosts()).toEqual([{ name: 'Draft test plan', prompt: '/test-plan {key} — {summary}' }]));
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
});
