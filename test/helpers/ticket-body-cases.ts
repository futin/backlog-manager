import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { JIRA_DETAIL_TAB_KEY, setJiraDetailTab } from '../../client/src/hooks/useJiraDetailTab';
import type { SessionLink } from '../../client/src/lib/jira-sessions';
import { browserTimeZone, formatZonedClock, zonedParts } from '../../client/src/lib/time-zone';
import { STATE_LABEL, type JiraSessionState } from '../../shared/jira-sessions';
import type {
  AgentsStatus,
  DashboardRow,
  GitlabMr,
  GitlabPayload,
  GitlabProjectView,
  GitlabReview,
  JiraBoardStatus,
  JiraIssue,
  JiraIssueDetail,
  JiraSessionsPayload,
  JiraStatusPayload
} from '../../shared/types';
import { daysAgoStamp } from './dates';

/*
  The Jira ticket body's shared cases (Jira detail tabs spec §9 cases 8–16): "rendered in the modal and on the page with the same fixtures". The body is
  one component drawn by two frames — `JiraDetail` (the modal, Task 7) and the ticket page (Task 8) — and what these cases pin is the body's behaviour, so
  each frame's suite runs this one table through its own mount rather than keeping a copy that could drift. The table owns the fixtures and the `it`s; a
  frame owns only how a fixture reaches the screen: which contexts it provides, how it answers the detail read (the modal and the page both fetch it — the
  bare body was handed it), and what "a write landed" looks like from outside it.

  A mount is ASYNC, unlike the body suites' `render`: both frames read the detail through `fetch`, so the tab counts that need it (Children) and the
  agents-status answer the review split and Stop wait on are only drawn after a flush, which the mount does before it returns. Fixture stamps are relative to
  the clock the assertion runs under (`test/helpers/dates.ts`); every name and key below is invented.
*/

const minutesAgo = (m: number): string => daysAgoStamp(m / 1440);
const REPOS = ['/Users/dana/pay'];

export const DANA = { accountId: 'acc-dana', name: 'Dana Novak' };
export const READER = { accountId: 'acc-sam', name: 'Sam Ortiz' };

export const ISSUE: JiraIssue = {
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

export function detail(over: Partial<JiraIssueDetail> = {}): JiraIssueDetail {
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

export function status(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: READER,
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
    mentions: null,
    ...over
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

/** One MR on PAY-12; the stamps default to the iid's own age, so a fixture's order is its iids' unless it says otherwise. */
export function mr(over: Partial<GitlabMr> & { iid: number }): GitlabMr {
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

/** `develop`'s lead: review clean, pipeline failed. Newer than `demo`'s lead, so it is the ticket's overall lead and the first row. */
const DEVELOP_LEAD = (): GitlabMr =>
  mr({ iid: 41, targetBranch: 'develop', review: CLEAN, pipeline: 'failed', updatedAt: minutesAgo(10), title: 'PAY-12 | refund partial captures' });
/** `demo`'s lead: review `none`, pipeline passed. */
const DEMO_LEAD = (): GitlabMr =>
  mr({ iid: 50, targetBranch: 'demo', review: NONE, pipeline: 'success', updatedAt: minutesAgo(20), title: 'PAY-12 | demo cut of refunds' });

/** §9 case 3's eight MRs: `develop` 1 open + 2 merged, `demo` 1 open + 3 merged + 1 closed; one older `demo` MR came from another source branch. */
export function eight(): GitlabMr[] {
  return [
    DEVELOP_LEAD(),
    merged(20, 'develop', 300),
    merged(21, 'develop', 60 * 24 * 4),
    DEMO_LEAD(),
    merged(30, 'demo', 120),
    mr({ iid: 31, targetBranch: 'demo', state: 'closed', pipeline: null, updatedAt: minutesAgo(60 * 24) }),
    merged(32, 'demo', 60 * 48, { sourceBranch: 'pay-12-hotfix' }),
    merged(33, 'demo', 60 * 72)
  ];
}

/** The two targets of the strip cases: `develop`'s pipeline failed (red), `demo` is open with no review and a passing pipeline (green). */
export const TWO_TARGETS = (): GitlabMr[] => [
  mr({ iid: 41, targetBranch: 'develop', pipeline: 'failed', updatedAt: minutesAgo(20) }),
  mr({ iid: 42, targetBranch: 'demo', pipeline: 'success', review: null, updatedAt: minutesAgo(10) })
];

const PAY_API: GitlabProjectView = { path: 'acme/pay-api', repo: 'pay-api', polledAt: minutesAgo(2), capped: false, failed: false, repos: REPOS };

/** The shell's GitLab answer; `views: null` maps no GitLab project to PAY, which is the `hidden` delivery (no Delivery tab). */
export function gitlab(mrs: GitlabMr[], views: GitlabProjectView[] | null = [PAY_API]): GitlabPayload {
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

export function link(over: Partial<SessionLink> & { sessionId: string; state: JiraSessionState }): SessionLink {
  return {
    key: 'PAY-12',
    how: 'run',
    action: 'execute',
    name: `Execute PAY-12 ${over.sessionId}`,
    repo: REPOS[0],
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
export function sessions(key = 'PAY-12'): JiraSessionsPayload {
  const ended = [1, 2, 3, 4, 5].map((n) =>
    link({ key, sessionId: `s-ended-${n}`, state: 'ended', startedAt: minutesAgo(600 + n * 60), stateSince: minutesAgo(500 + n * 60), endedAt: minutesAgo(500 + n * 60) })
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

const noSessions = (): JiraSessionsPayload => ({ links: [], reachable: true, rowsAt: new Date().toISOString() });

export const AGENTS_ON: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'acceptEdits',
  projectPaths: REPOS
};

const CHILD_A: JiraIssue = {
  ...ISSUE,
  key: 'PAY-21',
  id: '10021',
  summary: 'Ledger rounding fix',
  status: { name: 'To Do', category: 'new' },
  parent: { key: 'PAY-12', summary: 'Refund partial captures', type: null, status: null }
};
const CHILD_B: JiraIssue = { ...CHILD_A, key: 'PAY-22', id: '10022', summary: 'Refund webhook retries', status: { name: 'Done', category: 'done' } };

/** What one case draws. Every field but `issue` has a default (`resolveFixture`), so a case names only what it is about. */
export interface BodyFixture {
  issue?: JiraIssue;
  /** What the frame's detail read answers for `issue`; absent is `detail({ ...issue })`. */
  detail?: JiraIssueDetail;
  status?: Partial<JiraStatusPayload>;
  /** The sessions payload; absent is `sessions(issue.key)` — two live, five ended. */
  sessions?: JiraSessionsPayload;
  /** The shell's GitLab answer; absent is `TWO_TARGETS`. */
  gitlab?: GitlabPayload;
  /** The issue one step up the walk; absent is the walk's first issue. */
  back?: JiraIssue | null;
  /** `GET /api/agents/status`; absent is agents on. */
  agents?: AgentsStatus;
}

export interface ResolvedFixture {
  issue: JiraIssue;
  detail: JiraIssueDetail;
  status: JiraStatusPayload;
  sessions: JiraSessionsPayload;
  gitlab: GitlabPayload;
  back: JiraIssue | null;
  agents: AgentsStatus;
}

/** A fixture with its defaults filled in — what a frame's mount hands its contexts and its `fetch` stub. */
export function resolveFixture(f: BodyFixture): ResolvedFixture {
  const issue = f.issue ?? ISSUE;
  return {
    issue,
    detail: f.detail ?? detail({ ...issue }),
    status: status(f.status),
    sessions: f.sessions ?? sessions(issue.key),
    gitlab: f.gitlab ?? gitlab(TWO_TARGETS()),
    back: f.back ?? null,
    agents: f.agents ?? AGENTS_ON
  };
}

/** What a frame's mount hands back: the walk callbacks the body reaches its frame through, the POSTs sent, and the frame's own reading of a landed write. */
export interface MountedBody {
  /** Re-renders the same frame with another fixture — a walk step, a status change — and flushes the reads it starts. */
  rerender: (f: BodyFixture) => Promise<void>;
  onOpenIssue: jest.Mock;
  onBack: jest.Mock;
  onReview: jest.Mock;
  /** The POST urls sent so far, in order. */
  posts: () => string[];
  /** Resolves once a landed Assign or Move has reached the frame and the frame has acted on it — the body's `onWrote(true)`, as that frame sees it. */
  wrote: () => Promise<void>;
}

const tabNames = (): string[] => screen.getAllByRole('tab').map((t) => t.textContent ?? '');
const selected = (): string => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? '';
const stored = (): unknown => {
  const raw = window.localStorage.getItem(JIRA_DETAIL_TAB_KEY);
  return raw === null ? null : JSON.parse(raw);
};
const strip = (): HTMLElement => screen.getByRole('group', { name: 'Summary' });
const panel = (): HTMLElement => screen.getByRole('tabpanel');
/**
 * A click that switches the tab, flushed inside `act`. The pane it mounts may start a read of its own — the Agent and Delivery panes ask the agents status
 * for Stop and the review split — and a case that asserts nothing about that answer would otherwise end with it landing outside `act`: a stray warning.
 */
const press = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const openTab = (name: RegExp): Promise<void> => press(screen.getByRole('tab', { name }));
/** A fold's summary, found by its label, so a press toggles it as the reader's would. */
const summaryOf = (label: string): HTMLElement => {
  const el = within(panel()).getByText(label, { selector: '.jira-fold-label' }).closest('summary');
  if (el === null) throw new Error(`no summary for ${label}`);
  return el as HTMLElement;
};
const foldOf = (label: string): HTMLElement => summaryOf(label).closest('details') as HTMLElement;
/** Opens a card's `Session actions` menu and says whether it holds `name`; a card with no menu rows has no chevron at all. */
function cardMenuHas(card: HTMLElement, name: string): boolean {
  const chev = within(card).queryByRole('button', { name: 'More for PAY-12' });
  if (chev === null) return false;
  fireEvent.click(chev);
  const has = within(screen.getByRole('dialog', { name: 'Session actions' })).queryByRole('button', { name }) !== null;
  fireEvent.click(chev);
  return has;
}
/** The Delivery tab's rows, and one by its target. */
const rows = (): HTMLDetailsElement[] => [...document.querySelectorAll<HTMLDetailsElement>('details.jira-dlv-tgt')];
const row = (target: string): HTMLDetailsElement => {
  const found = rows().find((r) => r.querySelector('.jira-dlv-into')?.textContent === `into ${target}`);
  if (found === undefined) throw new Error(`no row into ${target}`);
  return found;
};
const summary = (target: string): HTMLElement => row(target).querySelector('summary') as HTMLElement;
const step = (target: string, label: string): HTMLElement => {
  const el = within(row(target)).getByText(label, { selector: '.jira-dlv-step-label' }).closest('li');
  if (el === null) throw new Error(`no step ${label} in ${target}`);
  return el;
};
const nextRow = (target: string): HTMLElement | null => row(target).querySelector('.jira-dlv-next');
const MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Registers §9 cases 8–16 against one frame. `mount` draws the fixture in that frame and resolves once its reads have landed. Each case starts on the
 * Ticket tab with an empty store, as a first open would: the remembered tab is a module store that outlives a mount.
 */
export function ticketBodyCases(mount: (f: BodyFixture) => Promise<MountedBody>): void {
  describe('the ticket body (shared cases, Jira detail tabs §9 cases 8–16)', () => {
    beforeEach(() => {
      window.localStorage.clear();
      setJiraDetailTab('ticket');
    });

    it('T8: Ticket, Delivery 2 targets, Agent 2 live, Children & comments with the direct-children count', async () => {
      const child = { ...ISSUE, key: 'PAY-15', id: '10015', summary: 'Partial refunds API', parent: { key: 'PAY-12', summary: '', type: null, status: null } };
      await mount({ detail: detail({ children: [child, { ...child, key: 'PAY-16', id: '10016' }, { ...child, key: 'PAY-17', id: '10017' }] }) });
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(tabNames()).toEqual(['Ticket', 'Delivery 2 targets', 'Agent 2 live', 'Children & comments 3']);
    });

    it('T8: one target reads `1 target`; a ticket with nothing to count draws no count', async () => {
      await mount({ gitlab: gitlab([mr({ iid: 51, targetBranch: 'develop' })]), sessions: noSessions() });
      expect(tabNames()).toEqual(['Ticket', 'Delivery 1 target', 'Agent', 'Children & comments']);
    });

    it('T8: the Agent count is the ended count when nothing is live', async () => {
      const only = sessions();
      await mount({ sessions: { ...only, links: only.links.filter((l) => l.endedAt !== null) } });
      expect(screen.getByRole('tab', { name: 'Agent 5' })).toBeInTheDocument();
    });

    it('T8: a `hidden` delivery draws three tabs and no Delivery cell', async () => {
      await mount({ gitlab: gitlab([], null) });
      expect(tabNames()).toEqual(['Ticket', 'Agent 2 live', 'Children & comments']);
      expect(within(strip()).queryByText('Delivery')).toBeNull();
    });

    it('T9: a selection is remembered across tickets; a tab this ticket does not draw falls back to Ticket without writing the store', async () => {
      const m = await mount({});
      expect(selected()).toBe('Ticket');
      await press(screen.getByRole('tab', { name: 'Agent 2 live' }));
      expect(stored()).toBe('agent');
      expect(selected()).toBe('Agent 2 live');

      const pay13 = { ...ISSUE, key: 'PAY-13', id: '10013', url: 'https://acme.atlassian.net/browse/PAY-13' };
      await m.rerender({ issue: pay13 });
      expect(selected()).toMatch(/^Agent/);

      await press(screen.getByRole('tab', { name: /^Delivery/ }));
      expect(stored()).toBe('delivery');
      const pay14 = { ...ISSUE, key: 'PAY-14', id: '10014', url: 'https://acme.atlassian.net/browse/PAY-14' };
      await m.rerender({ issue: pay14, gitlab: gitlab([], null) });
      expect(selected()).toBe('Ticket');
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: 'Ticket' }).id);
      expect(stored()).toBe('delivery');
    });

    it('T10: ArrowRight from Ticket selects Delivery and moves focus; ArrowLeft from Ticket wraps to the last tab', async () => {
      await mount({});
      const ticket = screen.getByRole('tab', { name: 'Ticket' });
      expect(ticket).toHaveAttribute('tabindex', '0');
      expect(screen.getByRole('tab', { name: /^Delivery/ })).toHaveAttribute('tabindex', '-1');
      ticket.focus();
      fireEvent.keyDown(ticket, { key: 'ArrowRight' });
      const delivery = screen.getByRole('tab', { name: /^Delivery/ });
      expect(delivery).toHaveAttribute('aria-selected', 'true');
      expect(delivery).toHaveFocus();
      expect(delivery).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id);

      fireEvent.keyDown(delivery, { key: 'ArrowLeft' });
      const back = screen.getByRole('tab', { name: 'Ticket' });
      fireEvent.keyDown(back, { key: 'ArrowLeft' });
      expect(screen.getByRole('tab', { name: /^Children & comments/ })).toHaveAttribute('aria-selected', 'true');
      expect(stored()).toBe('children');
    });

    it('T11: the Status chip opens `Move to` with the transitions; a pick posts the transition and the frame acts on the landed write', async () => {
      const m = await mount({});
      fireEvent.click(within(strip()).getByRole('button', { name: 'Move to' }));
      const popover = screen.getByRole('dialog', { name: 'Move to' });
      expect(within(popover).getByText('In Progress')).toBeInTheDocument();
      fireEvent.click(within(popover).getByText('Done'));
      await waitFor(() => expect(m.posts()).toEqual(['/api/jira/issue/transition']));
      await m.wrote();
    });

    it('T11: `Assign to me` keeps today’s disabled titles', async () => {
      const m = await mount({ status: { me: null } });
      expect(within(strip()).getByRole('button', { name: 'Assign to me' })).toBeDisabled();
      expect(within(strip()).getByRole('button', { name: 'Assign to me' })).toHaveAttribute('title', 'no identity');
      await m.rerender({ status: { me: DANA } });
      expect(within(strip()).getByRole('button', { name: 'Assign to me' })).toHaveAttribute('title', 'already assigned to you');
      expect(within(strip()).getByText('Dana Novak')).toBeInTheDocument();
    });

    it('T11: an unassigned ticket reads `unassigned`; sprint and parent are cells, absent when the ticket has none', async () => {
      const bare = { ...ISSUE, assignee: null, sprint: null, parent: null };
      await mount({ issue: bare, detail: detail({ ...bare }) });
      expect(within(strip()).getByText('unassigned')).toBeInTheDocument();
      expect(within(strip()).queryByText('Sprint')).toBeNull();
      expect(within(strip()).queryByText('Parent')).toBeNull();
    });

    it('T11: the `develop` pill is red on the Ticket tab, worst first; a pill click selects Delivery; the Agent pill selects Agent', async () => {
      await mount({});
      expect(selected()).toBe('Ticket');
      const pills = within(strip()).getAllByRole('button', { name: /pipeline/ });
      expect(pills.map((p) => [p.textContent, p.getAttribute('data-tone')])).toEqual([
        ['develop · pipeline failed', 'red'],
        ['demo · pipeline passed', 'green']
      ]);
      expect(within(strip()).getByText('Sprint 40')).toBeInTheDocument();
      expect(within(strip()).getByRole('button', { name: 'PAY-3 Refund flows' })).toBeInTheDocument();
      await press(pills[1]);
      expect(selected()).toBe('Delivery 2 targets');
      await press(within(strip()).getByRole('button', { name: new RegExp(STATE_LABEL.answer) }));
      expect(selected()).toBe('Agent 2 live');
    });

    it('T12: one row per target; the first is open with its full track and next row, the other folded with `+4 earlier`', async () => {
      setJiraDetailTab('delivery');
      await mount({ gitlab: gitlab(eight()), sessions: noSessions() });
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

    it('T12: opening `demo` keeps `develop` open; its older fold lists the four, newest first, `from` only on the one from another branch', async () => {
      setJiraDetailTab('delivery');
      await mount({ gitlab: gitlab(eight()), sessions: noSessions() });
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

    it('T13: a strip `demo` pill click selects Delivery and opens the `demo` row, leaving `develop` open', async () => {
      await mount({ gitlab: gitlab(eight()), sessions: noSessions() });
      expect(selected()).toBe('Ticket');
      await press(within(strip()).getByRole('button', { name: 'demo · pipeline passed' }));
      expect(selected()).toBe('Delivery 2 targets');
      expect(row('demo').open).toBe(true);
      expect(row('develop').open).toBe(true);
    });

    it('T14: `demo`’s next row requests a review of `demo`’s MR; its Review dot is ringed and reads `next · review`', async () => {
      setJiraDetailTab('delivery');
      const m = await mount({ gitlab: gitlab(eight()), sessions: noSessions() });
      fireEvent.click(summary('demo'));
      const reviewStep = step('demo', 'Review');
      expect(reviewStep).toHaveAttribute('data-next');
      expect(reviewStep.querySelector('.jira-dlv-dot')).toHaveAttribute('data-next');
      expect(reviewStep.querySelector('.jira-dlv-step-word')?.textContent).toBe('next · review');
      expect(summary('demo').querySelector('.jira-dlv-word')?.textContent).toBe('next: review');
      expect(summary('demo').querySelector('.jira-dlv-word')).toHaveAttribute('data-tone', 'next');
      expect(summary('demo').querySelector('.jira-dlv-track.compact .jira-dlv-dot[data-next]')).not.toBeNull();
      // The button is hidden until the agents status has answered, so it is found, not got.
      fireEvent.click(await within(nextRow('demo') as HTMLElement).findByRole('button', { name: 'Request review' }));
      expect(m.onReview).toHaveBeenCalledWith(expect.objectContaining({ key: 'PAY-12' }), 'request', expect.objectContaining({ iid: 50 }), REPOS);
    });

    it('T14: a target whose lead is merged draws no next row and rings nothing', async () => {
      setJiraDetailTab('delivery');
      await mount({ gitlab: gitlab([DEVELOP_LEAD(), merged(60, 'demo', 90)]), sessions: noSessions() });
      fireEvent.click(summary('demo'));
      expect(nextRow('demo')).toBeNull();
      expect(row('demo').querySelector('[data-next]')).toBeNull();
      expect(summary('demo').querySelector('.jira-dlv-word')?.textContent).toBe('merged');
    });

    it('T15: History is a closed fold reading `5 ended · last <date, time>`; opened, five rows each with `Reopen`', async () => {
      const payload = sessions();
      const newest = payload.links.find((l) => l.sessionId === 's-ended-1')?.endedAt as string;
      await mount({ sessions: payload });
      await openTab(/^Agent/);
      // Built from the parts, not from `formatCreated`, so the case pins the shape the client's dates share: lowercase month, day, then the zone's clock.
      const zone = browserTimeZone();
      const at = Date.parse(newest);
      const p = zonedParts(at, zone);
      const year = p.year === zonedParts(Date.now(), zone).year ? '' : ` '${String(p.year).slice(-2)}`;
      expect(summaryOf('History')).toHaveTextContent(`History5 ended · last ${MONTH[p.month - 1]} ${p.day}${year}, ${formatZonedClock(at, zone)}`);
      expect(foldOf('History')).not.toHaveAttribute('open');
      expect(within(panel()).queryByText('Reopen')).toBeNull();

      fireEvent.click(summaryOf('History'));
      expect(foldOf('History')).toHaveAttribute('open');
      const historyRows = within(foldOf('History')).getAllByRole('listitem');
      expect(historyRows).toHaveLength(5);
      for (const r of historyRows) expect(within(r).getByText('Reopen')).toBeInTheDocument();
    });

    it('T15: a live `review` card with a `stopState` offers no `Stop session`; an `execute` card with one still does', async () => {
      const stoppable = (id: string): DashboardRow => ({ id, status: 'busy', surface: 'dashboard', stopState: 'ready' });
      await mount({
        sessions: {
          links: [
            link({ sessionId: 's-review', action: 'review', state: 'working', row: stoppable('s-review'), startedAt: minutesAgo(4) }),
            link({ sessionId: 's-exec', action: 'execute', state: 'working', row: stoppable('s-exec'), startedAt: minutesAgo(8) })
          ],
          reachable: true,
          rowsAt: new Date().toISOString()
        }
      });
      await openTab(/^Agent/);
      const reviewCard = within(panel()).getByRole('article', { name: 'Session s-review' });
      const exec = within(panel()).getByRole('article', { name: 'Session s-exec' });
      // The execute card's Stop appears once the agents status lands; only then is the review card's absence a finding rather than a race.
      await waitFor(() => expect(within(exec).getByRole('button', { name: 'More for PAY-12' })).toBeInTheDocument());
      await waitFor(() => expect(cardMenuHas(exec, 'Stop session')).toBe(true));
      expect(cardMenuHas(reviewCard, 'Stop session')).toBe(false);
    });

    it('T16: a Children row click opens the child and the tab stays; `← PAY-12` is the frame’s Back', async () => {
      const m = await mount({ detail: detail({ children: [CHILD_A, CHILD_B] }), sessions: noSessions() });
      await openTab(/^Children & comments/);
      expect(summaryOf('Children')).toHaveTextContent('Children2');
      expect(foldOf('Children')).toHaveAttribute('open');
      fireEvent.click(within(panel()).getByRole('button', { name: /^PAY-21 Ledger rounding fix/ }));
      expect(m.onOpenIssue).toHaveBeenCalledWith(CHILD_A, null);

      await m.rerender({ issue: CHILD_A, detail: detail({ ...CHILD_A }), sessions: noSessions(), back: ISSUE });
      expect(selected()).toBe('Children & comments');
      fireEvent.click(screen.getByRole('button', { name: 'Back to PAY-12' }));
      expect(m.onBack).toHaveBeenCalledTimes(1);
    });

    it('T16: the Agent tab’s child-live line opens the child and the Agent tab stays selected', async () => {
      const childLive: JiraSessionsPayload = { ...noSessions(), links: [link({ key: 'PAY-21', sessionId: 's-child', state: 'working' })] };
      const m = await mount({ detail: detail({ children: [CHILD_A, CHILD_B] }), sessions: childLive });
      await openTab(/^Agent/);
      fireEvent.click(within(panel()).getByRole('button', { name: `${STATE_LABEL.working} on PAY-21 →` }));
      expect(m.onOpenIssue).toHaveBeenCalledWith(CHILD_A, null);

      await m.rerender({ issue: CHILD_A, detail: detail({ ...CHILD_A }), sessions: childLive, back: ISSUE });
      expect(selected()).toMatch(/^Agent/);
    });
  });
}
