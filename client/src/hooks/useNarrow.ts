import { useEffect, useState } from 'react';

/**
 * useNarrow — the one place JavaScript knows this board's phone breakpoint
 * (the design spec's §12.2).
 *
 * The number itself lives in two places by necessity: `styles.css` states it
 * in every `@media (max-width: 700px)` block, and JS states it here, because
 * a media query cannot be read from a stylesheet at runtime and a component
 * that needs to *render differently* (the rail's ☰ menu, a full-screen
 * overlay) cannot be driven by CSS alone. What this hook prevents is the
 * third, fourth and fifth copy: every component that needs the answer asks
 * this hook rather than calling `matchMedia` with a literal of its own, so a
 * breakpoint change is two edits and not seven.
 *
 * `matchMedia` is optional, not assumed. jsdom does not implement it, and
 * this board's component suites render the rail and the overlays without a
 * stub; an unguarded call would crash every one of them for a reading none of
 * them is about. Absent, the answer is `false` — the desktop shape, which is
 * the one every existing suite already asserts against.
 */
export const NARROW_QUERY = '(max-width: 700px)';

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => matchNarrow());

  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY) : null;
    if (!mq) return;
    // Re-read on mount as well as on change: the initializer ran during the
    // first render, and a resize between that and this effect would otherwise
    // be missed until the next one.
    setNarrow(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return narrow;
}

function matchNarrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NARROW_QUERY).matches;
}
