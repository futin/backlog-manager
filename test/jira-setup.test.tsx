/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import JiraView from '../client/src/components/jira/JiraView';
import { JiraProvider } from '../client/src/hooks/JiraContext';
import { setJiraPage } from '../client/src/hooks/useJiraPage';
import { JIRA_BOARD_KEY, JIRA_QUERY_PRESETS, boardRowLine } from '../client/src/lib/jira';
import { JIRA_PAGE_KEY } from '../client/src/lib/jira-page';
import type { JiraBoardStatus, JiraIssue, JiraStatusPayload } from '../shared/types';

/*
  Jira › Setup (Jira phase 2, Task 10; spec §6.4; DESIGN.md §8.9.3) — the real page over a mocked `fetch`, in `jira-board.test.tsx`'s style: the Boards
  card (its order, its line per board, `Open board`, the filter field from the sixth board) and the board sheet (new and edit, the roots search, the four
  query chips, the debounced JQL check, Save and Delete, and Review Focus 2's unreadable `jira.json`).

  The page reads `GET /api/jira` through the real `JiraProvider`, and is mounted through the real `JiraView` with the real page store, so `Open board` and
  Escape are asserted against the same store the rail's tree writes. Every request is recorded with its init, because several cases are about a request that
  must NOT be made and the save cases are about the body. Fixture stamps are relative to the clock the assertion runs under (`test/fixture-clock.test.ts`).

  Task 11 appends the Repositories and Connection cases to this file.
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

  it('`+ Assigned to me` adds a row with R5’s label and JQL', async () => {
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
