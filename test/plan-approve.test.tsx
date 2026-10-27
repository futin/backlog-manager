/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ItemModal } from '../client/src/components/board/ItemModal';
import { PlanApprove } from '../client/src/components/board/PlanApprove';
import { buildProjectHues } from '../client/src/lib/project-hue';
import type { BacklogItem } from '../shared/types';
import { daysAgoDate } from './helpers/dates';

/**
 * #367 — the item modal's Approve plan. A tracker item lifts its `plan-review` label through `POST /api/items/plan-review`, confirm-gated; a files item gets
 * no request at all, only a prompt to copy, because the board never writes item files.
 */
const TRACKER: BacklogItem = {
  id: '#41',
  title: 'reviewed plan',
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
const FILES: BacklogItem = {
  ...TRACKER,
  id: 'task-9',
  path: '/abs/alpha/backlog/tasks/open/task-9-reviewed-plan.md',
  source: 'files',
  url: null
};
const HUES = buildProjectHues([{ name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z' }]);

let answer: { status: number; body: unknown };
let posts: { url: string; body: unknown }[];

beforeEach(() => {
  posts = [];
  answer = { status: 201, body: { id: '#41', planReview: false } };
  global.fetch = jest.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return Promise.resolve({ ok: answer.status < 300, status: answer.status, json: () => Promise.resolve(answer.body) } as Response);
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve('body') } as Response);
  }) as jest.Mock;
});

describe('PlanApprove, tracker item', () => {
  it('asks before it posts, then posts planReview false, notes the approval and asks the board to re-read', async () => {
    const onApproved = jest.fn();
    render(<PlanApprove item={TRACKER} onApproved={onApproved} />);

    expect(screen.getByTestId('plan-approve').textContent).toBe('Approve plan');
    await userEvent.click(screen.getByTestId('plan-approve'));
    expect(posts).toEqual([]);
    expect(screen.getByTestId('plan-approve-confirm').textContent).toMatch(/Approve the plan on #41\? The next tick, or Execute here, can then run it\./);
    expect(screen.getByTestId('plan-approve-confirm-accept').textContent).toBe('Approve');
    expect(screen.getByTestId('plan-approve-confirm-dismiss').textContent).toBe('Keep in review');

    await userEvent.click(screen.getByTestId('plan-approve-confirm-accept'));
    await waitFor(() => expect(screen.getByTestId('plan-approved').textContent).toBe('plan approved'));
    expect(posts).toEqual([{ url: '/api/items/plan-review', body: { project: '/abs/alpha', id: '#41', planReview: false } }]);
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('plan-approve')).toBeNull();
  });

  it('puts the chip back and posts nothing when the confirm is dismissed', async () => {
    render(<PlanApprove item={TRACKER} onApproved={() => {}} />);
    await userEvent.click(screen.getByTestId('plan-approve'));
    await userEvent.click(screen.getByTestId('plan-approve-confirm-dismiss'));
    expect(screen.queryByTestId('plan-approve-confirm')).toBeNull();
    expect(screen.getByTestId('plan-approve')).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('prints the server’s refusal verbatim, brings the chip back and does not re-read', async () => {
    answer = { status: 409, body: { error: 'sync is off for futin/x' } };
    const onApproved = jest.fn();
    render(<PlanApprove item={TRACKER} onApproved={onApproved} />);
    await userEvent.click(screen.getByTestId('plan-approve'));
    await userEvent.click(screen.getByTestId('plan-approve-confirm-accept'));
    await waitFor(() => expect(screen.getByTestId('plan-approve-error').textContent).toBe('sync is off for futin/x'));
    expect(screen.getByTestId('plan-approve')).toBeEnabled();
    expect(screen.queryByTestId('plan-approved')).toBeNull();
    expect(onApproved).not.toHaveBeenCalled();
  });

  it('sends one approval for a double-click on the confirm', async () => {
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Promise<Response>(() => {});
    }) as jest.Mock;
    render(<PlanApprove item={TRACKER} onApproved={() => {}} />);
    await userEvent.click(screen.getByTestId('plan-approve'));
    const accept = screen.getByTestId('plan-approve-confirm-accept');
    act(() => {
      accept.click();
      accept.click();
    });
    expect(posts).toHaveLength(1);
  });

  it.each([
    ['carries no mark', { ...TRACKER, planReview: undefined }],
    ['is done', { ...TRACKER, status: 'done' as const }],
    ['is terminal', { ...TRACKER, status: 'terminal' as const }]
  ])('draws nothing for an item that %s', (_label, item) => {
    const { container } = render(<PlanApprove item={item} onApproved={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PlanApprove, files item', () => {
  const PROMPT =
    "Approve the unattended plan on task-9 in /abs/alpha: delete the plan-review: true line from backlog/tasks/open/task-9-reviewed-plan.md's frontmatter, then commit it.";
  const clipboard = (writeText: jest.Mock | undefined): void => {
    Object.defineProperty(navigator, 'clipboard', { value: writeText === undefined ? undefined : { writeText }, configurable: true });
  };
  afterEach(() => {
    jest.useRealTimers();
    clipboard(undefined);
  });

  it('posts nothing, says why, and copies the prompt — reading Copied for two seconds', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    clipboard(writeText);
    jest.useFakeTimers();
    render(<PlanApprove item={FILES} onApproved={() => {}} />);

    expect(screen.getByText('Approve from a Claude session — the board never writes item files.')).toBeInTheDocument();
    expect(screen.queryByTestId('plan-approve')).toBeNull();
    const copy = screen.getByTestId('plan-approve-copy');
    expect(copy.textContent).toBe('Copy prompt');

    await act(async () => {
      copy.click();
    });
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(copy.textContent).toBe('Copied');
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(copy.textContent).toBe('Copy prompt');
    expect(posts).toEqual([]);
    expect(screen.queryByTestId('plan-approve-prompt')).toBeNull();
  });

  it('draws the prompt for selection by hand when there is no clipboard', async () => {
    clipboard(undefined);
    render(<PlanApprove item={FILES} onApproved={() => {}} />);
    await userEvent.click(screen.getByTestId('plan-approve-copy'));
    expect(screen.getByTestId('plan-approve-prompt').textContent).toBe(PROMPT);
  });

  it('draws the prompt for selection by hand when the clipboard refuses the write', async () => {
    clipboard(jest.fn(() => Promise.reject(new Error('denied'))));
    render(<PlanApprove item={FILES} onApproved={() => {}} />);
    await userEvent.click(screen.getByTestId('plan-approve-copy'));
    await waitFor(() => expect(screen.getByTestId('plan-approve-prompt').textContent).toBe(PROMPT));
    expect(screen.getByTestId('plan-approve-copy').textContent).toBe('Copy prompt');
  });
});

describe('ItemModal draws PlanApprove', () => {
  it('under the dispatch chip and above the claim control, when the board passes onApproved', async () => {
    render(
      <ItemModal
        item={{ ...TRACKER, holder: { session: 'b1c2d3e4-5555-6666-7777-888899990000', host: 'laptop', heartbeat: new Date().toISOString() } }}
        hues={HUES}
        onClose={() => {}}
        agents={null}
        onDispatch={() => {}}
        onReleased={() => {}}
        onApproved={() => {}}
      />
    );
    await screen.findByText('body');
    const dispatch = document.querySelector('.item-facts-dispatch')!;
    const approve = screen.getByTestId('plan-approve');
    const release = screen.getByTestId('claim-release');
    expect(dispatch.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(approve.compareDocumentPosition(release) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers no write on a render site with nothing to re-read', async () => {
    render(<ItemModal item={TRACKER} hues={HUES} onClose={() => {}} />);
    await screen.findByText('body');
    expect(screen.queryByTestId('plan-approve')).toBeNull();
  });
});
