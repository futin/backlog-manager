/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { TrackersGroup } from '../client/src/components/settings/TrackersGroup';
import { TrackersProvider } from '../client/src/hooks/TrackersContext';
import { SYNC_INTERVALS } from '../shared/types';
import type { SyncInterval, TrackerProjectRow, TrackersPayload } from '../shared/types';

/**
 * The Trackers card's one control (#17, spec §9): a per-repo sync picker on every `github` row. What it must never do is show a value the server did not
 * answer — the pill follows the refetch, a refusal leaves the old value selected and says why in the row — and two checkouts of one repo are one setting.
 *
 * Mounted under the real `TrackersProvider`, so the refetch after a POST is the shell's own `useTrackers` read, not a stand-in.
 */

function row(over: Partial<TrackerProjectRow> = {}): TrackerProjectRow {
  return {
    name: 'alpha',
    path: '/abs/alpha',
    source: 'github',
    repo: 'futin/x',
    polledAt: new Date(Date.now() - 5_000).toISOString(),
    access: 'ok',
    detail: null,
    interval: '1m',
    connect: null,
    ...over
  };
}

const files = row({ name: 'beta', path: '/abs/beta', source: 'files', repo: null, polledAt: null, access: null, interval: null, connect: null });

let rows: TrackerProjectRow[];
let posts: { body: unknown; contentType: string | undefined }[];
let answerPost: (body: { repo: string; interval: SyncInterval }) => { status: number; body: unknown };

function stubFetch(): void {
  posts = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/trackers/sync') {
      const body = JSON.parse(String(init?.body)) as { repo: string; interval: SyncInterval };
      posts.push({ body, contentType: (init?.headers as Record<string, string> | undefined)?.['content-type'] });
      const res = answerPost(body);
      return Promise.resolve({ ok: res.status < 300, status: res.status, json: () => Promise.resolve(res.body) } as Response);
    }
    const payload: TrackersPayload = {
      platforms: [{ kind: 'github', hasToken: true, login: 'futin', limit: 5000, remaining: 4930, reset: null }],
      projects: rows
    };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
}

/** The server's own behaviour, in miniature: one key per repo, every row on that repo answering the new value. */
function serverWrites(): void {
  answerPost = ({ repo, interval }) => {
    rows = rows.map((r) => (r.repo === repo ? { ...r, interval } : r));
    return { status: 200, body: rows.find((r) => r.repo === repo) };
  };
}

async function renderCard(): Promise<void> {
  stubFetch();
  render(
    <TrackersProvider>
      <TrackersGroup />
    </TrackersProvider>
  );
  await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
}

const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('.set-row') as HTMLElement;
const pillOf = (name: string): HTMLElement => within(rowOf(name)).getByRole('group', { name: 'Sync interval' });
const selected = (name: string): string | null => within(pillOf(name)).getByRole('button', { pressed: true }).textContent;

beforeEach(() => {
  rows = [row(), files];
  serverWrites();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the Trackers card’s sync picker', () => {
  it('draws the four intervals on a github row with its interval selected, and no control on a files row', async () => {
    await renderCard();

    const labels = within(pillOf('alpha'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['15s', '1m', '5m', 'off']);
    // The pin: the options ARE the shared constant's keys, never a second list.
    expect(labels).toEqual(Object.keys(SYNC_INTERVALS));
    expect(selected('alpha')).toBe('1m');
    expect(within(rowOf('beta')).queryByRole('group')).toBeNull();
  });

  it('posts the choice as JSON and then shows the value the refetch answered', async () => {
    await renderCard();

    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: 'off' }));

    expect(posts).toEqual([{ body: { repo: 'futin/x', interval: 'off' }, contentType: 'application/json' }]);
    await waitFor(() => expect(selected('alpha')).toBe('off'));
    expect(within(rowOf('alpha')).getByText(/sync off · polled/)).toBeInTheDocument();
  });

  it('never shows an optimistic value: a server that answered 200 but kept 1m still reads 1m', async () => {
    answerPost = () => ({ status: 200, body: rows[0] });
    await renderCard();

    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: '5m' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.filter(([u]) => u === '/api/trackers').length).toBeGreaterThanOrEqual(2));
    expect(selected('alpha')).toBe('1m');
  });

  it('leaves the old value selected on a 409 and shows the refusal in the row', async () => {
    answerPost = () => ({ status: 409, body: { error: 'sync cannot be turned off while a run is running in guide-manager (run r1)' } });
    await renderCard();

    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: 'off' }));

    expect(await within(rowOf('alpha')).findByText('sync cannot be turned off while a run is running in guide-manager (run r1)')).toBeInTheDocument();
    expect(selected('alpha')).toBe('1m');
  });

  // Final review M6: clearing the refusal on ANY successful read let a scheduled poll or a focus refetch wipe it within a second of appearing — and a refused
  // pick does not move the pill, so the hint is the only sign the click was answered at all.
  it('keeps the refusal through an unrelated read, and clears it on the next pick for that repo', async () => {
    answerPost = () => ({ status: 409, body: { error: 'sync cannot be turned off while a run is running in guide-manager (run r1)' } });
    await renderCard();
    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: 'off' }));
    await within(rowOf('alpha')).findByText(/sync cannot be turned off/);

    const reads = (): number => (global.fetch as jest.Mock).mock.calls.filter(([u]) => u === '/api/trackers').length;
    const before = reads();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(reads()).toBe(before + 1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(rowOf('alpha')).getByText(/sync cannot be turned off/)).toBeInTheDocument();

    serverWrites();
    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: '5m' }));
    await waitFor(() => expect(selected('alpha')).toBe('5m'));
    expect(within(rowOf('alpha')).queryByText(/sync cannot be turned off/)).toBeNull();
  });

  it('moves every row on the repo together, since the repo is the setting (Review Focus 3)', async () => {
    rows = [row(), row({ name: 'alpha-twin', path: '/abs/alpha-twin' }), files];
    await renderCard();

    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: '15s' }));

    await waitFor(() => expect(selected('alpha')).toBe('15s'));
    expect(selected('alpha-twin')).toBe('15s');
  });
});
