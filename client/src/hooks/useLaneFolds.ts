import { useCallback, useMemo } from 'react';

import { JIRA_LANE_FOLDS_KEY, clampLaneFolds, laneOpen, laneOverrides, setLaneFold, type JiraLane, type JiraLanes } from '../lib/jira';
import { usePersistedState } from './usePersistedState';

/** Which Board lanes are open, and the one way to change it. */
export interface LaneFoldState {
  isOpen(lane: JiraLane): boolean;
  toggle(lane: JiraLane): void;
  /** True while a search is typed: every lane is drawn open and no chevron can fold one (parent-lanes spec §3.6). */
  locked: boolean;
}

/**
 * The Board's lane folds (parent-lanes spec §3.6; .claude/DESIGN.md §8.9.1). ONE `usePersistedState` under `JIRA_LANE_FOLDS_KEY` holds every board's
 * overrides, because that hook reads storage once on mount: a key per board would show the first board's folds after a pick changed the board without a
 * remount. The stored value is clamped on EVERY read, not once — the hook spreads an object over the fallback and hands anything else back raw, so `null`,
 * `"x"`, `[]` or a lane entry of `"junk"` reach this code as they were written, and each reads as "no override".
 *
 * `toggle` writes through `setLaneFold` with `board` — the page's UNFILTERED lanes — so the prune keeps every override for a lane that exists and is merely
 * filtered out, and drops the ones for lanes that left the board. While `searching`, every lane reads open and `toggle` does nothing, and what is stored is
 * never touched: clearing the search puts back exactly the folds the person had. `boardId` null (no board picked yet) reads defaults and stores nothing.
 */
export function useLaneFolds(boardId: string | null, board: JiraLanes, searching: boolean): LaneFoldState {
  const [stored, setStored] = usePersistedState<unknown>(JIRA_LANE_FOLDS_KEY, {});
  const folds = useMemo(() => clampLaneFolds(stored), [stored]);
  const overrides = useMemo(() => (boardId === null ? {} : laneOverrides(folds, boardId)), [folds, boardId]);

  const isOpen = useCallback((lane: JiraLane): boolean => searching || laneOpen(lane, overrides), [searching, overrides]);
  const toggle = useCallback(
    (lane: JiraLane): void => {
      if (searching || boardId === null) return;
      setStored(setLaneFold(folds, boardId, board, lane.key, !laneOpen(lane, overrides)));
    },
    [searching, boardId, folds, board, overrides, setStored]
  );

  return { isOpen, toggle, locked: searching };
}
