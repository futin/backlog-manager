/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ItemModal } from '../../client/src/components/board/ItemModal';
import { ReviewLift } from '../../client/src/components/board/ReviewLift';
import { buildProjectHues } from '../../client/src/lib/project-hue';
import type { BacklogItem } from '../../shared/types';
import { daysAgoDate } from '../helpers/dates';

/**
 * The item modal's Lift review (the in-review-without-PR spec). A tracker item labelled `in-review` with no open PR referencing it — an in-place execute's
 * leftover label, or a PR closed unmerged — can have the label removed here, behind a confirm that first asks this machine (`GET /api/items/held`) whether
 * an `execute/<n>` branch or worktree still holds work. The answer only changes the sentence: Lift is enabled in every state, and only the click writes.
 */
const TRACKER: BacklogItem = {
  id: '#214',
  title: 'stale review',
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
  path: 'gh:futin/x#214',
  source: 'github',
  url: 'https://github.com/futin/x/issues/214',
  assignee: null,
  untyped: false,
  inReview: true,
  inReviewNoPr: true
};
const HUES = buildProjectHues([{ name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z' }]);

const PENDING = 'Checking this machine for execute/214…';
const HELD = 'execute/214 still holds work for #214 on this machine — push it and open a PR instead. Lift anyway?';
const NOT_FOUND =
  'No execute/214 branch or worktree here. Work left uncommitted in a checkout, or on another machine, does not show up — lift only once you know it is gone or pushed.';
const UNKNOWN = 'Could not check this machine for execute/214. Lift only once you know the work is gone or pushed.';

type Answer = { status: number; body: unknown } | 'hang';
let held: Answer;
let post: { status: number; body: unknown };
let gets: string[];
let posts: { url: string; body: unknown }[];

function respond(a: { status: number; body: unknown }): Promise<Response> {
  return Promise.resolve({ ok: a.status < 300, status: a.status, json: () => Promise.resolve(a.body) } as Response);
}

beforeEach(() => {
  gets = [];
  posts = [];
  held = { status: 200, body: { branch: false, tree: false } };
  post = { status: 201, body: { id: '#214', inReview: false } };
  global.fetch = jest.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return respond(post);
    }
    if (url.startsWith('/api/items/held')) {
      gets.push(url);
      return held === 'hang' ? new Promise<Response>(() => {}) : respond(held);
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve('body') } as Response);
  }) as jest.Mock;
});

async function openConfirm(): Promise<void> {
  await userEvent.click(screen.getByTestId('review-lift'));
}

describe('ReviewLift, when it draws', () => {
  it.each([
    ['inReviewNoPr is absent', { ...TRACKER, inReviewNoPr: undefined }],
    ['the item is a files item', { ...TRACKER, source: 'files' as const, url: null }],
    ['the item is done', { ...TRACKER, status: 'done' as const }]
  ])('draws nothing when %s', (_name, item) => {
    render(<ReviewLift item={item as BacklogItem} onLifted={() => {}} />);
    expect(screen.queryByTestId('review-lift')).toBeNull();
  });

  it('draws nothing on a render site with nothing to re-read', () => {
    render(<ReviewLift item={TRACKER} />);
    expect(screen.queryByTestId('review-lift')).toBeNull();
  });

  it('draws the chip with its text and title', () => {
    render(<ReviewLift item={TRACKER} onLifted={() => {}} />);
    const chip = screen.getByTestId('review-lift');
    expect(chip.textContent).toBe('Lift review');
    expect(chip).toHaveAttribute('title', 'remove the in-review label so this item can be executed again');
  });
});

describe('ReviewLift, the confirm asks this machine first', () => {
  it('says it is checking while the read is out, with Lift already enabled', async () => {
    held = 'hang';
    render(<ReviewLift item={TRACKER} onLifted={() => {}} />);
    await openConfirm();
    expect(screen.getByTestId('review-lift-confirm').textContent).toContain(PENDING);
    expect(screen.getByTestId('review-lift-confirm-accept').textContent).toBe('Lift review');
    expect(screen.getByTestId('review-lift-confirm-accept')).toBeEnabled();
    expect(screen.getByTestId('review-lift-confirm-dismiss').textContent).toBe('Keep in review');
  });

  it.each([
    ['a branch', { branch: true, tree: false }],
    ['a worktree', { branch: false, tree: true }],
    ['a worktree beside a branch git could not be asked about', { branch: null, tree: true }]
  ])('warns when %s still holds work', async (_name, body) => {
    held = { status: 200, body };
    render(<ReviewLift item={TRACKER} onLifted={() => {}} />);
    await openConfirm();
    await waitFor(() => expect(screen.getByTestId('review-lift-confirm').textContent).toContain(HELD));
  });

  it('says nothing was found, and what that cannot see', async () => {
    held = { status: 200, body: { branch: false, tree: false } };
    render(<ReviewLift item={TRACKER} onLifted={() => {}} />);
    await openConfirm();
    await waitFor(() => expect(screen.getByTestId('review-lift-confirm').textContent).toContain(NOT_FOUND));
  });

  it.each([
    ['git could not be asked', { status: 200, body: { branch: null, tree: false } }],
    ['the read failed', { status: 500, body: { error: 'boom' } }]
  ])('says it could not check when %s', async (_name, answer) => {
    held = answer;
    render(<ReviewLift item={TRACKER} onLifted={() => {}} />);
    await openConfirm();
    await waitFor(() => expect(screen.getByTestId('review-lift-confirm').textContent).toContain(UNKNOWN));
  });

  it('reads once per opening, with both parameters encoded', async () => {
    const { rerender } = render(<ReviewLift item={TRACKER} onLifted={() => {}} />);
    await openConfirm();
    await waitFor(() => expect(screen.getByTestId('review-lift-confirm').textContent).toContain(NOT_FOUND));
    rerender(<ReviewLift item={{ ...TRACKER }} onLifted={() => {}} />);
    expect(gets).toEqual(['/api/items/held?project=%2Fabs%2Falpha&id=%23214']);
    await userEvent.click(screen.getByTestId('review-lift-confirm-dismiss'));
    await openConfirm();
    await waitFor(() => expect(gets).toHaveLength(2));
  });
});

describe('ReviewLift, the write', () => {
  it('posts inReview false once, notes the lift, asks the board to re-read, and keeps the note on the fresh item', async () => {
    const onLifted = jest.fn();
    const { rerender } = render(<ReviewLift item={TRACKER} onLifted={onLifted} />);
    await openConfirm();
    expect(posts).toEqual([]);
    await userEvent.click(screen.getByTestId('review-lift-confirm-accept'));
    await waitFor(() => expect(screen.getByTestId('review-lifted').textContent).toBe('review lifted'));
    expect(screen.getByTestId('review-lifted')).toHaveClass('item-claim-note');
    expect(posts).toEqual([{ url: '/api/items/review', body: { project: '/abs/alpha', id: '#214', inReview: false } }]);
    expect(onLifted).toHaveBeenCalledTimes(1);

    rerender(<ReviewLift item={{ ...TRACKER, inReview: undefined, inReviewNoPr: undefined }} onLifted={onLifted} />);
    expect(screen.getByTestId('review-lifted').textContent).toBe('review lifted');
  });

  it('sends one request for a double-click', async () => {
    render(<ReviewLift item={TRACKER} onLifted={() => {}} />);
    await openConfirm();
    await userEvent.dblClick(screen.getByTestId('review-lift-confirm-accept'));
    await waitFor(() => expect(screen.getByTestId('review-lifted')).toBeInTheDocument());
    expect(posts).toHaveLength(1);
  });

  it('posts nothing on Keep in review, and the chip comes back', async () => {
    render(<ReviewLift item={TRACKER} onLifted={() => {}} />);
    await openConfirm();
    await userEvent.click(screen.getByTestId('review-lift-confirm-dismiss'));
    expect(screen.getByTestId('review-lift')).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('prints a refusal verbatim, brings the chip back and does not re-read', async () => {
    post = { status: 409, body: { error: 'sync is off for futin/x' } };
    const onLifted = jest.fn();
    render(<ReviewLift item={TRACKER} onLifted={onLifted} />);
    await openConfirm();
    await userEvent.click(screen.getByTestId('review-lift-confirm-accept'));
    await waitFor(() => expect(screen.getByTestId('review-lift-error').textContent).toBe('sync is off for futin/x'));
    expect(screen.getByTestId('review-lift')).toBeInTheDocument();
    expect(onLifted).not.toHaveBeenCalled();
  });
});

describe('ItemModal draws ReviewLift', () => {
  it('after the dispatch control and before Approve plan, when the board passes onLifted', async () => {
    render(
      <ItemModal
        item={{ ...TRACKER, planReview: true }}
        hues={HUES}
        onClose={() => {}}
        agents={null}
        onDispatch={() => {}}
        onApproved={() => {}}
        onLifted={() => {}}
      />
    );
    await screen.findByText('body');
    const dispatch = document.querySelector('.item-facts-dispatch')!;
    const lift = screen.getByTestId('review-lift');
    const approve = screen.getByTestId('plan-approve');
    expect(dispatch.compareDocumentPosition(lift) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lift.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers no lift on a render site with nothing to re-read', async () => {
    render(<ItemModal item={TRACKER} hues={HUES} onClose={() => {}} />);
    await screen.findByText('body');
    expect(screen.queryByTestId('review-lift')).toBeNull();
  });
});
