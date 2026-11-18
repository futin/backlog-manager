import { useMemo, useRef, useState } from 'react';

import { useFetched } from '../../hooks/useFetched';
import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { useJiraView } from '../../hooks/useJiraView';
import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import { useLaneFolds } from '../../hooks/useLaneFolds';
import { useNow } from '../../hooks/useNow';
import { useOffBoardParent } from '../../hooks/useOffBoardParent';
import { usePickedJiraBoard } from '../../hooks/usePickedJiraBoard';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  JIRA_FILTERS_KEY,
  NO_JIRA_PANEL_FILTERS,
  boardFilterCount,
  clampJiraPanelFilters,
  boardFilterOptions,
  effectiveBoardFilters,
  fetchJiraWorktrees,
  laneViews,
  matchesBoardFilters,
  ticketWorktrees,
  type JiraAssigneeFilter,
  type JiraBoardFilters,
  type JiraChildrenIndex,
  type JiraPanelFilters
} from '../../lib/jira';
import { DELIVERY_FILTER_LABELS, effectiveDeliveryFilter, matchesDelivery, ticketDelivery, type DeliveryFilter } from '../../lib/delivery';
import { boardAgents, endedByKey, sessionCells } from '../../lib/jira-deck';
import type { JiraPage } from '../../lib/jira-page';
import type { JiraAction, JiraIssue, JiraLiveSession, JiraWorktree, JiraWorktreesPayload } from '../../../../shared/types';
import { FilterBar, FilterSection } from '../FilterBar';
import { Band } from '../ui/Band';
import { Chip } from '../ui/Chip';
import { Segmented } from '../ui/Segmented';
import { GitlabBandLine } from './GitlabBandLine';
import { JiraAgentDeck } from './JiraAgentDeck';
import { JiraBandSub } from './JiraBandSub';
import { JiraBoardPicker } from './JiraBoardPicker';
import { JiraIssueList } from './JiraIssueList';
import { JiraLaneBoard } from './JiraLaneBoard';
import { JiraViewSwitch } from './JiraViewSwitch';

/** The quick filter's options, in the mock's order (`List.dc.html`): one list for the panel's chips and the List's segmented control. */
const DELIVERY_OPTIONS = (Object.keys(DELIVERY_FILTER_LABELS) as DeliveryFilter[]).map((value) => ({ value, label: DELIVERY_FILTER_LABELS[value] }));

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
 * track. Under the sub-line, while GitLab is shown, `GitlabBandLine` adds `GitLab: N open · N failing · N merged · polled <age>` over the shown tops
 * (GitLab connection spec §7.2) — unlike the sub-line's counts, AFTER the filters, because it answers "how is the work I am looking at doing".
 *
 * **The panel filters persist; the search is per mount**: type, status (multi-select, by name), assignee (`anyone` / `me` / `unassigned`; no `me` while
 * the identity is unknown) and sprint, all read off the LOADED list and stored under `JIRA_FILTERS_KEY` (one value for every board — `JiraBoardFilters`
 * says why the panel persists and the search does not), plus the search over key and summary, held in this mount only — none a request. A pick the current list
 * no longer offers reads as "any" (`effectiveBoardFilters`), so switching boards cannot leave the columns emptied by a filter the panel no longer draws. The
 * options read EVERY loaded issue, so a type only sub-tasks carry is still pickable. On the Board a filter matches per issue (parent-lanes spec §6.2): a card
 * shows when it matches, a header when it or anything under it does, and nothing is ringed — no issue is hidden under another any more. The List reads the
 * same filtered lanes, so a filter narrows its rows per issue too.
 *
 * **The shapes that are not a board.** `configUnreadable` → `jira.json cannot be read — <reason>` (Review Focus 2): the credentials are in `.env`, so the
 * status still says `configured`, but the boards could not be read, and `No boards yet` would invite the reader to create a board the server would refuse to
 * write. No picker then, and no chip: Setup cannot fix a file that does not parse. No boards at all → `No boards yet`, with a chip to Setup that is
 * `onOpenJiraPage('setup')` — the rail's own navigation threaded down from `App`, so it means what the tree's `Setup` entry means by construction and is not a
 * second page switch (the section has no in-page switch at any width, spec §6.1). A board with no issues draws the column header with zeros and `No issues`.
 *
 * **One lane per parent** (parent-lanes spec §3; DESIGN.md §8.9.1). `laneBoard` (through `usePickedJiraBoard`) is the one walk: every issue with an
 * on-board child is a lane header, every other issue a card in its parent's lane — an on-board header, an off-board stub, or `No parent`. This page only
 * filters it (`laneViews`) and hands the same views to `JiraLaneBoard` and to the List; it never walks a parent chain itself. The walk is memoised on the list, so the minute tick
 * re-renders the cards without re-walking up to 500 issues. The band's `N cards` still counts the fold's tops (`fold.tops`).
 *
 * **The band's numbers are the LOADED list's**, unfiltered: its length and its tops, so `17 issues · 5 cards` counts one list — not the status poll's
 * `board.count`, a different poller one interval apart. They are passed only once the list has loaded, which is exactly the condition under which the
 * columns are drawn (not loading, and not a failed first read with nothing in hand); before that the band reads today's line from `board.count`, so it
 * can never claim cards the columns are not drawing.
 *
 * Clicking a card calls `onOpenIssue(issue, childrenOf)` — the slot the issue modal fills, plus the lanes' parent → children index as a snapshot, so the
 * modal's Children tree can reach the grandchildren the detail read does not return without a Jira call of its own (grouped-board spec §6).
 *
 * **The Board is an agent deck over the lanes** (Jira sessions spec §7.1; parent-lanes D7; DESIGN.md §8.9.1). `lib/jira-deck.ts` derives both from the
 * ONE sessions answer (`useJiraSessionsContext` — this page starts no poll of its own) and the status's `live` (a Starting reservation has no link yet):
 * `JiraAgentDeck` draws a card per live session, filtered by the session's OWN issue, and a live card stays in its lane cell with its state line
 * (`sessionCells`), so a session shows in both places. The band's Board | List
 * switch sits before the picker. `Run ▾` is the card's and `onRun` passes straight through; this page hosts NO sheet. `JiraView` does, one for the whole
 * section, because the sheet has to mount above an open modal as well and the modal is not this page's child.
 *
 * **The List is the same page's other view** (Sessions-page spec; parent-lanes spec §4): it replaces the deck and the lane grid with an issue table whose
 * rows are the same lanes — a header row per lane, its card rows under it. The two views share ONE fold state and ONE off-board read, both owned here
 * (`useLaneFolds`, `useOffBoardParent`) and handed to whichever view is drawn: the fold store is per instance (it reads storage on mount), so a hook inside
 * each view would let a fold made in one view go unseen by the other until a reload, and a read started in one could open Detail after a switch to the other
 * with no record of being the newest click. The session table the List used to hold is Jira › Sessions' (`JiraSessionsView`). `FilterBar` and the issue search are drawn in both views — type, assignee and sprint describe an issue, and the
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
  const { boards, board, unreadable, pick, list, fold, lanes, loaded, shown } = usePickedJiraBoard(nudge);
  // Card ages are relative (`now`, `4m`, `2h`, `6d`), so a minute's tick is plenty; the band's seconds have their own clock below.
  const now = useNow(true);

  // The panel's four filters survive a reload (`JIRA_FILTERS_KEY`); the search does not (`JiraBoardFilters` says why). What comes back from storage is
  // clamped on every read, so a hand-edited or older-build value can be a wrong shape and still never reach `effectiveBoardFilters` as one.
  const [stored, setStored] = usePersistedState<JiraPanelFilters>(JIRA_FILTERS_KEY, NO_JIRA_PANEL_FILTERS);
  const panel = useMemo(() => clampJiraPanelFilters(stored), [stored]);
  const [search, setSearch] = useState('');
  const filters = useMemo<JiraBoardFilters>(() => ({ ...panel, search }), [panel, search]);
  const set = <K extends keyof JiraPanelFilters>(key: K, value: JiraPanelFilters[K]): void => setStored({ ...panel, [key]: value });

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
  // GitLab's index, or null while delivery is not shown. Both delivery controls and the filter's effect hang on it: a stored value reads as `all` when it is
  // null, so a filter the reader cannot see or clear never empties the board or lights the badge (spec §7.4, Review Focus 5).
  const deliveryIndex = useDeliveryIndex();
  const applied = useMemo(() => {
    const f = effectiveBoardFilters(filters, options, me);
    return { ...f, delivery: effectiveDeliveryFilter(f.delivery, deliveryIndex !== null) };
  }, [filters, options, me, deliveryIndex]);
  const sessions = useJiraSessionsContext();
  const [view] = useJiraView();
  // Memoised on the fold, the lanes, the filters, the sessions answer and the minute's `now` — `now` only since the `Review open` filter, whose match
  // depends on the clock (a stuck review stops reading `reviewing`); neither model is rebuilt by it, and the filter pass over up to 500 issues is a map
  // lookup each. ONE predicate answers for every surface (parent-lanes spec §3.5): the panel's filters and the search AND, while a delivery filter is picked
  // and GitLab's index is loaded, the issue's OWN delivery. Filters match per issue — no fold, so no F1 ring: a lane is drawn when its subtree holds a match
  // or its own header matches (`laneViews`), and the deck keeps a live session whose own ticket matches.
  const { views, deck, matching, cells, ended } = useMemo(() => {
    const byDelivery = applied.delivery === 'all' || deliveryIndex === null ? null : (i: JiraIssue) => matchesDelivery(applied.delivery, ticketDelivery(i, deliveryIndex), now);
    const matches = (i: JiraIssue): boolean => matchesBoardFilters(i, applied, me) && (byDelivery === null || byDelivery(i));
    const agents = boardAgents(fold, sessions.data, live);
    return {
      views: laneViews(lanes, matches),
      deck: agents.filter((e) => matches(e.issue)),
      matching: list.issues.filter(matches),
      // A card's session reading is keyed by its OWN key, read off the UNFILTERED agents, so a card a filter keeps says its session even when the deck's
      // copy of that session is filtered out — the deck filters by the session's ticket, the card IS that ticket, so the two never disagree in practice.
      cells: sessionCells(agents, sessions.data?.links ?? []),
      ended: endedByKey(sessions.data)
    };
  }, [fold, lanes, list.issues, applied, me, sessions.data, live, deliveryIndex, now]);
  // A typed search opens every lane and locks the chevrons (spec §3.6) — exactly when `matchesBoardFilters` reads `search` as a filter at all.
  const searching = filters.search.trim() !== '';
  // The folds and the off-board read are the page's, not a view's (see "The List is the same page's other view" above), and are called before the early
  // return below so the hook order never changes. The folds are handed the UNFILTERED lanes, so a toggle under a filter never prunes an override for a lane
  // that is only hidden; `drawnOff` is the off-board lanes the filter leaves, which the read checks when an answer lands.
  const folds = useLaneFolds(board?.id ?? null, lanes, searching);
  // An off-board lane is always a root (`laneBoard`: nothing on the board says what is above it), so the root views are every one there is.
  const drawnOff = useMemo(() => new Set(views.filter((v) => v.lane.kind === 'off').map((v) => v.lane.key)), [views]);
  const openWithTree = (issue: JiraIssue): void => onOpenIssue(issue, lanes.childrenOf);
  const read = useOffBoardParent(openWithTree, drawnOff);

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
        sub={
          <>
            <JiraBandSub board={shown} site={data?.site ?? ''} fold={loaded ? { issues: list.issues.length, cards: fold.tops.length } : null} />
            {/* GitLab's line counts the issues the filters keep — every matching issue, lane header or card — so a filter narrows it with the board
                (spec §7.2). Drawn only once the list has loaded: before that nothing matches and the line would read `no merge requests`. */}
            {loaded && <GitlabBandLine issues={matching} />}
          </>
        }
      >
        <JiraViewSwitch />
        <JiraBoardPicker boards={boards} current={board} onPick={pick} />
        <input
          type="search"
          className="board-band-search"
          aria-label="Search issues"
          placeholder="search summaries"
          value={filters.search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {/* One element in one place on every render, for the reason BoardView gives at length: `FilterBar` keeps which panel is open in its own state
            and a pick does not close it, so a remount on a pick — or on a Board | List switch — would shut the panel under the reader's pointer. Drawn in
            both views since the List became an issue table: its type, status, assignee and sprint describe issues, as the Board's do. */}
        <FilterBar
          count={boardFilterCount(applied)}
          showing={{ shown: matching.length, total: list.issues.length, note: 'options come from the loaded issues' }}
          onClear={() => setStored(NO_JIRA_PANEL_FILTERS)}>
            <Picks title="Type" all="All types" values={options.types} value={applied.type} onPick={(v) => set('type', v ?? undefined)} />
            {/* The one multi-select: a chip toggles its status in or out, `All statuses` empties the set. Toggled against `applied`, not `filters`, so a
                pick the board no longer offers is dropped by the next click rather than lingering unseen in state. */}
            <FilterSection title="Status">
              <div className="filter-bar-picks" role="group" aria-label="Status">
                <Chip size={28} pressed={applied.statuses.length === 0} onClick={() => set('statuses', [])}>
                  All statuses
                </Chip>
                {options.statuses.map((s) => (
                  <Chip
                    key={s}
                    size={28}
                    pressed={applied.statuses.includes(s)}
                    onClick={() => set('statuses', applied.statuses.includes(s) ? applied.statuses.filter((x) => x !== s) : [...applied.statuses, s])}>
                    {s}
                  </Chip>
                ))}
              </div>
            </FilterSection>
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
            {deliveryIndex !== null && (
              <FilterSection title="Delivery">
                <div className="filter-bar-picks" role="group" aria-label="Delivery">
                  {DELIVERY_OPTIONS.map((o) => (
                    <Chip key={o.value} size={28} pressed={applied.delivery === o.value} onClick={() => set('delivery', o.value)}>
                      {o.label}
                    </Chip>
                  ))}
                </div>
              </FilterSection>
            )}
        </FilterBar>
      </Band>

      {loaded ? (
        view === 'list' ? (
          <>
            {/* The same value as the panel's Delivery section, drawn again above the table (spec §7.4, mock `List.dc.html`): one filter, two controls. Kept
                outside `JiraIssueList` so it stays while the filter empties the table — the way back to `All` must not vanish with the rows. */}
            {deliveryIndex !== null && (
              <div className="jira-issues-quick">
                <Segmented<DeliveryFilter> label="Delivery" value={applied.delivery} options={DELIVERY_OPTIONS} onChange={(v) => set('delivery', v)} />
              </div>
            )}
            <JiraIssueList
              views={views}
              folds={folds}
              sessions={cells}
              parentOf={lanes.parentOf}
              site={data?.site ?? ''}
              read={read}
              now={now}
              filtered={boardFilterCount(applied) > 0 || searching}
              onOpenIssue={openWithTree}
              onRun={onRun}
            />
          </>
        ) : (
          <>
            <JiraAgentDeck entries={deck} now={now} onOpenIssue={openWithTree} />
            <JiraLaneBoard
              views={views}
              lanes={lanes}
              folds={folds}
              read={read}
              total={list.issues.length}
              cells={cells}
              ended={ended}
              treesOf={treesOf}
              board={board}
              me={me}
              now={now}
              site={data?.site ?? ''}
              onOpenIssue={openWithTree}
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
