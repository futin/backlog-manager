/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lazy, Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { SectionBoundary } from '../client/src/components/SectionBoundary';
import { RELOAD_GUARD_KEY, RELOAD_GUARD_MS, installPreloadReload, installPreloadReloadOnWindow } from '../client/src/lib/preload-reload';

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

describe('installPreloadReloadOnWindow', () => {
  // A window whose `sessionStorage` getter throws, as a browser blocking site storage for this origin does. main.tsx calls this at module top level, before
  // React renders anything, so a throw here is a blank app with no boundary to catch it (#270 fix loop 1).
  function blockedStorageWindow(reload: () => void): { win: Window; fire: () => Event } {
    const target = new EventTarget();
    const win = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      location: { reload },
    } as unknown as Window;
    Object.defineProperty(win, 'sessionStorage', {
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    const fire = (): Event => {
      const event = new Event('vite:preloadError', { cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    return { win, fire };
  }

  it('installs without touching a sessionStorage that throws, so main.tsx cannot blank the app', () => {
    const reload = jest.fn();
    const { win, fire } = blockedStorageWindow(reload);
    let uninstall: () => void = () => undefined;
    expect(() => {
      uninstall = installPreloadReloadOnWindow(win);
    }).not.toThrow();

    // A preload failure under blocked storage cannot carry the loop guard, so it does not reload — it propagates to SectionBoundary.
    let event: Event | undefined;
    expect(() => {
      event = fire();
    }).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
    expect(event?.defaultPrevented).toBe(false);
    uninstall();
  });

  it('is what main.tsx calls, and main.tsx reads no storage of its own at module top level', () => {
    // A source guard because behaviour cannot reach main.tsx without rendering the whole app: the case above proves the function is safe, this proves
    // the entry point goes through it rather than handing it `window.sessionStorage` evaluated eagerly — the shape fix loop 1 removed.
    const main = readFileSync(join(__dirname, '../client/src/main.tsx'), 'utf8');
    expect(main).toContain('installPreloadReloadOnWindow(window)');
    expect(main).not.toMatch(/sessionStorage/);
  });

  it('reloads through the window it was given when storage works', () => {
    const reload = jest.fn();
    const uninstall = installPreloadReloadOnWindow({
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
      sessionStorage: window.sessionStorage,
      location: { reload },
    } as unknown as Window);
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(1);
    uninstall();
    window.sessionStorage.clear();
  });
});
