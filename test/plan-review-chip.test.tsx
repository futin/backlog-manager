/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { PlanReviewChip } from '../client/src/components/board/PlanReviewChip';
import { daysAgoDate } from './helpers/dates';
import type { AgentsStatus, BacklogItem, OrchestratorRunsPayload, ProjectSummary, TicksPayload } from '../shared/types';

/**
 * #367 — the band's plan-review reading, and the board half of Approve: the card's `Review plan` opens the item, and after an approval the open modal
 * draws the FRESH item from the re-read payload rather than the snapshot it was opened on.
 */
describe('PlanReviewChip', () => {
  const blocked = { projectPath: '/abs/alpha', name: 'alpha', count: 2, cap: 2, blocked: true };
  const under = { projectPath: '/abs/beta', name: 'beta', count: 1, cap: 3, blocked: false };

  it('draws nothing when there is nothing to say', () => {
    const { container } = render(<PlanReviewChip tallies={[]} projectValue={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('paints the paused dot while a project in scope is at its cap, and titles every project', () => {
    render(<PlanReviewChip tallies={[blocked, under]} projectValue={null} />);
    const chip = screen.getByTestId('plan-review-chip');
    expect(chip).toHaveTextContent('3 plans awaiting review · tick blocked in alpha');
    expect(chip.querySelector('.ui-dot-paused')).not.toBeNull();
    expect(chip).toHaveAttribute('title', 'alpha: 2/2\nbeta: 1/3');
  });

  it('draws a toneless dot when the project in scope is under its cap', () => {
    render(<PlanReviewChip tallies={[blocked, under]} projectValue="/abs/beta" />);
    const chip = screen.getByTestId('plan-review-chip');
    expect(chip).toHaveTextContent('1/3 plan awaiting review');
    expect(chip.querySelector('.ui-dot-paused')).toBeNull();
    expect(chip.querySelector('.ui-dot')).not.toBeNull();
  });

  it('is a reading, not a control', () => {
    render(<PlanReviewChip tallies={[under]} projectValue={null} />);
    expect(within(screen.getByTestId('plan-review-chip').parentElement!).queryByRole('button')).toBeNull();
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
    config: { haltAfter: 3, source: 'default' },
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
