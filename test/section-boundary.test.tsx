/**
 * @jest-environment jsdom
 */
import { lazy, Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { SectionBoundary } from '../client/src/components/SectionBoundary';
import { RELOAD_GUARD_KEY, RELOAD_GUARD_MS, installPreloadReload } from '../client/src/lib/preload-reload';

/**
 * #270 — a rebuild while a tab is open deletes the lazy sections' chunks, and with no boundary and no `vite:preloadError` handler the next section
 * switch blanked the whole app. Two halves: the preload handler reloads the page once (and only once, so a chunk a reload cannot bring back does not
 * loop), and the boundary turns whatever still throws into an in-place failure with a reload action instead of an unmounted tree.
 */

describe('SectionBoundary', () => {
  // React logs every caught render error to console.error; the throw is the point here, so the noise is muted for this block only.
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());

  it('renders the in-place failure, not a blank tree, when a lazy section chunk fails to import', async () => {
    const Broken = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    render(
      <div>
        <nav>rail</nav>
        <SectionBoundary>
          <Suspense fallback={<span>loading…</span>}>
            <Broken />
          </Suspense>
        </SectionBoundary>
      </div>
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('this section failed to load');
    // The rest of the shell survives — the rail is outside the boundary.
    expect(screen.getByText('rail')).toBeInTheDocument();
  });

  it('calls reload from its reload action', async () => {
    const Throws = (): never => {
      throw new Error('render throw');
    };
    const onReload = jest.fn();
    render(
      <SectionBoundary onReload={onReload}>
        <Throws />
      </SectionBoundary>
    );
    await userEvent.click(screen.getByRole('button', { name: 'reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('renders its children untouched when nothing throws', () => {
    render(
      <SectionBoundary>
        <p>board</p>
      </SectionBoundary>
    );
    expect(screen.getByText('board')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('installPreloadReload', () => {
  let uninstall: () => void = () => undefined;
  afterEach(() => {
    uninstall();
    window.sessionStorage.clear();
  });

  function fire(): Event {
    const event = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it('reloads once on a preload error, and not again on a second one straight after', () => {
    let now = 1_000_000;
    const reload = jest.fn();
    uninstall = installPreloadReload({ target: window, storage: window.sessionStorage, reload, now: () => now });

    const first = fire();
    expect(reload).toHaveBeenCalledTimes(1);
    // Stops Vite rethrowing while the page navigates away.
    expect(first.defaultPrevented).toBe(true);
    expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe(String(now));

    // The reloaded page failing again on its own first paint: the reload did not help, so no loop — the error propagates to the boundary.
    now += 500;
    const second = fire();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
  });

  it('reloads again for a later rebuild once the guard window has passed', () => {
    let now = 1_000_000;
    const reload = jest.fn();
    uninstall = installPreloadReload({ target: window, storage: window.sessionStorage, reload, now: () => now });
    fire();
    now += RELOAD_GUARD_MS + 1;
    fire();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('reads the guard across a reload, from sessionStorage rather than memory', () => {
    const now = 1_000_000;
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(now - 100));
    const reload = jest.fn();
    uninstall = installPreloadReload({ target: window, storage: window.sessionStorage, reload, now: () => now });
    fire();
    expect(reload).not.toHaveBeenCalled();
  });
});
