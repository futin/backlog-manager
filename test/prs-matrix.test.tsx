/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { PrMatrix } from '../client/src/components/github/PrMatrix';
import type { PrLayoutProps } from '../client/src/components/github/pr-layout-props';
import { prRunWarning } from '../client/src/lib/pr-run';
import type { OrchestratorRun, ProjectSummary, PrRepoView, PullRequestRow, RunQueueItem } from '../shared/types';

/**
 * GitHub › PRs, Matrix layout (`.claude/DESIGN.md` §8.11; spec `2026-10-29-prs-layouts-design.md`, "Matrix" and "Writes and outcomes"). `PrMatrix` is rendered with
 * fixture props and a `jest.fn` write. What must hold: the header counts the rows whose cell is a problem, a cell reports its own fact whatever the row's rank,
 * one row's expansion is open at a time and is UNMOUNTED (not hidden) when it closes, a click on a link or control inside a row never toggles, every element is
 * keyed by `<repo>#<number>`, an outcome line is visible while its row is collapsed, and a repo whose read failed keeps its rows and adds one muted row.
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
  return { repos, outcomes: {}, marks: {}, now: NOW, ctx: EMPTY_CTX, write: jest.fn(() => Promise.resolve()), inFlight: new Set(), ...over };
}

/** One failing, one behind, one clean PR on one repo. */
const failing = pr({ number: 1, title: 'failing one', checks: 'failure' });
const behind = pr({ number: 2, title: 'behind one', mergeState: 'behind', url: 'https://github.com/a/x/pull/2' });
const clean = pr({ number: 3, title: 'clean one', url: 'https://github.com/a/x/pull/3' });
const trio = () => repo('a/x', [clean, behind, failing]);

const row = (key: string) => screen.getByTestId(`pr-mrow-${key}`);
const rowIds = () => screen.getAllByTestId(/^pr-mrow-/).map((el) => el.getAttribute('data-testid'));

describe('PrMatrix — header, cells and order', () => {
  it('shows a count on a header only when some row has a problem in that column', () => {
    render(<PrMatrix {...props([trio()])} />);
    expect(screen.getByRole('columnheader', { name: 'Checks 1' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Base 1' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Mergeable' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Auto-merge' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Updated' })).toBeInTheDocument();
  });

  it('draws rows in rank order: failing, then behind, then clean', () => {
    render(<PrMatrix {...props([trio()])} />);
    expect(rowIds()).toEqual(['pr-mrow-a/x#1', 'pr-mrow-a/x#2', 'pr-mrow-a/x#3']);
  });

  it('draws the PR column: link, title, repo · head → base, draft pill and the age', () => {
    render(<PrMatrix {...props([repo('a/x', [pr({ number: 5, title: 'a draft', draft: true })])])} />);
    const r = row('a/x#5');
    expect(within(r).getByRole('link', { name: '#5' })).toHaveAttribute('href', 'https://github.com/a/x/pull/1');
    expect(r).toHaveTextContent('a draft');
    expect(r).toHaveTextContent('a/x · feature/1 → main');
    expect(within(r).getByText('draft')).toBeInTheDocument();
    expect(r).toHaveTextContent('1h ago');
  });

  it('gives a draft with failing checks a failing cell while it stays ranked with the quiet rows', () => {
    const draft = pr({ number: 4, title: 'wip', draft: true, checks: 'failure', updatedAt: '2026-10-29T11:59:00Z' });
    render(<PrMatrix {...props([repo('a/x', [draft, clean, behind])])} />);
    // The draft is the newest PR, but a draft is Quiet: it ranks after the behind PR, with the clean one.
    expect(rowIds()).toEqual(['pr-mrow-a/x#2', 'pr-mrow-a/x#4', 'pr-mrow-a/x#3']);
    expect(within(row('a/x#4')).getByText('failing')).toHaveClass('prs-cell-bad');
    expect(screen.getByRole('columnheader', { name: 'Checks 1' })).toBeInTheDocument();
  });

  it('puts each fact in its own tone class', () => {
    render(<PrMatrix {...props([repo('a/x', [pr({ number: 6, review: 'approved', autoMerge: { method: 'squash', enabledAt: '2026-10-29T10:00:00Z' } })])])} />);
    const r = row('a/x#6');
    expect(within(r).getByText('passing')).toHaveClass('prs-cell-ok');
    expect(within(r).getByText('approved')).toHaveClass('prs-cell-ok');
    expect(within(r).getByText('squash')).toHaveClass('prs-cell-live');
    expect(within(r).queryAllByText('—')).toHaveLength(0);
  });

  it('shows updating… in the Base cell while a mark holds, in place of behind', () => {
    const marks = { 'a/x#2': { sha: SHA, until: NOW + 10_000 } };
    render(<PrMatrix {...props([repo('a/x', [behind])], { marks })} />);
    expect(within(row('a/x#2')).getByText('updating…')).toHaveClass('prs-cell-live');
    expect(within(row('a/x#2')).queryByText('behind')).not.toBeInTheDocument();
    // The header counts facts, not motion (`columnCounts`): the marked row is still behind, so the header keeps its `1` from the click to the re-read.
    expect(screen.getByRole('columnheader', { name: 'Base 1' })).toBeInTheDocument();
  });

  it('names the five tones in a legend under the table', () => {
    render(<PrMatrix {...props([trio()])} />);
    const legend = screen.getByTestId('pr-matrix-legend');
    for (const word of ['healthy', 'needs you', 'worth a look', 'in motion', 'not applicable']) expect(legend).toHaveTextContent(word);
  });

  it('says no open pull requests when no shown repo has a PR', () => {
    render(<PrMatrix {...props([repo('a/x', [])])} />);
    expect(screen.getByText('no open pull requests')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('PrMatrix — the expansion', () => {
  it('opens the PR actions under a row on click and reaches the merge confirm through Merge', async () => {
    const user = userEvent.setup();
    render(<PrMatrix {...props([repo('a/x', [clean])])} />);
    expect(screen.queryByTestId('pr-expand-a/x#3')).not.toBeInTheDocument();
    await user.click(row('a/x#3'));
    expect(row('a/x#3')).toHaveAttribute('aria-expanded', 'true');
    const expansion = screen.getByTestId('pr-expand-a/x#3');
    expect(within(expansion).getByRole('link', { name: 'Open on GitHub ↗' })).toHaveAttribute('href', 'https://github.com/a/x/pull/3');
    await user.click(within(expansion).getByRole('button', { name: 'Merge' }));
    expect(within(expansion).getByTestId('pr-merge-confirm')).toBeInTheDocument();
  });

  it('closes the first expansion when a second row opens, and UNMOUNTS it with its Confirm', async () => {
    const user = userEvent.setup();
    render(<PrMatrix {...props([repo('a/x', [clean, pr({ number: 8, url: 'https://github.com/a/x/pull/8' })])])} />);
    await user.click(row('a/x#3'));
    await user.click(within(screen.getByTestId('pr-expand-a/x#3')).getByRole('button', { name: 'Merge' }));
    expect(screen.getByTestId('pr-merge-confirm')).toBeInTheDocument();
    await user.click(row('a/x#8'));
    expect(screen.queryByTestId('pr-expand-a/x#3')).not.toBeInTheDocument();
    expect(row('a/x#3')).toHaveAttribute('aria-expanded', 'false');
    // Unmounted, not hidden: a Confirm left in a hidden subtree would still sit on useDialogEscape's stack.
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('pr-expand-a/x#8')).toBeInTheDocument();
  });

  it('toggles closed on a second click of the same row', async () => {
    const user = userEvent.setup();
    render(<PrMatrix {...props([repo('a/x', [clean])])} />);
    await user.click(row('a/x#3'));
    await user.click(row('a/x#3'));
    expect(screen.queryByTestId('pr-expand-a/x#3')).not.toBeInTheDocument();
  });

  it('toggles on Enter and on Space of a focused row, and Space does not scroll', async () => {
    const user = userEvent.setup();
    render(<PrMatrix {...props([repo('a/x', [clean])])} />);
    const r = row('a/x#3');
    expect(r).toHaveAttribute('tabindex', '0');
    r.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('pr-expand-a/x#3')).toBeInTheDocument();
    await user.keyboard(' ');
    expect(screen.queryByTestId('pr-expand-a/x#3')).not.toBeInTheDocument();
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      r.dispatchEvent(space);
    });
    expect(space.defaultPrevented).toBe(true);
  });

  it('does not toggle on a click on the #n link, nor on Enter pressed on that link', async () => {
    const user = userEvent.setup();
    render(<PrMatrix {...props([repo('a/x', [clean])])} />);
    const link = within(row('a/x#3')).getByRole('link', { name: '#3' });
    link.addEventListener('click', (e) => e.preventDefault());
    await user.click(link);
    expect(screen.queryByTestId('pr-expand-a/x#3')).not.toBeInTheDocument();
    link.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('pr-expand-a/x#3')).not.toBeInTheDocument();
  });

  it('does not toggle on a click inside the expansion', async () => {
    const user = userEvent.setup();
    render(<PrMatrix {...props([repo('a/x', [clean])])} />);
    await user.click(row('a/x#3'));
    const expansion = screen.getByTestId('pr-expand-a/x#3');
    await user.click(within(expansion).getByRole('combobox', { name: 'Merge method' }));
    expect(screen.getByTestId('pr-expand-a/x#3')).toBeInTheDocument();
  });

  it('expands a/x#7 and a/y#7 independently', async () => {
    const user = userEvent.setup();
    const ax = pr({ number: 7, checks: 'failure', url: 'https://github.com/a/x/pull/7' });
    const ay = pr({ number: 7, review: 'review-required', url: 'https://github.com/a/y/pull/7' });
    render(<PrMatrix {...props([repo('a/x', [ax]), repo('a/y', [ay])])} />);
    await user.click(row('a/y#7'));
    expect(screen.getByTestId('pr-expand-a/y#7')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-expand-a/x#7')).not.toBeInTheDocument();
    expect(row('a/x#7')).toHaveAttribute('aria-expanded', 'false');
  });

  it('hands the page its write keyed by <repo>#<number> and the PR head', async () => {
    const user = userEvent.setup();
    const write = jest.fn(() => Promise.resolve());
    render(<PrMatrix {...props([repo('a/x', [behind])], { write })} />);
    await user.click(row('a/x#2'));
    await user.click(within(screen.getByTestId('pr-expand-a/x#2')).getByRole('button', { name: 'Update branch' }));
    expect(write).toHaveBeenCalledWith('a/x#2', SHA, expect.any(Function));
  });
});

describe('PrMatrix — keys', () => {
  it('keeps the open expansion, and its Confirm, on a/y#7 when a/x#7, ranked ahead of it, leaves the list', async () => {
    const user = userEvent.setup();
    const ax = pr({ number: 7, checks: 'failure', updatedAt: '2026-10-29T11:30:00Z', url: 'https://github.com/a/x/pull/7' });
    const ay = pr({ number: 7, review: 'review-required', url: 'https://github.com/a/y/pull/7' });
    const { rerender } = render(<PrMatrix {...props([repo('a/x', [ax]), repo('a/y', [ay])])} />);
    expect(rowIds()).toEqual(['pr-mrow-a/x#7', 'pr-mrow-a/y#7']);
    await user.click(row('a/y#7'));
    await user.click(within(screen.getByTestId('pr-expand-a/y#7')).getByRole('button', { name: 'Merge' }));
    expect(screen.getByTestId('pr-merge-confirm')).toBeInTheDocument();
    rerender(<PrMatrix {...props([repo('a/x', []), repo('a/y', [{ ...ay }])])} />);
    expect(screen.queryByTestId('pr-mrow-a/x#7')).not.toBeInTheDocument();
    expect(row('a/y#7')).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByTestId('pr-expand-a/y#7')).getByTestId('pr-merge-confirm')).toBeInTheDocument();
  });

  it('keeps the same DOM row for a PR whose position shifts across a re-render', () => {
    const { rerender } = render(<PrMatrix {...props([trio()])} />);
    const before = row('a/x#3');
    // The clean PR gains failing checks and moves from last to first.
    rerender(<PrMatrix {...props([repo('a/x', [pr({ number: 3, title: 'clean one', checks: 'failure', updatedAt: '2026-10-29T11:59:00Z' }), behind, failing])])} />);
    expect(rowIds()).toEqual(['pr-mrow-a/x#3', 'pr-mrow-a/x#1', 'pr-mrow-a/x#2']);
    expect(row('a/x#3')).toBe(before);
  });
});

describe('PrMatrix — outcomes, run warning and failing repos', () => {
  it('draws an outcome under its row while the row is collapsed, outside the expansion', async () => {
    const user = userEvent.setup();
    render(<PrMatrix {...props([trio()], { outcomes: { 'a/x#3': { text: 'auto-merge off', kind: 'ok' } } })} />);
    expect(screen.getByTestId('pr-outcome')).toHaveTextContent('auto-merge off');
    expect(row('a/x#3').nextElementSibling).toContainElement(screen.getByTestId('pr-outcome'));
    await user.click(row('a/x#3'));
    expect(screen.getByTestId('pr-expand-a/x#3')).not.toContainElement(screen.getByTestId('pr-outcome'));
  });

  it('draws no extra row for a PR with no outcome line', () => {
    render(<PrMatrix {...props([repo('a/x', [clean])])} />);
    expect(row('a/x#3').nextElementSibling).toBeNull();
  });

  it('draws the outcome of a PR a write took off the list above the table', () => {
    render(<PrMatrix {...props([trio()], { outcomes: { 'a/x#12': { text: 'merged', kind: 'ok' } } })} />);
    expect(screen.getByText('a/x#12 merged')).toBeInTheDocument();
  });

  it('draws the truncated note below the table', () => {
    render(<PrMatrix {...props([repo('a/x', [clean], { truncated: true, total: 90 })])} />);
    expect(screen.getByTestId('pr-truncated-a/x')).toHaveTextContent('a/x: showing 1 of 90');
  });

  it('puts the run warning in the PR column sub-line', () => {
    const runPr = pr({ number: 9, head: 'backlog/42', review: 'approved', url: 'https://github.com/a/x/pull/9' });
    const ctx: PrLayoutProps['ctx'] = {
      ...EMPTY_CTX,
      projects: [{ name: 'x', path: '/p/x', repo: 'a/x' }] as unknown as ProjectSummary[],
      runs: [{ runId: 'r1', project: '/p/x', status: 'running', base: 'main', queue: [{ id: '42', title: 't', stage: 'pending' } as RunQueueItem] } as OrchestratorRun]
    };
    expect(prRunWarning(runPr, 'a/x', ctx, NOW)).toBe('run in progress on this machine');
    render(<PrMatrix {...props([repo('a/x', [runPr])], { ctx })} />);
    expect(row('a/x#9')).toHaveTextContent('run in progress on this machine');
  });

  it('keeps a rate-limited repo’s rows AND draws one muted row with its detail', () => {
    const limited = repo('a/x', [failing, clean], { access: 'rate-limited', detail: 'GitHub rate limit reached' });
    render(<PrMatrix {...props([limited])} />);
    expect(rowIds()).toEqual(['pr-mrow-a/x#1', 'pr-mrow-a/x#3']);
    const fail = screen.getByTestId('pr-mfail-a/x');
    expect(fail).toHaveTextContent('a/x');
    expect(fail).toHaveTextContent('GitHub rate limit reached');
    expect(fail.firstElementChild).toBeEmptyDOMElement();
    // The detail spans the check columns.
    expect(fail.querySelector('td[colspan="5"]')).toHaveTextContent('GitHub rate limit reached');
  });

  it('draws only the muted row for a failing repo that holds no PR, and no empty-state sentence for it', () => {
    render(<PrMatrix {...props([repo('a/x', [clean]), repo('a/y', [], { access: 'error', detail: 'boom' })])} />);
    expect(screen.getByTestId('pr-mfail-a/y')).toHaveTextContent('boom');
    expect(screen.queryByText('no open pull requests')).not.toBeInTheDocument();
  });

  it('still draws the table (not the empty sentence) when the only shown repo failed', () => {
    render(<PrMatrix {...props([repo('a/y', [], { access: 'rate-limited', detail: 'slow down' })])} />);
    expect(screen.getByTestId('pr-mfail-a/y')).toHaveTextContent('slow down');
  });
});
