/**
 * @jest-environment jsdom
 */
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';

import { PullRequestsProvider, usePullRequestsContext } from '../../client/src/hooks/PullRequestsContext';

/**
 * The provider's disable → enable flip: the previous read must not be exposed while the freshly mounted reader has not yet reported. The tracker answer and the
 * reader are stubbed, so the test sees only the provider's own state.
 */
let trackers: { projects: { source: string }[] } | null;
const FIRST = { token: true, repos: [] };
jest.mock('../../client/src/hooks/TrackersContext', () => ({ useTrackersContext: () => ({ data: trackers }) }));
jest.mock('../../client/src/lib/tracker', () => ({ hasTracker: (p: { source: string }[]) => p.some((x) => x.source === 'github') }));
let readerData: typeof FIRST | null = null;
const refresh = () => Promise.resolve(null);
jest.mock('../../client/src/hooks/usePullRequests', () => ({
  usePullRequests: () => {
    // Set by the test: the first reader answers at once; the remounted one reports nothing yet, so only the provider's own state can show an old read.
    return { data: readerData, error: null, refresh };
  }
}));

// Every render's value, because the stale read lived for one render before the new reader's effect replaced it — a settled DOM cannot show it.
let seen: string[] = [];
function Probe() {
  const v = usePullRequestsContext();
  seen.push(`${v.enabled}:${v.data === null ? 'null' : 'data'}`);
  return <p data-testid="p">{`${v.enabled}:${v.data === null ? 'null' : 'data'}`}</p>;
}

const tree = () => (
  <PullRequestsProvider>
    <Probe />
  </PullRequestsProvider>
);

it('clears the stale read when the shell stops reading, so a re-enable does not expose it', () => {
  readerData = FIRST;
  trackers = { projects: [{ source: 'github' }] };
  const { rerender } = render(tree());
  expect(screen.getByTestId('p')).toHaveTextContent('true:data');
  trackers = { projects: [] };
  readerData = null;
  act(() => rerender(tree()));
  expect(screen.getByTestId('p')).toHaveTextContent('false:null');
  trackers = { projects: [{ source: 'github' }] };
  seen = [];
  act(() => rerender(tree()));
  expect(screen.getByTestId('p')).toHaveTextContent('true:null');
  expect(seen).not.toContain('true:data');
});
