import { useEffect, useState } from 'react';

import { RUNS_MODE_KEY, isRunsMode, type RunsMode } from '../lib/runs-mode';

/**
 * useRunsMode — the Runs sub-view, shared by every surface that names it.
 *
 * This exists because the rail's sub-nav tree (DESIGN.md §8.0) made the stored
 * mode a question TWO mounted components ask at once: the tree in the rail and
 * the segmented control inside `RunsView`. `usePersistedState` cannot serve
 * that — it is a `useState` per caller over one key, so a write from the rail
 * would reach localStorage and never reach the already-mounted `RunsView`, and
 * clicking `Watchdog` in the tree would persist a mode the page beside it went
 * on ignoring until a reload.
 *
 * So the value is held once, at module level, with every mounted reader
 * subscribed to it. That is the smallest thing that makes "the rail and the
 * page are looking at the same mode" true by construction rather than by two
 * components happening to re-mount at the right moment.
 *
 * `lib/runs-mode.ts` is untouched and stays the one home of the key, the
 * member list and the guard — this is the React binding over it, which is why
 * it is a hook here rather than a second export there (that module is
 * deliberately React-free so the guard can be tested without rendering a
 * section).
 *
 * Reads go through `isRunsMode` on the way out of storage for the reason that
 * module's own comment gives: localStorage can hand back anything at all, and
 * the one outcome the Runs section must never have is rendering neither
 * surface.
 */

type Listener = (m: RunsMode) => void;

/**
 * Mounted readers, and NOT a cached value beside them. The stored mode is read
 * from localStorage on every mount, exactly as `usePersistedState` does, so
 * this module holds no state that could outlive a `localStorage.clear()` — a
 * cache here would make one test's stored mode leak into the next one's first
 * render, and make a second browser tab's write invisible to this one. What
 * the set adds over `usePersistedState` is only the part that was missing: a
 * write reaches every mounted reader, not just the one that made it.
 */
const listeners = new Set<Listener>();

function read(): RunsMode {
  try {
    const raw = localStorage.getItem(RUNS_MODE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isRunsMode(parsed) ? parsed : 'runs';
  } catch {
    // Private mode, a quota error, or a stored value that is not JSON at all.
    return 'runs';
  }
}

/** Written the way `usePersistedState` writes every other key: JSON, not a bare string. */
function write(mode: RunsMode): void {
  try {
    localStorage.setItem(RUNS_MODE_KEY, JSON.stringify(mode));
  } catch {
    /* ignore: private mode / quota — the in-memory value still moves */
  }
}

export function setRunsMode(mode: RunsMode): void {
  write(mode);
  for (const l of listeners) l(mode);
}

export function useRunsMode(): [RunsMode, (m: RunsMode) => void] {
  const [mode, setMode] = useState<RunsMode>(read);

  useEffect(() => {
    listeners.add(setMode);
    return () => {
      listeners.delete(setMode);
    };
  }, []);

  return [mode, setRunsMode];
}
