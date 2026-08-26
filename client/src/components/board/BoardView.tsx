import { useState } from 'react';

import { useBoard } from '../../hooks/useBoard';
import { usePersistedState } from '../../hooks/usePersistedState';
import { ItemCard } from './ItemCard';
import { ItemDrawer } from './ItemDrawer';
import type { BacklogItem, Section } from '../../../../shared/types';

const PROJECT_KEY = 'backlog-manager.project';
const STATUS_KEY = 'backlog-manager.status';
const SORT_KEY = 'backlog-manager.sort';

/** The "not narrowed" sentinel — a sentinel rather than '', so a stored value
 *  always reads as itself and never as "the field was cleared". */
const ALL = 'all';

type StatusFilter = 'open' | 'done' | 'all';
type SortKey = 'created' | 'name' | 'project';

/** Fixed column order — the store's own section order, not alphabetical. */
const COLUMNS: { section: Section; label: string; slug: string }[] = [
  { section: 'bugs', label: 'Bugs', slug: 'bugs' },
  { section: 'ideas', label: 'Ideas', slug: 'ideas' },
  { section: 'tasks', label: 'Tasks', slug: 'tasks' },
  { section: 'out-of-scope', label: 'Out of scope', slug: 'oos' }
];

/**
 * Onto a copy, never in place — the array belongs to the fetched index.
 * `created` compares as a string: backlog.mjs writes fixed-width UTC
 * YYYY-MM-DD, where lexicographic order is chronological order, and an
 * unparseable value sorts predictably instead of NaN-scrambling the list.
 */
function sortItems(items: BacklogItem[], sort: SortKey): BacklogItem[] {
  const out = [...items];
  if (sort === 'name') {
    out.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sort === 'project') {
    out.sort((a, b) => a.project.localeCompare(b.project) || b.created.localeCompare(a.created));
  } else {
    out.sort((a, b) => b.created.localeCompare(a.created));
  }
  return out;
}

/**
 * The board: every registered project's items in four fixed type columns.
 * All narrowing happens here, client-side, over the fetched index — the whole
 * corpus is a few hundred rows of title-and-date, and a server-side filter
 * would cost a round trip per keystroke (guide-manager's rationale, kept).
 */
export default function BoardView() {
  const { items: index, projects, loading, error } = useBoard();
  const [open, setOpen] = useState<BacklogItem | null>(null);

  /* The query is plain useState — deliberately not remembered. A remembered
     query is a board that opens showing three cards out of forty for no
     visible reason. The selects survive that objection because each one
     permanently states its own value in the bar. */
  const [query, setQuery] = useState('');
  const [project, setProject] = usePersistedState<string>(PROJECT_KEY, ALL);
  const [status, setStatus] = usePersistedState<StatusFilter>(STATUS_KEY, 'open');
  const [sort, setSort] = usePersistedState<SortKey>(SORT_KEY, 'created');

  const all = index?.items ?? [];
  const registered = projects ?? [];

  /* Fail-open on a stale stored project (unregistered since): an unmatched
     filter that emptied the board would look like the server broke. The
     fallback feeds back into the select, so control and board agree. */
  const knownPaths = new Set(registered.map((p) => p.path));
  const projectValue = knownPaths.has(project) ? project : ALL;

  const needle = query.trim().toLowerCase();
  const matches = (i: BacklogItem): boolean =>
    (projectValue === ALL || i.projectPath === projectValue) &&
    (needle === '' || i.title.toLowerCase().includes(needle)) &&
    // out-of-scope is flat and terminal — the open/done select has no say there
    (i.section === 'out-of-scope' || status === 'all' || i.status === status);

  const visible = all.filter(matches);
  const missing = registered.filter((p) => p.missing);
  const warnings = [
    ...missing.map((p) => `unreachable: ${p.name} — no backlog/ at ${p.path}`),
    ...(index?.errors ?? [])
  ];

  return (
    <div className="board">
      <div className="board-bar">
        <div className="board-title">Projects</div>
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
          <select
            className="board-select"
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
          <select
            className="board-select"
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="created">Newest first</option>
            <option value="name">By name</option>
            <option value="project">By project</option>
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
        /* Two distinct empty states: an empty registry is fixed by running a
           backlog skill in some project; an empty RESULT is fixed by the
           controls two inches above the message. */
        <div className="board-empty">nothing registered yet</div>
      ) : visible.length === 0 ? (
        <div className="board-empty">no matches</div>
      ) : (
        <div className="board-columns">
          {COLUMNS.map((col) => {
            const colItems = sortItems(visible.filter((i) => i.section === col.section), sort);
            return (
              <div className={`board-col board-col-${col.slug}`} key={col.section} data-testid="board-col">
                <div className="board-col-h">
                  <span className="board-col-tick" />
                  <span className="board-col-name" data-testid="col-name">{col.label}</span>
                  <span className="board-col-count" data-testid="col-count">{colItems.length}</span>
                </div>
                <div className="board-col-cards">
                  {colItems.map((item) => (
                    <ItemCard key={item.path} item={item} onOpen={() => setOpen(item)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open !== null && <ItemDrawer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
