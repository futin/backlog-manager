import { RUNS_MODE_KEY, isRunsMode, type RunsMode } from '../lib/runs-mode';
import { persistedStore } from './persistedStore';

/**
 * useRunsMode — the Runs sub-view, shared by every surface that names it.
 *
 * This exists because the rail's sub-nav tree (DESIGN.md §8.0) made the stored
 * mode a question TWO mounted components ask at once: the tree in the rail and
 * the page inside `RunsView`. A `persistedStore`, for the reason that file
 * gives: clicking `Watchdog` in the tree would otherwise persist a mode the page
 * beside it went on ignoring until a reload.
 *
 * `lib/runs-mode.ts` is untouched and stays the one home of the key, the
 * member list and the guard — this is the React binding over it, which is why
 * it is a hook here rather than a second export there (that module is
 * deliberately React-free so the guard can be tested without rendering a
 * section).
 *
 * The fallback is `runs` for the reason that module's own comment gives:
 * localStorage can hand back anything at all, and the one outcome the Runs
 * section must never have is rendering neither surface.
 */
const store = persistedStore<RunsMode>(RUNS_MODE_KEY, isRunsMode, 'runs');

export const useRunsMode = store.useValue;
export const setRunsMode = store.set;
