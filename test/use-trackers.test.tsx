/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { TrackersProvider, useTrackersContext } from '../client/src/hooks/TrackersContext';
import { TRACKER_FETCH_SLACK_MS, useTrackers } from '../client/src/hooks/useTrackers';
import { TRACKER_CYCLE_MS } from '../client/src/lib/tracker';
import type { TrackerProjectRow, TrackersPayload } from '../shared/types';

/**
 * `useTrackers` on the server's poll clock (the tracker strip spec, §4): one fetch on mount, then exactly one pending timer after every answer, aimed just
 * past the server's next tick so the chip's bar reaches its end and snaps back instead of drifting. Fake timers throughout; every fetch is counted.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z');

function row(over: Partial<TrackerProjectRow> = {}): TrackerProjectRow {
  return { name: 'x', path: '/abs/x', source: 'github', repo: 'futin/x', polledAt: null, access: 'ok', detail: null, interval: null, connect: null, ...over };
}

function payload(rows: TrackerProjectRow[]): TrackersPayload {
  return {
    platforms: [{ kind: 'github', hasToken: true, login: 'futin', limit: 5000, remaining: 4930, reset: 1_790_000_000 }],
    projects: rows
  };
}

const answer = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
const healthy = () => payload([row({ polledAt: new Date(NOW - 5_000).toISOString() })]);

let fetchMock: jest.Mock;

function Probe() {
  const { data } = useTrackers();
  return <span>{data?.platforms[0]?.login ?? 'none'}</span>;
}

function ContextProbe({ testId }: { testId?: string }) {
  const { data } = useTrackersContext();
  return <span data-testid={testId}>{data?.platforms[0]?.login ?? 'none'}</span>;
}

/** Flush the fetch promise chain and whatever state it sets. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  fetchMock = jest.fn(() => answer(healthy()));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useTrackers', () => {
  it('fetches once on mount', async () => {
    render(<Probe />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/trackers');
    expect(screen.getByText('futin')).toBeInTheDocument();
  });

  it("schedules the next fetch just after the server's next tick", async () => {
    // polledAt + cycle + slack − now = −5_000 + 17_000 + 500.
    expect(TRACKER_CYCLE_MS + TRACKER_FETCH_SLACK_MS - 5_000).toBe(12_500);
    render(<Probe />);
    await flush();
    await advance(12_499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('floors the schedule at one second when the deadline is nearer than that', async () => {
    // Review Focus 2, the "never in the past" half: 17_000 + 500 − 16_800 is 700 ms, under the floor.
    fetchMock.mockImplementation(() => answer(payload([row({ polledAt: new Date(NOW - 16_800).toISOString() })])));
    render(<Probe />);
    await flush();
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits a whole cycle, not the floor, once the newest stamp is overdue', async () => {
    // Review Focus 2, the "never a tight loop" half: a background tab or a stalled poller leaves every stamp two cycles old, the deadline long past and
    // nothing due. The server is not restamping, so asking every second would be 3,600 reads an hour that learn nothing; one cycle keeps `overdue` honest.
    fetchMock.mockImplementation(() => answer(payload([row({ polledAt: new Date(NOW - 60_000).toISOString() })])));
    render(<Probe />);
    await flush();
    await advance(TRACKER_CYCLE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(TRACKER_CYCLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('waits a whole cycle when every repo is failing, whatever its stamp', async () => {
    // A failing repo's stamp does not move, so its deadline passes once and stays passed: the same loop as the overdue case, reached in 17.5 s.
    fetchMock.mockImplementation(() => answer(payload([row({ polledAt: new Date(NOW - 20_000).toISOString(), access: 'forbidden' })])));
    render(<Probe />);
    await flush();
    await advance(TRACKER_CYCLE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches at the floor while another repo of the same sweep is still due', async () => {
    // The server stamps repos one after another (~0.8 s each), so an answer taken mid-sweep holds one fresh stamp and others a cycle old; aiming at the
    // newest alone would leave those rows reading 0s for a whole cycle. Measured on the running stack with five repos: a 4 s spread.
    fetchMock.mockImplementation(() =>
      answer(payload([row({ polledAt: new Date(NOW - 2_000).toISOString() }), row({ path: '/abs/y', polledAt: new Date(NOW - 18_000).toISOString() })]))
    );
    render(<Probe />);
    await flush();
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not hurry for a repo that is overdue or failing, only for one that is due', async () => {
    // Overdue (two cycles silent) means the server is not polling it, and a failing repo's stamp does not move — fetching every second for either would
    // be a loop that learns nothing. Both fall back to the newest stamp's deadline: 17_000 + 500 − 2_000.
    fetchMock.mockImplementation(() =>
      answer(
        payload([
          row({ polledAt: new Date(NOW - 2_000).toISOString() }),
          row({ path: '/abs/y', polledAt: new Date(NOW - 40_000).toISOString() }),
          row({ path: '/abs/z', polledAt: new Date(NOW - 20_000).toISOString(), access: 'forbidden' })
        ])
      )
    );
    render(<Probe />);
    await flush();
    await advance(15_499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to one cycle when no row has polled yet', async () => {
    fetchMock.mockImplementation(() => answer(payload([row({ polledAt: null })])));
    render(<Probe />);
    await flush();
    await advance(TRACKER_CYCLE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // #17: each repo's next stamp lands on its own interval, so the schedule aims at the earliest of them and never hurries for a slow one between polls.
  it('aims at a 5m repo’s own next stamp, not at a 15s cycle', async () => {
    // 40 s old on a 302 s cycle: the next stamp is 262 s away, plus the slack.
    fetchMock.mockImplementation(() => answer(payload([row({ interval: '5m', polledAt: new Date(NOW - 40_000).toISOString() })])));
    render(<Probe />);
    await flush();
    await advance(262_499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not hurry for a slowed repo whose age merely passed fifteen seconds', async () => {
    // A 1m repo 20 s old is not due, whatever a 15s one that age would be; the 15s repo beside it sets the schedule.
    fetchMock.mockImplementation(() =>
      answer(payload([row({ polledAt: new Date(NOW - 5_000).toISOString() }), row({ path: '/abs/y', interval: '1m', polledAt: new Date(NOW - 20_000).toISOString() })]))
    );
    render(<Probe />);
    await flush();
    await advance(12_499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sets no timer when every tracker repo is off — nothing on the server is moving', async () => {
    fetchMock.mockImplementation(() => answer(payload([row({ interval: 'off', polledAt: new Date(NOW - 5_000).toISOString() })])));
    render(<Probe />);
    await flush();
    await advance(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sets no timer when no project is a tracker', async () => {
    fetchMock.mockImplementation(() => answer(payload([row({ source: 'files', polledAt: new Date(NOW - 5_000).toISOString() })])));
    render(<Probe />);
    await flush();
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-arms after an error at one cycle', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
    function ErrorProbe() {
      const { error } = useTrackers();
      return <span>{error ? 'error' : 'fine'}</span>;
    }
    render(<ErrorProbe />);
    await flush();
    expect(screen.getByText('error')).toBeInTheDocument();
    await advance(TRACKER_CYCLE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches on focus and re-arms from that answer', async () => {
    // First answer: stamp 5 s old → deadline 12_500. Second (the focus fetch): stamp 1 s old → deadline 16_500.
    fetchMock
      .mockImplementationOnce(() => answer(healthy()))
      .mockImplementationOnce(() => answer(payload([row({ polledAt: new Date(NOW - 1_000).toISOString() })])));
    render(<Probe />);
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(12_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(16_500 - 12_500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears the pending timer on unmount', async () => {
    const { unmount } = render(<Probe />);
    await flush();
    unmount();
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('TrackersContext', () => {
  it('the provider hands one state to every reader', async () => {
    render(
      <TrackersProvider>
        <ContextProbe testId="a" />
        <ContextProbe testId="b" />
      </TrackersProvider>
    );
    await flush();
    expect(screen.getByTestId('a')).toHaveTextContent('futin');
    expect(screen.getByTestId('b')).toHaveTextContent('futin');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a reader without a provider sees the loading state and does not throw', async () => {
    render(<ContextProbe />);
    await flush();
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
