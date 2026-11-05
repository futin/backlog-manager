import { useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useNow } from '../../hooks/useNow';
import { usePickedJiraBoard } from '../../hooks/usePickedJiraBoard';
import type { JiraChildrenIndex } from '../../lib/jira';
import type { JiraPage } from '../../lib/jira-page';
import type { JiraAction, JiraIssue } from '../../../../shared/types';
import { Band } from '../ui/Band';
import { Chip } from '../ui/Chip';
import { JiraBoardPicker } from './JiraBoardPicker';
import { JiraSessionList } from './JiraSessionList';

/**
 * Jira › Sessions — the session table on a page of its own (Sessions-page spec, "Jira › Sessions"; mocks `SessionsB.dc.html` for the band and
 * `SessionTable.dc.html` for the table, which is `JiraSessionList` as it was on the Board's List view, unrestyled).
 *
 * **It loads the picked board exactly as the Board page does** — `usePickedJiraBoard`, the one stored pick under `JIRA_BOARD_KEY` (C4) and the same `nudge` — because
 * `JiraSessionList` scopes its rows and stubs the off-board ones from the board's loaded `issues` and the fold's `childrenOf`. A pick made here is the Board
 * page's pick, and a write landed in Detail re-reads this list at once, as it does there. It starts no poll: the sessions are `useJiraSessionsContext`'s one answer.
 *
 * **The List's bar is drawn in every state** (C8). Whatever the board is doing, `JiraSessionList` always mounts and is handed `unavailable` — the Board page's
 * own words, in its precedence (unreadable config, no board, still loading, failed) — and itself decides that the body gives way to the line only while
 * `All tickets` is off: with it on the table is scoped to every linked ticket and "what needs me" does not wait on a board read. The band says what is wrong
 * with the board either way, and the picker is drawn only when there are boards to pick from and the config could be read.
 *
 * **Search is this page's own state**, `Search sessions` over key, summary, repo and branch — no longer the issue search the Board's List shared. There is no
 * FilterBar (the List's bar carries the session filters) and no Board | List switch; the rail is the only page switch (DESIGN.md §8.0).
 */
export function JiraSessionsView({
  onOpenJiraPage,
  onOpenIssue,
  onRun,
  nudge
}: {
  onOpenJiraPage: (p: JiraPage) => void;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  nudge: number;
}) {
  const { data } = useJiraContext();
  const { boards, board, unreadable, pick, list, fold, loaded } = usePickedJiraBoard(nudge);
  const now = useNow(true);
  const [search, setSearch] = useState('');

  // The Board page's states, in its precedence: a config that cannot be read hides everything, no board comes next, then the list's own loading/failure.
  const unavailable =
    unreadable !== null ? (
      `jira.json cannot be read — ${unreadable}`
    ) : board === null ? (
      <>
        No boards yet
        <Chip size={28} onClick={() => onOpenJiraPage('setup')}>
          Open Setup
        </Chip>
      </>
    ) : loaded ? null : list.loading ? (
      'loading…'
    ) : (
      'board unavailable'
    );
  const sub = unreadable !== null ? 'jira.json cannot be read' : board === null ? 'no board to scope to' : `${board.name} · ${data?.site ?? ''}`;

  return (
    <div className="board">
      <Band title="Sessions" sub={sub}>
        {boards.length > 0 && unreadable === null && board !== null && <JiraBoardPicker boards={boards} current={board} onPick={pick} />}
        <input
          type="search"
          className="board-band-search"
          aria-label="Search sessions"
          placeholder="search key, summary, repo, branch"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </Band>
      <JiraSessionList
        issues={loaded ? list.issues : []}
        search={search}
        now={now}
        childrenOf={fold.childrenOf}
        onOpenIssue={onOpenIssue}
        onRun={onRun}
        unavailable={unavailable}
      />
    </div>
  );
}
