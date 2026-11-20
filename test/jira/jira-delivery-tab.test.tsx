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
import { useDialogEscape } from '../../client/src/hooks/useDialogEscape';
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
  JiraSkill,
  JiraStatusPayload
} from '../../shared/types';
import { daysAgoStamp } from '../helpers/dates';

/*
  Jira › Detail's Delivery tab (Jira detail tabs spec §4, §9 cases 12–14, 24, 25, 29; DESIGN.md §8.9.6): one fold row per (project, target branch), the
  next step ringed on its track with its row under it, `Ignore` and its store, the older-MRs fold and the Worktrees fold. Mounted through the shared body
  (`JiraTicketBody`), because which rows are open is the body's state and a strip pill opens one — the fold, the pill and the row are one behaviour. The
  fixture is §9 case 3's shape on PAY-12: `develop` has one open MR and two merged, `demo` one open, three merged and one closed — eight MRs in two targets.
  Every stamp is relative to the clock the assertion runs under (`test/helpers/dates.ts`). §9 cases 12–14 are the shared table's
  (`test/helpers/ticket-body-cases.ts`), run through each frame that draws the body; the cases left here are the tab's own.
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

function status(skills: JiraSkill[] = []): JiraStatusPayload {
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
    skills,
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
let onReviewSkill: jest.Mock;
let onRun: jest.Mock;

beforeEach(() => {
  window.localStorage.clear();
  mockAgents = { enabled: true } as AgentsStatus;
  onReview = jest.fn();
  onReviewSkill = jest.fn();
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
  /** `GET /api/jira`'s skills; none unless a case says so. */
  skills?: JiraSkill[];
  /** Draw the body with no `onReview` (and no `onReviewSkill`), as a frame that offers no review does. */
  noReview?: boolean;
}

function tree(opts: Opts = {}) {
  const issue = opts.issue ?? ISSUE;
  const gl = opts.gitlab === undefined ? gitlab(eight()) : opts.gitlab;
  const live = opts.sessions ?? noSessions();
  return (
    <SettingsProvider>
      <GitlabContext.Provider value={{ data: gl, error: null, refresh: () => Promise.resolve(gl) }}>
        <JiraContext.Provider value={{ data: status(opts.skills), loading: false, error: false, reload: jest.fn() }}>
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
              onReview={opts.noReview ? undefined : onReview}
              onReviewSkill={opts.noReview ? undefined : onReviewSkill}
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

describe('JiraDeliveryTab — rows', () => {
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

describe('JiraDeliveryTab — the next step (T24, rows 8, 9, 12)', () => {
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

  it('T26: an open review on the expanded row reads `Review ·`, and nothing drawn on the tab names the review bot', () => {
    mount({ gitlab: gitlab([DEVELOP_LEAD({ review: review() })]) });
    expect(nextRow('develop')?.textContent).toContain('Review · 2 open findings');
    expect(document.body.textContent).not.toMatch(/CodeRabbit/i);
    for (const el of document.querySelectorAll('[title], [aria-label]')) {
      expect(`${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`).not.toMatch(/CodeRabbit/i);
    }
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

/*
  `Review ▾` (Jira review skills spec §4): with at least one review skill the review split gains a chevron, `More reviewers`, whose `Review menu` is the bot
  row then the review skills, and every expanded target whose lead is OPEN offers the skills where the split is not drawn, through a ghost `Review ▾`
  (`Review with a skill`) whose menu holds the skills alone. One gate (`reviewGate`) and one set of hide conditions serve the split, the chevron and the ghost.
*/
const RS1: JiraSkill = { id: 's_deep0001', name: 'Deep review', prompt: '/deep-review {mr.url}', group: 'review' };
const RS2: JiraSkill = { id: 's_sec00002', name: 'Security pass', prompt: '/sec-pass {key} {mr.iid}', group: 'review' };
const RUN_SKILL: JiraSkill = { id: 's_plan0003', name: 'Plan it', prompt: '/plan {key}', group: 'run' };
const SKILLS = [RUN_SKILL, RS1, RS2];
const reviewMenu = (): HTMLElement => screen.getByRole('dialog', { name: 'Review menu' });
const menuHeads = (): string[] => [...reviewMenu().querySelectorAll('.jira-run-head')].map((h) => h.textContent ?? '');
const menuRows = (): HTMLButtonElement[] => within(reviewMenu()).getAllByRole('button') as HTMLButtonElement[];
const labels = (): string[] => menuRows().map((o) => o.querySelector('.jira-run-label')?.textContent ?? '');
const ghostIn = (target: string): HTMLElement | null => within(row(target)).queryByRole('button', { name: 'Review with a skill' });
const chevronIn = (target: string): HTMLElement | null => within(row(target)).queryByRole('button', { name: 'More reviewers' });
const liveLinks = (links: SessionLink[]): JiraSessionsPayload => ({ links, reachable: true, rowsAt: new Date().toISOString() });
const RUN_LINK = (): SessionLink => link({ sessionId: 's-run', state: 'working', action: 'execute', name: 'Execute PAY-12' });
/** `develop`'s lead as `!42` on a `request` row: review `none`, pipeline green. */
const REQUEST_42 = (): GitlabMr => DEVELOP_LEAD({ iid: 42, review: NONE, pipeline: 'success' });

/** An earlier Escape-stack entry, mounted before the tree so the menu ranks above it — what the menu's Escape must NOT reach. */
function Under({ onEscape }: { onEscape: () => void }) {
  useDialogEscape(onEscape);
  return null;
}

describe('JiraDeliveryTab — Review ▾ (review skills spec §4)', () => {
  it('a `request` row: the split gains `More reviewers`; its menu is `Built in` with the bot row marked default, then `Your review skills`', () => {
    mount({ gitlab: gitlab([REQUEST_42()]), skills: SKILLS });
    const more = chevronIn('develop') as HTMLElement;
    expect(more).toHaveAttribute('aria-haspopup', 'dialog');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    // One pill, two halves: the chevron sits in the split whose left half is today's `Request review`.
    expect(within(row('develop')).getByRole('button', { name: 'Request review' }).closest('.ui-split')).toBe(more.closest('.ui-split'));
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(menuHeads()).toEqual(['Built in', 'Your review skills']);
    expect(labels()).toEqual(['Review bot — request review', 'Deep review', 'Security pass']);
    expect(menuRows().map((o) => o.querySelector('.jira-run-sub')?.textContent ?? null)).toEqual(['Posts the review request on !42', '/deep-review', '/sec-pass']);
    expect(menuRows()[0].querySelector('.jira-run-mark')?.textContent).toBe('default');
    expect(menuRows()[1].querySelector('.jira-run-mark')).toBeNull();
    expect(menuRows()[1]).toHaveAttribute('title', RS1.prompt);
    // A run skill is Run ▾'s, never this menu's.
    expect(reviewMenu().textContent).not.toContain(RUN_SKILL.name);
  });

  it('the bot row is the left half’s action, and closes the menu', () => {
    mount({ gitlab: gitlab([REQUEST_42()]), skills: SKILLS });
    fireEvent.click(chevronIn('develop') as HTMLElement);
    fireEvent.click(menuRows()[0]);
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ key: 'PAY-12' }), 'request', expect.objectContaining({ iid: 42 }), REPOS);
    expect(onReviewSkill).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Review menu' })).toBeNull();
  });

  it('a skill row opens the launch sheet’s skill variant for THIS row’s MR, with its candidate repos', () => {
    mount({ gitlab: gitlab([REQUEST_42()]), skills: SKILLS });
    fireEvent.click(chevronIn('develop') as HTMLElement);
    fireEvent.click(within(reviewMenu()).getByRole('button', { name: 'Security pass' }));
    expect(onReviewSkill).toHaveBeenCalledWith(expect.objectContaining({ key: 'PAY-12' }), RS2.id, expect.objectContaining({ iid: 42, sourceBranch: 'pay-12-refunds' }), REPOS);
    expect(onReview).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Review menu' })).toBeNull();
  });

  it('a `fix` row’s bot row reads `Review bot — fix findings` / `Fixes the open findings on !42` and launches the fix half', () => {
    mount({ gitlab: gitlab([DEVELOP_LEAD({ iid: 42, review: review() })]), skills: SKILLS });
    fireEvent.click(chevronIn('develop') as HTMLElement);
    expect(labels()[0]).toBe('Review bot — fix findings');
    expect(menuRows()[0].querySelector('.jira-run-sub')?.textContent).toBe('Fixes the open findings on !42');
    fireEvent.click(menuRows()[0]);
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ key: 'PAY-12' }), 'fix', expect.objectContaining({ iid: 42 }), REPOS);
  });

  it.each<[string, () => GitlabMr[]]>([
    ['request', () => [REQUEST_42()]],
    ['run', () => [DEVELOP_LEAD()]],
    ['merge', () => [DEVELOP_LEAD({ pipeline: 'success' })]],
    ['gitlab', () => [DEVELOP_LEAD({ pipeline: 'canceled' })]],
    ['none', () => [DEVELOP_LEAD({ pipeline: 'running' })]]
  ])('with no review skill (a run skill only) a `%s` row draws no chevron and no ghost', (_kind, mrs) => {
    mount({ gitlab: gitlab(mrs()), skills: [RUN_SKILL] });
    expect(chevronIn('develop')).toBeNull();
    expect(ghostIn('develop')).toBeNull();
  });

  it('with no review skill the split is exactly today’s: one half, no chevron', () => {
    mount({ gitlab: gitlab([REQUEST_42()]), skills: [RUN_SKILL] });
    const split = within(row('develop')).getByRole('button', { name: 'Request review' }).closest('.ui-split') as HTMLElement;
    expect(split.querySelectorAll('button')).toHaveLength(1);
  });

  it('`fix` with a live bot review link: `Open session`, then the ghost — held by that session, so it says why with the ghost’s own tail', () => {
    mount({ gitlab: gitlab([DEVELOP_LEAD({ review: review() })]), sessions: liveLinks([link({ sessionId: 's-review', state: 'working' })]), skills: SKILLS });
    const next = nextRow('develop') as HTMLElement;
    const open = within(next).getByRole('link', { name: 'Open session' });
    const ghost = ghostIn('develop') as HTMLElement;
    expect(open.compareDocumentPosition(ghost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ghost).toBeDisabled();
    expect(row('develop').querySelector('.jira-dlv-next-why')?.textContent).toBe(
      'Review PAY-12 s-review is live on this ticket — Review waits until it ends or you stop it.'
    );
  });

  it('`fix` with a live bot review link elsewhere: the ghost’s menu holds the review skills alone — never the bot row', () => {
    const elsewhere = link({ sessionId: 's-review', state: 'working', how: 'manual', repo: '/Users/dana/other', branch: 'other-branch' });
    mount({ gitlab: gitlab([DEVELOP_LEAD({ review: review() })]), sessions: liveLinks([elsewhere]), skills: SKILLS });
    expect(within(nextRow('develop') as HTMLElement).getByRole('link', { name: 'Open session' })).toBeInTheDocument();
    const ghost = ghostIn('develop') as HTMLElement;
    expect(ghost).toBeEnabled();
    expect(ghost).toHaveTextContent(/^Review$/);
    expect(ghost.querySelector('svg')).not.toBeNull();
    fireEvent.click(ghost);
    expect(menuHeads()).toEqual(['Your review skills']);
    expect(labels()).toEqual(['Deep review', 'Security pass']);
    expect(reviewMenu().textContent).not.toMatch(/Review bot/);
    fireEvent.click(menuRows()[0]);
    expect(onReviewSkill).toHaveBeenCalledWith(expect.objectContaining({ key: 'PAY-12' }), RS1.id, expect.objectContaining({ iid: 41 }), REPOS);
  });

  it('`fix` with a live review-SKILL link on the branch: still the split and its chevron, never `Open session`', () => {
    const skillLink = link({ sessionId: 's-skill', state: 'working', action: { skill: RS1.id }, name: 'Deep review PAY-12' });
    mount({ gitlab: gitlab([DEVELOP_LEAD({ review: review() })]), sessions: liveLinks([skillLink]), skills: SKILLS });
    const next = nextRow('develop') as HTMLElement;
    expect(within(next).queryByRole('link', { name: 'Open session' })).toBeNull();
    expect(within(next).getByRole('button', { name: 'Fix review' })).toBeInTheDocument();
    expect(chevronIn('develop')).toBeInTheDocument();
    expect(ghostIn('develop')).toBeNull();
  });

  it('`run`: `Run ▾`, then the ghost', () => {
    mount({ skills: SKILLS });
    const run = within(row('develop')).getByRole('button', { name: 'Run options for PAY-12' });
    const ghost = ghostIn('develop') as HTMLElement;
    expect(run.compareDocumentPosition(ghost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(ghost);
    expect(labels()).toEqual(['Deep review', 'Security pass']);
  });

  it.each<[string, Partial<GitlabMr>, string]>([
    ['merge', { pipeline: 'success' }, 'Merge in GitLab ↗'],
    ['gitlab', { pipeline: 'canceled' }, 'GitLab ↗']
  ])('`%s`: the chip, then the ghost', (_kind, over, chip) => {
    mount({ gitlab: gitlab([DEVELOP_LEAD(over)]), skills: SKILLS });
    const chipEl = within(row('develop')).getByRole('link', { name: chip });
    expect(chipEl.compareDocumentPosition(ghostIn('develop') as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no next kind on an OPEN lead (a running pipeline, no sentence): the row draws with the ghost alone', () => {
    mount({ gitlab: gitlab([DEVELOP_LEAD({ pipeline: 'running' })]), skills: SKILLS });
    const next = nextRow('develop') as HTMLElement;
    expect(next).not.toBeNull();
    expect(next.querySelector('.jira-dlv-next-text')).toBeNull();
    expect(within(next).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Review with a skill']);
  });

  it.each<[string, () => GitlabMr]>([
    ['merged', () => merged(41, 'develop', 10)],
    ['closed', () => mr({ iid: 41, targetBranch: 'develop', state: 'closed', pipeline: null, updatedAt: minutesAgo(10) })]
  ])('a %s lead draws no ghost, and the row stays absent', (_state, lead) => {
    mount({ gitlab: gitlab([lead()]), skills: SKILLS });
    expect(ghostIn('develop')).toBeNull();
    expect(nextRow('develop')).toBeNull();
  });

  it('gate held (a live run on the key): the chevron is disabled with the gate’s sentence, and the split’s reason line is unchanged', () => {
    mount({ gitlab: gitlab([REQUEST_42()]), sessions: liveLinks([RUN_LINK()]), skills: SKILLS });
    const more = chevronIn('develop') as HTMLElement;
    expect(more).toBeDisabled();
    expect(more).toHaveAttribute('title', 'Execute PAY-12 is live on this ticket');
    expect(row('develop').querySelector('.jira-dlv-next-why')?.textContent).toBe(
      'Execute PAY-12 is live on this ticket — Request review waits until it ends or you stop it.'
    );
  });

  it('gate held: the ghost is disabled in the dashed skin with the gate’s sentence, and its reason line ends ` — Review waits …`', () => {
    mount({ sessions: liveLinks([RUN_LINK()]), skills: SKILLS });
    const ghost = ghostIn('develop') as HTMLElement;
    expect(ghost).toBeDisabled();
    expect(ghost).toHaveAttribute('title', 'Execute PAY-12 is live on this ticket');
    expect(ghost.closest('.ui-split')).toHaveClass('ui-split-dashed');
    const why = row('develop').querySelector('.jira-dlv-next-why') as HTMLElement;
    expect(why.textContent).toBe('Execute PAY-12 is live on this ticket — Review waits until it ends or you stop it.');
    expect(ghost).toHaveAttribute('aria-describedby', why.id);
  });

  it('gate held while the menu is open: every row is disabled, titled with the gate’s sentence', () => {
    const view = mount({ gitlab: gitlab([REQUEST_42()]), skills: SKILLS });
    fireEvent.click(chevronIn('develop') as HTMLElement);
    view.rerender(tree({ gitlab: gitlab([REQUEST_42()]), sessions: liveLinks([RUN_LINK()]), skills: SKILLS }));
    for (const r of menuRows()) {
      expect(r).toBeDisabled();
      expect(r).toHaveAttribute('title', 'Execute PAY-12 is live on this ticket');
    }
  });

  it.each<[string, () => void, Opts]>([
    ['agents are off', () => (mockAgents = { enabled: false } as AgentsStatus), {}],
    ['agents are not yet answered', () => (mockAgents = null), {}],
    ['no candidate repo', () => undefined, { gitlab: gitlab(eight(), [{ ...PAY_API, repos: [] }]) }],
    ['no `onReview`', () => undefined, { noReview: true }]
  ])('hidden when %s: no chevron on the `request` row, no ghost on the `run` row', (_why, arrange, opts) => {
    arrange();
    mount({ skills: SKILLS, ...opts });
    expect(chevronIn('demo')).toBeNull();
    expect(ghostIn('develop')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /More reviewers|Review with a skill/ })).toHaveLength(0);
  });

  it('Escape closes the menu and nothing under it: the menu is a `ui/Popover` on the dialog stack', () => {
    const under = jest.fn();
    render(
      <>
        <Under onEscape={under} />
        {tree({ gitlab: gitlab([REQUEST_42()]), skills: SKILLS })}
      </>
    );
    fireEvent.click(chevronIn('develop') as HTMLElement);
    expect(reviewMenu()).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Review menu' })).toBeNull();
    expect(under).not.toHaveBeenCalled();
    expect(chevronIn('develop')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('JiraDeliveryTab — Ignore (T25, T29)', () => {
  it('T25: ignoring `develop`’s failed pipeline stores it, draws `ignored`, moves the pill to merge — and the strip stays red', () => {
    // Built ONCE: `DEVELOP_LEAD`'s stamp is minute-relative to the clock, so a second build could land a second later than the one drawn.
    const mrs = eight();
    mount({ gitlab: gitlab(mrs) });
    const red = () => within(strip()).getByRole('button', { name: 'develop · pipeline failed' });
    expect(red()).toHaveAttribute('data-tone', 'red');
    fireEvent.click(within(nextRow('develop') as HTMLElement).getByRole('button', { name: 'Ignore' }));
    expect(ignoredStore()).toEqual({ 'acme/pay-api!41': { pipeline: { status: 'failed', updatedAt: mrs[0].updatedAt } } });
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
