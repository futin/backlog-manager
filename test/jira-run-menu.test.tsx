/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraRunMenu } from '../client/src/components/jira/JiraRunMenu';
import { JiraContext } from '../client/src/hooks/JiraContext';
import { JiraSessionsContext } from '../client/src/hooks/JiraSessionsContext';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { stubIssue } from '../client/src/lib/jira-list';
import { daysAgoStamp } from './helpers/dates';
import { JIRA_BUILTIN_LABELS, type JiraIssue, type JiraIssueDetail, type JiraLink, type JiraSessionsPayload, type JiraStatusPayload } from '../shared/types';

/*
  `Run on` in the Run menu (spec `2026-11-11-jira-run-on-parent-design.md` §4.2, §6 cases 4–10 and 16; DESIGN.md §8.9.1) — `JiraRunMenu` alone, between the
  two contexts the shell would fill, over a `fetch` whose parent reads land only when a case says so. What it owns: the toggle drawn on a sub-task with a
  parent (and nowhere else), its reset to the sub-task on every open, the parent read on demand only, the parent's own gate on the parent's rows, and a
  pick that carries the issue the rows act on. The four callers' closures are pinned through the real pages in `jira-board.test.tsx` and
  `jira-list.test.tsx`, because a closure that drops the issue argument is exactly what this suite, calling `onPick` directly, cannot see.
*/

function issue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    id: `1${key.replace(/\D/g, '')}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `Summary of ${key}`,
    project: { key: key.split('-')[0], name: 'Project' },
    type: { name: 'Story', level: 0, subtask: false },
    status: { name: 'To Do', category: 'new' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: daysAgoStamp(3),
    updated: daysAgoStamp(1),
    resolved: null,
    ...over
  };
}
const SUB_TYPE = { name: 'Sub-task', level: -1, subtask: true };
const subtask = (key: string, parentKey: string): JiraIssue => issue(key, { type: SUB_TYPE, parent: { key: parentKey, summary: `Summary of ${parentKey}` } });
const S_1 = subtask('S-1', 'P-1');

function detail(key: string, over: Partial<JiraIssue> = {}): JiraIssueDetail {
  return { ...issue(key, over), description: '', children: [], transitions: [], boards: [], session: null };
}

const SKILL = { id: 'sk-review', name: 'Review', prompt: '/review-it' };

function status(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: null,
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [],
    repos: { S: ['/r/s'], P: ['/r/p'] },
    repoDefaults: {},
    projects: [],
    skills: [SKILL],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: true,
    home: '/home/ada',
    ...over
  };
}

type SessionLink = JiraSessionsPayload['links'][number];
function runLink(key: string): SessionLink {
  const l: JiraLink = {
    key,
    sessionId: 's1',
    how: 'run',
    action: 'execute',
    name: `jira ${key}`,
    repo: '/r/p',
    branch: null,
    surface: 'dashboard',
    model: null,
    effort: null,
    snapshot: { summary: 'x', type: 'Story', parentKey: null },
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    endedAt: null,
    endReason: null,
    quietSince: null,
    reattachedAt: null
  };
  return { ...l, state: 'working', row: null, stateSince: l.startedAt };
}

const json = (body: unknown, code = 200): Response => ({ ok: code >= 200 && code < 300, status: code, json: () => Promise.resolve(body) }) as Response;

/** The issue reads asked for, in order, and one resolver per read. */
let reads: string[];
let answers: ((res: Response) => void)[];
const land = async (i: number, res: Response): Promise<void> => {
  await act(async () => {
    answers[i](res);
  });
};

beforeEach(() => {
  localStorage.clear();
  reads = [];
  answers = [];
  global.fetch = jest.fn(
    (input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => {
        reads.push(String(input));
        answers.push(resolve);
      })
  ) as unknown as typeof fetch;
});

let onPick: jest.Mock;
function mount(issues: JiraIssue[], opts: { status?: Partial<JiraStatusPayload>; sessions?: JiraSessionsPayload | null } = {}): void {
  onPick = jest.fn();
  render(
    <SettingsProvider>
      <JiraContext.Provider value={{ data: status(opts.status), loading: false, error: false, reload: jest.fn() }}>
        <JiraSessionsContext.Provider value={{ data: opts.sessions ?? null, reload: jest.fn(() => Promise.resolve()) }}>
          {issues.map((i) => (
            <JiraRunMenu key={i.key} issue={i} onPick={onPick} />
          ))}
        </JiraSessionsContext.Provider>
      </JiraContext.Provider>
    </SettingsProvider>
  );
}

const chevron = (key: string): HTMLElement => screen.getByRole('button', { name: `Run options for ${key}` });
async function openMenu(key: string): Promise<HTMLElement> {
  await userEvent.click(chevron(key));
  return screen.getByRole('dialog', { name: 'Run menu' });
}
const toggle = (menu: HTMLElement): HTMLElement => within(menu).getByRole('group', { name: 'Run on' });
const segment = (menu: HTMLElement, key: string): HTMLElement => within(toggle(menu)).getByRole('button', { name: new RegExp(`^${key}\\b`) });
const rowsOf = (menu: HTMLElement): HTMLButtonElement[] => Array.from(menu.querySelectorAll<HTMLButtonElement>('.jira-run-opt'));
const rowNamed = (menu: HTMLElement, label: string): HTMLElement => within(menu).getByRole('button', { name: label });
const subOf = (row: HTMLElement): string => row.querySelector('.jira-run-sub')?.textContent ?? '';
const issueReads = (): string[] => reads.filter((u) => u.startsWith('/api/jira/issue/'));

describe('Run on — when the toggle draws', () => {
  it('a story under an epic has no Run on control', async () => {
    mount([issue('S-2', { parent: { key: 'E-1', summary: 'Epic' } })]);
    const menu = await openMenu('S-2');
    expect(within(menu).queryByRole('group', { name: 'Run on' })).toBeNull();
  });

  it("a sub-task's menu opens on its own segment, and a row picks the sub-task — today's behaviour", async () => {
    mount([S_1]);
    const menu = await openMenu('S-1');
    expect(segment(menu, 'S-1')).toHaveAttribute('aria-pressed', 'true');
    expect(segment(menu, 'S-1')).toHaveTextContent('this sub-task');
    expect(segment(menu, 'P-1')).toHaveAttribute('aria-pressed', 'false');
    expect(segment(menu, 'P-1')).toHaveTextContent(/^P-1parent$/);
    await userEvent.click(rowNamed(menu, JIRA_BUILTIN_LABELS.execute));
    expect(onPick).toHaveBeenCalledWith(S_1, 'execute');
  });

  it('the left Run half still runs the sub-task', async () => {
    mount([S_1]);
    await userEvent.click(screen.getByRole('button', { name: 'Run S-1' }));
    expect(onPick).toHaveBeenCalledWith(S_1, 'execute');
  });
});

describe('Run on — the parent segment', () => {
  it('disables every row while the parent loads, then acts on the read parent', async () => {
    mount([S_1]);
    const menu = await openMenu('S-1');
    await userEvent.click(segment(menu, 'P-1'));
    expect(issueReads()).toEqual(['/api/jira/issue/P-1']);
    expect(segment(menu, 'P-1')).toHaveAttribute('aria-pressed', 'true');
    for (const r of rowsOf(menu)) {
      expect(r).toBeDisabled();
      expect(r).toHaveAttribute('title', 'loading P-1…');
    }
    await land(0, json(detail('P-1', { type: { name: 'Story', level: 0, subtask: false } })));
    expect(segment(menu, 'P-1')).toHaveTextContent('parent story');
    for (const r of rowsOf(menu)) expect(r).toBeEnabled();
    expect(subOf(rowNamed(menu, JIRA_BUILTIN_LABELS.execute))).toBe('Work P-1 end to end');
    // Every other row's sub-line is unchanged.
    expect(subOf(rowNamed(menu, JIRA_BUILTIN_LABELS.context))).toBe('A session, you drive');
    await userEvent.click(rowNamed(menu, JIRA_BUILTIN_LABELS.execute));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].key).toBe('P-1');
    expect(onPick.mock.calls[0][1]).toBe('execute');
  });

  it('a skill row picks the parent with that skill', async () => {
    mount([S_1]);
    let menu = await openMenu('S-1');
    await userEvent.click(segment(menu, 'P-1'));
    await land(0, json(detail('P-1')));
    menu = screen.getByRole('dialog', { name: 'Run menu' });
    await userEvent.click(rowNamed(menu, 'Review'));
    expect(onPick.mock.calls[0][0].key).toBe('P-1');
    expect(onPick.mock.calls[0][1]).toEqual({ skill: 'sk-review' });
  });

  it("the parent's live run disables the parent rows only; the sub-task segment stays enabled", async () => {
    mount([S_1], { sessions: { links: [runLink('P-1')], reachable: true, rowsAt: null } });
    const menu = await openMenu('S-1');
    await userEvent.click(segment(menu, 'P-1'));
    await land(0, json(detail('P-1')));
    for (const r of rowsOf(menu)) {
      expect(r).toBeDisabled();
      expect(r).toHaveAttribute('title', 'a session is running on P-1');
    }
    await userEvent.click(segment(menu, 'S-1'));
    for (const r of rowsOf(menu)) expect(r).toBeEnabled();
  });

  it("gates on the parent's own project: a parent in an unmapped project is no-repo while the sub-task's rows stay enabled", async () => {
    mount([S_1]);
    const menu = await openMenu('S-1');
    await userEvent.click(segment(menu, 'P-1'));
    await land(0, json(detail('P-1', { project: { key: 'OTHER', name: 'Other' } })));
    for (const r of rowsOf(menu)) {
      expect(r).toBeDisabled();
      expect(r).toHaveAttribute('title', 'no repository mapped for OTHER — Jira › Setup › Repositories');
    }
    await userEvent.click(segment(menu, 'S-1'));
    for (const r of rowsOf(menu)) expect(r).toBeEnabled();
  });

  it('a failed read titles the rows with the sentence and notes it under the toggle; picking the segment again clears it and reads again', async () => {
    mount([S_1]);
    const menu = await openMenu('S-1');
    await userEvent.click(segment(menu, 'P-1'));
    await land(0, json({ error: 'boom' }, 500));
    for (const r of rowsOf(menu)) {
      expect(r).toBeDisabled();
      expect(r).toHaveAttribute('title', 'boom');
    }
    expect(within(menu).getByText('boom')).toHaveClass('jira-run-target-note');
    await userEvent.click(segment(menu, 'P-1'));
    expect(within(menu).queryByText('boom')).toBeNull();
    expect(issueReads()).toHaveLength(2);
    await land(1, json(detail('P-1')));
    for (const r of rowsOf(menu)) expect(r).toBeEnabled();
  });
});

describe('Run on — resets and reads', () => {
  it('close and reopen starts on the sub-task again', async () => {
    mount([S_1]);
    let menu = await openMenu('S-1');
    await userEvent.click(segment(menu, 'P-1'));
    await land(0, json(detail('P-1')));
    await userEvent.click(chevron('S-1'));
    expect(screen.queryByRole('dialog', { name: 'Run menu' })).toBeNull();
    menu = await openMenu('S-1');
    expect(segment(menu, 'S-1')).toHaveAttribute('aria-pressed', 'true');
  });

  it("another sub-task's menu opens on its own segment after the first picked its parent", async () => {
    mount([S_1, subtask('S-2', 'P-1')]);
    const first = await openMenu('S-1');
    await userEvent.click(segment(first, 'P-1'));
    await land(0, json(detail('P-1')));
    await userEvent.click(chevron('S-1'));
    const second = await openMenu('S-2');
    expect(segment(second, 'S-2')).toHaveAttribute('aria-pressed', 'true');
    expect(segment(second, 'P-1')).toHaveAttribute('aria-pressed', 'false');
  });

  it('three sub-task cards read nothing; only picking the parent segment reads', async () => {
    mount([S_1, subtask('S-2', 'P-1'), subtask('S-3', 'P-3')]);
    const menu = await openMenu('S-2');
    expect(issueReads()).toEqual([]);
    await userEvent.click(segment(menu, 'P-1'));
    expect(issueReads()).toEqual(['/api/jira/issue/P-1']);
    await land(0, json(detail('P-1')));
  });

  it('a menu re-reads after it closed: pick, land, close, reopen, pick → a second read', async () => {
    mount([S_1]);
    let menu = await openMenu('S-1');
    await userEvent.click(segment(menu, 'P-1'));
    await land(0, json(detail('P-1')));
    await userEvent.click(chevron('S-1'));
    menu = await openMenu('S-1');
    await userEvent.click(segment(menu, 'P-1'));
    expect(issueReads()).toHaveLength(2);
    await land(1, json(detail('P-1')));
  });

  it("a Sessions stub (parent summary '') still draws the toggle, reads by key, and picks the read parent", async () => {
    const stub = stubIssue('S-9', { summary: 's', type: 'Sub-task', parentKey: 'P-9' }, '');
    mount([stub], { status: { repos: { S: ['/r/s'], P: ['/r/p'] } } });
    const menu = await openMenu('S-9');
    expect(segment(menu, 'P-9')).toBeInTheDocument();
    await userEvent.click(segment(menu, 'P-9'));
    expect(issueReads()).toEqual(['/api/jira/issue/P-9']);
    await land(0, json(detail('P-9')));
    await userEvent.click(rowNamed(menu, JIRA_BUILTIN_LABELS.execute));
    expect(onPick.mock.calls[0][0].key).toBe('P-9');
    expect(onPick.mock.calls[0][0].summary).toBe('Summary of P-9');
  });
});
