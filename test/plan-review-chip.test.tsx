/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { PlanReviewChip } from '../client/src/components/board/PlanReviewChip';
import { daysAgoDate } from './helpers/dates';
import { clearFilters, pickProject, pickStatus } from './helpers/filter-bar';
import type { AgentsStatus, BacklogItem, OrchestratorRunsPayload, ProjectSummary, TicksPayload } from '../shared/types';

/**
 * #367 — the band's plan-review reading, and the board half of Approve: the card's `Review plan` opens the item, and after an approval the open modal
 * draws the FRESH item from the re-read payload rather than the snapshot it was opened on.
 */
describe('PlanReviewChip', () => {
  const blocked = { projectPath: '/abs/alpha', name: 'alpha', count: 2, cap: 2, blocked: true };
  const under = { projectPath: '/abs/beta', name: 'beta', count: 1, cap: 3, blocked: false };

  it('draws nothing when there is nothing to say', () => {
    const { container } = render(<PlanReviewChip tallies={[]} projectValue={null} pressed={false} onToggle={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('paints the paused dot while a project in scope is at its cap, and titles every project', () => {
    render(<PlanReviewChip tallies={[blocked, under]} projectValue={null} pressed={false} onToggle={() => {}} />);
    const chip = screen.getByTestId('plan-review-chip');
    expect(chip).toHaveTextContent('3 plans awaiting review · tick blocked in alpha');
    expect(chip.querySelector('.ui-dot-paused')).not.toBeNull();
    expect(chip).toHaveAttribute('title', 'alpha: 2/2\nbeta: 1/3');
  });

  it('draws a toneless dot when the project in scope is under its cap', () => {
    render(<PlanReviewChip tallies={[blocked, under]} projectValue="/abs/beta" pressed={false} onToggle={() => {}} />);
    const chip = screen.getByTestId('plan-review-chip');
    expect(chip).toHaveTextContent('1/3 plan awaiting review');
    expect(chip.querySelector('.ui-dot-paused')).toBeNull();
    expect(chip.querySelector('.ui-dot')).not.toBeNull();
  });

  it('is a button named by its reading, aria-pressed as told', () => {
    const { rerender } = render(<PlanReviewChip tallies={[blocked, under]} projectValue={null} pressed={false} onToggle={() => {}} />);
    const button = screen.getByRole('button', { name: '3 plans awaiting review · tick blocked in alpha' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    rerender(<PlanReviewChip tallies={[blocked, under]} projectValue={null} pressed onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: '3 plans awaiting review · tick blocked in alpha' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onToggle once per click', async () => {
    const onToggle = jest.fn();
    render(<PlanReviewChip tallies={[under]} projectValue={null} pressed={false} onToggle={onToggle} />);
    await userEvent.click(screen.getByTestId('plan-review-chip'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('draws nothing with no tallies, whatever pressed says', () => {
    const { container } = render(<PlanReviewChip tallies={[]} projectValue={null} pressed onToggle={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('BoardView and plan review', () => {
  const PROJECTS: ProjectSummary[] = [
    {
      name: 'alpha',
      path: '/abs/alpha',
      createdAt: '2026-08-26T00:00:00.000Z',
      missing: false,
      counts: { bugs: 0, ideas: 0, tasks: 1, refactors: 0, 'out-of-scope': 0 },
      source: 'files',
      repo: null,
      polledAt: null,
      access: null,
      detail: null,
      interval: null
    }
  ];
  const AGENTS_STATUS: AgentsStatus = {
    enabled: true,
    reachable: true,
    remoteAnswer: true,
    spawnAvailable: true,
    spawnMaxPermission: 'auto',
    projectPaths: ['/abs/alpha']
  };
  const MARKED: BacklogItem = {
    id: '#41',
    title: 'a reviewed plan',
    created: daysAgoDate(2),
    tags: [],
    updated: '',
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    section: 'tasks',
    status: 'open',
    project: 'alpha',
    projectPath: '/abs/alpha',
    groomed: true,
    started: '',
    path: 'gh:futin/x#41',
    source: 'github',
    url: 'https://github.com/futin/x/issues/41',
    assignee: null,
    untyped: false,
    planReview: true
  };
  const TICKS: TicksPayload = {
    config: { haltAfter: 3, maxPlans: 3, maxPrs: 2, source: 'default' },
    projects: [
      {
        root: '/abs/alpha',
        name: 'alpha',
        lock: null,
        recent: [],
        lastDecide: { at: new Date().toISOString(), verdict: 'idle', caps: { openPrs: 0, maxPrs: 3, planReview: 1, maxPlans: 1 } }
      }
    ]
  };

  const realFetch = global.fetch;
  let items: BacklogItem[];
  let posts: { url: string; body: unknown }[];

  beforeEach(() => {
    items = [MARKED];
    posts = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        // The server lifts the label; the board's next read carries the item without it.
        items = items.map(({ planReview: _gone, ...rest }) => rest);
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: '#41', planReview: false }) } as Response);
      }
      const payload: unknown = url.includes('/api/agents/status')
        ? AGENTS_STATUS
        : url.includes('/api/orchestrator/runs')
          ? ({ runs: [], starting: [], remote: [], remoteStarting: [] } satisfies OrchestratorRunsPayload)
          : url.includes('/api/projects')
            ? PROJECTS
            : url.includes('/api/ticks')
              ? TICKS
              : url.includes('/api/items/body')
                ? null
                : { items, errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload), text: () => Promise.resolve('## Plan\n\nthe plan') } as Response);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    localStorage.clear();
  });

  // All projects is the band's default scope, which sums counts and names the blocked project — the cap itself is the title's.
  it('reads the tick’s cap in the band', async () => {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByTestId('plan-review-chip')).toHaveTextContent('1 plan awaiting review · tick blocked in alpha'));
    expect(screen.getByTestId('plan-review-chip')).toHaveAttribute('title', 'alpha: 1/1');
  });

  it('opens the item from the card’s Review plan, and after Approve the modal draws the fresh item', async () => {
    render(<BoardView />);
    await userEvent.click(await screen.findByTestId('review-plan'));
    const approve = await screen.findByTestId('plan-approve');
    await userEvent.click(approve);
    await userEvent.click(screen.getByTestId('plan-approve-confirm-accept'));

    await waitFor(() => expect(screen.getByTestId('plan-approved')).toBeInTheDocument());
    expect(posts).toEqual([{ url: '/api/items/plan-review', body: { project: '/abs/alpha', id: '#41', planReview: false } }]);
    // The re-read landed: the band has nothing to say, the card offers execute again, and the modal's chip no longer gives the plan-review reason.
    await waitFor(() => expect(screen.queryByTestId('plan-review-chip')).toBeNull());
    expect(screen.queryByTestId('review-plan')).toBeNull();
    const modalChip = within(document.querySelector('.item-facts-dispatch') as HTMLElement).getByRole('button', { name: 'execute' });
    expect(modalChip.getAttribute('title') ?? '').not.toContain('this plan awaits review');
  });
});

/**
 * #387 — the `Awaiting review` filter: the band chip and the Filters panel's `Plan review` chip are two hands on one `useState` in BoardView, which narrows
 * the board to `awaitsPlanReview` items, composes with project, status and search, counts in the badge, is cleared by Clear all, and is never persisted.
 */
describe('BoardView plan-review filter', () => {
  const project = (name: string): ProjectSummary => ({
    name,
    path: `/abs/${name}`,
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
    source: 'files',
    repo: null,
    polledAt: null,
    access: null,
    detail: null,
    interval: null
  });
  const card = (name: string, id: string, title: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
    id,
    title,
    created: daysAgoDate(2),
    tags: [],
    updated: '',
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    section: 'tasks',
    status: 'open',
    project: name,
    projectPath: `/abs/${name}`,
    groomed: true,
    started: '',
    path: `gh:futin/${name}${id}`,
    source: 'github',
    url: `https://github.com/futin/${name}/issues/${id.slice(1)}`,
    assignee: null,
    untyped: false,
    ...over
  });
  // Five open items in alpha, two of them awaiting review (a bug and a task), and one done task that still carries the mark.
  const ALPHA: BacklogItem[] = [
    card('alpha', '#1', 'marked bug', { section: 'bugs', planReview: true }),
    card('alpha', '#2', 'marked task', { planReview: true }),
    card('alpha', '#3', 'plain task one'),
    card('alpha', '#4', 'plain task two'),
    card('alpha', '#5', 'plain bug', { section: 'bugs' }),
    card('alpha', '#6', 'done marked task', { status: 'done', planReview: true })
  ];

  const realFetch = global.fetch;
  let projects: ProjectSummary[];
  let items: BacklogItem[];

  beforeEach(() => {
    projects = [project('alpha')];
    items = ALPHA;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload: unknown = url.includes('/api/agents/status')
        ? ({ enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto', projectPaths: projects.map((p) => p.path) } satisfies AgentsStatus)
        : url.includes('/api/orchestrator/runs')
          ? ({ runs: [], starting: [], remote: [], remoteStarting: [] } satisfies OrchestratorRunsPayload)
          : url.includes('/api/projects')
            ? projects
            : url.includes('/api/ticks')
              ? ({ config: { haltAfter: 3, maxPlans: 3, maxPrs: 2, source: 'default' }, projects: [] } satisfies TicksPayload)
              : { items, errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    localStorage.clear();
  });

  const titles = (): string[] => Array.from(document.querySelectorAll('.board-card-title'), (el) => el.textContent ?? '').sort();
  const ALL_OPEN = ['marked bug', 'marked task', 'plain bug', 'plain task one', 'plain task two'];
  const MARKED_OPEN = ['marked bug', 'marked task'];
  const panelChip = (): HTMLElement =>
    within(within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('group', { name: 'Plan review' })).getByRole('button', {
      name: 'Awaiting review'
    });

  it('the band chip narrows to the open plan-review cards, and a second click restores the board', async () => {
    render(<BoardView />);
    const chip = await screen.findByTestId('plan-review-chip');
    await waitFor(() => expect(titles()).toEqual(ALL_OPEN));

    await userEvent.click(chip);
    expect(titles()).toEqual(MARKED_OPEN);
    expect(screen.getByTestId('plan-review-chip')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Filters, 1 set' })).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('plan-review-chip'));
    expect(titles()).toEqual(ALL_OPEN);
    expect(screen.getByTestId('plan-review-chip')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('the panel’s Awaiting review chip is the same state as the band chip', async () => {
    render(<BoardView />);
    await screen.findByTestId('plan-review-chip');
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(panelChip()).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(panelChip());
    expect(titles()).toEqual(MARKED_OPEN);
    expect(panelChip()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-review-chip')).toHaveAttribute('aria-pressed', 'true');
  });

  it('with Status Done it is honestly empty, and says so', async () => {
    render(<BoardView />);
    await userEvent.click(await screen.findByTestId('plan-review-chip'));
    await pickStatus('Done');
    expect(titles()).toEqual([]);
    expect(screen.getByText('no plans awaiting review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filters, 2 set' })).toBeInTheDocument();
  });

  it('Clear all turns it off along with the status', async () => {
    render(<BoardView />);
    await userEvent.click(await screen.findByTestId('plan-review-chip'));
    await pickStatus('Done');
    await clearFilters();
    expect(panelChip()).toHaveAttribute('aria-pressed', 'false');
    expect(within(within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('group', { name: 'Status' })).getByRole('button', { pressed: true })).toHaveTextContent(
      'Open'
    );
    expect(titles()).toEqual(ALL_OPEN);
  });

  it('composes with the search, which is never counted', async () => {
    render(<BoardView />);
    await userEvent.click(await screen.findByTestId('plan-review-chip'));
    await userEvent.type(screen.getByLabelText('Search items'), 'marked bug');
    expect(titles()).toEqual(['marked bug']);
    expect(screen.getByRole('button', { name: 'Filters, 1 set' })).toBeInTheDocument();
  });

  it('leaves the picked project as it is', async () => {
    projects = [project('alpha'), project('beta')];
    items = [...ALPHA, card('beta', '#7', 'beta marked', { planReview: true }), card('beta', '#8', 'beta plain')];
    render(<BoardView />);
    await screen.findByTestId('plan-review-chip');
    await pickProject('beta');
    await userEvent.click(screen.getByTestId('plan-review-chip'));
    expect(titles()).toEqual(['beta marked']);
    // The click outside closed the panel; reopen it to read the pick.
    if (screen.queryByRole('dialog', { name: 'Filters' }) === null) await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    expect(
      within(within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('group', { name: 'Project' })).getByRole('button', { pressed: true })
    ).toHaveTextContent('beta');
  });

  it('is not persisted: a remount starts with it off, and it writes no storage key', async () => {
    const { unmount } = render(<BoardView />);
    await screen.findByTestId('plan-review-chip');
    const keys = Object.keys(localStorage).sort();
    await userEvent.click(screen.getByTestId('plan-review-chip'));
    expect(titles()).toEqual(MARKED_OPEN);
    unmount();

    render(<BoardView />);
    await waitFor(() => expect(titles()).toEqual(ALL_OPEN));
    expect(screen.getByTestId('plan-review-chip')).toHaveAttribute('aria-pressed', 'false');
    expect(Object.keys(localStorage).sort()).toEqual(keys);
  });
});
