import { useMemo } from 'react';

import { JIRA_BOARD_KEY, foldBoard, pickBoard, type JiraFold } from '../lib/jira';
import type { JiraBoardStatus } from '../../../shared/types';
import { useJiraContext } from './JiraContext';
import { useJiraBoard, type JiraBoardState } from './useJiraBoard';
import { usePersistedState } from './usePersistedState';

export interface PickedJiraBoard {
  boards: readonly JiraBoardStatus[];
  /** The stored pick resolved against the live list; `null` while the config is unreadable or no board exists. */
  board: JiraBoardStatus | null;
  unreadable: string | null;
  pick: (id: string) => void;
  list: JiraBoardState;
  fold: JiraFold;
  /** "The list has loaded" — the condition the columns are drawn under, read once so the band and the columns cannot disagree about it. */
  loaded: boolean;
  /** `board` with its `polledAt` advanced to the list's own when that is newer (the two pollers run one interval apart). */
  shown: JiraBoardStatus | null;
}

const NO_BOARDS: readonly JiraBoardStatus[] = [];

/**
 * The picked board and its issue list, loaded one way for every Jira page that reads them. Two pages (Board and Sessions) read the ONE stored pick under
 * `JIRA_BOARD_KEY` (spec C4), so they must resolve it, request it and fold it identically — `nudge` (`JiraView`'s write counter) included — or a pick made on
 * one page would show a different board, or a stale list, on the other. The stored value is only a preference: `pickBoard` resolves it against the status's
 * live list on every render, and `useJiraBoard` is handed ONLY the resolved id.
 */
export function usePickedJiraBoard(nudge: number): PickedJiraBoard {
  const { data } = useJiraContext();
  const [stored, setStored] = usePersistedState<unknown>(JIRA_BOARD_KEY, null);
  const boards = data?.boards ?? NO_BOARDS;
  const unreadable = data?.configUnreadable ?? null;
  // Resolved against the live list every render; `null` while unreadable, so nothing is requested from a board list the server could not read.
  const board = unreadable === null ? pickBoard(stored, boards) : null;
  // The ONLY id a page ever asks the server about (the one stored pick).
  const list = useJiraBoard(board?.id ?? null, board?.interval ?? null, nudge);
  const fold = useMemo(() => foldBoard(list.issues), [list.issues]);
  const loaded = !list.loading && !(list.error && list.issues.length === 0);
  const shown: JiraBoardStatus | null =
    board !== null && list.polledAt !== null && newer(list.polledAt, board.polledAt) ? { ...board, polledAt: list.polledAt } : board;
  return { boards, board, unreadable, pick: setStored, list, fold, loaded, shown };
}

/** Whether stamp `a` is strictly later than `b` (an unparseable or absent `b` loses). */
function newer(a: string, b: string | null): boolean {
  const tb = b === null ? NaN : Date.parse(b);
  return Number.isNaN(tb) || Date.parse(a) > tb;
}
