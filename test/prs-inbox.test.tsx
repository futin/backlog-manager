/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { PrInbox } from '../client/src/components/github/PrInbox';
import type { PrLayoutProps } from '../client/src/components/github/pr-layout-props';
import { prRunWarning } from '../client/src/lib/pr-run';
import type { OrchestratorRun, ProjectSummary, PrRepoView, PullRequestRow, RunQueueItem } from '../shared/types';

/**
 * GitHub › PRs, Inbox layout (`.claude/DESIGN.md` §8.11; spec `2026-10-29-prs-layouts-design.md`, "Inbox" and "Writes and outcomes"). `PrInbox` is rendered with
 * fixture props and a `jest.fn` write. What must hold: the tiles count and filter, the order is the rank's, a filter that a re-read empties says so, an item
 * is keyed by `<repo>#<number>` (two repos' `#7`, and a Confirm that survives a re-render), a quiet line's actions are one click away, and a repo whose read
 * failed keeps its rows and adds a `Can't read` line.
 */

const NOW = Date.parse('2026-10-29T12:00:00Z');
const SHA = 'a'.repeat(40);

function pr(over: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: 1,
    title: 'title 1',
    url: 'https://github.com/a/x/pull/1',
    author: 'ana',
    draft: false,
    head: 'feature/1',
    headSha: SHA,
    base: 'main',
    crossRepository: false,
    maintainerCanModify: true,
    updatedAt: '2026-10-29T11:00:00Z',
    mergeable: 'mergeable',
    mergeState: 'clean',
    review: null,
    checks: 'success',
    autoMerge: null,
    canUpdateBranch: true,
    ...over
  };
}

function repo(name: string, prs: PullRequestRow[], over: Partial<PrRepoView> = {}): PrRepoView {
  return {
    repo: name,
    polledAt: '2026-10-29T11:59:50Z',
    access: 'ok',
    detail: null,
    syncOff: null,
    methods: ['squash', 'merge'],
    autoMergeAllowed: true,
    prs,
    total: prs.length,
    truncated: false,
    ...over
  };
}

const EMPTY_CTX: PrLayoutProps['ctx'] = { projects: [], items: [], runs: [], remote: [], remoteStarting: [] };

function props(repos: PrRepoView[], over: Partial<PrLayoutProps> = {}): PrLayoutProps {
  return { repos, outcomes: {}, marks: {}, now: NOW, ctx: EMPTY_CTX, write: jest.fn(() => Promise.resolve()), ...over };
}

/** A failing, a behind and a clean PR on one repo — one per tile. */
const failing = pr({ number: 1, title: 'failing one', checks: 'failure' });
const behind = pr({ number: 2, title: 'behind one', mergeState: 'behind', url: 'https://github.com/a/x/pull/2' });
const clean = pr({ number: 3, title: 'clean one', url: 'https://github.com/a/x/pull/3' });
const trio = () => repo('a/x', [clean, behind, failing]);

describe('PrInbox — tiles, order and filter', () => {
  it('counts one PR in each level and lists failing, then behind, then the quiet line', () => {
    render(<PrInbox {...props([trio()])} />);
    expect(screen.getByTestId('pr-tile-needs-you')).toHaveTextContent('1 Needs you');
    expect(screen.getByTestId('pr-tile-worth-a-look')).toHaveTextContent('1 Worth a look');
    expect(screen.getByTestId('pr-tile-quiet')).toHaveTextContent('1 Quiet');
    const order = ['pr-item-a/x#1', 'pr-item-a/x#2', 'pr-quiet-a/x#3'].map((id) => screen.getByTestId(id));
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(order[0]).getByText('Checks are failing.')).toBeInTheDocument();
  });

  it('filters on a tile and clears on a second click', async () => {
    const user = userEvent.setup();
    render(<PrInbox {...props([trio()])} />);
    const tile = screen.getByRole('button', { name: /Needs you/ });
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    await user.click(tile);
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('pr-item-a/x#1')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-item-a/x#2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pr-quiet-a/x#3')).not.toBeInTheDocument();
    await user.click(tile);
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('pr-item-a/x#2')).toBeInTheDocument();
    expect(screen.getByTestId('pr-quiet-a/x#3')).toBeInTheDocument();
  });

  it('says No pull request at this level. when a re-read leaves the selected level empty', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PrInbox {...props([trio()])} />);
    await user.click(screen.getByRole('button', { name: /Needs you/ }));
    rerender(<PrInbox {...props([repo('a/x', [clean, behind, pr({ number: 1, title: 'failing one' })])])} />);
    expect(screen.getByText('No pull request at this level.')).toBeInTheDocument();
    expect(screen.getByTestId('pr-tile-needs-you')).toHaveTextContent('0 Needs you');
    expect(screen.getByTestId('pr-tile-needs-you')).toHaveAttribute('aria-pressed', 'true');
  });

  it('says no open pull requests when no shown repo has a PR, and not the filter sentence', () => {
    render(<PrInbox {...props([repo('a/x', [])])} />);
    expect(screen.getByText('no open pull requests')).toBeInTheDocument();
    expect(screen.queryByText('No pull request at this level.')).not.toBeInTheDocument();
  });
});

describe('PrInbox — items', () => {
  it('draws author, branches and age, and ghost for a deleted account', () => {
    render(<PrInbox {...props([repo('a/x', [failing, pr({ number: 4, author: null, checks: 'failure', mergeable: 'conflicting' })])])} />);
    const item = screen.getByTestId('pr-item-a/x#1');
    expect(item).toHaveTextContent('ana');
    expect(item).toHaveTextContent('feature/1 → main');
    expect(item).toHaveTextContent('1h ago');
    expect(screen.getByTestId('pr-item-a/x#4')).toHaveTextContent('ghost');
  });

  it('draws the problems after the verdict as steps', () => {
    render(<PrInbox {...props([repo('a/x', [pr({ number: 6, checks: 'failure', review: 'approved' })])])} />);
    const item = screen.getByTestId('pr-item-a/x#6');
    expect(within(item).getByText('Checks are failing.')).toBeInTheDocument();
    expect(within(item).getByText('Approved.')).toHaveClass('prs-inbox-step-calm');
  });

  it('draws two repos each with #7, keyed apart', () => {
    render(<PrInbox {...props([repo('a/x', [pr({ number: 7, checks: 'failure' })]), repo('a/y', [pr({ number: 7, checks: 'failure' })])])} />);
    expect(screen.getByTestId('pr-item-a/x#7')).toBeInTheDocument();
    expect(screen.getByTestId('pr-item-a/y#7')).toBeInTheDocument();
  });

  it('hands the page its write keyed by <repo>#<number> and the PR head', async () => {
    const user = userEvent.setup();
    const write = jest.fn(() => Promise.resolve());
    render(<PrInbox {...props([repo('a/x', [behind])], { write })} />);
    await user.click(within(screen.getByTestId('pr-item-a/x#2')).getByRole('button', { name: 'Update branch' }));
    expect(write).toHaveBeenCalledWith('a/x#2', SHA, expect.any(Function));
  });

  it('draws an outcome for a listed PR under its item, and for a quiet one whether or not the line is open', () => {
    render(
      <PrInbox
        {...props([trio()], { outcomes: { 'a/x#1': { text: 'auto-merge armed', kind: 'ok' }, 'a/x#3': { text: 'auto-merge off', kind: 'ok' } } })}
      />
    );
    expect(within(screen.getByTestId('pr-item-a/x#1')).getByTestId('pr-outcome')).toHaveTextContent('auto-merge armed');
    expect(within(screen.getByTestId('pr-quiet-a/x#3')).getByTestId('pr-outcome')).toHaveTextContent('auto-merge off');
  });

  it('draws the outcome of a PR a write took off the list above the list', () => {
    render(<PrInbox {...props([trio()], { outcomes: { 'a/x#12': { text: 'merged', kind: 'ok' } } })} />);
    expect(screen.getByText('a/x#12 merged')).toBeInTheDocument();
  });
});

describe('PrInbox — the quiet line', () => {
  /** A clean approved PR on `backlog/42` and a run still working item 42 in the repo's project. */
  const runPr = pr({ number: 9, head: 'backlog/42', review: 'approved', url: 'https://github.com/a/x/pull/9' });
  const runCtx: PrLayoutProps['ctx'] = {
    ...EMPTY_CTX,
    projects: [{ name: 'x', path: '/p/x', repo: 'a/x' }] as unknown as ProjectSummary[],
    runs: [{ runId: 'r1', project: '/p/x', status: 'running', base: 'main', queue: [{ id: '42', title: 't', stage: 'pending' } as RunQueueItem] } as OrchestratorRun]
  };

  it('carries the run warning in a clean PR on a branch a run still holds', () => {
    const warning = prRunWarning(runPr, 'a/x', runCtx, NOW);
    expect(warning).toBe('run in progress on this machine');
    render(<PrInbox {...props([repo('a/x', [runPr])], { ctx: runCtx })} />);
    const line = screen.getByTestId('pr-quiet-a/x#9');
    expect(line).toHaveTextContent(warning as string);
    expect(line).toHaveTextContent('approved');
    expect(screen.getByTestId('pr-tile-quiet')).toHaveTextContent('1 Quiet');
  });

  it('keeps the #n link outside the toggle, which opens the compact strip', async () => {
    const user = userEvent.setup();
    render(<PrInbox {...props([repo('a/x', [clean])])} />);
    const line = screen.getByTestId('pr-quiet-a/x#3');
    const toggle = within(line).getByRole('button', { name: 'Actions for #3' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toContainElement(within(line).getByRole('link', { name: '#3' }));
    expect(within(line).queryByRole('button', { name: 'Merge…' })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(line).getByRole('button', { name: 'Merge…' })).toBeVisible();
  });

  it('keeps an open merge Confirm across a re-render with a fresh props object holding the same PR', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PrInbox {...props([repo('a/x', [clean])])} />);
    const line = () => screen.getByTestId('pr-quiet-a/x#3');
    await user.click(within(line()).getByRole('button', { name: 'Actions for #3' }));
    await user.click(within(line()).getByRole('button', { name: 'Merge…' }));
    await user.click(within(line()).getByRole('button', { name: 'Merge' }));
    expect(screen.getByTestId('pr-merge-confirm')).toBeInTheDocument();
    rerender(<PrInbox {...props([repo('a/x', [{ ...clean }])])} />);
    expect(screen.getByTestId('pr-merge-confirm')).toBeInTheDocument();
  });
});

describe('PrInbox — repos that did not read cleanly', () => {
  it("keeps a rate-limited repo ranked with its rows and adds a Can't read line with the detail", () => {
    render(<PrInbox {...props([repo('a/x', [failing], { access: 'rate-limited', detail: 'rate limited until 12:30' })])} />);
    expect(screen.getByTestId('pr-item-a/x#1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "Can't read" })).toBeInTheDocument();
    expect(screen.getByTestId('pr-cantread-a/x')).toHaveTextContent('a/x — rate limited until 12:30');
    expect(screen.getByTestId('pr-tile-needs-you')).toHaveTextContent('1 Needs you');
  });

  it("draws no Can't read heading when every repo read ok", () => {
    render(<PrInbox {...props([trio()])} />);
    expect(screen.queryByRole('heading', { name: "Can't read" })).not.toBeInTheDocument();
  });

  it('says the sync-off sentence once and how many of a truncated repo are shown', () => {
    const sentence = 'sync is off for a/x — turn it on in GitHub › Settings';
    render(<PrInbox {...props([repo('a/x', [clean], { syncOff: sentence, total: 150, truncated: true })])} />);
    expect(screen.getAllByText(sentence)).toHaveLength(1);
    expect(screen.getByText('a/x: showing 1 of 150')).toBeInTheDocument();
  });
});
