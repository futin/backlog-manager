import { useMemo, useRef, useState } from 'react';

import { useFetched } from '../../hooks/useFetched';
import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { useJiraView } from '../../hooks/useJiraView';
import { useNow } from '../../hooks/useNow';
import { usePickedJiraBoard } from '../../hooks/usePickedJiraBoard';
import {
  NO_JIRA_FILTERS,
  boardFilterCount,
  boardFilterOptions,
  effectiveBoardFilters,
  fetchJiraWorktrees,
  foldMatches,
  matchesBoardFilters,
  sortTops,
  ticketWorktrees,
  type JiraAssigneeFilter,
  type JiraBoardFilters,
  type JiraChildrenIndex
} from '../../lib/jira';
import { boardAgents, boardShelves, topSessionState } from '../../lib/jira-deck';
import type { JiraPage } from '../../lib/jira-page';
import type { JiraAction, JiraIssue, JiraLiveSession, JiraWorktree, JiraWorktreesPayload } from '../../../../shared/types';
import { FilterBar, FilterSection } from '../FilterBar';
import { Band } from '../ui/Band';
import { Chip } from '../ui/Chip';
import { JiraAgentDeck } from './JiraAgentDeck';
import { JiraBandSub } from './JiraBandSub';
import { JiraBoardPicker } from './JiraBoardPicker';
import { JiraIssueList } from './JiraIssueList';
import { JiraShelves } from './JiraShelves';
import { JiraViewSwitch } from './JiraViewSwitch';

/** The status while it is unknown: no sessions. One object, so `live` is not a fresh `{}` per render. */
const NO_LIVE: Readonly<Record<string, JiraLiveSession>> = {};
const NO_TREES: readonly JiraWorktree[] = [];

/**
 * Jira › Board — one tracked board's issues in three status-category columns (Jira phase 2, spec §6.2; DESIGN.md §8.9.1, which applies §8.3's Board).
 *
 * **Which board, and the one request that must never be made** (Review Focus 3). The browser remembers a board under `backlog-manager.jira-board`, but what
 * it remembers is only a preference: `pickBoard` resolves it against the status's live list on every render, and `useJiraBoard` is handed ONLY the id of the
 * board that resolution returns — never the stored value. A board deleted here or in another browser, a hand-edited key, a number: each falls to the first
 * board by name, and the page never asks the server for `/boards/<that id>/issues`. The stored value is left as it is (a pick is written only by a pick), so
 * a board that comes back — the file restored, the other browser's delete undone — is drawn again without anyone choosing it twice.
 *
 * **The band.** Title = the board's name; the sub-line is `bandSub`'s text, red (`.failing`) while the last sweep could not read a root or a query. Its age
 * is the NEWER of the two readings the page holds — the board list's own `polledAt` (read every `BOARD_TRACKER_POLL_MS`) over the status's, when the list
 * has one — and it ticks every second in its own small component, so the clock re-renders one line and not every card. The right slot holds the picker (a
 * `Chip` naming the board, opening a `Popover` of every board by name — pick only: `Edit` and `New` are Setup's, spec §1), the summary search, and the filter
 * track.
 *
 * **Filters are per mount** (the global constraints): type, assignee (`anyone` / `me` / `unassigned`; no `me` while the identity is unknown) and sprint, all
 * read off the LOADED list, plus the search over key and summary — none persisted, none a request. A pick the current list no longer offers reads as "any"
 * (`effectiveBoardFilters`), so switching boards cannot leave the columns emptied by a filter the panel no longer draws. The options read EVERY loaded
 * issue, folded or not, so a type only sub-tasks carry is still pickable; and a filter finds folded issues through their top card (F1, `foldMatches`),
 * which is shown ringed with the match named rather than hidden — a fold must never make a matching issue unfindable (grouped-board spec §5).
 *
 * **The shapes that are not a board.** `configUnreadable` → `jira.json cannot be read — <reason>` (Review Focus 2): the credentials are in `.env`, so the
 * status still says `configured`, but the boards could not be read, and `No boards yet` would invite the reader to create a board the server would refuse to
 * write. No picker then, and no chip: Setup cannot fix a file that does not parse. No boards at all → `No boards yet`, with a chip to Setup that is
 * `onOpenJiraPage('setup')` — the rail's own navigation threaded down from `App`, so it means what the tree's `Setup` entry means by construction and is not a
 * second page switch (the section has no in-page switch at any width, spec §6.1). A board with no issues draws its three empty columns.
 *
 * **One card per top issue** (grouped-board spec §3–§4; DESIGN.md §8.9.1). `foldBoard` folds every on-board descendant into its topmost on-board ancestor,
 * and the columns draw only the tops — each in its OWN status category's column, whatever its folded issues' columns are — ordered by `sortTops` (the
 * newest `updated` across the top and everything under it). This page never walks a parent chain itself: the fold is the one walk, and the columns, the
 * band's counts and the click below all read its result. The column count pill counts cards. The fold is memoised on the list, so the minute tick
 * re-renders the cards without re-folding up to 500 issues.
 *
 * **The band's numbers are the LOADED list's**, unfiltered: its length and its tops, so `17 issues · 5 cards` counts one list — not the status poll's
 * `board.count`, a different poller one interval apart. They are passed only once the list has loaded, which is exactly the condition under which the
 * columns are drawn (not loading, and not a failed first read with nothing in hand); before that the band reads today's line from `board.count`, so it
 * can never claim cards the columns are not drawing.
 *
 * Clicking a card calls `onOpenIssue(issue, childrenOf)` — the slot the issue modal fills, plus the fold's parent → children index as a snapshot, so the
 * modal's Children tree can reach the grandchildren the detail read does not return without a Jira call of its own (grouped-board spec §6).
 *
 * **The Board is an agent deck over status shelves** (Jira sessions spec §7.1, C1, C8; DESIGN.md §8.9.1). `lib/jira-deck.ts` derives both from the fold, the
 * ONE sessions answer (`useJiraSessionsContext` — this page starts no poll of its own) and the status's `live` (a Starting reservation has no link yet):
 * `JiraAgentDeck` draws a card per live session, `JiraShelves` the tops no live session took, cut at 8 / 8 / 3 with `+ N more`. The band's Board | List
 * switch sits before the picker. `Run ▾` is the card's and `onRun` passes straight through; this page hosts NO sheet. `JiraView` does, one for the whole
 * section, because the sheet has to mount above an open modal as well and the modal is not this page's child.
 *
 * **The List is the same page's other view** (Sessions-page spec): it replaces the deck and the shelves with an issue table. The session table it used to
 * hold is Jira › Sessions' (`JiraSessionsView`). `FilterBar` and the issue search are drawn in both views — type, assignee and sprint describe an issue, and the
 * List's rows are issues now. The band's sub stays the board's (`bandSub`) in either view.
 *
 * **Worktree chips** (Jira repo/branch, spec §5.5; DESIGN.md §8.9.1). The page reads `GET /api/jira/worktrees` ONCE on mount and again only when the SET of
 * live keys changes — a Start or a Stop landing — compared as a sorted, joined key list, so a status reload that hands back a
 * new `live` object with the same keys, or a render, asks for nothing. It is not a poller: nothing runs on a clock, and a tree made in a terminal shows up at
 * the next mount or live change. That includes a Start's own tree (final review, M5): the session cuts it with `jira.mjs worktree` some time after the key
 * goes live, so the re-read that Start triggers usually lands before the tree exists, and its chip appears on the next change of live keys or a remount.
 * A failed read is not an error state — no chip is drawn and nothing is said, because the chip is a convenience and Setup is
 * where the trees' health is. While a re-read is out the previous answer stays drawn, so a chip does not blink off between a Start and its answer.
 *
 * `nudge` is `JiraView`'s write counter (Jira phase 3, R7), handed to `useJiraBoard` as given: this page neither reads nor bumps it, so a write in the modal
 * re-reads the list without the modal and the board knowing about each other.
 */
export function JiraBoardView({
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
  const { boards, board, unreadable, pick, list, fold, loaded, shown } = usePickedJiraBoard(nudge);
  // Card ages are relative (`now`, `4m`, `2h`, `6d`), so a minute's tick is plenty; the band's seconds have their own clock below.
  const now = useNow(true);

  const [filters, setFilters] = useState<JiraBoardFilters>(NO_JIRA_FILTERS);
  const set = <K extends keyof JiraBoardFilters>(key: K, value: JiraBoardFilters[K]): void => setFilters((f) => ({ ...f, [key]: value }));

  const me = data?.me ?? null;
  const live = data?.live ?? NO_LIVE;
  // The set of live keys as a string, so the worktrees read below is keyed on WHICH keys are live and not on the `live` object's identity.
  const liveKeys = Object.keys(live).sort().join(',');
  const worktrees = useFetched(board === null ? null : () => fetchJiraWorktrees(), [liveKeys]);
  const lastTrees = useRef<JiraWorktreesPayload | null>(null);
  if (worktrees.status === 'ok') lastTrees.current = worktrees.value;
  else if (worktrees.status === 'failed') lastTrees.current = null;
  const treesOf = (key: string): readonly JiraWorktree[] => (lastTrees.current === null ? NO_TREES : ticketWorktrees(key, lastTrees.current));
  const options = useMemo(() => boardFilterOptions(list.issues), [list.issues]);
  const applied = useMemo(() => effectiveBoardFilters(filters, options, me), [filters, options, me]);
  const sessions = useJiraSessionsContext();
  const [view] = useJiraView();
  // Memoised on the fold, the filters and the sessions answer — never on `now`, so the minute tick re-ages the cards without re-folding or re-filtering up
  // to 500 issues. F1 (grouped-board spec §5): a top is kept when it matches or when an issue folded under it does, with that issue's key to ring it by.
  // The deck and the shelves read the same `kept`, so one filter answers for both; which tops a live session took OFF the shelves is `boardAgents`' call on
  // the UNFILTERED fold, so a filter never puts a ticket on a shelf and on the deck at once.
  const { deck, shelves, rows, cellStates } = useMemo(() => {
    const kept = foldMatches(fold, (i) => matchesBoardFilters(i, applied, me));
    const agents = boardAgents(fold, sessions.data, live);
    return {
      deck: agents.filter((e) => kept.has(e.top.key)),
      shelves: boardShelves(fold, kept, agents, sessions.data),
      // The List's rows: every kept top, `sortTops` order, no cut. The Session cell reads the UNFILTERED `agents`, so a top's cell names the deck's lead session
      // for that card even when a filter would have dropped that session's own ticket from the deck (the card is the top; the filter kept the top).
      rows: sortTops(fold.tops.filter((t) => kept.has(t.key)), fold.under),
      cellStates: topSessionState(agents)
    };
  }, [fold, applied, me, sessions.data, live]);

  if (unreadable !== null || board === null || shown === null) {
    return (
      <div className="board">
        <Band title="Jira" />
        {unreadable !== null ? (
          <div className="board-empty">jira.json cannot be read — {unreadable}</div>
        ) : (
          <div className="board-empty">
            No boards yet
            <Chip size={28} onClick={() => onOpenJiraPage('setup')}>
              Open Setup
            </Chip>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="board">
      <Band
        title={board.name}
        sub={<JiraBandSub board={shown} site={data?.site ?? ''} fold={loaded ? { issues: list.issues.length, cards: fold.tops.length } : null} />}
      >
        <JiraViewSwitch />
        <JiraBoardPicker boards={boards} current={board} onPick={pick} />
        <input
          type="search"
          className="board-band-search"
          aria-label="Search issues"
          placeholder="search summaries"
          value={filters.search}
          onChange={(e) => set('search', e.target.value)}
        />
        {/* One element in one place on every render, for the reason BoardView gives at length: `FilterBar` keeps which panel is open in its own state
            and a pick does not close it, so a remount on a pick — or on a Board | List switch — would shut the panel under the reader's pointer. Drawn in
            both views since the List became an issue table: its type, assignee and sprint describe issues, as the Board's do. */}
        <FilterBar count={boardFilterCount(applied)} onClear={() => setFilters((f) => ({ ...NO_JIRA_FILTERS, search: f.search }))}>
            <Picks title="Type" all="All types" values={options.types} value={applied.type} onPick={(v) => set('type', v ?? undefined)} />
            <FilterSection title="Assignee">
              <div className="filter-bar-picks" role="group" aria-label="Assignee">
                {(['anyone', 'me', 'unassigned'] as JiraAssigneeFilter[])
                  .filter((a) => a !== 'me' || me !== null)
                  .map((a) => (
                    <Chip key={a} size={28} pressed={applied.assignee === a} onClick={() => set('assignee', a)}>
                      {a}
                    </Chip>
                  ))}
              </div>
            </FilterSection>
            <Picks
              title="Sprint"
              all="All sprints"
              values={options.sprints}
              value={applied.sprint}
              none={options.noSprint ? 'no sprint' : undefined}
              onPick={(v) => set('sprint', v)}
            />
        </FilterBar>
      </Band>

      {loaded ? (
        view === 'list' ? (
          <JiraIssueList
            tops={rows}
            fold={fold}
            sessions={cellStates}
            now={now}
            filtered={boardFilterCount(applied) > 0 || filters.search.trim() !== ''}
            onOpenIssue={onOpenIssue}
          />
        ) : (
          <>
            <JiraAgentDeck entries={deck} now={now} onOpenIssue={(issue) => onOpenIssue(issue, fold.childrenOf)} />
            <JiraShelves
              shelves={shelves}
              board={board}
              me={me}
              now={now}
              treesOf={treesOf}
              childrenOf={fold.childrenOf}
              onOpenIssue={onOpenIssue}
              onRun={onRun}
            />
          </>
        )
      ) : (
        <div className="board-empty">{list.loading ? 'loading…' : 'board unavailable'}</div>
      )}
    </div>
  );
}

/**
 * One single-select chip group with an "any" chip first — `ProjectPicks`' shape, for the type and sprint filters. `undefined` is "any"; `none`, when given,
 * adds a last chip for the `null` pick (`no sprint`), drawn only when some loaded issue has no value at all. Pressed is `Chip`'s own pressed look, never the
 * ink fill, for the reason `ProjectPicks` gives.
 */
function Picks({
  title,
  all,
  values,
  value,
  none,
  onPick
}: {
  title: string;
  all: string;
  values: string[];
  value: string | null | undefined;
  none?: string;
  onPick: (v: string | null | undefined) => void;
}) {
  return (
    <FilterSection title={title}>
      <div className="filter-bar-picks" role="group" aria-label={title}>
        <Chip size={28} pressed={value === undefined} onClick={() => onPick(undefined)}>
          {all}
        </Chip>
        {values.map((v) => (
          <Chip key={v} size={28} pressed={value === v} onClick={() => onPick(v)}>
            {v}
          </Chip>
        ))}
        {none !== undefined && (
          <Chip size={28} pressed={value === null} onClick={() => onPick(null)}>
            {none}
          </Chip>
        )}
      </div>
    </FilterSection>
  );
}
