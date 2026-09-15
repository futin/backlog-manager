/**
 * @jest-environment jsdom
 */
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';

import { NARROW_QUERY, useNarrow } from '../client/src/hooks/useNarrow';

function Probe() {
  return <span>{useNarrow() ? 'narrow' : 'wide'}</span>;
}

/** A `matchMedia` that answers one fixed verdict and remembers its listeners. */
function installMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: NARROW_QUERY,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => { listeners.add(l); },
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => { listeners.delete(l); }
  };
  const impl = jest.fn(() => mql);
  Object.defineProperty(window, 'matchMedia', { value: impl, configurable: true, writable: true });
  return {
    impl,
    listeners,
    emit(next: boolean) {
      mql.matches = next;
      for (const l of listeners) l({ matches: next } as MediaQueryListEvent);
    }
  };
}

describe('useNarrow', () => {
  afterEach(() => {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
  });

  /*
    The absent-matchMedia path is the one that matters most and the one a
    behavioural test would never think to write: jsdom does not implement
    `matchMedia`, and this board's component suites render the rail and the
    overlays without a stub. An unguarded call would crash every one of them
    for a reading none of them is about — so "absent means the desktop shape"
    is the contract, not a fallback nobody exercises.
  */
  it('reads wide when the environment has no matchMedia at all', () => {
    render(<Probe />);

    expect(screen.getByText('wide')).toBeInTheDocument();
  });

  it('asks for the one query this board knows, and reports its verdict', () => {
    const mm = installMatchMedia(true);

    render(<Probe />);

    expect(mm.impl).toHaveBeenCalledWith(NARROW_QUERY);
    expect(screen.getByText('narrow')).toBeInTheDocument();
  });

  it('follows the query across a resize', () => {
    const mm = installMatchMedia(false);
    render(<Probe />);
    expect(screen.getByText('wide')).toBeInTheDocument();

    act(() => mm.emit(true));

    expect(screen.getByText('narrow')).toBeInTheDocument();
  });

  it('unsubscribes on unmount', () => {
    const mm = installMatchMedia(false);
    const { unmount } = render(<Probe />);
    expect(mm.listeners.size).toBe(1);

    unmount();

    expect(mm.listeners.size).toBe(0);
  });
});
