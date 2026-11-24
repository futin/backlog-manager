/**
 * @jest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { JiraTicketBody } from '../../client/src/components/jira/JiraTicketBody';
import { GitlabContext } from '../../client/src/hooks/GitlabContext';
import { JiraContext } from '../../client/src/hooks/JiraContext';
import { MentionWrap, mention, mentionIssue, mentionsPayload } from '../helpers/mention-stub';
import { JiraSessionsContext } from '../../client/src/hooks/JiraSessionsContext';
import { JIRA_DETAIL_TAB_KEY, setJiraDetailTab } from '../../client/src/hooks/useJiraDetailTab';
import { SettingsProvider } from '../../client/src/hooks/useSettings';
import { UNKNOWN_LINE } from '../../client/src/lib/delivery';
import type { SessionLink } from '../../client/src/lib/jira-sessions';
import { browserTimeZone, formatZonedClock, zonedParts } from '../../client/src/lib/time-zone';
import { pollAge } from '../../client/src/lib/tracker';
import { STATE_LABEL, type JiraSessionState } from '../../shared/jira-sessions';
import type {
  AgentsStatus,
  DashboardRow,
  GitlabMr,
  GitlabPayload,
  GitlabProjectView,
  JiraBoardStatus,
  JiraIssue,
  JiraIssueDetail,
  JiraSessionsPayload,
  JiraStatusPayload
} from '../../shared/types';
import { daysAgoStamp } from '../helpers/dates';

/*
  Jira › Detail's body (Jira detail tabs spec §1, §9 case 27; DESIGN.md §8.9.2): the heading, the summary strip, the tab row and the Ticket pane,
  drawn by both frames. It is mounted here bare — no `Modal`, no page — with the frame's read handed in as `detail`, so what is asserted is the body's alone:
  which tabs draw and which is selected (the remembered `jira-detail-tab` store, never written by a fallback), the strip's cells on every tab, the write
  controls that moved into it, and the Details facts that did not. Fixture stamps are relative to the clock the assertion runs under (`test/helpers/dates.ts`).
  §9 cases 8–16 are not here: they are the shared table (`test/helpers/ticket-body-cases.ts`), run through each frame that draws this body, so the modal
  and the page are held to one set of cases on one set of fixtures (Task 7).
*/

const minutesAgo = (m: number): string => daysAgoStamp(m / 1440);

const DANA = { accountId: 'acc-dana', name: 'Dana Novak' };
const READER = { accountId: 'acc-sam', name: 'Sam Ortiz' };

const ISSUE: JiraIssue = {
  key: 'PAY-12',
  id: '10012',
  url: 'https://acme.atlassian.net/browse/PAY-12',
  summary: 'Refund partial captures',
  project: { key: 'PAY', name: 'Payments' },
  type: { name: 'Story', level: 0, subtask: false },
  status: { name: 'In Review', category: 'indeterminate' },
  priority: 'High',
  assignee: DANA,
  reporter: 'Lee Park',
  parent: { key: 'PAY-3', summary: 'Refund flows', type: null, status: null },
  subtasks: 0,
  labels: ['payments'],
  sprint: 'Sprint 40',
  created: daysAgoStamp(10),
  updated: daysAgoStamp(1),
  resolved: null
};

const BOARD: JiraBoardStatus = {
  id: 'b_0a1b2c3d',
  name: 'Payments',
  roots: ['PAY-3'],
  queries: [],
  interval: '1m',
  polledAt: daysAgoStamp(0),
  count: 3,
  truncated: false,
  failures: []
};

function detail(over: Partial<JiraIssueDetail> = {}): JiraIssueDetail {
  return {
    ...ISSUE,
    description: 'Partial captures are **not** refunded.',
    children: [],
    transitions: [
      { id: '21', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' } },
      { id: '31', name: 'Done', to: { name: 'Done', category: 'done' } }
    ],
    boards: [BOARD.id],
    session: null,
    ...over
  } as JiraIssueDetail;
}

function status(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: READER,
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [BOARD],
    repos: { PAY: ['/Users/dana/pay'] },
    repoDefaults: {},
    projects: [{ key: 'PAY', name: 'Payments' }],
    skills: [],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: true,
    home: '/Users/dana',
    mentions: null,
    ...over
  };
}

let nextIid = 40;
function mr(over: Partial<GitlabMr>): GitlabMr {
  const iid = over.iid ?? nextIid++;
  return {
    project: 'acme/pay-api',
    iid,
    title: `PAY-12 | change ${iid}`,
    webUrl: `https://gitlab.example.test/acme/pay-api/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    sourceBranch: 'pay-12-refunds',
    targetBranch: 'develop',
    createdAt: minutesAgo(600),
    updatedAt: minutesAgo(30),
    mergedAt: null,
    headSha: null,
    pipeline: 'success',
    keys: ['PAY-12'],
    review: null,
    ...over
  };
}

const PAY_API: GitlabProjectView = { path: 'acme/pay-api', repo: 'pay-api', polledAt: minutesAgo(2), capped: false, failed: false, repos: [] };

function gitlab(mrs: GitlabMr[], views: GitlabProjectView[] | null = [PAY_API]): GitlabPayload {
  return {
    status: {
      state: 'connected',
      site: 'gitlab.example.test',
      malformedSite: false,
      user: { username: 'dana', name: 'Dana Novak' },
      httpStatus: null,
      reason: null,
      armed: true,
      retryAt: null,
      mappedRepos: 1,
      foundHosts: [],
      problems: [],
      interval: '1m'
    },
    jiraProjects: views === null ? {} : { PAY: views },
    mrs
  };
}

/** The two targets of the brief's fixture: `develop`'s pipeline failed (red), `demo` is open with no review and a passing pipeline (green). */
const TWO_TARGETS = (): GitlabMr[] => [
  mr({ iid: 41, targetBranch: 'develop', pipeline: 'failed', updatedAt: minutesAgo(20) }),
  mr({ iid: 42, targetBranch: 'demo', pipeline: 'success', review: null, updatedAt: minutesAgo(10) })
];

function link(over: Partial<SessionLink> & { sessionId: string; state: JiraSessionState }): SessionLink {
  return {
    key: 'PAY-12',
    how: 'run',
    action: 'execute',
    name: `Execute PAY-12 ${over.sessionId}`,
    repo: '/Users/dana/pay',
    branch: null,
    surface: 'dashboard',
    model: null,
    effort: null,
    snapshot: { summary: 'Refund partial captures', type: 'Story', parentKey: 'PAY-3' },
    startedAt: minutesAgo(5),
    endedAt: null,
    endReason: null,
    quietSince: null,
    reattachedAt: null,
    row: null,
    stateSince: minutesAgo(5),
    ...over
  };
}

/** One `working` session 3 min old, one waiting on an answer for 10 min (older), and five ended ones. */
function sessions(key = 'PAY-12'): JiraSessionsPayload {
  const ended = [1, 2, 3, 4, 5].map((n) =>
    link({
      key,
      sessionId: `s-ended-${n}`,
      state: 'ended',
      startedAt: minutesAgo(600 + n * 60),
      stateSince: minutesAgo(500 + n * 60),
      endedAt: minutesAgo(500 + n * 60)
    })
  );
  return {
    links: [
      link({ key, sessionId: 's-working', state: 'working', startedAt: minutesAgo(3), stateSince: minutesAgo(3) }),
      link({ key, sessionId: 's-answer', state: 'answer', startedAt: minutesAgo(10), stateSince: minutesAgo(10) }),
      ...ended
    ],
    reachable: true,
    rowsAt: new Date().toISOString()
  };
}

function json(body: unknown, init: { status?: number } = {}): Response {
  const code = init.status ?? 200;
  return { ok: code >= 200 && code < 300, status: code, json: () => Promise.resolve(body) } as Response;
}

let posts: string[];
let post: (url: string) => Response;
let onWrote: jest.Mock;
let onOpenIssue: jest.Mock;
let onBack: jest.Mock;
let reload: jest.Mock;
/** The agents status the session cards ask for: `null` never answers (see the stub), a value answers — only the Stop cases need one. */
let agentsStatus: AgentsStatus | null;

beforeEach(() => {
  posts = [];
  agentsStatus = null;
  post = () => json({ ok: true, reread: true });
  onWrote = jest.fn();
  onOpenIssue = jest.fn();
  onBack = jest.fn();
  reload = jest.fn();
  setJiraDetailTab('ticket');
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push(url);
      return post(url);
    }
    if (url === '/api/agents/status' && agentsStatus !== null) return json(agentsStatus);
    // The two reads this suite asserts nothing about — the Worktrees list's and the session cards' agents status — never answer: an answer would land after
    // a synchronous case's last line, outside `act`, and neither is what these cases are about (`jira-detail.test.tsx` covers both).
    if (url === '/api/agents/status' || url === '/api/jira/worktrees') return new Promise<Response>(() => {});
    return json({ error: 'not in this suite' }, { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(cleanup);

interface Opts {
  issue?: JiraIssue;
  detail?: JiraIssueDetail | null;
  failure?: string | null;
  status?: Partial<JiraStatusPayload>;
  sessions?: JiraSessionsPayload | null;
  gitlab?: GitlabPayload | null;
  back?: JiraIssue | null;
}

function tree(opts: Opts = {}) {
  const issue = opts.issue ?? ISSUE;
  const gl = opts.gitlab === undefined ? gitlab(TWO_TARGETS()) : opts.gitlab;
  const live = opts.sessions === undefined ? sessions(issue.key) : opts.sessions;
  return (
    <SettingsProvider>
      <GitlabContext.Provider value={{ data: gl, error: null, refresh: () => Promise.resolve(gl) }}>
        <JiraContext.Provider value={{ data: status(opts.status), loading: false, error: false, reload }}>
          <JiraSessionsContext.Provider value={{ data: live, reload: jest.fn(() => Promise.resolve()) }}>
            <JiraTicketBody
              issue={issue}
              detail={opts.detail === undefined ? detail({ ...issue }) : opts.detail}
              failure={opts.failure ?? null}
              childrenOf={null}
              back={opts.back ?? null}
              onBack={onBack}
              onOpenIssue={onOpenIssue}
              onWrote={onWrote}
              onRun={jest.fn()}
            />
          </JiraSessionsContext.Provider>
        </JiraContext.Provider>
      </GitlabContext.Provider>
    </SettingsProvider>
  );
}

const mount = (opts: Opts = {}) => render(tree(opts));
const tabNames = (): string[] => screen.getAllByRole('tab').map((t) => t.textContent ?? '');
const selected = (): string => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? '';
const stored = (): unknown => {
  const raw = window.localStorage.getItem(JIRA_DETAIL_TAB_KEY);
  return raw === null ? null : JSON.parse(raw);
};
const strip = (): HTMLElement => screen.getByRole('group', { name: 'Summary' });

describe('JiraTicketBody — the strip (T27)', () => {
  // The transition itself, and the strip's other T11 cases, are the shared table's (`test/helpers/ticket-body-cases.ts`), run through each frame; what only
  // the bare body can show is the argument it hands its frame on a landed write: `true`, "re-read me".
  it('a landed transition hands the frame `onWrote(true)`', async () => {
    mount();
    fireEvent.click(within(strip()).getByRole('button', { name: 'Move to' }));
    const panel = screen.getByRole('dialog', { name: 'Move to' });
    expect(within(panel).getByText('In Progress')).toBeInTheDocument();
    fireEvent.click(within(panel).getByText('Done'));
    await waitFor(() => expect(posts).toEqual(['/api/jira/issue/transition']));
    await waitFor(() => expect(onWrote).toHaveBeenCalledWith(true));
  });

  it('T27: the Agent pill leads with the session waiting on an answer, not the newer working one, then `+1`', () => {
    mount();
    const lead = within(strip()).getByRole('button', { name: new RegExp(STATE_LABEL.answer) });
    expect(lead).toHaveTextContent(`${STATE_LABEL.answer} · ${pollAge(minutesAgo(10), Date.now())}`);
    expect(lead).toHaveTextContent(`${STATE_LABEL.answer} · 10m`);
    expect(within(strip()).getByText('+1')).toBeInTheDocument();
    expect(within(strip()).queryByText(new RegExp(`^${STATE_LABEL.working}`))).toBeNull();
  });

  it('a `starting` reservation alone leads the Agent pill, aged from its `startedAt`', () => {
    mount({
      sessions: { links: [], reachable: true, rowsAt: new Date().toISOString() },
      status: { live: { 'PAY-12': { name: 'Execute PAY-12', sessionId: null, startedAt: minutesAgo(4), repo: '/Users/dana/pay', starting: true } } }
    });
    expect(within(strip()).getByRole('button', { name: `${STATE_LABEL.starting} · 4m` })).toBeInTheDocument();
  });

  it('with nothing live: `idle · 5 ended`, or `no sessions` on a ticket that never had one', () => {
    const only = sessions();
    const { rerender } = mount({ sessions: { ...only, links: only.links.filter((l) => l.endedAt !== null) } });
    expect(within(strip()).getByText('idle · 5 ended')).toBeInTheDocument();
    rerender(tree({ sessions: { links: [], reachable: true, rowsAt: new Date().toISOString() } }));
    expect(within(strip()).getByText('no sessions')).toBeInTheDocument();
  });

  it('Review Focus 4: five targets draw red, amber, amber, then `+2` in green’s tone; `+2` selects Delivery', () => {
    mount({
      gitlab: gitlab([
        mr({ iid: 61, targetBranch: 'develop', pipeline: 'success', updatedAt: minutesAgo(60) }),
        mr({ iid: 62, targetBranch: 'demo', pipeline: null, updatedAt: minutesAgo(120) }),
        mr({ iid: 63, targetBranch: 'staging', pipeline: 'running', updatedAt: minutesAgo(180) }),
        mr({ iid: 64, targetBranch: 'release', pipeline: 'running', updatedAt: minutesAgo(240) }),
        mr({ iid: 65, targetBranch: 'main', pipeline: 'failed', updatedAt: minutesAgo(300) })
      ])
    });
    const pills = within(strip()).getAllByRole('button', { name: /pipeline/ });
    expect(pills.map((p) => [p.textContent, p.getAttribute('data-tone')])).toEqual([
      ['main · pipeline failed', 'red'],
      ['staging · pipeline running', 'amber'],
      ['release · pipeline running', 'amber']
    ]);
    const more = within(strip()).getByRole('button', { name: '+2' });
    expect(more).toHaveAttribute('data-tone', 'green');
    fireEvent.click(more);
    expect(selected()).toBe('Delivery 5 targets');
  });

  it('`none` draws one grey `no MR`; `unknown` draws a grey `unknown` titled with the Delivery pane’s sentence', () => {
    const { rerender } = mount({ gitlab: gitlab([]) });
    const none = within(strip()).getByText('no MR');
    expect(none).toHaveAttribute('data-tone', 'grey');
    expect(screen.getByRole('tab', { name: 'Delivery' })).toBeInTheDocument();
    rerender(tree({ gitlab: gitlab([], [{ ...PAY_API, polledAt: null }]) }));
    const unknown = within(strip()).getByText('unknown');
    expect(unknown).toHaveAttribute('data-tone', 'grey');
    expect(unknown).toHaveAttribute('title', UNKNOWN_LINE['not-read']);
  });

  it('a failing `Assign to me` draws its sentence in the alert under the strip, on every tab', async () => {
    post = () => json({ error: 'Jira refused: assignee not allowed' }, { status: 502 });
    mount();
    fireEvent.click(within(strip()).getByRole('button', { name: 'Assign to me' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Jira refused: assignee not allowed');
    for (const name of [/^Delivery/, /^Agent/, /^Children/, /^Ticket/]) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(screen.getByRole('alert')).toHaveTextContent('Jira refused: assignee not allowed');
    }
    expect(onWrote).not.toHaveBeenCalled();
  });
});

describe('JiraTicketBody — heading and Ticket pane', () => {
  it('draws the key, the type and labels as tags, and the summary as the title', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Refund partial captures' })).toBeInTheDocument();
    const head = screen.getByRole('heading').parentElement as HTMLElement;
    expect(within(head).getByText('PAY-12')).toBeInTheDocument();
    expect(within(head).getByText('Story')).toBeInTheDocument();
    expect(within(head).getByText('payments')).toBeInTheDocument();
  });

  it('draws `← <key>` while a walk is open, and its press is the frame’s `onBack`', () => {
    mount({ back: { ...ISSUE, key: 'PAY-9', summary: 'Card refunds' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to PAY-9' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Details holds Reporter, Priority, Created · updated, On boards, Repository and Session — and none of the strip’s facts', () => {
    mount();
    const details = screen.getByRole('region', { name: 'Details' });
    for (const label of ['Reporter', 'Priority', 'Labels', 'Created · updated', 'On boards', 'Repository', 'Session']) {
      expect(within(details).getByText(label)).toBeInTheDocument();
    }
    expect(within(details).getByText('Lee Park')).toBeInTheDocument();
    expect(within(details).getByText('Payments')).toBeInTheDocument();
    expect(within(details).getByText('~/pay')).toBeInTheDocument();
    for (const label of ['Status', 'Assignee', 'Sprint', 'Parent', 'Resolved']) {
      expect(within(details).queryByText(label)).toBeNull();
    }
    expect(screen.getByText('Partial captures are', { exact: false })).toBeInTheDocument();
  });

  it('draws `Resolved` when the ticket carries a resolution date, and no `Labels` fact without labels', () => {
    const done = { ...ISSUE, labels: [], resolved: daysAgoStamp(2) };
    mount({ issue: done, detail: detail({ ...done }) });
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('Resolved')).toBeInTheDocument();
    expect(within(details).queryByText('Labels')).toBeNull();
  });

  it('a failed read keeps the card’s facts and says why where the description would be', () => {
    mount({ detail: null, failure: 'Jira unreachable: timeout' });
    expect(screen.getByText('could not read the ticket — Jira unreachable: timeout')).toBeInTheDocument();
    expect(within(strip()).getByText('Sprint 40')).toBeInTheDocument();
    expect(within(strip()).getByRole('button', { name: 'Move to' })).toHaveAttribute('title', 'transitions unavailable');
  });

  it('the Agent tab draws today’s band content without `Run ▾`', async () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: /^Agent/ }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getAllByRole('article')).toHaveLength(2);
    expect(within(panel).queryByRole('button', { name: /Run/ })).toBeNull();
  });
});

/*
  The Agent tab (spec §5, case 15) and the Children & comments tab (spec §6, case 16). The folds render their body only while open (`ui/Fold`), so "closed"
  is asserted as the rows not being in the document at all, and a summary is pressed by its label.
*/
const AGENTS_ON: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'acceptEdits',
  projectPaths: ['/Users/dana/pay']
};
const MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const panel = (): HTMLElement => screen.getByRole('tabpanel');
/** A fold's summary, found by its label, so a press toggles it as the reader's would. */
const summaryOf = (label: string): HTMLElement => {
  const el = within(panel()).getByText(label, { selector: '.jira-fold-label' }).closest('summary');
  if (el === null) throw new Error(`no summary for ${label}`);
  return el as HTMLElement;
};
const foldOf = (label: string): HTMLElement => summaryOf(label).closest('details') as HTMLElement;
const openTab = (name: RegExp): void => {
  fireEvent.click(screen.getByRole('tab', { name }));
};
/** Opens a card's `Session actions` menu and says whether it holds `name`; a card with no menu rows has no chevron at all. */
async function cardMenuHas(card: HTMLElement, name: string): Promise<boolean> {
  const chev = within(card).queryByRole('button', { name: 'More for PAY-12' });
  if (chev === null) return false;
  fireEvent.click(chev);
  const has = within(screen.getByRole('dialog', { name: 'Session actions' })).queryByRole('button', { name }) !== null;
  fireEvent.click(chev);
  return has;
}
const CHILD_A: JiraIssue = {
  ...ISSUE,
  key: 'PAY-21',
  id: '10021',
  summary: 'Ledger rounding fix',
  status: { name: 'To Do', category: 'new' },
  parent: { key: 'PAY-12', summary: 'Refund partial captures', type: null, status: null }
};
const CHILD_B: JiraIssue = { ...CHILD_A, key: 'PAY-22', id: '10022', summary: 'Refund webhook retries', status: { name: 'Done', category: 'done' } };
const NO_SESSIONS: JiraSessionsPayload = { links: [], reachable: true, rowsAt: new Date().toISOString() };

describe('JiraTicketBody — Agent tab', () => {
  it('with no live session: `No session on this ticket`, the `default: … · last run <age>` line, and no `Run ▾` in the pane', () => {
    const payload = sessions();
    const endedOnly: JiraSessionsPayload = { ...payload, links: payload.links.filter((l) => l.endedAt !== null) };
    const newest = endedOnly.links.find((l) => l.sessionId === 's-ended-1')?.endedAt as string;
    mount({ sessions: endedOnly });
    openTab(/^Agent/);
    expect(within(panel()).getByText('No session on this ticket')).toBeInTheDocument();
    expect(within(panel()).getByText(`default: Work it end to end · last run ${pollAge(newest, Date.now())}`)).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: /Run/ })).toBeNull();
    expect(within(panel()).queryByRole('article')).toBeNull();
  });

  it('the gate line sits at the top of the tab, above the cards', () => {
    mount();
    openTab(/^Agent/);
    const gate = within(panel()).getByText('Next Run can start once this one is quiet.');
    const [first] = within(panel()).getAllByRole('article');
    expect(gate.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('an opened History closes again on a walk step to the next ticket', () => {
    const both: JiraSessionsPayload = { ...sessions('PAY-12'), links: [...sessions('PAY-12').links, ...sessions('PAY-21').links] };
    const { rerender } = mount({ sessions: both });
    openTab(/^Agent/);
    fireEvent.click(summaryOf('History'));
    expect(foldOf('History')).toHaveAttribute('open');
    rerender(tree({ issue: CHILD_A, detail: detail({ ...CHILD_A }), sessions: both, back: ISSUE }));
    expect(foldOf('History')).not.toHaveAttribute('open');
  });

  it('a ticket that never had a session draws no History fold', () => {
    mount({ sessions: NO_SESSIONS });
    openTab(/^Agent/);
    expect(within(panel()).queryByText('History')).toBeNull();
  });
});

describe('JiraTicketBody — Children & comments tab', () => {
  it('while the detail read is out the Children fold reads `loading…`', () => {
    mount({ detail: null });
    openTab(/^Children & comments/);
    expect(within(foldOf('Children')).getByText('loading…')).toBeInTheDocument();
  });

  it('a failed read draws nothing in the Children fold (the Ticket tab carries the failure line)', () => {
    mount({ detail: null, failure: 'Jira unreachable: timeout' });
    openTab(/^Children & comments/);
    const fold = foldOf('Children');
    expect(fold).toHaveAttribute('open');
    expect(fold.textContent).toBe('Children');
    expect(within(panel()).queryByText(/could not read the ticket/)).toBeNull();
  });

  it('zero children: `No child tickets.` in the fold, and neither the tab nor the fold draws a count', () => {
    mount({ detail: detail({ children: [] }) });
    expect(screen.getByRole('tab', { name: /^Children & comments/ }).textContent).toBe('Children & comments');
    openTab(/^Children & comments/);
    expect(within(foldOf('Children')).getByText('No child tickets.')).toBeInTheDocument();
    expect(summaryOf('Children').textContent).toBe('Children');
  });

  it('Comments is a closed fold; opened, today’s sentence and the issue’s link', () => {
    mount();
    openTab(/^Children & comments/);
    expect(foldOf('Comments')).not.toHaveAttribute('open');
    expect(within(panel()).queryByText(/Comments stay in Jira/)).toBeNull();
    fireEvent.click(summaryOf('Comments'));
    expect(within(foldOf('Comments')).getByText(/Comments stay in Jira — v1 neither reads nor writes them\./)).toBeInTheDocument();
    expect(within(foldOf('Comments')).getByRole('link', { name: 'PAY-12 in Jira ↗' })).toHaveAttribute('href', ISSUE.url);
  });
});

describe('JiraTicketBody — the strip’s Mentions cell (Jira mentions <-> board link, Task 5)', () => {
  const data = mentionsPayload({
    issues: [mentionIssue(ISSUE.key, [mention('m2', 'Ivo', 'newer', ISSUE.key, 0.1), mention('m1', 'Mara', 'older', ISSUE.key, 0.2)])]
  });

  it('draws a Mentions cell holding @ 2 after the Agent cell, and a click calls the opener with the key', () => {
    const open = jest.fn();
    render(
      <MentionWrap data={data} open={open}>
        {tree()}
      </MentionWrap>
    );
    const cells = Array.from(strip().querySelectorAll('dt')).map((d) => d.textContent);
    expect(cells[cells.length - 2]).toBe('Agent');
    expect(cells[cells.length - 1]).toBe('Mentions');
    const mark = within(strip()).getByText('@ 2');
    fireEvent.click(mark);
    expect(open).toHaveBeenCalledWith(ISSUE.key);
  });

  it('draws no Mentions cell for a ticket the index lacks', () => {
    render(
      <MentionWrap data={mentionsPayload()} open={jest.fn()}>
        {tree()}
      </MentionWrap>
    );
    expect(within(strip()).queryByText('Mentions')).toBeNull();
  });
});
