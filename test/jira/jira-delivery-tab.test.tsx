/**
 * @jest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { JiraDeliveryTab } from '../../client/src/components/jira/JiraDeliveryTab';
import { JiraTicketBody } from '../../client/src/components/jira/JiraTicketBody';
import { GitlabContext } from '../../client/src/hooks/GitlabContext';
import { JiraContext } from '../../client/src/hooks/JiraContext';
import { JiraSessionsContext } from '../../client/src/hooks/JiraSessionsContext';
import { JIRA_IGNORED_STEPS_KEY } from '../../client/src/hooks/useIgnoredSteps';
import { setJiraDetailTab } from '../../client/src/hooks/useJiraDetailTab';
import { SettingsProvider } from '../../client/src/hooks/useSettings';
import type { SessionLink } from '../../client/src/lib/jira-sessions';
import type { JiraSessionState } from '../../shared/jira-sessions';
import type {
  AgentsStatus,
  GitlabMr,
  GitlabPayload,
  GitlabProjectView,
  GitlabReview,
  GitlabStatus,
  JiraBoardStatus,
  JiraIssue,
  JiraIssueDetail,
  JiraSessionsPayload,
  JiraStatusPayload
} from '../../shared/types';
import { daysAgoStamp } from '../helpers/dates';

/*
  Jira › Detail's Delivery tab (Jira detail tabs spec §4, §9 cases 12–14, 24, 25, 29; DESIGN.md §8.9.6): one fold row per (project, target branch), the
  next step ringed on its track with its row under it, `Ignore` and its store, the older-MRs fold and the Worktrees fold. Mounted through the shared body
  (`JiraTicketBody`), because which rows are open is the body's state and a strip pill opens one — the fold, the pill and the row are one behaviour. The
  fixture is §9 case 3's shape on PAY-12: `develop` has one open MR and two merged, `demo` one open, three merged and one closed — eight MRs in two targets.
  Every stamp is relative to the clock the assertion runs under (`test/helpers/dates.ts`).
*/

// The review split asks the dashboard whether agents are on (`useAgents`); the hook fetches, so it is replaced by a status this suite sets per case.
let mockAgents: AgentsStatus | null = { enabled: true } as AgentsStatus;
jest.mock('../../client/src/hooks/useAgents', () => ({ useAgents: () => ({ status: mockAgents, reload: jest.fn() }) }));

const minutesAgo = (m: number): string => daysAgoStamp(m / 1440);
const REPOS = ['/Users/dana/pay'];

const ISSUE: JiraIssue = {
  key: 'PAY-12',
  id: '10012',
  url: 'https://acme.atlassian.net/browse/PAY-12',
  summary: 'Refund partial captures',
  project: { key: 'PAY', name: 'Payments' },
  type: { name: 'Story', level: 0, subtask: false },
  status: { name: 'In Review', category: 'indeterminate' },
  priority: 'High',
  assignee: { accountId: 'acc-dana', name: 'Dana Novak' },
  reporter: 'Dana Novak',
  parent: { key: 'PAY-3', summary: 'Refund flows', type: null, status: null },
  subtasks: 0,
  labels: [],
  sprint: null,
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

function detail(of: JiraIssue): JiraIssueDetail {
  return { ...of, description: 'Partial captures are not refunded.', children: [], transitions: [], boards: [BOARD.id], session: null } as JiraIssueDetail;
}

function status(): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: { accountId: 'acc-dana', name: 'Dana Novak' },
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [BOARD],
    repos: { PAY: REPOS },
    repoDefaults: {},
    projects: [{ key: 'PAY', name: 'Payments' }],
    skills: [],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: true,
    home: '/Users/dana',
    mentions: null
  };
}

/** A review fact set; defaults to two open findings (one major, one minor) landed 4 m ago. */
function review(over: Partial<GitlabReview> = {}): GitlabReview {
  return {
    open: 2,
    resolved: 5,
    worst: 'major',
    bySeverity: { critical: 0, major: 1, minor: 1, trivial: 0, other: 0 },
    triggeredAt: minutesAgo(30),
    landedAt: minutesAgo(4),
    commitsSince: 0,
    capped: false,
    readAt: minutesAgo(1),
    failed: false,
    ...over
  };
}
const ZERO = { critical: 0, major: 0, minor: 0, trivial: 0, other: 0 };
const NONE = review({ open: 0, resolved: 0, worst: null, bySeverity: ZERO, triggeredAt: null, landedAt: null });
const CLEAN = review({ open: 0, worst: null, bySeverity: ZERO });
const UNKNOWN = review({ open: 0, capped: true });

function mr(over: Partial<GitlabMr> & { iid: number }): GitlabMr {
  const project = over.project ?? 'acme/pay-api';
  return {
    project,
    title: `PAY-12 | change ${over.iid}`,
    webUrl: `https://gitlab.example.test/${project}/-/merge_requests/${over.iid}`,
    state: 'opened',
    draft: false,
    sourceBranch: 'pay-12-refunds',
    targetBranch: 'develop',
    createdAt: minutesAgo(600 + over.iid),
    updatedAt: minutesAgo(over.iid),
    mergedAt: null,
    pipeline: 'success',
    keys: ['PAY-12'],
    review: null,
    ...over
  };
}

const merged = (iid: number, target: string, ageMin: number, over: Partial<GitlabMr> = {}): GitlabMr =>
  mr({ iid, targetBranch: target, state: 'merged', pipeline: null, updatedAt: minutesAgo(ageMin), mergedAt: minutesAgo(ageMin), ...over });

/** `develop`'s lead: review clean, pipeline failed — row 8. Newer than `demo`'s lead, so it is the ticket's overall lead and the first row. */
const DEVELOP_LEAD = (over: Partial<GitlabMr> = {}): GitlabMr =>
  mr({ iid: 41, targetBranch: 'develop', review: CLEAN, pipeline: 'failed', updatedAt: minutesAgo(10), title: 'PAY-12 | refund partial captures', ...over });
/** `demo`'s lead: review `none`, pipeline passed — row 3. */
const DEMO_LEAD = (over: Partial<GitlabMr> = {}): GitlabMr =>
  mr({ iid: 50, targetBranch: 'demo', review: NONE, pipeline: 'success', updatedAt: minutesAgo(20), title: 'PAY-12 | demo cut of refunds', ...over });

/** The eight MRs: `develop` 1 open + 2 merged, `demo` 1 open + 3 merged + 1 closed; one older `demo` MR came from another source branch. */
function eight(develop: Partial<GitlabMr> = {}, demo: Partial<GitlabMr> = {}): GitlabMr[] {
  return [
    DEVELOP_LEAD(develop),
    merged(20, 'develop', 300),
    merged(21, 'develop', 60 * 24 * 4),
    DEMO_LEAD(demo),
    merged(30, 'demo', 120),
    mr({ iid: 31, targetBranch: 'demo', state: 'closed', pipeline: null, updatedAt: minutesAgo(60 * 24) }),
    merged(32, 'demo', 60 * 48, { sourceBranch: 'pay-12-hotfix' }),
    merged(33, 'demo', 60 * 72)
  ];
}

const PAY_API: GitlabProjectView = { path: 'acme/pay-api', repo: 'pay-api', polledAt: minutesAgo(2), capped: false, failed: false, repos: REPOS };
const PAY_WEB: GitlabProjectView = { path: 'acme/pay-web', repo: 'pay-web', polledAt: minutesAgo(3), capped: false, failed: false, repos: REPOS };

function gitlabStatus(over: Partial<GitlabStatus> = {}): GitlabStatus {
  return {
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
    interval: '1m',
    ...over
  };
}

function gitlab(mrs: GitlabMr[], views: GitlabProjectView[] | null = [PAY_API], st: Partial<GitlabStatus> = {}): GitlabPayload {
  return { status: gitlabStatus(st), jiraProjects: views === null ? {} : { PAY: views }, mrs };
}

function link(over: Partial<SessionLink> & { sessionId: string; state: JiraSessionState }): SessionLink {
  return {
    key: 'PAY-12',
    how: 'run',
    action: 'review',
    name: `Review PAY-12 ${over.sessionId}`,
    repo: REPOS[0],
    branch: 'pay-12-refunds',
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

const noSessions = (): JiraSessionsPayload => ({ links: [], reachable: true, rowsAt: new Date().toISOString() });

function json(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

let worktrees: () => Promise<Response>;
let onReview: jest.Mock;
let onRun: jest.Mock;

beforeEach(() => {
  window.localStorage.clear();
  mockAgents = { enabled: true } as AgentsStatus;
  onReview = jest.fn();
  onRun = jest.fn();
  setJiraDetailTab('delivery');
  // The Worktrees read never answers unless a case says so: an answer would land after a synchronous case's last line, outside `act`.
  worktrees = () => new Promise<Response>(() => {});
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/jira/worktrees') return worktrees();
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
});

afterEach(cleanup);

interface Opts {
  issue?: JiraIssue;
  gitlab?: GitlabPayload | null;
  sessions?: JiraSessionsPayload;
}

function tree(opts: Opts = {}) {
  const issue = opts.issue ?? ISSUE;
  const gl = opts.gitlab === undefined ? gitlab(eight()) : opts.gitlab;
  const live = opts.sessions ?? noSessions();
  return (
    <SettingsProvider>
      <GitlabContext.Provider value={{ data: gl, error: null, refresh: () => Promise.resolve(gl) }}>
        <JiraContext.Provider value={{ data: status(), loading: false, error: false, reload: jest.fn() }}>
          <JiraSessionsContext.Provider value={{ data: live, reload: jest.fn(() => Promise.resolve()) }}>
            <JiraTicketBody
              issue={issue}
              detail={detail(issue)}
              failure={null}
              childrenOf={null}
              back={null}
              onBack={jest.fn()}
              onOpenIssue={jest.fn()}
              onWrote={jest.fn()}
              onReview={onReview}
              onRun={onRun}
            />
          </JiraSessionsContext.Provider>
        </JiraContext.Provider>
      </GitlabContext.Provider>
    </SettingsProvider>
  );
}

const mount = (opts: Opts = {}) => render(tree(opts));
const strip = (): HTMLElement => screen.getByRole('group', { name: 'Summary' });
const tabNames = (): string[] => screen.getAllByRole('tab').map((t) => t.textContent ?? '');
const selected = (): string => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? '';
const rows = (): HTMLDetailsElement[] => [...document.querySelectorAll<HTMLDetailsElement>('details.jira-dlv-tgt')];
const row = (target: string): HTMLDetailsElement => {
  const found = rows().find((r) => r.querySelector('.jira-dlv-into')?.textContent === `into ${target}`);
  if (found === undefined) throw new Error(`no row into ${target}`);
  return found;
};
const summary = (target: string): HTMLElement => row(target).querySelector('summary') as HTMLElement;
/** One full-track step's `<li>` inside a row, found by its label. */
const step = (target: string, label: string): HTMLElement => {
  const el = within(row(target)).getByText(label, { selector: '.jira-dlv-step-label' }).closest('li');
  if (el === null) throw new Error(`no step ${label} in ${target}`);
  return el;
};
const stepWord = (target: string, label: string): string | null => step(target, label).querySelector('.jira-dlv-step-word')?.textContent ?? null;
const nextRow = (target: string): HTMLElement | null => row(target).querySelector('.jira-dlv-next');
const pill = (target: string): string | null => summary(target).querySelector('.jira-dlv-word')?.textContent ?? null;
const ignoredStore = (): unknown => {
  const raw = window.localStorage.getItem(JIRA_IGNORED_STEPS_KEY);
  return raw === null ? null : JSON.parse(raw);
};
const IGNORED_TITLE = 'ignored in this browser — click to stop ignoring';

describe('JiraDeliveryTab — rows (T12, T13)', () => {
  it('T12: one row per target; the first is open with its full track and next row, the other folded with `+4 earlier`', () => {
    mount();
    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.querySelector('.jira-dlv-into')?.textContent)).toEqual(['into develop', 'into demo']);
    expect(row('develop').open).toBe(true);
    expect(row('demo').open).toBe(false);
    expect(row('develop').querySelector('ol.jira-dlv-track')).not.toBeNull();
    expect(nextRow('develop')).not.toBeNull();
    expect(summary('demo').textContent).toContain('+4 earlier');
    expect(summary('develop').textContent).toContain('+2 earlier');
    // The compact line: `!iid` links out, the title, the five-dot track.
    expect(within(summary('demo')).getByRole('link', { name: '!50' })).toHaveAttribute('target', '_blank');
    expect(summary('demo').textContent).toContain('PAY-12 | demo cut of refunds');
    expect(summary('demo').querySelectorAll('.jira-dlv-track.compact .jira-dlv-dot')).toHaveLength(5);
  });

  it('T12: opening `demo` keeps `develop` open; its older fold lists the four, newest first, `from` only on the one from another branch', () => {
    mount();
    fireEvent.click(summary('demo'));
    expect(row('demo').open).toBe(true);
    expect(row('develop').open).toBe(true);
    const older = row('demo').querySelector('details.jira-dlv-older') as HTMLDetailsElement;
    expect(older).not.toBeNull();
    expect(older.open).toBe(false);
    const olderSummary = older.querySelector('summary') as HTMLElement;
    expect(olderSummary.textContent).toBe('4 earlier MRs into demo · 3 merged, 1 closed');
    fireEvent.click(olderSummary);
    expect(older.open).toBe(true);
    const orows = [...older.querySelectorAll('.jira-dlv-orow')];
    expect(orows.map((r) => within(r as HTMLElement).getByRole('link').textContent)).toEqual(['!30 ↗', '!31 ↗', '!32 ↗', '!33 ↗']);
    expect(orows.map((r) => r.querySelector('.jira-dlv-word')?.textContent)).toEqual(['merged', 'closed', 'merged', 'merged']);
    expect(orows.map((r) => r.querySelector('.jira-dlv-from')?.textContent ?? null)).toEqual([null, null, 'from pay-12-hotfix', null]);
    // Folding the row again closes it alone.
    fireEvent.click(summary('develop'));
    expect(row('develop').open).toBe(false);
    expect(row('demo').open).toBe(true);
  });

  it('T13: a strip `demo` pill click selects Delivery and opens the `demo` row, leaving `develop` open', () => {
    setJiraDetailTab('ticket');
    mount();
    expect(selected()).toBe('Ticket');
    fireEvent.click(within(strip()).getByRole('button', { name: 'demo · pipeline passed' }));
    expect(selected()).toBe('Delivery 2 targets');
    expect(row('demo').open).toBe(true);
    expect(row('develop').open).toBe(true);
  });

  it('Review Focus 1: a poll that replaces `demo`’s lead keeps the row open on the new lead; a poll without `demo` draws one row', () => {
    const view = mount();
    fireEvent.click(summary('demo'));
    const next = [...eight().filter((m) => m.iid !== 50), DEMO_LEAD({ state: 'merged', pipeline: null, mergedAt: minutesAgo(15), updatedAt: minutesAgo(15) })];
    next.push(mr({ iid: 55, targetBranch: 'demo', review: NONE, updatedAt: minutesAgo(5), title: 'PAY-12 | demo cut, second try' }));
    view.rerender(tree({ gitlab: gitlab(next) }));
    expect(row('demo').open).toBe(true);
    expect(within(summary('demo')).getByRole('link', { name: '!55' })).toBeInTheDocument();
    expect(row('demo').querySelector('details.jira-dlv-older summary')?.textContent).toBe('5 earlier MRs into demo · 4 merged, 1 closed');
    view.rerender(tree({ gitlab: gitlab(eight().filter((m) => m.targetBranch !== 'demo')) }));
    expect(rows()).toHaveLength(1);
    expect(row('develop').open).toBe(true);
  });
});

describe('JiraDeliveryTab — the head line', () => {
  it('reads `Branch <source>` when the targets share it, and `2 targets · 8 MRs`', () => {
    mount();
    const head = document.querySelector('.jira-dlv-thead') as HTMLElement;
    expect(head.textContent).toContain('Branch pay-12-refunds');
    expect(head.textContent).toContain('2 targets · 8 MRs');
    expect(head.textContent).not.toContain('via');
  });

  it('omits `Branch` when the leads come from two branches; one target and one MR read singular', () => {
    const view = mount({ gitlab: gitlab(eight({}, { sourceBranch: 'pay-12-demo' })) });
    expect(document.querySelector('.jira-dlv-thead')?.textContent).not.toContain('Branch');
    view.rerender(tree({ gitlab: gitlab([DEVELOP_LEAD()]) }));
    expect(document.querySelector('.jira-dlv-thead')?.textContent).toContain('1 target · 1 MR');
  });

  it('a sub-task drawing its parent’s MRs reads `via PAY-3`', () => {
    const sub: JiraIssue = { ...ISSUE, key: 'PAY-14', id: '10014', type: { name: 'Sub-task', level: -1, subtask: true } };
    mount({ issue: sub, gitlab: gitlab([DEVELOP_LEAD({ keys: ['PAY-3'] })]) });
    expect(document.querySelector('.jira-dlv-thead')?.textContent).toContain('via PAY-3');
  });

  it('the compact rows name the repo only when the targets span two projects', () => {
    const view = mount();
    expect(document.querySelector('.jira-dlv-tgt .jira-dlv-repo')).toBeNull();
    const web = mr({ iid: 70, project: 'acme/pay-web', targetBranch: 'develop', updatedAt: minutesAgo(30), review: CLEAN });
    view.rerender(tree({ gitlab: gitlab([...eight(), web], [PAY_API, PAY_WEB]) }));
    expect(rows().map((r) => r.querySelector('.jira-dlv-repo')?.textContent)).toEqual(['pay-api', 'pay-api', 'pay-web']);
  });
});

describe('JiraDeliveryTab — the next step (T14, T24, rows 8, 9, 12)', () => {
  it('T14: `demo`’s next row requests a review of `demo`’s MR; its Review dot is ringed and reads `next · review`', () => {
    mount();
    fireEvent.click(summary('demo'));
    const review = step('demo', 'Review');
    expect(review).toHaveAttribute('data-next');
    expect(review.querySelector('.jira-dlv-dot')).toHaveAttribute('data-next');
    expect(stepWord('demo', 'Review')).toBe('next · review');
    expect(pill('demo')).toBe('next: review');
    expect(summary('demo').querySelector('.jira-dlv-word')).toHaveAttribute('data-tone', 'next');
    expect(summary('demo').querySelector('.jira-dlv-track.compact .jira-dlv-dot[data-next]')).not.toBeNull();
    fireEvent.click(within(nextRow('demo') as HTMLElement).getByRole('button', { name: 'Request review' }));
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ key: 'PAY-12' }), 'request', expect.objectContaining({ iid: 50 }), REPOS);
  });

  it('T14: a target whose lead is merged draws no next row and rings nothing', () => {
    mount({ gitlab: gitlab([DEVELOP_LEAD(), merged(60, 'demo', 90)]) });
    fireEvent.click(summary('demo'));
    expect(nextRow('demo')).toBeNull();
    expect(row('demo').querySelector('[data-next]')).toBeNull();
    expect(pill('demo')).toBe('merged');
  });

  it('row 8: a failed pipeline under a clean review draws its sentence and a second `Run ▾`', () => {
    mount();
    const next = nextRow('develop') as HTMLElement;
    expect(next.textContent).toContain('The pipeline failed — fix it in a Run session.');
    expect(within(next).getByRole('button', { name: 'Run options for PAY-12' })).toBeInTheDocument();
    expect(stepWord('develop', 'Pipeline')).toBe('next · fix pipeline');
    expect(pill('develop')).toBe('next: fix pipeline');
  });

  it('row 9: a clean, green MR draws `Merge in GitLab ↗` to its own page, in a new tab', () => {
    mount({ gitlab: gitlab([DEVELOP_LEAD({ pipeline: 'success' })]) });
    const merge = within(nextRow('develop') as HTMLElement).getByRole('link', { name: 'Merge in GitLab ↗' });
    expect(merge).toHaveAttribute('href', 'https://gitlab.example.test/acme/pay-api/-/merge_requests/41');
    expect(merge).toHaveAttribute('target', '_blank');
    expect(stepWord('develop', 'Merged')).toBe('next · merge');
    // Merge offers no Ignore.
    expect(within(nextRow('develop') as HTMLElement).queryByRole('button', { name: 'Ignore' })).toBeNull();
  });

  it('row 12: a canceled pipeline draws `GitLab ↗`', () => {
    mount({ gitlab: gitlab([DEVELOP_LEAD({ pipeline: 'canceled' })]) });
    const next = nextRow('develop') as HTMLElement;
    expect(next.textContent).toContain('The pipeline was canceled — re-run it in GitLab.');
    expect(within(next).getByRole('link', { name: 'GitLab ↗' })).toHaveAttribute('href', 'https://gitlab.example.test/acme/pay-api/-/merge_requests/41');
  });

  it('T24: open findings with a live review session draw `Open session`, which opens that session', () => {
    mount({
      gitlab: gitlab([DEVELOP_LEAD({ review: review() })]),
      sessions: { links: [link({ sessionId: 's-review', state: 'working' })], reachable: true, rowsAt: new Date().toISOString() }
    });
    const next = nextRow('develop') as HTMLElement;
    const open = within(next).getByRole('link', { name: 'Open session' });
    expect(open.getAttribute('href')).toContain('session=s-review');
    expect(within(next).queryByRole('button', { name: 'Fix review' })).toBeNull();
  });

  it('T24: with only an ended review session, today’s split with the fix half preset', () => {
    mount({
      gitlab: gitlab([DEVELOP_LEAD({ review: review() })]),
      sessions: {
        links: [link({ sessionId: 's-old', state: 'ended', endedAt: minutesAgo(30), startedAt: minutesAgo(60) })],
        reachable: true,
        rowsAt: new Date().toISOString()
      }
    });
    const next = nextRow('develop') as HTMLElement;
    expect(within(next).queryByRole('link', { name: 'Open session' })).toBeNull();
    expect(next.querySelector('.jira-dlv-next-text')).toHaveAttribute('data-tone', 'amber');
    fireEvent.click(within(next).getByRole('button', { name: 'Fix review' }));
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ key: 'PAY-12' }), 'fix', expect.objectContaining({ iid: 41 }), REPOS);
  });

  it('a live `run` session on the key disables the review split and says why under the row', () => {
    mount({
      gitlab: gitlab([DEVELOP_LEAD({ review: NONE })]),
      sessions: { links: [link({ sessionId: 's-run', state: 'working', action: 'execute', name: 'Execute PAY-12' })], reachable: true, rowsAt: null }
    });
    const btn = within(nextRow('develop') as HTMLElement).getByRole('button', { name: 'Request review' });
    expect(btn).toBeDisabled();
    expect(document.querySelector('.jira-dlv-next-why')?.textContent).toBe('Execute PAY-12 is live on this ticket — Request review waits until it ends or you stop it.');
  });

  it('draws no review button while agents are off, and keeps the sentence', () => {
    mockAgents = { enabled: false } as AgentsStatus;
    mount({ gitlab: gitlab([DEVELOP_LEAD({ review: review() })]) });
    const next = nextRow('develop') as HTMLElement;
    expect(next.querySelector('.jira-dlv-next-text')?.textContent).toContain('2 open findings');
    expect(within(next).queryByRole('button', { name: 'Fix review' })).toBeNull();
    expect(within(next).getByRole('button', { name: 'Ignore' })).toBeInTheDocument();
  });
});

describe('JiraDeliveryTab — Ignore (T25, T29)', () => {
  it('T25: ignoring `develop`’s failed pipeline stores it, draws `ignored`, moves the pill to merge — and the strip stays red', () => {
    mount();
    const red = () => within(strip()).getByRole('button', { name: 'develop · pipeline failed' });
    expect(red()).toHaveAttribute('data-tone', 'red');
    fireEvent.click(within(nextRow('develop') as HTMLElement).getByRole('button', { name: 'Ignore' }));
    expect(ignoredStore()).toEqual({ 'acme/pay-api!41': { pipeline: { status: 'failed', updatedAt: DEVELOP_LEAD().updatedAt } } });
    const word = within(step('develop', 'Pipeline')).getByRole('button', { name: 'ignored' });
    expect(word).toHaveAttribute('title', IGNORED_TITLE);
    expect(step('develop', 'Pipeline').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'grey');
    expect(pill('develop')).toBe('next: merge');
    expect(red()).toHaveAttribute('data-tone', 'red');
    fireEvent.click(word);
    expect(ignoredStore()).toEqual({});
    expect(pill('develop')).toBe('next: fix pipeline');
    expect(red()).toHaveAttribute('data-tone', 'red');
  });

  it('an `unknown` review draws `Ignore` alone; ignoring it stores the state and its landing, and the pill moves on to the pipeline', () => {
    mount({ gitlab: gitlab([DEVELOP_LEAD({ review: UNKNOWN })]) });
    const next = nextRow('develop') as HTMLElement;
    expect(within(next).getAllByRole('button').map((b) => b.textContent)).toEqual(['Ignore']);
    expect(within(next).queryByRole('link')).toBeNull();
    expect(next.querySelector('.jira-dlv-next-text')).toBeNull();
    fireEvent.click(within(next).getByRole('button', { name: 'Ignore' }));
    expect(ignoredStore()).toEqual({ 'acme/pay-api!41': { review: { state: 'unknown', landedAt: UNKNOWN.landedAt } } });
    expect(pill('develop')).toBe('next: fix pipeline');
  });

  it('T29: `Ignore` on a `none` review draws the Review step `ignored`, and still does after an unmount and remount', () => {
    const one = () => gitlab([DEVELOP_LEAD({ review: NONE, pipeline: 'success' })]);
    mount({ gitlab: one() });
    fireEvent.click(within(nextRow('develop') as HTMLElement).getByRole('button', { name: 'Ignore' }));
    expect(stepWord('develop', 'Review')).toBe('ignored');
    expect(pill('develop')).toBe('next: merge');
    cleanup();
    mount({ gitlab: one() });
    expect(stepWord('develop', 'Review')).toBe('ignored');
  });
});

describe('JiraDeliveryTab — no rows', () => {
  it('`none` draws today’s sentence in place of rows, and the tab draws no count', () => {
    mount({ gitlab: gitlab([]) });
    expect(screen.getByText('no merge request for PAY-12 in pay-api in the last 30 days')).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
    expect(tabNames()).toContain('Delivery');
  });

  it('names every mapped repo, in the payload’s order', () => {
    mount({ gitlab: gitlab([], [PAY_API, PAY_WEB]) });
    expect(screen.getByText('no merge request for PAY-12 in pay-api, pay-web in the last 30 days')).toBeInTheDocument();
  });

  it.each<[string, GitlabProjectView, string]>([
    ['never read', { ...PAY_API, polledAt: null }, 'GitLab not read yet'],
    ['never read and failed', { ...PAY_API, polledAt: null, failed: true }, 'GitLab could not be read — Settings › Shared › Sources'],
    ['capped', { ...PAY_API, capped: true }, 'more merge requests than were read — some may be missing']
  ])('an unknown ticket (%s) reads its unknown line, not the no-MR one', (_name, v, line) => {
    mount({ gitlab: gitlab([], [v]) });
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByText(/no merge request/)).not.toBeInTheDocument();
    expect(tabNames()).toContain('Delivery');
  });

  /** The tab alone, for the cases where it must draw nothing at all. */
  function drawTab(data: GitlabPayload | null) {
    return render(
      <SettingsProvider>
        <GitlabContext.Provider value={{ data, error: null, refresh: () => Promise.resolve(data) }}>
          <JiraContext.Provider value={{ data: status(), loading: false, error: false, reload: jest.fn() }}>
            <JiraSessionsContext.Provider value={{ data: noSessions(), reload: jest.fn(() => Promise.resolve()) }}>
              <JiraDeliveryTab
                issue={ISSUE}
                now={Date.now()}
                onRun={onRun}
                openRows={new Set()}
                onToggleRow={jest.fn()}
                onOpenRow={jest.fn()}
                liveReviewLink={null}
                worktrees={null}
              />
            </JiraSessionsContext.Provider>
          </JiraContext.Provider>
        </GitlabContext.Provider>
      </SettingsProvider>
    );
  }

  it('draws nothing for a ticket whose Jira project maps no GitLab project', () => {
    const { container } = drawTab(gitlab([DEVELOP_LEAD()], null));
    expect(container).toBeEmptyDOMElement();
  });

  it.each<[string, GitlabPayload | null]>([
    ['no payload', null],
    ['unconfigured', gitlab([DEVELOP_LEAD()], [PAY_API], { state: 'unconfigured', armed: false })],
    ['not armed', gitlab([DEVELOP_LEAD()], [PAY_API], { armed: false })]
  ])('draws nothing while delivery is not shown (%s)', (_name, data) => {
    const { container } = drawTab(data);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('JiraDeliveryTab — Worktrees', () => {
  const TREES = {
    worktrees: [
      { repo: REPOS[0], path: `${REPOS[0]}/.worktrees/PAY-12-refunds`, branch: 'PAY-12-refunds', main: false },
      { repo: REPOS[0], path: `${REPOS[0]}/.worktrees/PAY-12-hotfix`, branch: 'PAY-12-hotfix', main: false }
    ],
    unavailable: []
  };

  it('draws a closed `Worktrees 2` fold at the bottom of the Delivery tab', async () => {
    worktrees = () => Promise.resolve(json(TREES));
    mount();
    await waitFor(() => expect(document.querySelector('details.jira-wt-fold')).not.toBeNull());
    const fold = document.querySelector('details.jira-wt-fold') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')?.textContent).toMatch(/^Worktrees\s*2$/);
    expect(within(screen.getByRole('tabpanel')).getByText('Worktrees')).toBeInTheDocument();
    // It is the last thing in the pane, after the rows.
    expect(rows()[1].compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(fold.querySelector('summary') as HTMLElement);
    expect(fold.open).toBe(true);
    expect(fold.querySelectorAll('.jira-wt-row')).toHaveLength(2);
  });

  it('an unmapped ticket, with no Delivery tab, draws the fold at the bottom of the Ticket tab', async () => {
    worktrees = () => Promise.resolve(json(TREES));
    mount({ gitlab: gitlab([], null) });
    expect(tabNames()).not.toContain('Delivery');
    expect(selected()).toBe('Ticket');
    await waitFor(() => expect(within(screen.getByRole('tabpanel')).getByText('Worktrees')).toBeInTheDocument());
    await act(async () => {});
  });
});
