/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { ItemModal } from '../client/src/components/board/ItemModal';
import { buildProjectHues } from '../client/src/lib/project-hue';
import { daysAgoDate, daysAgoStamp } from './helpers/dates';
import { CLAIM_STALE_MS } from '../shared/types';
import type { AgentsStatus, BacklogItem, DashboardsView, ItemHolder, OrchestratorRunsPayload, ProjectSummary, RemoteStarting } from '../shared/types';

/**
 * Multi-dashboard task 10 — which machine a card or a run is on, driven through the real `BoardView` (the board's own wiring is what is under test: the
 * dashboards view, the runs payload's `remoteStarting` and the item list meeting on one card). The pure derivations are pinned beside their modules
 * (`tracker-lib`, `runs-list`, `board-run-chip`); the Runs page's rows are `runs-view.test.tsx`'s.
 *
 * Fixture dates are relative to the clock the assertion runs under: a heartbeat is `Date.now()` minus an offset, never a literal, because `claimReading`
 * compares it against the reader's clock.
 */

const VIEW: DashboardsView = {
  source: 'file',
  file: '/x/dashboards.json',
  home: { label: 'Home', url: 'http://127.0.0.1:4310', account: null, models: [], efforts: [], tokenVar: 'BM_AGENTS_TOKEN', tokenSet: false },
  dashboards: [
    { name: 'Pro', url: 'http://pro:4310', bmUrl: 'http://pro:4322', host: 'pro-mac', tokenVar: 'BM_AGENTS_TOKEN_PRO', tokenSet: true, models: [], efforts: [] }
  ],
  order: ['home', 'Pro'],
  strategy: 'prefer',
  threshold: 80
};

const PROJECTS: ProjectSummary[] = [
  {
    name: 'alpha',
    path: '/abs/alpha',
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: false,
    counts: { bugs: 2, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
    source: 'github',
    repo: 'futin/x',
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

function bug(id: string, title: string, holder?: ItemHolder): BacklogItem {
  return {
    id,
    title,
    created: daysAgoDate(2),
    started: '',
    tags: [],
    updated: daysAgoStamp(0),
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    section: 'bugs',
    status: 'open',
    project: 'alpha',
    projectPath: '/abs/alpha',
    groomed: false,
    path: `gh:futin/x${id}`,
    source: 'github',
    url: `https://github.com/futin/x/issues/${id.slice(1)}`,
    assignee: null,
    untyped: false,
    ...(holder === undefined ? {} : { holder })
  };
}

const HUES = buildProjectHues([{ name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z' }]);

const beat = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  localStorage.clear();
});

function stub(items: BacklogItem[], remoteStarting: RemoteStarting[] = []): void {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const payload: unknown = url.includes('/api/agents/status')
      ? AGENTS_STATUS
      : url.includes('/api/orchestrator/runs')
        ? ({ runs: [], starting: [], remote: [], remoteStarting } satisfies OrchestratorRunsPayload)
        : url.includes('/api/dashboards')
          ? VIEW
          : url.includes('/api/projects')
            ? PROJECTS
            : { items, errors: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  }) as unknown as typeof fetch;
}

async function renderBoard(): Promise<void> {
  render(<BoardView />);
  await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
}

/** The marker row of the card carrying `title`. */
function markersOf(title: string): HTMLElement | null {
  return screen.getByText(title).closest('.board-card')!.querySelector('[data-testid="marker-row"]');
}

describe('the card says which machine holds it', () => {
  it('draws running on <machine> for a live claim whose host a remote owns', async () => {
    stub([bug('#31', 'remote work', { session: 's', host: 'pro-mac', heartbeat: beat(60_000) })]);
    await renderBoard();
    await waitFor(() => expect(within(markersOf('remote work')!).getByText('running on Pro')).toBeInTheDocument());
  });

  it('draws nothing for a stale claim, a run-held claim, an unowned host or a hand claim on this machine', async () => {
    stub([
      bug('#31', 'stale one', { session: 's', host: 'pro-mac', heartbeat: beat(CLAIM_STALE_MS + 60_000) }),
      bug('#32', 'run held', { session: 's', host: 'pro-mac', heartbeat: beat(60_000), run: 'run-9' }),
      bug('#33', 'elsewhere', { session: 's', host: 'laptop', heartbeat: beat(60_000) })
    ]);
    await renderBoard();
    // The dashboards view has landed once any card could have drawn the badge; wait on the view's own fetch, then assert the absence.
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/dashboards'));
    await screen.findByText('elsewhere');
    expect(screen.queryByText(/running on/)).toBeNull();
  });
});

describe('a launch still starting on another machine', () => {
  const dispatch: RemoteStarting = { kind: 'dispatch', project: '/abs/alpha', machine: 'Pro', itemId: '#31', requestedAt: '2026-10-22T10:00:00.000Z' };
  const orchestrate: RemoteStarting = { kind: 'orchestrate', project: '/abs/alpha', machine: 'Pro', itemId: null, requestedAt: '2026-10-22T10:00:00.000Z' };

  it('puts Starting on <machine> on the card it dispatched, and on no other card', async () => {
    stub([bug('#31', 'being started'), bug('#32', 'bystander')], [dispatch]);
    await renderBoard();
    await waitFor(() => expect(within(markersOf('being started')!).getByText('Starting on Pro')).toBeInTheDocument());
    expect(screen.getAllByText('Starting on Pro')).toHaveLength(1);
  });

  it('puts Starting on <machine> on the run chip for an orchestrate launch, with no run behind it', async () => {
    stub([bug('#31', 'a bug')], [orchestrate]);
    await renderBoard();
    await waitFor(() => expect(screen.getByTestId('run-chip')).toHaveTextContent('Starting on Pro'));
    expect(screen.getByTestId('run-chip')).not.toHaveTextContent('1 starting');
  });

  it('leaves the chip off for a card dispatch — the chip is about runs', async () => {
    stub([bug('#31', 'a bug')], [dispatch]);
    await renderBoard();
    await waitFor(() => expect(within(markersOf('a bug')!).getByText('Starting on Pro')).toBeInTheDocument());
    expect(screen.queryByTestId('run-chip')).toBeNull();
  });

  it('falls back to the machine id when it is not a configured remote', async () => {
    stub([bug('#31', 'a bug')], [{ ...orchestrate, machine: 'Mini' }]);
    await renderBoard();
    await waitFor(() => expect(screen.getByTestId('run-chip')).toHaveTextContent('Starting on Mini'));
  });
});

describe('Stop & release for a claim on a remote machine', () => {
  const held = (host: string): BacklogItem => bug('#31', 'held', { session: 'b1c2d3e4-5555-6666-7777-888899990000', host, heartbeat: beat(60_000) });

  it('is offered once the holder host is one a remote owns, though the board never flagged it dispatched', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('body') } as Response)) as unknown as typeof fetch;
    render(<ItemModal item={held('pro-mac')} hues={HUES} onClose={() => {}} onReleased={() => {}} remoteHosts={new Set(['pro-mac'])} />);
    await screen.findByText('body');
    expect(screen.getByTestId('claim-release')).toHaveTextContent('Stop & release');
    await userEvent.click(screen.getByTestId('claim-release'));
    expect(screen.getByTestId('claim-release-confirm-accept')).toHaveTextContent('Stop & release');
  });

  it('stays the plain Release claim for a host no remote owns, and with no remoteHosts at all', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('body') } as Response)) as unknown as typeof fetch;
    const { rerender } = render(<ItemModal item={held('laptop')} hues={HUES} onClose={() => {}} onReleased={() => {}} remoteHosts={new Set(['pro-mac'])} />);
    await screen.findByText('body');
    expect(screen.getByTestId('claim-release')).toHaveTextContent('Release claim');

    rerender(<ItemModal item={held('pro-mac')} hues={HUES} onClose={() => {}} onReleased={() => {}} />);
    expect(screen.getByTestId('claim-release')).toHaveTextContent('Release claim');
  });
});
