import { useMemo, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraBoard } from '../../hooks/useJiraBoard';
import { useNow } from '../../hooks/useNow';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  JIRA_BOARD_KEY,
  JIRA_COLUMNS,
  NO_JIRA_FILTERS,
  bandSub,
  boardFilterCount,
  boardFilterOptions,
  boardsByName,
  cardFold,
  columnOf,
  effectiveBoardFilters,
  foldBoard,
  matchesBoardFilters,
  pickBoard,
  sortTops,
  type JiraAssigneeFilter,
  type JiraBoardFilters,
  type JiraChildrenIndex
} from '../../lib/jira';
import type { JiraPage } from '../../lib/jira-page';
import type { JiraBoardStatus, JiraIssue } from '../../../../shared/types';
import { BoardColumn } from '../board/BoardColumn';
import { FilterBar, FilterSection } from '../FilterBar';
import { Band } from '../ui/Band';
import { Chevron } from '../ui/Chevron';
import { Chip } from '../ui/Chip';
import { Popover } from '../ui/Popover';
import { JiraCard } from './JiraCard';

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
 * (`effectiveBoardFilters`), so switching boards cannot leave the columns emptied by a filter the panel no longer draws.
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
 * modal's Children tree can reach the grandchildren the detail read does not return without a Jira call of its own (grouped-board spec §6). No `Run ▾` and
 * no live strip: phase 5.
 */
export function JiraBoardView({
  onOpenJiraPage,
  onOpenIssue
}: {
  onOpenJiraPage: (p: JiraPage) => void;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex) => void;
}) {
  const { data } = useJiraContext();
  const [stored, setStored] = usePersistedState<unknown>(JIRA_BOARD_KEY, null);
  const boards = data?.boards ?? [];
  const unreadable = data?.configUnreadable ?? null;
  // Resolved against the live list every render; `null` while unreadable, so nothing is requested from a board list the server could not read.
  const board = unreadable === null ? pickBoard(stored, boards) : null;
  // The ONLY id this page ever asks the server about (Review Focus 3).
  const list = useJiraBoard(board?.id ?? null, board?.interval ?? null);
  // Card ages are relative (`now`, `4m`, `2h`, `6d`), so a minute's tick is plenty; the band's seconds have their own clock below.
  const now = useNow(true);

  const [filters, setFilters] = useState<JiraBoardFilters>(NO_JIRA_FILTERS);
  const set = <K extends keyof JiraBoardFilters>(key: K, value: JiraBoardFilters[K]): void => setFilters((f) => ({ ...f, [key]: value }));

  const me = data?.me ?? null;
  const options = useMemo(() => boardFilterOptions(list.issues), [list.issues]);
  const applied = useMemo(() => effectiveBoardFilters(filters, options, me), [filters, options, me]);
  const fold = useMemo(() => foldBoard(list.issues), [list.issues]);
  // Memoised on the fold and the filters, so the minute tick above re-renders the cards without re-filtering and re-sorting up to 500 issues.
  const columns = useMemo(() => {
    const kept = fold.tops.filter((i) => matchesBoardFilters(i, applied, me));
    return JIRA_COLUMNS.map((col) => ({
      ...col,
      cards: sortTops(
        kept.filter((i) => columnOf(i) === col.slug),
        fold.under
      ).map((issue) => ({ issue, fold: cardFold(issue.key, fold) }))
    }));
  }, [fold, applied, me]);
  // "The list has loaded" is the condition the columns below are drawn under, read once so the band and the columns cannot disagree about it.
  const loaded = !list.loading && !(list.error && list.issues.length === 0);

  if (unreadable !== null || board === null) {
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

  const shown: JiraBoardStatus = list.polledAt !== null && newer(list.polledAt, board.polledAt) ? { ...board, polledAt: list.polledAt } : board;

  return (
    <div className="board">
      <Band
        title={board.name}
        sub={<BandSub board={shown} site={data?.site ?? ''} fold={loaded ? { issues: list.issues.length, cards: fold.tops.length } : null} />}
      >
        <BoardPicker boards={boards} current={board} onPick={setStored} />
        <input
          type="search"
          className="board-band-search"
          aria-label="Search issues"
          placeholder="search summaries"
          value={filters.search}
          onChange={(e) => set('search', e.target.value)}
        />
        {/* One element in one place on every render, for the reason BoardView gives at length: `FilterBar` keeps which panel is open in its own state and a
            pick does not close it, so a remount on a pick would shut the panel under the reader's pointer. */}
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
        <div className="board-columns jira-board-columns">
          {columns.map((col) => (
            <BoardColumn key={col.slug} slug={col.slug} label={col.label} count={col.cards.length}>
              {col.cards.map((c) => (
                <JiraCard
                  key={c.issue.key}
                  issue={c.issue}
                  board={board}
                  me={me}
                  now={now}
                  fold={c.fold}
                  matches={[]}
                  onOpen={(issue) => onOpenIssue(issue, fold.childrenOf)}
                />
              ))}
            </BoardColumn>
          ))}
        </div>
      ) : (
        <div className="board-empty">{list.loading ? 'loading…' : 'board unavailable'}</div>
      )}
    </div>
  );
}

/** Whether stamp `a` is strictly later than `b` (an unparseable or absent `b` loses). */
function newer(a: string, b: string | null): boolean {
  const tb = b === null ? NaN : Date.parse(b);
  return Number.isNaN(tb) || Date.parse(a) > tb;
}

/**
 * The band's sub-line on its own one-second clock: `polled 12 s ago` needs seconds, and ticking the whole page for it would re-render every card once a
 * second for a date that changes once a day. `.failing` is the red reading — the class rather than a colour on the text, so the theme owns the red.
 */
function BandSub({ board, site, fold }: { board: JiraBoardStatus; site: string; fold: { issues: number; cards: number } | null }) {
  const now = useNow(true, 1_000);
  const sub = bandSub(board, site, now, fold);
  return <span className={sub.failing ? 'jira-band-sub failing' : 'jira-band-sub'}>{sub.text}</span>;
}

/**
 * The board picker: a `Chip` reading the board's name that opens a `Popover` listing every board by name — pick only (spec §1: Edit and New belong to
 * Setup). A pick stores the board's id and closes the panel; nothing else happens, because what the page draws follows from the stored id alone. The chip is
 * the popover's anchor (its own click toggles; Escape hands focus back to it), which is what `Chip`'s ref is for.
 */
function BoardPicker({ boards, current, onPick }: { boards: readonly JiraBoardStatus[]; current: JiraBoardStatus; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  return (
    <div className="jira-picker">
      <Chip
        ref={chip}
        aria-label={`Pick a Jira board: ${current.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="jira-picker-name">{current.name}</span>
        <Chevron dir={open ? 'up' : 'down'} />
      </Chip>
      {open && (
        <Popover label="Boards" width={320} anchor={chip} onClose={() => setOpen(false)}>
          {boardsByName(boards).map((b) => (
            <button
              key={b.id}
              type="button"
              className={b.id === current.id ? 'jira-picker-opt on' : 'jira-picker-opt'}
              aria-pressed={b.id === current.id}
              onClick={() => {
                onPick(b.id);
                setOpen(false);
              }}
            >
              <span>{b.name}</span>
              <svg className="jira-picker-tick" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 10.5l4 4 8-9" />
              </svg>
            </button>
          ))}
        </Popover>
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
