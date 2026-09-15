/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { useRunsMode } from '../client/src/hooks/useRunsMode';
import { RUNS_MODE_KEY } from '../client/src/lib/runs-mode';

/*
  The hook exists for one reason (task-36): the rail's sub-nav tree and the
  segmented control inside `RunsView` are two MOUNTED components asking the
  same stored question at once, and `usePersistedState` is a `useState` per
  caller — the rail's write would reach localStorage and never reach the page
  beside it. These cases pin that, and pin that nothing else about the key
  changed: same storage key, same JSON shape, same guard on the way out.
*/

function Reader({ id }: { id: string }) {
  const [mode, setMode] = useRunsMode();
  return (
    <button onClick={() => setMode(mode === 'runs' ? 'watchdog' : 'runs')}>
      {id}:{mode}
    </button>
  );
}

describe('useRunsMode', () => {
  beforeEach(() => localStorage.clear());

  it('opens on runs when nothing is stored', () => {
    render(<Reader id="a" />);

    expect(screen.getByRole('button', { name: 'a:runs' })).toBeInTheDocument();
  });

  it('reads the stored mode, in the JSON shape usePersistedState writes', () => {
    localStorage.setItem(RUNS_MODE_KEY, JSON.stringify('watchdog'));

    render(<Reader id="a" />);

    expect(screen.getByRole('button', { name: 'a:watchdog' })).toBeInTheDocument();
  });

  /*
    A stored value can come back as a number, an object, `null` or a word this
    union never had — an older build, a hand edit. The one outcome the Runs
    section must never have is rendering neither surface, so an unrecognised
    value reads as `runs` rather than as itself.
  */
  it.each([['"banana"', 'a word outside the union'], ['7', 'a number'], ['not json', 'not JSON at all']])(
    'clamps %s (%s) back to runs', (raw) => {
      localStorage.setItem(RUNS_MODE_KEY, raw);

      render(<Reader id="a" />);

      expect(screen.getByRole('button', { name: 'a:runs' })).toBeInTheDocument();
    }
  );

  it('carries one reader’s write to every other mounted reader', async () => {
    render(<><Reader id="a" /><Reader id="b" /></>);

    await userEvent.click(screen.getByRole('button', { name: 'a:runs' }));

    expect(screen.getByRole('button', { name: 'a:watchdog' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'b:watchdog' })).toBeInTheDocument();
  });

  it('persists the write under the same key', async () => {
    render(<Reader id="a" />);

    await userEvent.click(screen.getByRole('button', { name: 'a:runs' }));

    expect(JSON.parse(localStorage.getItem(RUNS_MODE_KEY) as string)).toBe('watchdog');
  });

  /*
    No module-level cache: a value held here would survive a
    `localStorage.clear()` between cases and make one test's stored mode leak
    into the next one's first render — which is exactly how this hook's first
    draft broke 31 cases in `runs-view.test.tsx`.
  */
  it('re-reads storage on a fresh mount rather than caching', () => {
    const { unmount } = render(<Reader id="a" />);
    unmount();
    localStorage.setItem(RUNS_MODE_KEY, JSON.stringify('watchdog'));

    render(<Reader id="b" />);

    expect(screen.getByRole('button', { name: 'b:watchdog' })).toBeInTheDocument();
  });
});
