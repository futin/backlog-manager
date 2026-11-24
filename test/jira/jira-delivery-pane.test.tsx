/**
 * @jest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ReactNode } from 'react';

import { DeliveryPane } from '../../client/src/components/jira/DeliveryPane';
import { JiraDeliveryTab } from '../../client/src/components/jira/JiraDeliveryTab';
import { GitlabContext } from '../../client/src/hooks/GitlabContext';
import { JiraContext } from '../../client/src/hooks/JiraContext';
import { JiraSessionsContext } from '../../client/src/hooks/JiraSessionsContext';
import { deliveryTargets, targetRowId, type DeliveryNext } from '../../client/src/lib/delivery';
import type { AgentsStatus, GitlabMr, GitlabPayload, GitlabProjectView, GitlabReview, GitlabStatus, JiraIssue, JiraSessionsPayload, JiraStatusPayload } from '../../shared/types';
import { ruleBlocks, readStyles } from '../helpers/css-rule';
import { daysAgoStamp } from '../helpers/dates';

/**
 * Jira Detail's Delivery pane (GitLab connection spec §7.1, mock `OptionC.dc.html`; one target's expanded body since Jira detail tabs spec §4.2): an MR's
 * head and its track with each step's word, then the next row for a Review step (the CodeRabbit row's rules, now `NextRow`'s `request`/`fix` branch). The
 * pane is drawn with a QUIET next (nothing ringed), so the step words asserted here are the track's own; the ring, the `Also:` line's replacement (one row
 * per target), the `via` mark and the no-MR, unknown, hidden and not-shown shapes are the tab's and live in `jira-delivery-tab.test.tsx`. Rendered under the
 * RAW `GitlabContext` with a payload in hand, so no fetch runs. Every MR stamp is relative to `now`, which the pane takes as a prop, so the ages asserted
 * here are fixed whatever the real clock says; the issue's own `created`/`updated` go through `daysAgoStamp` for the fixture-clock guard.
 */

// The CodeRabbit row asks the dashboard whether agents are on (`useAgents`); the hook fetches, so it is replaced by a status this suite sets per case.
let mockAgents: AgentsStatus | null = { enabled: true } as AgentsStatus;
jest.mock('../../client/src/hooks/useAgents', () => ({ useAgents: () => ({ status: mockAgents, reload: jest.fn() }) }));

const now = Date.now();
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

function mr(over: Partial<GitlabMr> = {}): GitlabMr {
  const iid = over.iid ?? 412;
  return {
    project: 'development/backend/microservice',
    iid,
    title: `TIMIFY-123 | change ${iid}`,
    webUrl: `https://gitlab.example.test/development/backend/microservice/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    sourceBranch: `timify-123-change-${iid}`,
    targetBranch: 'develop',
    createdAt: ago(120),
    updatedAt: ago(30),
    mergedAt: null,
    headSha: null,
    pipeline: 'success',
    keys: ['TIMIFY-123'],
    review: null,
    ...over
  };
}

const MICRO: GitlabProjectView = { path: 'development/backend/microservice', repo: 'microservice', polledAt: ago(5), capped: false, failed: false, repos: [] };
const PROXY: GitlabProjectView = { path: 'development/graphql/dev-api-graphql-proxy', repo: 'dev-api-graphql-proxy', polledAt: ago(3), capped: false, failed: false, repos: [] };

function status(over: Partial<GitlabStatus> = {}): GitlabStatus {
  return {
    state: 'connected',
    site: 'gitlab.example.test',
    malformedSite: false,
    user: { username: 'ada', name: 'Ada' },
    httpStatus: null,
    reason: null,
    armed: true,
    retryAt: null,
    mappedRepos: 2,
    foundHosts: [],
    problems: [],
    interval: '1m',
    ...over
  };
}

function payload(mrs: GitlabMr[], jiraProjects: Record<string, GitlabProjectView[]> = { TIMIFY: [MICRO, PROXY] }, st: Partial<GitlabStatus> = {}): GitlabPayload {
  return { status: status(st), jiraProjects, mrs };
}

function issue(over: Partial<JiraIssue> = {}): JiraIssue {
  const key = over.key ?? 'TIMIFY-123';
  return {
    key,
    id: `id-${key}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `summary of ${key}`,
    project: { key: key.split('-')[0], name: 'Timify' },
    type: { name: 'Story', level: 0, subtask: false },
    status: { name: 'In Progress', category: 'indeterminate' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: daysAgoStamp(10),
    updated: daysAgoStamp(1),
    resolved: null,
    ...over
  };
}

/** A next step that rings nothing and offers nothing, so the track draws every step's own word. */
const QUIET: DeliveryNext = { step: null, word: null, pill: '', sentence: null, button: null, ignore: null, ignored: { review: false, pipeline: false } };

/** The pane for one MR — the payload's first, a target's lead as the tab would hand it down. */
function draw(data: GitlabPayload) {
  return render(
    <GitlabContext.Provider value={{ data, error: null, refresh: () => Promise.resolve(data) }}>
      <DeliveryPane mr={data.mrs[0]} now={now} next={QUIET} onUnignore={jest.fn()} />
    </GitlabContext.Provider>
  );
}

/** One track step's `<li>`, found by its label, so a word is asserted against the step it sits under and never against the pane at large. */
const step = (label: string): HTMLElement => {
  const el = screen.getByText(label, { selector: '.jira-dlv-step-label' }).closest('li');
  if (el === null) throw new Error(`no track step labelled ${label}`);
  return el;
};
const stepWord = (label: string): string | null => step(label).querySelector('.jira-dlv-step-word')?.textContent ?? null;

afterEach(() => {
  cleanup();
  mockAgents = { enabled: true } as AgentsStatus;
});

describe('DeliveryPane', () => {
  it('draws an open MR with a passing pipeline: head, link, repo → target, polled age, and the five-step track', () => {
    const { container } = draw(payload([mr()]));
    expect(screen.getByRole('region', { name: '!412 into develop' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '!412' });
    expect(link).toHaveAttribute('href', 'https://gitlab.example.test/development/backend/microservice/-/merge_requests/412');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(screen.getByText('microservice → develop')).toBeInTheDocument();
    // The lead MR's own project's age, not the other mapped project's.
    expect(screen.getByText('polled 5m ago')).toBeInTheDocument();

    const labels = [...container.querySelectorAll('.jira-dlv-step-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Pushed', 'MR open', 'Review', 'Pipeline', 'Merged']);
    expect(stepWord('Pushed')).toBe('2h');
    expect(stepWord('MR open')).toBe('2h');
    expect(stepWord('Pipeline')).toBe('pipeline passed');
    expect(stepWord('Merged')).toBeNull();
    expect(step('Pipeline').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'green');
    expect(step('Merged').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'off');

    // The Review step is in the track (CodeRabbit spec §5.1), off with no word for `review: null`, and `review: null` draws no CodeRabbit row (§5.2).
    expect(stepWord('Review')).toBeNull();
    expect(step('Review').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'off');
    expect(container.textContent).not.toMatch(/CodeRabbit/);
    expect(screen.queryByText(/Also:/)).not.toBeInTheDocument();
  });

  it('a merged MR carries its merged-at age at Merged, and Pipeline has no word', () => {
    draw(payload([mr({ state: 'merged', pipeline: null, mergedAt: ago(60 * 26), updatedAt: ago(60 * 26) })]));
    expect(stepWord('Merged')).toBe('1d');
    expect(stepWord('Pipeline')).toBeNull();
    expect(stepWord('Pushed')).toBe('2h');
    expect(step('Merged').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'magenta');
  });
});

// jsdom paints nothing, so the track's z-order is pinned at the rule: step i+1's positioned rail comes later in the tree than step i's dot and, with no
// z-index on the dot, painted over its right half — the glyph cut and the rail showing through a hollow ring (ui-verify 2026-11-12). `isolation` keeps the
// dot's z-index local, so it never rises over the List's sticky header or a menu.
describe('delivery track paint order', () => {
  const css = readStyles();
  it('lifts the dot over the rail', () => {
    expect(ruleBlocks(css, '.jira-dlv-dot').some((b) => /(^|[;\s])z-index:\s*1\b/.test(b))).toBe(true);
  });
  it('keeps that z-index inside the track', () => {
    expect(ruleBlocks(css, '.jira-dlv-track').some((b) => /isolation:\s*isolate/.test(b))).toBe(true);
  });
});


/** A review fact set; defaults to two open findings (one major, one minor) landed 4m ago, the `opt-b-open.png` state. */
function review(over: Partial<GitlabReview> = {}): GitlabReview {
  return {
    open: 2,
    resolved: 25,
    worst: 'major',
    bySeverity: { critical: 0, major: 1, minor: 1, trivial: 0, other: 0 },
    triggeredAt: ago(30),
    landedAt: ago(4),
    commitsSince: 0,
    capped: false,
    readAt: ago(1),
    failed: false,
    ...over
  };
}
const NONE = review({ open: 0, resolved: 0, worst: null, bySeverity: { critical: 0, major: 0, minor: 0, trivial: 0, other: 0 }, triggeredAt: null, landedAt: null });

const REPOS = ['/a/one', '/a/two'];
const MICRO_R: GitlabProjectView = { ...MICRO, repos: REPOS };

function link(over: Partial<JiraSessionsPayload['links'][number]> = {}): JiraSessionsPayload['links'][number] {
  return {
    key: 'TIMIFY-123',
    sessionId: 's1',
    how: 'run',
    action: 'execute',
    name: 'TIMIFY-123 execute',
    repo: '/a/one',
    branch: null,
    surface: 'desktop',
    model: null,
    effort: null,
    snapshot: { summary: 's', type: 'Story', parentKey: null },
    startedAt: ago(20),
    endedAt: null,
    endReason: null,
    quietSince: null,
    reattachedAt: null,
    state: 'working',
    row: null,
    stateSince: ago(20),
    ...over
  } as JiraSessionsPayload['links'][number];
}

/** The pane under every context the row reads: GitLab, the Jira status (its `live` map) and the sessions payload. */
function drawRow(mrs: GitlabMr[], opts: { links?: JiraSessionsPayload['links']; live?: JiraStatusPayload['live']; onReview?: jest.Mock; projects?: GitlabProjectView[] } = {}) {
  const data = payload(mrs, { TIMIFY: opts.projects ?? [MICRO_R, PROXY] });
  const jira = { repos: { TIMIFY: REPOS }, live: opts.live ?? {} } as unknown as JiraStatusPayload;
  const wrap = (children: ReactNode) => (
    <JiraContext.Provider value={{ data: jira, loading: false, error: false, reload: jest.fn() }}>
      <JiraSessionsContext.Provider value={{ data: { links: opts.links ?? [], reachable: true, rowsAt: null }, reload: jest.fn(() => Promise.resolve()) }}>
        <GitlabContext.Provider value={{ data, error: null, refresh: () => Promise.resolve(data) }}>{children}</GitlabContext.Provider>
      </JiraSessionsContext.Provider>
    </JiraContext.Provider>
  );
  return render(wrap(<DeliveryPane mr={mrs[0]} now={now} next={QUIET} onUnignore={jest.fn()} />));
}

/**
 * The next row lives in the tab now (spec §4.4: every expanded target with an open lead gets one), so its cases draw `JiraDeliveryTab` with every row open,
 * under every context the row reads: GitLab, the Jira status (its `live` map) and the sessions payload. `onReview` keeps the old pane's three-argument shape
 * by dropping the issue the tab adds.
 */
function drawNext(
  mrs: GitlabMr[],
  opts: { links?: JiraSessionsPayload['links']; live?: JiraStatusPayload['live']; onReview?: jest.Mock; projects?: GitlabProjectView[] } = {}
) {
  const data = payload(mrs, { TIMIFY: opts.projects ?? [MICRO_R, PROXY] });
  const jira = { repos: { TIMIFY: REPOS }, live: opts.live ?? {} } as unknown as JiraStatusPayload;
  const onReview = opts.onReview;
  return render(
    <JiraContext.Provider value={{ data: jira, loading: false, error: false, reload: jest.fn() }}>
      <JiraSessionsContext.Provider value={{ data: { links: opts.links ?? [], reachable: true, rowsAt: null }, reload: jest.fn(() => Promise.resolve()) }}>
        <GitlabContext.Provider value={{ data, error: null, refresh: () => Promise.resolve(data) }}>
          <JiraDeliveryTab
            issue={issue()}
            now={now}
            onReview={onReview === undefined ? undefined : (_issue, half, m, repos) => onReview(half, m, repos)}
            onRun={jest.fn()}
            openRows={new Set(deliveryTargets(mrs).map(targetRowId))}
            onToggleRow={jest.fn()}
            onOpenRow={jest.fn()}
            liveReviewLink={null}
            worktrees={null}
          />
        </GitlabContext.Provider>
      </JiraSessionsContext.Provider>
    </JiraContext.Provider>
  );
}
const rowEl = (): HTMLElement | null => document.querySelector('.jira-dlv-next');

describe('the Review step', () => {
  it.each<[string, GitlabReview | null, string, string | null]>([
    ['none', NONE, 'off', 'not reviewed'],
    ['reviewing', review({ open: 0, triggeredAt: ago(4), landedAt: null }), 'grey', 'reviewing… 4m'],
    ['open', review(), 'amber', '2 open · 1 major'],
    ['clean', review({ open: 0, worst: null, resolved: 25, bySeverity: { critical: 0, major: 0, minor: 0, trivial: 0, other: 0 } }), 'green', '0 open · 25 resolved'],
    ['stale', review({ open: 0, worst: null, commitsSince: 3 }), 'grey', '3 commits since review'],
    ['not read', null, 'off', null]
  ])('draws the %s state with its mark and word', (_n, r, mark, word) => {
    drawRow([mr({ review: r })]);
    expect(step('Review').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', mark);
    expect(stepWord('Review')).toBe(word);
  });

  it('puts the failed-read suffix in the step’s title', () => {
    drawRow([mr({ review: review({ failed: true, readAt: ago(7) }) })]);
    expect(step('Review').getAttribute('title')).toContain('not refreshed since 7m');
    expect(step('Pipeline')).not.toHaveAttribute('title');
  });

  it('reads `pipeline passed` at Pipeline while Review shows open findings, and the head draws no word', () => {
    const { container } = drawRow([mr({ review: review() }), mr({ iid: 415, updatedAt: ago(90), review: review() })]);
    expect(stepWord('Pipeline')).toBe('pipeline passed');
    expect(stepWord('Review')).toBe('2 open · 1 major');
    expect(container.querySelector('.jira-dlv-head .jira-dlv-word')).toBeNull();
  });

  it('draws a merged lead’s Review step magenta with no word', () => {
    drawRow([mr({ state: 'merged', pipeline: null, mergedAt: ago(60), review: null })]);
    expect(step('Review').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'magenta');
    expect(stepWord('Review')).toBeNull();
  });
});

describe('the next row on a Review step (was the CodeRabbit row)', () => {
  it('open: the sentence in amber and a `Fix review` button, which launches the fix half on the lead with the candidate repos', () => {
    const onReview = jest.fn();
    const lead = mr({ review: review() });
    drawNext([lead], { onReview });
    expect(rowEl()?.textContent).toContain('Review · 2 open findings · 1 major, 1 minor · reviewed 4m ago');
    expect(rowEl()?.querySelector('[data-tone]')).toHaveAttribute('data-tone', 'amber');
    // The sentence ellipsises before the button gives way (a failed read's suffix overflowed 505 > 495 at 1440 in /ui-verify), so it is its own title.
    expect(rowEl()?.querySelector('.jira-dlv-next-text')).toHaveAttribute('title', 'Review · 2 open findings · 1 major, 1 minor · reviewed 4m ago');
    const btn = screen.getByRole('button', { name: 'Fix review' });
    expect(btn).toBeEnabled();
    expect(btn.closest('.ui-split')).toHaveClass('ui-split-28');
    fireEvent.click(btn);
    expect(onReview).toHaveBeenCalledWith('fix', expect.objectContaining({ iid: 412, project: lead.project }), ['/a/one', '/a/two']);
  });

  it('none: `not reviewed yet` and `Request review`, launching the request half', () => {
    const onReview = jest.fn();
    drawNext([mr({ review: NONE })], { onReview });
    expect(rowEl()?.textContent).toContain('Review · not reviewed yet');
    fireEvent.click(screen.getByRole('button', { name: 'Request review' }));
    expect(onReview).toHaveBeenCalledWith('request', expect.objectContaining({ iid: 412 }), REPOS);
  });

  it('stale offers `Request review` too', () => {
    drawNext([mr({ review: review({ open: 0, worst: null, commitsSince: 3 }) })], { onReview: jest.fn() });
    expect(rowEl()?.textContent).toContain('3 commits since the last review');
    expect(screen.getByRole('button', { name: 'Request review' })).toBeInTheDocument();
  });

  // No review split for any of these. Since the next step (spec §4.5) a row still draws for the ones with a later step or an `Ignore`: a clean, green MR's
  // is the Merge row, an `unknown` review's is `Ignore` alone, an unread one's is its sentence and `Ignore`; a review in flight and a merged lead draw none.
  it.each<[string, GitlabMr, string | null]>([
    ['reviewing', mr({ review: review({ open: 0, triggeredAt: ago(4), landedAt: null }) }), null],
    ['clean', mr({ review: review({ open: 0, worst: null }) }), 'Reviewed and green — merge happens in GitLab.Merge in GitLab ↗'],
    ['unknown', mr({ review: review({ open: 0, capped: true }) }), 'Ignore'],
    ['not read', mr({ review: null }), 'The review has not been read yet.Ignore'],
    ['a merged lead', mr({ state: 'merged', pipeline: null, mergedAt: ago(60), review: review() }), null]
  ])('draws no review split for %s', (_n, lead, text) => {
    drawNext([lead], { onReview: jest.fn() });
    expect(rowEl()?.textContent ?? null).toBe(text);
    expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument();
  });

  it('draws the row without a button when no repo is a candidate', () => {
    drawNext([mr({ review: review() })], { projects: [{ ...MICRO, repos: [] }] });
    expect(rowEl()?.textContent).toContain('Review · 2 open findings');
    expect(screen.queryByRole('button', { name: 'Fix review' })).not.toBeInTheDocument();
  });

  it('draws no button while agents are off or not yet answered', () => {
    mockAgents = { enabled: false } as AgentsStatus;
    drawNext([mr({ review: review() })]);
    expect(rowEl()).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Fix review' })).not.toBeInTheDocument();
    cleanup();
    mockAgents = null;
    drawNext([mr({ review: review() })]);
    expect(screen.queryByRole('button', { name: 'Fix review' })).not.toBeInTheDocument();
  });

  it('draws no button without an `onReview` to call', () => {
    drawNext([mr({ review: review() })]);
    expect(screen.queryByRole('button', { name: 'Fix review' })).not.toBeInTheDocument();
  });

  describe('the live-session gate', () => {
    const open = (): GitlabMr => mr({ review: review() });
    const why = (): HTMLElement | null => document.querySelector('.jira-dlv-next-why');
    const blocked = (title: string) => {
      const btn = screen.getByRole('button', { name: 'Fix review' });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', title);
      // A disabled button takes no hover, so the wrapper carries the same sentence for the pointer.
      expect(btn.parentElement).toHaveAttribute('title', title);
      // An ink button drew :disabled exactly like an enabled one, so the blocked one wears the board's dashed skin — the look Run ▾ and Merge use.
      expect(btn.parentElement).toHaveClass('ui-split-dashed');
      // The reason is on screen, not only in a tooltip: the line under the row says who holds it and what to do, and the button points at it.
      expect(why()?.textContent).toBe(`${title} — Fix review waits until it ends or you stop it.`);
      expect(btn).toHaveAttribute('aria-describedby', why()?.id);
    };

    it('names the session in bold on the reason line', () => {
      drawNext([open()], { onReview: jest.fn(), links: [link({ name: 'TIMIFY-123 execute' })] });
      expect(why()?.querySelector('strong')?.textContent).toBe('TIMIFY-123 execute');
    });

    it('says the request half’s own label on the line', () => {
      drawNext([mr({ review: NONE })], {
        onReview: jest.fn(),
        links: [link({ name: 'TIMIFY-123 execute' })]
      });
      expect(screen.getByRole('button', { name: 'Request review' })).toBeDisabled();
      expect(why()?.textContent).toBe('TIMIFY-123 execute is live on this ticket — Request review waits until it ends or you stop it.');
    });

    it('a live `run` link on the key disables it, naming the session', () => {
      drawNext([open()], { onReview: jest.fn(), links: [link({ name: 'TIMIFY-123 execute' })] });
      blocked('TIMIFY-123 execute is live on this ticket');
    });

    it('a `starting` reservation on the key disables it the same way', () => {
      drawNext([open()], {
        onReview: jest.fn(),
        live: { 'TIMIFY-123': { name: 'TIMIFY-123 execute', sessionId: null, startedAt: ago(1), repo: '/a/one', starting: true } }
      });
      blocked('TIMIFY-123 execute is live on this ticket');
    });

    it('a live link on another key whose stored branch is the MR’s source branch disables it, naming the branch', () => {
      drawNext([open()], { onReview: jest.fn(), links: [link({ key: 'TIMIFY-9', how: 'branch', name: 'my session', branch: 'timify-123-change-412', repo: '/a/two' })] });
      blocked('my session is live on timify-123-change-412');
    });

    it('a live link whose dashboard row is on the source branch in a candidate checkout disables it', () => {
      const row = { status: 'working', gitBranch: 'timify-123-change-412', projectPath: '/a/one/.worktrees/x' } as JiraSessionsPayload['links'][number]['row'];
      drawNext([open()], { onReview: jest.fn(), links: [link({ key: 'TIMIFY-9', how: 'manual', name: 'hand session', row })] });
      blocked('hand session is live on timify-123-change-412');
    });

    it('does not block on an ended link, a branch link on another branch, or a branch outside the candidates', () => {
      drawNext([open()], {
        onReview: jest.fn(),
        links: [
          link({ key: 'TIMIFY-9', how: 'branch', branch: 'timify-123-change-412', endedAt: ago(1) }),
          link({ key: 'TIMIFY-8', how: 'branch', branch: 'other', repo: '/a/one' }),
          link({ key: 'TIMIFY-7', how: 'branch', branch: 'timify-123-change-412', repo: '/elsewhere' }),
          // A `branch` link on THIS key is not the ticket gate's (only `run` is), and this one is on another branch.
          link({ how: 'branch', branch: 'x' })
        ]
      });
      const btn = screen.getByRole('button', { name: 'Fix review' });
      expect(btn).toBeEnabled();
      // Unblocked, the button is the ink pill again and there is no reason line to point at.
      expect(btn.parentElement).not.toHaveClass('ui-split-dashed');
      expect(btn).not.toHaveAttribute('aria-describedby');
      expect(why()).toBeNull();
    });
  });
});
