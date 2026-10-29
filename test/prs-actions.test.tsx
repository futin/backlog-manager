/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { PrActions } from '../client/src/components/github/PrActions';
import { PrOutcomeLine } from '../client/src/components/github/PrOutcomeLine';
import type { PrRepoView, PrWriteResult, PullRequestRow } from '../shared/types';

/**
 * The shared PR actions strip and outcome line (`.claude/DESIGN.md` §8.11; spec `2026-10-29-prs-layouts-design.md`, Inbox's compact keys and "Writes and
 * outcomes"). `PrActions` is rendered directly with an `onWrite` that awaits the call it is handed, as the page does, so the call really POSTs through
 * `prs-api` and the stub `fetch` records it. What must hold: the compact keys front the SAME writes (one POST each, to the same routes), `Merge…` never
 * merges by itself, a disabled key says why in visible text, and a write in flight disables every key.
 */

const SHA = 'a'.repeat(40);

function pr(over: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: 5,
    title: 'title 5',
    url: 'https://github.com/futin/x/pull/5',
    author: 'ana',
    draft: false,
    head: 'feature/5',
    headSha: SHA,
    base: 'main',
    crossRepository: false,
    maintainerCanModify: true,
    updatedAt: '2026-10-29T11:59:00Z',
    mergeable: 'mergeable',
    mergeState: 'clean',
    review: null,
    checks: 'success',
    autoMerge: null,
    canUpdateBranch: true,
    ...over
  };
}

const REPO: PrRepoView = {
  repo: 'futin/x',
  polledAt: '2026-10-29T11:59:50Z',
  access: 'ok',
  detail: null,
  syncOff: null,
  methods: ['squash', 'merge'],
  autoMergeAllowed: true,
  prs: [],
  total: 0,
  truncated: false
};

const OK: PrWriteResult = { ok: true, outcome: 'update-requested', pr: null, reread: true };

let posts: { url: string; body: unknown }[];
let release: (() => void) | null;

beforeEach(() => {
  posts = [];
  release = null;
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(OK) } as Response);
  }) as unknown as typeof fetch;
});

/** An `onWrite` as the page gives one: it awaits the call, then resolves. `hold` keeps the write in flight until `release()`. */
function writer(hold = false) {
  return jest.fn(async (call: () => Promise<PrWriteResult>): Promise<void> => {
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    await call();
  });
}

describe('PrActions — compact', () => {
  it('puts Update branch first on a behind PR and sends the one update-branch POST when clicked', async () => {
    const user = userEvent.setup();
    const onWrite = writer();
    render(<PrActions repo={REPO} pr={pr({ mergeState: 'behind' })} onWrite={onWrite} variant="compact" />);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Update branch');
    expect(screen.getByRole('button', { name: 'Merge…' })).toBeInTheDocument();
    await user.click(buttons[0]);
    expect(posts).toEqual([{ url: '/api/prs/update-branch', body: { repo: 'futin/x', number: 5, headSha: SHA } }]);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it('opens the full strip on Merge… and POSTs nothing until the Confirm is accepted', async () => {
    const user = userEvent.setup();
    render(<PrActions repo={REPO} pr={pr()} onWrite={writer()} variant="compact" />);
    expect(screen.queryByRole('combobox', { name: 'Merge method' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Merge…' }));
    expect(screen.getByRole('combobox', { name: 'Merge method' })).toBeInTheDocument();
    expect(posts).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(screen.getByTestId('pr-merge-confirm')).toHaveTextContent('Merge #5 into main (squash)?');
    expect(posts).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    await user.click(within(screen.getByTestId('pr-merge-confirm')).getByRole('button', { name: 'Merge' }));
    expect(posts).toEqual([{ url: '/api/prs/merge', body: { repo: 'futin/x', number: 5, method: 'squash', headSha: SHA } }]);
  });

  it('shows Merge… disabled with its reason as visible text on a failing-checks PR, and never opens the strip', async () => {
    const user = userEvent.setup();
    render(<PrActions repo={REPO} pr={pr({ checks: 'failure' })} onWrite={writer()} variant="compact" />);
    const merge = screen.getByRole('button', { name: 'Merge…' });
    expect(merge).toBeDisabled();
    expect(screen.getByText('checks failing')).toBeVisible();
    expect(merge).toHaveAccessibleDescription('checks failing');
    await user.click(merge);
    expect(screen.queryByRole('combobox', { name: 'Merge method' })).not.toBeInTheDocument();
  });

  it('fills the primary key ink and leaves the rest outline, and offers Open ↗ in a new tab', () => {
    render(<PrActions repo={REPO} pr={pr({ mergeState: 'behind' })} onWrite={writer()} variant="compact" />);
    expect(screen.getByRole('button', { name: 'Update branch' })).toHaveClass('ui-chip-ink');
    expect(screen.getByRole('button', { name: 'Merge…' })).not.toHaveClass('ui-chip-ink');
    const link = screen.getByRole('link', { name: 'Open ↗' });
    expect(link).toHaveAttribute('href', 'https://github.com/futin/x/pull/5');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('disables every key while a write is in flight and frees them when it lands', async () => {
    const user = userEvent.setup();
    render(<PrActions repo={REPO} pr={pr({ mergeState: 'behind' })} onWrite={writer(true)} variant="compact" />);
    await user.click(screen.getByRole('button', { name: 'Update branch' }));
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    await act(async () => {
      release?.();
    });
    expect(screen.getByRole('button', { name: 'Update branch' })).toBeEnabled();
    expect(posts).toHaveLength(1);
  });
});

describe('PrActions — full', () => {
  it('draws the method select, Merge, auto-merge and Update branch and no Open link', () => {
    render(<PrActions repo={REPO} pr={pr({ mergeState: 'behind' })} onWrite={writer()} variant="full" />);
    expect(screen.getByRole('combobox', { name: 'Merge method' })).toBeInTheDocument();
    for (const name of ['Merge', 'Enable auto-merge', 'Update branch']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open ↗' })).not.toBeInTheDocument();
  });
});

describe('PrOutcomeLine', () => {
  it('renders nothing for an updating outcome once the mark has expired, and nothing for no outcome', () => {
    const { container, rerender } = render(<PrOutcomeLine outcome={{ kind: 'updating', text: 'updating…' }} updating={false} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PrOutcomeLine outcome={undefined} updating={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an updating outcome while it is updating, and an error in the error class', () => {
    const { rerender } = render(<PrOutcomeLine outcome={{ kind: 'updating', text: 'updating…' }} updating />);
    expect(screen.getByRole('status')).toHaveTextContent('updating…');
    rerender(<PrOutcomeLine outcome={{ kind: 'error', text: 'GitHub said no' }} updating={false} />);
    expect(screen.getByTestId('pr-outcome')).toHaveClass('prs-outcome-error');
  });
});
