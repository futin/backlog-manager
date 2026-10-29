/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import GithubSettingsView from '../client/src/components/github/GithubSettingsView';
import { TrackersProvider } from '../client/src/hooks/TrackersContext';
import { SYNC_INTERVALS } from '../shared/types';
import type { SyncInterval, TrackerProjectRow, TrackersPayload } from '../shared/types';

/**
 * GitHub › Settings (source-sections spec, "Parts of the how"): each registered github project's sync picker, moved here off Settings › Shared's old
 * Trackers card (#17, spec §9 of the sync-interval design). What it must never do is show a value the server did not answer — the pill follows the
 * refetch, a refusal leaves the old value selected and says why in the row — and two checkouts of one repo are one setting.
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

const files = row({ name: 'beta', path: '/abs/beta', source: 'files', repo: null, polledAt: null, access: null, interval: null, connect: 'connect beta' });

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

async function renderPage(waitFor_ = 'alpha'): Promise<void> {
  stubFetch();
  render(
    <TrackersProvider>
      <GithubSettingsView />
    </TrackersProvider>
  );
  await waitFor(() => expect(screen.getByText(waitFor_)).toBeInTheDocument());
}

const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('.set-row') as HTMLElement;
const pillOf = (name: string): HTMLElement => within(rowOf(name)).getByRole('group', { name: 'Sync interval' });
const selected = (name: string): string | null => within(pillOf(name)).getByRole('button', { pressed: true }).textContent;
const hintOf = (name: string): string | null => rowOf(name).querySelector('.set-hint')?.textContent ?? null;

beforeEach(() => {
  rows = [row(), files];
  serverWrites();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GitHub › Settings: the sync card', () => {
  it('draws one row per github project — its name, its repo as the hint — and none for a files project', async () => {
    await renderPage();

    expect(hintOf('alpha')).toBe('futin/x');
    // A files project has no sync to set: it has no row here at all (its connect command is the Sources card's).
    expect(screen.queryByText('beta')).toBeNull();
    expect(screen.queryByText('connect beta')).toBeNull();
    // The card's own landmark and scope: everything on it is this machine's.
    const card = rowOf('alpha').closest('.set-group') as HTMLElement;
    expect(within(card).getByText('Sync')).toHaveClass('ui-sheet-title');
    expect(within(card).getByText('this machine')).toBeInTheDocument();
  });

  it('draws the four intervals with the repo’s interval selected', async () => {
    await renderPage();

    const labels = within(pillOf('alpha'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['15s', '1m', '5m', 'off']);
    // The pin: the options ARE the shared constant's keys, never a second list.
    expect(labels).toEqual(Object.keys(SYNC_INTERVALS));
    expect(selected('alpha')).toBe('1m');
  });

  it('posts the choice as JSON and then shows the value the refetch answered', async () => {
    await renderPage();

    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: 'off' }));

    expect(posts).toEqual([{ body: { repo: 'futin/x', interval: 'off' }, contentType: 'application/json' }]);
    await waitFor(() => expect(selected('alpha')).toBe('off'));
  });

  it('never shows an optimistic value: a server that answered 200 but kept 1m still reads 1m', async () => {
    answerPost = () => ({ status: 200, body: rows[0] });
    await renderPage();

    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: '5m' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.filter(([u]) => u === '/api/trackers').length).toBeGreaterThanOrEqual(2));
    expect(selected('alpha')).toBe('1m');
  });

  it('leaves the old value selected on a 409 and shows the refusal in place of the repo hint', async () => {
    answerPost = () => ({ status: 409, body: { error: 'sync cannot be turned off while a run is running in guide-manager (run r1)' } });
    await renderPage();

    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: 'off' }));

    expect(await within(rowOf('alpha')).findByText('sync cannot be turned off while a run is running in guide-manager (run r1)')).toBeInTheDocument();
    expect(hintOf('alpha')).toBe('sync cannot be turned off while a run is running in guide-manager (run r1)');
    expect(selected('alpha')).toBe('1m');
  });

  // Final review M6: clearing the refusal on ANY successful read let a scheduled poll or a focus refetch wipe it within a second of appearing — and a refused
  // pick does not move the pill, so the hint is the only sign the click was answered at all.
  it('keeps the refusal through an unrelated read, and clears it — back to the repo — on the next pick for that repo', async () => {
    answerPost = () => ({ status: 409, body: { error: 'sync cannot be turned off while a run is running in guide-manager (run r1)' } });
    await renderPage();
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
    expect(hintOf('alpha')).toBe('futin/x');
  });

  it('moves every row on the repo together, since the repo is the setting (Review Focus 3)', async () => {
    rows = [row(), row({ name: 'alpha-twin', path: '/abs/alpha-twin' }), files];
    await renderPage();

    expect(hintOf('alpha-twin')).toBe('futin/x');
    await userEvent.click(within(pillOf('alpha')).getByRole('button', { name: '15s' }));

    await waitFor(() => expect(selected('alpha')).toBe('15s'));
    expect(selected('alpha-twin')).toBe('15s');
  });

  it('says `nothing registered yet` with no github project — the page is reachable only while the section is held', async () => {
    rows = [files];
    await renderPage('nothing registered yet');
    expect(screen.queryByRole('group', { name: 'Sync interval' })).toBeNull();
  });

  it('says `checking…` before the first answer', async () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as jest.Mock;
    render(
      <TrackersProvider>
        <GithubSettingsView />
      </TrackersProvider>
    );
    expect(screen.getByText('checking…')).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
  });
});
