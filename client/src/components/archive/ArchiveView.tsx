import { useMemo, useState } from 'react';

import { useAgents } from '../../hooks/useAgents';
import { useBoard } from '../../hooks/useBoard';
import { useNow } from '../../hooks/useNow';
import { useOrchestratorRuns } from '../../hooks/useOrchestratorRuns';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useSettings } from '../../hooks/useSettings';
import { groupByMonth } from '../../lib/item-month';
import { leavesBoard } from '../../lib/item-stale';
import { buildProjectHues } from '../../lib/project-hue';
import { PROJECT_KEY } from '../../lib/view-keys';
import { runClaimBlock } from '../../../../shared/agent';
import { ItemCard } from '../board/ItemCard';
import { ItemDrawer } from '../board/ItemDrawer';
import { LaunchSheet } from '../board/LaunchSheet';
import type { BacklogItem, Section } from '../../../../shared/types';

/**
 * Archive — the board's second surface: what is still actionable in principle
 * but not actionable now.
 *
 * Two populations, and they arrive by different routes. Open refactors, ideas
 * and bugs nobody has touched inside the staleness window fall in on their own,
 * without anyone deciding to; out-of-scope items were put here by a decision.
 * Neither is finished, which is the whole reason this is not a graveyard: both
 * can come back, by the two promotion paths below.
 *
 * The one predicate this surface has is `leavesBoard` (lib/item-stale.ts) —
 * the SAME implementation BoardView filters with, read from the other side,
 * never a second copy. That is what makes the two surfaces exactly
 * complementary: it already exempts tasks (a stale task keeps its Board column
 * and is marked instead) and already answers `false` for anything not `open`
 * (so a done item is in neither surface's columns, reachable only through the
 * Board's own Done filter). An item cannot be in both surfaces or in neither,
 * and no caller here re-decides any of that.
 *
 * `ALL` and the fetch-state ladder below are deliberately shaped like
 * BoardView's rather than merged with them: the two surfaces answer different
 * questions over one index, and the parts that must not drift — the staleness
 * rule, the action derivation, the card, the drawer, the sheet — are already
 * shared modules. What is restated here is the small amount that genuinely
 * differs, which is cheaper and more honest than a `<BoardSurface>` component
 * with a mode flag threading four behaviours through one render.
 */

/** The "not narrowed" sentinel, same value and same reasoning as BoardView's:
 *  a sentinel rather than '', so a stored value always reads as itself and
 *  never as "the field was cleared". */
const ALL = 'all';

/**
 * Archive's four fixed columns — the design's Refactoring · Ideas · Bugs ·
 * Out of scope.
 *
 * Three of the four are the Board's own sections seen from the far side of the
 * window, and they reuse the Board's `.board-col-<slug>` classes deliberately:
 * a refactor is magenta on both surfaces, because the tick is type identity and
 * type does not change when an item goes quiet. Out of scope has no tick colour
 * of its own and falls through to the default grey — correct, since a rejection
 * is a verdict rather than a type, and giving it an accent would put it in the
 * same visual vocabulary as the three columns that are still live work.
 *
 * No Tasks column, and that is the same rule stated from the other side:
 * `leavesBoard` never lets a task leave, so a Tasks column here could only ever
 * be empty.
 *
 * `slug` is the full section name — `oos` was retired along with the Board's
 * out-of-scope column and does not come back here.
 */
const COLUMNS: { section: Section; label: string; slug: string }[] = [
  { section: 'refactors', label: 'Refactoring', slug: 'refactors' },
  { section: 'ideas', label: 'Ideas', slug: 'ideas' },
  { section: 'bugs', label: 'Bugs', slug: 'bugs' },
  { section: 'out-of-scope', label: 'Out of scope', slug: 'out-of-scope' }
];

export default function ArchiveView() {
  const { items: index, projects, loading, error } = useBoard();
  /* Only `staleDays` is read, but the whole control comes back — `useSettings`
     falls back to the defaults outside a provider (see its own comment), which
     is what lets a test that never mounts one still get the documented 30-day
     window rather than undefined. Same arrangement BoardView has, and it has to
     be: the two surfaces split on this number, so they must read it from the
     same place. */
  const { settings } = useSettings();
  const { status: agents } = useAgents();
  /* The run payload, read by two things here and still by no strip or drawer —
     a run is queue work and this surface is what is not queue work.

     `leavesBoard` below is the second reader and the newer one (bug-11): the
     predicate that decides this surface's contents now takes the run payload,
     because an orchestrator stamps `started:` only inside its own worktree
     and so the item file both surfaces render cannot say a run is on it. That
     is what keeps a long-untouched bug a run has picked up on the Board
     instead of here. Archive gets it for free — the payload was already
     fetched on this line for the other reader — and gets it by construction,
     which is the point of the split living in lib/item-stale.ts rather than in
     either surface's own filter.

     `runClaimBlock` (`runBlockFor` below) is the older one. The hook polls
     only while some run is fresh (see useOrchestratorRuns), so an idle machine
     pays nothing for either. */
  const { runs } = useOrchestratorRuns();

  const [open, setOpen] = useState<BacklogItem | null>(null);
  const [dispatching, setDispatching] = useState<BacklogItem | null>(null);

  /* Persisted project filter, sharing the Board's key (lib/view-keys.ts). The
     query is plain useState and deliberately not remembered, for the reason
     BoardView states: a remembered query is a surface that opens showing three
     cards out of forty for no visible reason, where the select permanently
     states its own value. */
  const [query, setQuery] = useState('');
  const [project, setProject] = usePersistedState<string>(PROJECT_KEY, ALL);

  const all = index?.items ?? [];
  const registered = projects ?? [];

  /* Keyed on `projects`, not on `registered` — see BoardView's identical memo:
     `registered` is a fresh [] on every render while the fetch is in flight,
     which would make the memo a no-op and hand every card a new prop object on
     each keystroke in the search box. */
  const hues = useMemo(() => buildProjectHues(projects ?? []), [projects]);

  /* Fail-open on a stale stored project, same as the Board: an unmatched filter
     that emptied the surface would look like the server broke. The fallback
     feeds back into the select, so control and columns agree. */
  const knownPaths = new Set(registered.map((p) => p.path));
  const projectValue = knownPaths.has(project) ? project : ALL;

  /* `useNow(false)`: this surface can never hold a live card — an in-progress
     item is never stale (item-stale.ts sequences that rule ahead of the
     arithmetic) and an out-of-scope one is never in progress at all — so there
     is no elapsed reading here to go stale between events, and installing a
     minute timer would be a wakeup forever to re-render identical output. The
     hook still hands back a `Date.now()`, which is what the staleness
     comparison below needs. */
  const now = useNow(false);

  /*
   * Archive's contents, before the toolbar narrows them.
   *
   * The out-of-scope arm is a section check with no date in it at all, and that
   * asymmetry is the design's: a rejection belongs here on the strength of the
   * rejection, however recent it is. The other arm is the whole of the
   * staleness rule, delegated — never re-decided here.
   */
  const archived = all.filter(
    (i) => i.section === 'out-of-scope' || leavesBoard(i, settings.staleDays, now, runs)
  );

  const needle = query.trim().toLowerCase();
  /* Project and search, and nothing else. No status filter, deliberately and
     per the design: Archive's contents are defined by staleness and rejection,
     not by status, so a status select here would be a control that either does
     nothing or contradicts the surface it sits on. No sort control either —
     the month grouping below IS the ordering. */
  const visible = archived.filter(
    (i) =>
      (projectValue === ALL || i.projectPath === projectValue) &&
      (needle === '' || i.title.toLowerCase().includes(needle))
  );

  const missing = registered.filter((p) => p.missing);
  /* Reported here as well as on the Board. A registered path with no `backlog/`
     is a fact about the corpus rather than about a surface, and Archive can be
     the section this app opens on (Settings' `landing`), so a reader who never
     visits the Board would otherwise never be told. */
  const warnings = [
    ...missing.map((p) => `unreachable: ${p.name} — no backlog/ at ${p.path}`),
    ...(index?.errors ?? [])
  ];

  /* Why a run forbids dispatching this card, or null — the same block the
     Board's cards carry.

     Its reachable case narrowed with bug-11 and the block stays anyway. It
     used to be the common one: a stale open item sitting `pending` in a run's
     queue, archived by the calendar while the run was about to reach it. That
     item cannot land here at all now — a run holding it keeps it on the Board,
     `pending` included. What remains is an item REJECTED while a run held it,
     which enters this surface by section rather than by staleness and so is
     not covered by the widened predicate at all. Narrow, but real, and
     deleting the block would let exactly that card dispatch from Archive while
     its equivalent on the Board is blocked — which is the half-fixed state the
     block was added to close. */
  const runBlockFor = (item: BacklogItem): string | null => runClaimBlock(item, runs);

  /* The same two overlays the Board has, with the same relationship: the sheet
     may be opened from a card (drawer closed) or from inside the drawer (drawer
     stays open behind it), so one piece of state cannot serve both, and their
     coexistence is deliberate rather than an oversight — see BoardView's own
     comment on why LaunchSheet and ItemDrawer are the one pair NOT mutually
     excluded. Archive has no third or fourth overlay, so there is no exclusion
     to arrange here at all. */
  return (
    <div className="board">
      <div className="board-bar">
        <div className="board-title">Archive</div>
        <div className="board-tools">
          <input
            type="search"
            className="board-search"
            aria-label="Search items"
            placeholder="search titles"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="board-select"
            aria-label="Project"
            value={projectValue}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value={ALL}>All projects</option>
            {/* Valued by path, labelled by name — two checkouts of one repo
                stay two selectable options. */}
            {registered.map((p) => (
              <option key={p.path} value={p.path}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="board-warn" data-testid="board-warn">
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="board-empty">loading…</div>
      ) : error && all.length === 0 ? (
        <div className="board-empty">board unavailable</div>
      ) : all.length === 0 ? (
        <div className="board-empty">nothing registered yet</div>
      ) : archived.length === 0 ? (
        /* Three empty states, not two, and the third is this one: the Board's
           pair distinguishes "nothing registered" from "your filters matched
           nothing", and Archive needs a third for the case that has no Board
           equivalent — a corpus where nothing is stale and nothing was ever
           ruled out. That is good news about the backlog, not a narrowing
           accident, and collapsing it into `no matches` would send the reader
           to fix controls that are working. */
        <div className="board-empty">nothing archived yet</div>
      ) : visible.length === 0 ? (
        <div className="board-empty">no matches</div>
      ) : (
        <div className="board-columns">
          {COLUMNS.map((col) => {
            /* Grouped, not sorted: within a column the months are the
               structure, and `groupByMonth` owns all three ordering rules
               (newest month first, undated last, newest-touched first inside a
               group). See lib/item-month.ts. */
            const groups = groupByMonth(visible.filter((i) => i.section === col.section));
            const count = groups.reduce((n, g) => n + g.items.length, 0);
            return (
              <div className={`board-col board-col-${col.slug}`} key={col.section} data-testid="archive-col">
                <div className="board-col-h">
                  <span className="board-col-tick" />
                  <span className="board-col-name" data-testid="col-name">{col.label}</span>
                  <span className="board-col-count" data-testid="col-count">{count}</span>
                </div>
                <div className="board-col-cards">
                  {groups.map((group) => (
                    <div className="archive-group" key={group.key}>
                      {/* Sticky, so the month a card belongs to is still
                          readable once the column is scrolled past its own
                          heading — which is the entire reason the grouping
                          earns its place here rather than being a sort. */}
                      <div className="archive-month" data-testid="archive-month">{group.label}</div>
                      {group.items.map((item) => (
                        <ItemCard
                          key={item.path}
                          item={item}
                          hues={hues}
                          onOpen={() => setOpen(item)}
                          agents={agents}
                          onDispatch={() => setDispatching(item)}
                          now={now}
                          /* No `stale` prop, deliberately. Every card in the
                             first three columns here is stale by construction,
                             and a marker that is always on says nothing — the
                             same argument the card already makes for not
                             badging `groomed` on a task. The column heading
                             carries the fact instead. */
                          runBlock={runBlockFor(item)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open !== null && (
        <ItemDrawer
          item={open}
          hues={hues}
          onClose={() => setOpen(null)}
          agents={agents}
          onDispatch={() => setDispatching(open)}
          runBlock={runBlockFor(open)}
        />
      )}
      {dispatching !== null && (
        /* `key` on a singleton, for the reason BoardView's own copy of this
           comment gives at length: it makes re-targeting the sheet a REMOUNT
           rather than a prop change, so item A's success panel and error state
           cannot render under item B's title. */
        <LaunchSheet key={dispatching.path} item={dispatching} onClose={() => setDispatching(null)} />
      )}
    </div>
  );
}
