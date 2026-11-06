/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { PrInbox } from '../client/src/components/github/PrInbox';
import type { PrLayoutProps } from '../client/src/components/github/pr-layout-props';
import { prRunWarning } from '../client/src/lib/pr-run';
import { mainOf, moreOf, openOf, menuRow } from './helpers/pr-keys';
import type { OrchestratorRun, ProjectSummary, PrRepoView, PullRequestRow, RunQueueItem } from '../shared/types';

/**
 * GitHub › PRs, Inbox layout (`.claude/DESIGN.md` §8.11; specs `2026-10-29-prs-layouts-design.md`, "Inbox" and "Writes and outcomes", and
 * `2026-10-30-prs-page-fixes-design.md`, "Inbox"). `PrInbox` is rendered with fixture props and a `jest.fn` write — or, for every case that opens a Confirm,
 * inside `Harness`, which holds the confirming key the way the page does. What must hold: the tiles count and filter, the order is the rank's, a filter that a
 * re-read empties says so, a row is keyed by `<repo>#<number>` (two repos' `#7`, and a Confirm that survives a re-render), every row — loud or quiet — carries
 * the same four keys, its why-line and its foot, and a repo whose read failed keeps its rows and gets a `Can't read` line below the list.
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
    checksDetail: null,
    ...over
  };
}

/**
 * The page's half of the Confirm, mirrored: the confirming key is state here, `Merge` sets it, and `write` clears it when it names the writing row before the
 * call runs, so a Confirm is gone before its POST is answered. `confirming-key` shows the state for the cases that assert it went back to `null`.
 */
function Harness(p: Omit<PrLayoutProps, 'confirming' | 'setConfirming'>) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const write: PrLayoutProps['write'] = (key, sha, call) => {
    if (confirming === key) setConfirming(null);
    return p.write(key, sha, call);
  };
  return (
    <>
      <output data-testid="confirming-key">{confirming ?? ''}</output>
      <PrInbox {...p} write={write} confirming={confirming} setConfirming={setConfirming} />
    </>
  );
}

/** `props(...)` without the confirming pair, for `Harness`. */
function hp(repos: PrRepoView[], over: Partial<PrLayoutProps> = {}) {
  const { confirming: _c, setConfirming: _s, ...rest } = props(repos, over);
  return rest;
}

/** The keys column of a row, and its split Merge's main half — the Confirm's own accept is also named `Merge`, so the half is always found in the column. */
const keysOf = (row: HTMLElement) => row.querySelector('.prs-keys-side') as HTMLElement;
const mergeKey = (row: HTMLElement) => mainOf(keysOf(row));

const EMPTY_CTX: PrLayoutProps['ctx'] = { projects: [], items: [], runs: [], remote: [], remoteStarting: [] };

function props(repos: PrRepoView[], over: Partial<PrLayoutProps> = {}): PrLayoutProps {
  return {
    repos,
    outcomes: {},
    marks: {},
    now: NOW,
    ctx: EMPTY_CTX,
    write: jest.fn(() => Promise.resolve()),
    inFlight: new Set(),
    confirming: null,
    setConfirming: jest.fn(),
    ...over
  };
}

/** A failing, a behind and a clean PR on one repo — one per tile. */
const failing = pr({ number: 1, title: 'failing one', checks: 'failure' });
const behind = pr({ number: 2, title: 'behind one', mergeState: 'behind', url: 'https://github.com/a/x/pull/2' });
const clean = pr({ number: 3, title: 'clean one', url: 'https://github.com/a/x/pull/3' });
const trio = () => repo('a/x', [clean, behind, failing]);

describe('PrInbox — tiles, order and filter', () => {
  it('counts one PR in each level and lists failing, then behind, then the quiet line', () => {
    render(<PrInbox {...props([trio()])} />);
    const triage = screen.getByRole('group', { name: 'Triage' });
    expect(triage).toHaveClass('ui-seg-track');
    expect(within(triage).getAllByRole('button').map((b) => b.textContent)).toEqual(['Needs you 1', 'Worth a look 1', 'Quiet 1']);
    const order = ['pr-row-a/x#1', 'pr-row-a/x#2', 'pr-row-a/x#3'].map((id) => screen.getByTestId(id));
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(order[0].querySelector('.prs-chips') as HTMLElement).getByText('checks failing')).toBeInTheDocument();
  });

  it('filters on a tile and clears on a second click', async () => {
    const user = userEvent.setup();
    render(<PrInbox {...props([trio()])} />);
    const tile = screen.getByRole('button', { name: /^Needs you \d/ });
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    await user.click(tile);
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('pr-row-a/x#1')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-row-a/x#2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pr-row-a/x#3')).not.toBeInTheDocument();
    await user.click(tile);
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('pr-row-a/x#2')).toBeInTheDocument();
    expect(screen.getByTestId('pr-row-a/x#3')).toBeInTheDocument();
  });

  it('says No pull request at this level. when a re-read leaves the selected level empty', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PrInbox {...props([trio()])} />);
    await user.click(screen.getByRole('button', { name: /^Needs you \d/ }));
    rerender(<PrInbox {...props([repo('a/x', [clean, behind, pr({ number: 1, title: 'failing one' })])])} />);
    expect(screen.getByText('No pull request at this level.')).toBeInTheDocument();
    const tile = screen.getByRole('button', { name: 'Needs you 0' });
    expect(tile).toHaveAttribute('aria-pressed', 'true');
  });

  it('says no open pull requests when no shown repo has a PR, and not the filter sentence', () => {
    render(<PrInbox {...props([repo('a/x', [])])} />);
    expect(screen.getByText('no open pull requests')).toBeInTheDocument();
    expect(screen.queryByText('No pull request at this level.')).not.toBeInTheDocument();
  });

  it('does not claim no open pull requests while a shown repo could not be read, and draws no tiles over nothing', () => {
    render(<PrInbox {...props([repo('a/x', []), repo('a/y', [], { access: 'rate-limited', detail: 'slow down' })])} />);
    expect(screen.queryByText('no open pull requests')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Triage' })).not.toBeInTheDocument();
    expect(screen.getByTestId('pr-cantread-a/y')).toHaveTextContent("Can't read · a/y — slow down");
  });
});

describe('PrInbox — items', () => {
  it('draws author, branches and age, and ghost for a deleted account', () => {
    render(<PrInbox {...props([repo('a/x', [failing, pr({ number: 4, author: null, checks: 'failure', mergeable: 'conflicting' })])])} />);
    const item = screen.getByTestId('pr-row-a/x#1');
    expect(item).toHaveTextContent('ana');
    expect(item).toHaveTextContent('feature/1 → main');
    expect(item).toHaveTextContent('1h ago');
    expect(screen.getByTestId('pr-row-a/x#4')).toHaveTextContent('ghost');
  });

  it('draws the checks tile in the checks tone, the neutral one when there are none', () => {
    const rows = [
      pr({ number: 11, checks: 'failure' }),
      pr({ number: 12, checks: 'pending' }),
      pr({ number: 13, checks: 'success' }),
      pr({ number: 14, checks: 'none' })
    ];
    render(<PrInbox {...props([repo('a/x', rows)])} />);
    const tone = (n: number) => screen.getByTestId(`pr-row-a/x#${n}`).querySelector('.ui-glyph-tile');
    expect(tone(11)).toHaveAttribute('data-tone', 'red');
    expect(tone(12)).toHaveAttribute('data-tone', 'amber');
    expect(tone(13)).toHaveAttribute('data-tone', 'green');
    expect(tone(14)).toHaveAttribute('data-tone', 'neutral');
    expect(tone(11)).toHaveAttribute('data-size', '40');
  });

  it('draws the facts as pills and no verdict, steps or quiet-facts line', () => {
    render(<PrInbox {...props([repo('a/x', [pr({ number: 6, checks: 'failure', review: 'approved', mergeState: 'behind' })])])} />);
    const item = screen.getByTestId('pr-row-a/x#6');
    const pills = within(item.querySelector('.prs-chips') as HTMLElement);
    for (const label of ['checks failing', 'behind base', 'approved']) expect(pills.getByText(label)).toBeInTheDocument();
    expect(item.querySelector('.prs-inbox-verdict, .prs-inbox-steps, .prs-inbox-facts')).toBeNull();
    expect(within(item).queryByText('Checks are failing.')).not.toBeInTheDocument();
  });

  it('leads the checks and mergeability pills with a glyph, and draws none on a pill that is only text', () => {
    const rows = [
      pr({ number: 21, checks: 'failure' }),
      pr({ number: 22, checks: 'success' }),
      pr({ number: 23, checks: 'pending' }),
      pr({ number: 24, mergeable: 'conflicting' }),
      pr({ number: 25, mergeState: 'behind' })
    ];
    render(<PrInbox {...props([repo('a/x', rows)])} />);
    const pill = (n: number, label: string) => within(screen.getByTestId(`pr-row-a/x#${n}`)).getByText(label, { selector: '.ui-pill' });
    expect(pill(21, 'checks failing').querySelector('svg')).not.toBeNull();
    expect(pill(22, 'checks passing').querySelector('svg')).not.toBeNull();
    expect(pill(23, 'checks pending').querySelector('svg')).not.toBeNull();
    expect(pill(24, 'conflicts').querySelector('svg')).not.toBeNull();
    expect(pill(25, 'behind base').querySelector('svg')).toBeNull();
  });

  it('puts the pills and the meta in one container, so they wrap as one line, and the run warning stays at its end', () => {
    render(<PrInbox {...props([repo('a/x', [pr({ number: 31, checks: 'failure' })])])} />);
    const line = screen.getByTestId('pr-row-a/x#31').querySelector('.prs-line') as HTMLElement;
    expect(line.querySelector('.prs-chips')).not.toBeNull();
    expect(line.querySelector('.prs-meta')).not.toBeNull();
    // Pills first, then the meta: the order the eye reads, and the only DOM order that wraps them as one flow.
    expect(Array.from(line.children).map((el) => el.className)).toEqual(['prs-chips', 'prs-meta']);
  });

  it('names a PR\'s repo at the start of the meta line, short, and the full owner/name only where two shown repos share a short one', () => {
    const { unmount } = render(<PrInbox {...props([repo('futin/backlog-manager', [pr({ number: 41 })]), repo('futin/timify-web', [pr({ number: 42 })])])} />);
    const meta = (n: number, name: string) => screen.getByTestId(`pr-row-${name}#${n}`).querySelector('.prs-meta') as HTMLElement;
    expect(meta(41, 'futin/backlog-manager').firstElementChild).toHaveTextContent(/^backlog-manager$/);
    expect(meta(42, 'futin/timify-web').firstElementChild).toHaveTextContent(/^timify-web$/);
    // The name is no longer beside the title.
    expect(screen.getByTestId('pr-row-futin/timify-web#42').querySelector('.prs-row-title .prs-inbox-repo')).toBeNull();
    unmount();

    render(<PrInbox {...props([repo('acme/ui-kit', [pr({ number: 43 })]), repo('futin/ui-kit', [pr({ number: 43 })])])} />);
    expect(meta(43, 'acme/ui-kit').firstElementChild).toHaveTextContent(/^acme\/ui-kit$/);
    expect(meta(43, 'futin/ui-kit').firstElementChild).toHaveTextContent(/^futin\/ui-kit$/);
  });

  it('draws an armed auto-merge as a tinted done pill, not the solid live fill', () => {
    render(<PrInbox {...props([repo('a/x', [pr({ number: 51, autoMerge: { method: 'squash', enabledAt: '2026-10-29T09:00:00Z' } })])])} />);
    const pill = within(screen.getByTestId('pr-row-a/x#51')).getByText('auto-merge · squash');
    expect(pill).toHaveClass('ui-pill-done');
    expect(pill).not.toHaveClass('ui-pill-live');
  });

  it('draws two repos each with #7, keyed apart', () => {
    render(<PrInbox {...props([repo('a/x', [pr({ number: 7, checks: 'failure' })]), repo('a/y', [pr({ number: 7, checks: 'failure' })])])} />);
    expect(screen.getByTestId('pr-row-a/x#7')).toBeInTheDocument();
    expect(screen.getByTestId('pr-row-a/y#7')).toBeInTheDocument();
  });

  it('keeps an open Confirm on a/y#7 when a/x#7, ranked ahead of it, leaves the list', async () => {
    const user = userEvent.setup();
    // Both are loud; a/y#7 has a missing review rather than red checks, because red checks block Merge. a/x#7 is newer, so it ranks first.
    const ax = pr({ number: 7, checks: 'failure', updatedAt: '2026-10-29T11:30:00Z', url: 'https://github.com/a/x/pull/7' });
    const ay = pr({ number: 7, review: 'review-required', url: 'https://github.com/a/y/pull/7' });
    const { rerender } = render(<Harness {...hp([repo('a/x', [ax]), repo('a/y', [ay])])} />);
    expect(screen.getAllByTestId(/^pr-row-/).map((el) => el.getAttribute('data-testid'))).toEqual(['pr-row-a/x#7', 'pr-row-a/y#7']);
    const row = () => screen.getByTestId('pr-row-a/y#7');
    await user.click(mergeKey(row()));
    expect(within(row()).getByTestId('pr-merge-confirm')).toBeInTheDocument();
    rerender(<Harness {...hp([repo('a/x', []), repo('a/y', [{ ...ay }])])} />);
    expect(screen.queryByTestId('pr-row-a/x#7')).not.toBeInTheDocument();
    expect(within(row()).getByTestId('pr-merge-confirm')).toBeInTheDocument();
  });

  it('hands the page its write keyed by <repo>#<number> and the PR head', async () => {
    const user = userEvent.setup();
    const write = jest.fn(() => Promise.resolve());
    render(<PrInbox {...props([repo('a/x', [behind])], { write })} />);
    await user.click(menuRow(keysOf(screen.getByTestId('pr-row-a/x#2')), 'Update branch'));
    expect(write).toHaveBeenCalledWith('a/x#2', SHA, expect.any(Function));
  });

  it('draws an outcome line under a loud and under a quiet row', () => {
    render(
      <PrInbox {...props([trio()], { outcomes: { 'a/x#1': { text: 'auto-merge armed', kind: 'ok' }, 'a/x#3': { text: 'auto-merge off', kind: 'ok' } } })} />
    );
    expect(within(screen.getByTestId('pr-row-a/x#1')).getByTestId('pr-outcome')).toHaveTextContent('auto-merge armed');
    expect(within(screen.getByTestId('pr-row-a/x#3')).getByTestId('pr-outcome')).toHaveTextContent('auto-merge off');
  });
});

describe('PrInbox — one row vocabulary', () => {
  const KEYS = ['Merge', 'Open on GitHub'];
  /** The strip is the split Merge and the Open link, named by their labels (not the face, which reads `Blocked` on a loud row) minus the PR's `#n`. */
  const keyNames = (row: HTMLElement) =>
    [mainOf(keysOf(row)), openOf(keysOf(row))].map((el) => (el.getAttribute('aria-label') ?? '').replace(/ #\d+/, ''));

  it('draws the same strip on a loud row and on a quiet one, and a quiet row has no toggle', () => {
    render(<PrInbox {...props([trio()])} />);
    const loud = screen.getByTestId('pr-row-a/x#1');
    const quiet = screen.getByTestId('pr-row-a/x#3');
    expect(keyNames(loud)).toEqual(KEYS);
    expect(keyNames(quiet)).toEqual(KEYS);
    // The row's text block has exactly one link, `#n`; `Open ↗` is the keys column's.
    const main = quiet.querySelector('.prs-row-main') as HTMLElement;
    expect(
      within(main)
        .getAllByRole('link')
        .map((a) => a.textContent)
    ).toEqual(['#3']);
    // A row is not a toggle; the only `aria-expanded` here is the split Merge's chevron.
    expect(document.querySelector('[aria-expanded]:not(.ui-split-more)')).toBeNull();
    expect(within(quiet).queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });

  it('draws a why-line only when a repo reason holds', () => {
    const { unmount } = render(<PrInbox {...props([repo('a/x', [clean], { autoMergeAllowed: false })])} />);
    expect(screen.getByTestId('pr-row-a/x#3').querySelector('.prs-why')).toHaveTextContent('auto-merge not enabled on the repo');
    unmount();
    render(<PrInbox {...props([repo('a/x', [clean])])} />);
    expect(screen.getByTestId('pr-row-a/x#3').querySelector('.prs-why')).toBeNull();
  });

  it('says updating… on the why-line once a later outcome replaced the updating one, and only on the outcome line while it has not', () => {
    const marks = { 'a/x#2': { sha: SHA } };
    const { unmount } = render(<PrInbox {...props([trio()], { marks, outcomes: { 'a/x#2': { text: 'auto-merge armed', kind: 'ok' } } })} />);
    let row = screen.getByTestId('pr-row-a/x#2');
    expect(row.querySelector('.prs-why')).toHaveTextContent(/^updating…$/);
    expect(within(row).getByTestId('pr-outcome')).toHaveTextContent('auto-merge armed');
    unmount();
    render(<PrInbox {...props([trio()], { marks, outcomes: { 'a/x#2': { text: 'updating…', kind: 'updating' } } })} />);
    row = screen.getByTestId('pr-row-a/x#2');
    expect(row.querySelector('.prs-why')).toBeNull();
    expect(within(row).getByTestId('pr-outcome')).toHaveTextContent('updating…');
  });

  it('draws both the updating… reason and an error that landed during the mark (Review Focus 5)', () => {
    const marks = { 'a/x#2': { sha: SHA } };
    render(<PrInbox {...props([trio()], { marks, outcomes: { 'a/x#2': { text: 'refused', kind: 'error' } } })} />);
    const row = screen.getByTestId('pr-row-a/x#2');
    expect(row.querySelector('.prs-why')).toHaveTextContent(/^updating…$/);
    const outcome = within(row).getByTestId('pr-outcome');
    expect(outcome).toHaveTextContent('refused');
    expect(outcome).toHaveClass('prs-outcome-error');
  });

  it('draws the run warning of a loud row as one pill on its meta line, after author · head → base · age, and not as a step', () => {
    const runPr = pr({ number: 9, author: 'futin', head: 'backlog/42', checks: 'failure', updatedAt: '2026-10-29T10:00:00Z' });
    const runCtx: PrLayoutProps['ctx'] = {
      ...EMPTY_CTX,
      projects: [{ name: 'x', path: '/p/x', repo: 'a/x' }] as unknown as ProjectSummary[],
      runs: [
        {
          runId: 'r1',
          project: '/p/x',
          status: 'running',
          base: 'main',
          queue: [{ id: '42', title: 't', stage: 'pending' } as RunQueueItem]
        } as OrchestratorRun
      ]
    };
    render(<PrInbox {...props([repo('a/x', [runPr])], { ctx: runCtx })} />);
    const row = screen.getByTestId('pr-row-a/x#9');
    const meta = row.querySelector('.prs-meta') as HTMLElement;
    // The separators are their own spans, spaced by the flex gap, so the line is read part by part.
    expect(Array.from(meta.children).map((el) => el.textContent)).toEqual([
      'x',
      '·',
      'futin',
      '·',
      'backlog/42 → main',
      '·',
      '2h ago',
      'run in progress on this machine'
    ]);
    expect(within(row).getAllByText('run in progress on this machine')).toHaveLength(1);
  });

  it("opens one Confirm on the page, in the second row's foot under its text and not in its keys column", async () => {
    const user = userEvent.setup();
    const one = pr({ number: 5, review: 'review-required', url: 'https://github.com/a/x/pull/5' });
    const two = pr({ number: 6, review: 'review-required', url: 'https://github.com/a/x/pull/6', updatedAt: '2026-10-29T10:00:00Z' });
    render(<Harness {...hp([repo('a/x', [one, two])])} />);
    await user.click(mergeKey(screen.getByTestId('pr-row-a/x#5')));
    const second = screen.getByTestId('pr-row-a/x#6');
    await user.click(mergeKey(second));
    expect(screen.getAllByTestId('pr-merge-confirm')).toHaveLength(1);
    const confirm = screen.getByTestId('pr-merge-confirm');
    expect(second.querySelector('.prs-row-main')).toContainElement(confirm);
    expect(keysOf(second)).not.toContainElement(confirm);
  });

  it('opens the Confirm under a/x#7 alone when a/y#7 is listed too (Review Focus 4)', async () => {
    const user = userEvent.setup();
    const ax = pr({ number: 7, review: 'review-required', url: 'https://github.com/a/x/pull/7', headSha: 'b'.repeat(40) });
    const ay = pr({ number: 7, review: 'review-required', url: 'https://github.com/a/y/pull/7', headSha: 'c'.repeat(40) });
    render(<Harness {...hp([repo('a/x', [ax]), repo('a/y', [ay])])} />);
    await user.click(mergeKey(screen.getByTestId('pr-row-a/x#7')));
    expect(screen.getAllByTestId('pr-merge-confirm')).toHaveLength(1);
    expect(within(screen.getByTestId('pr-row-a/x#7')).getByTestId('pr-merge-confirm')).toBeInTheDocument();
    expect(within(screen.getByTestId('pr-row-a/y#7')).queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
  });

  it('keeps an open Confirm on its quiet row when a newer quiet PR is ranked ahead of it', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness {...hp([repo('a/x', [clean])])} />);
    await user.click(mergeKey(screen.getByTestId('pr-row-a/x#3')));
    expect(within(screen.getByTestId('pr-row-a/x#3')).getByTestId('pr-merge-confirm')).toBeInTheDocument();
    // #8 is clean and newer, so it ranks first and #3 moves from index 0 to index 1: an index key would hand #3's Confirm to #8's row.
    const newer = pr({ number: 8, title: 'newer clean', updatedAt: '2026-10-29T11:30:00Z', url: 'https://github.com/a/x/pull/8' });
    rerender(<Harness {...hp([repo('a/x', [{ ...newer }, { ...clean }])])} />);
    expect(screen.getAllByTestId(/^pr-row-/).map((el) => el.getAttribute('data-testid'))).toEqual(['pr-row-a/x#8', 'pr-row-a/x#3']);
    expect(within(screen.getByTestId('pr-row-a/x#3')).getByTestId('pr-merge-confirm')).toBeInTheDocument();
    expect(screen.getAllByTestId('pr-merge-confirm')).toHaveLength(1);
  });

  it('closes the Confirm when a tile filter hides its row', async () => {
    const user = userEvent.setup();
    render(<Harness {...hp([trio()])} />);
    await user.click(mergeKey(screen.getByTestId('pr-row-a/x#3')));
    expect(screen.getByTestId('confirming-key')).toHaveTextContent('a/x#3');
    await user.click(screen.getByRole('button', { name: /^Needs you \d/ }));
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('confirming-key')).toHaveTextContent(/^$/);
    // Cleared, not hidden: lifting the filter does not bring it back.
    await user.click(screen.getByRole('button', { name: /^Needs you \d/ }));
    await act(async () => {});
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
  });

  it('carries the run warning in a clean PR on a branch a run still holds, as a quiet row', () => {
    const runPr = pr({ number: 9, head: 'backlog/42', review: 'approved', url: 'https://github.com/a/x/pull/9' });
    const runCtx: PrLayoutProps['ctx'] = {
      ...EMPTY_CTX,
      projects: [{ name: 'x', path: '/p/x', repo: 'a/x' }] as unknown as ProjectSummary[],
      runs: [
        {
          runId: 'r1',
          project: '/p/x',
          status: 'running',
          base: 'main',
          queue: [{ id: '42', title: 't', stage: 'pending' } as RunQueueItem]
        } as OrchestratorRun
      ]
    };
    const warning = prRunWarning(runPr, 'a/x', runCtx, NOW);
    expect(warning).toBe('run in progress on this machine');
    render(<PrInbox {...props([repo('a/x', [runPr])], { ctx: runCtx })} />);
    const row = screen.getByTestId('pr-row-a/x#9');
    expect(row.querySelector('.prs-meta')).toHaveTextContent(warning as string);
    expect(row).toHaveTextContent('approved');
    expect(screen.getByRole('button', { name: 'Quiet 1' })).toBeInTheDocument();
  });
});

describe('PrInbox — notes above and below the list', () => {
  it('draws departed outcomes above the list', () => {
    render(<PrInbox {...props([trio()], { outcomes: { 'a/x#12': { text: 'merged', kind: 'ok' } } })} />);
    const departed = screen.getByText('a/x#12 merged');
    expect(departed.compareDocumentPosition(screen.getByTestId('pr-row-a/x#1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps a rate-limited repo ranked with its rows and draws Can't read and showing N of M below the list, with no heading", () => {
    render(
      <PrInbox
        {...props([
          repo('a/x', [failing], { access: 'rate-limited', detail: 'rate limited until 12:30' }),
          repo('a/y', [pr({ number: 4, url: 'https://github.com/a/y/pull/4' })], { total: 150, truncated: true })
        ])}
      />
    );
    const row = screen.getByTestId('pr-row-a/x#1');
    const cantRead = screen.getByTestId('pr-cantread-a/x');
    const truncated = screen.getByTestId('pr-truncated-a/y');
    expect(cantRead).toHaveTextContent("Can't read · a/x — rate limited until 12:30");
    expect(truncated).toHaveTextContent('a/y: showing 1 of 150');
    expect(row.compareDocumentPosition(cantRead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(truncated) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('heading', { name: "Can't read" })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Needs you 1' })).toBeInTheDocument();
  });

  it("says a sync-off repo's sentence once above the list and sync off on each of its rows' why-lines", () => {
    const sentence = 'sync is off for a/x — turn it on in GitHub › Settings';
    render(<PrInbox {...props([repo('a/x', [clean, behind], { syncOff: sentence })])} />);
    expect(screen.getAllByText(sentence)).toHaveLength(1);
    for (const id of ['pr-row-a/x#2', 'pr-row-a/x#3']) {
      expect(screen.getByTestId(id).querySelector('.prs-why')).toHaveTextContent(/^sync off$/);
    }
  });
});
