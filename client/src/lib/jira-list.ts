import { needsYou } from '../../../shared/jira-sessions';
import { JIRA_BUILTIN_LABELS, type JiraIssue, type JiraLiveSession, type JiraSessionsPayload } from '../../../shared/types';
import { repoBasename } from './jira';
import { deckGroup, deckOrder, type DeckGroup } from './jira-deck';
import { MONTHS, elapsedSince } from './item-age';
import { sessionDuration, type SessionLink } from './jira-sessions';
import { formatZonedClock, startOfZonedDay, zonedParts } from './time-zone';

/**
 * jira-list.ts — what the Sessions page's session table draws: one row per session, live above ended, filtered and counted (Jira sessions spec §7.2, C7; DESIGN.md
 * §8.9.1). Pure, and the one home of these derivations — `JiraSessionList` draws what `buildListRows` and `applyListFilters` return, so no component holds a
 * copy of "which sessions are in scope", "which ended rows the window hides" or "which row comes first".
 *
 * **A row is a session, not a ticket.** The identity is the pair, `${key}:${sessionId}` — the deck's — because one session can be linked to several tickets
 * (`/jira link` twice, a branch carrying two keys) and two rows must not share a React key. That is also why a ticket two boards both hold gives ONE row with
 * All tickets on: rows come from the links, never from a board, so no board can contribute a second copy. A Starting row is the exception to "from the links":
 * a reservation has no link until the dashboard answers (`GET /api/jira/sessions` never carries one), so it is built from the status's `live[key]` entry,
 * exactly as the deck and Detail do, and its id is `starting:<KEY>`.
 *
 * **Scope is the board's keys, or every link.** By default a row belongs to the List when its ticket is on the picked board's LOADED list (a top or anything
 * folded under one — the issues the fold was made from); All tickets widens that to every link, and a ticket the board does not hold is drawn from the link's
 * `snapshot` (`stubIssue`), the ticket as it stood when the link was made — the one reason the store keeps it.
 *
 * **The window is for the Ended group, and only the Ended group** (§7.2): a live session is never hidden by age, however long ago it started — a session that
 * has been running for ten days is the one a person most needs to see — and an ended row is judged on `endedAt` alone, never on when it started, so a session
 * that ran for a week and finished an hour ago is "an hour ago".
 */

export type ListChip = 'all' | 'needs-you' | 'working' | 'ended';
export const LIST_CHIPS: readonly ListChip[] = ['all', 'needs-you', 'working', 'ended'];

export type ListWindow = '24h' | '7d' | '30d' | 'all';
const HOUR_MS = 3_600_000;
/** Declaration order is the select's order. `ms` is how far back an ended session's `endedAt` may be; `null` is no limit. */
export const LIST_WINDOWS: readonly { value: ListWindow; label: string; ms: number | null }[] = [
  { value: '24h', label: '24 h', ms: 24 * HOUR_MS },
  { value: '7d', label: '7 d', ms: 7 * 24 * HOUR_MS },
  { value: '30d', label: '30 d', ms: 30 * 24 * HOUR_MS },
  { value: 'all', label: 'All', ms: null }
];
export const DEFAULT_LIST_WINDOW: ListWindow = '7d';

/** The List's own filters — the ones the rail badge (C4) and a reload must be able to set from outside the page, so they live in `hooks/useJiraListFilters`. */
export interface ListFilters {
  chip: ListChip;
  /** A repo's basename (what the column shows), or `null` for any. */
  repo: string | null;
  /** A `runKey`, or `null` for any. */
  run: string | null;
  window: ListWindow;
  allTickets: boolean;
}

export const DEFAULT_LIST_FILTERS: ListFilters = { chip: 'all', repo: null, run: null, window: DEFAULT_LIST_WINDOW, allTickets: false };

/** One row of the List. */
export interface ListRow {
  /** `${key}:${sessionId}`, or `starting:${key}` for a reservation. */
  id: string;
  key: string;
  state: SessionLink['state'];
  group: DeckGroup;
  /** In the Ended group: the link carries an `endedAt`, or the server derived `ended`. */
  ended: boolean;
  /** The ticket as the board holds it, or `stubIssue`'s reading of the link's snapshot when the board does not. */
  issue: JiraIssue;
  /** Whether the ticket is on the picked board's loaded list — a stub's Detail has no fold to hand its Children tree. */
  onBoard: boolean;
  link: SessionLink | null;
  starting: JiraLiveSession | null;
  repo: string;
  branch: string | null;
  startedAt: string;
  endedAt: string | null;
  /** When this server first saw the session in this state; a reservation's is its `startedAt`. */
  since: string;
}

const ms = (iso: string | null): number => {
  const t = iso === null ? NaN : Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * What `snapshot.type` (a bare name) says about a type's glyph: Jira's own sub-task and epic names. The snapshot kept no level or flag, so this is a reading
 * of a name — a team's custom "Initiative" draws the plain task square — and the glyph is the only thing it feeds; nothing acts on a stub's type.
 */
function stubType(name: string): JiraIssue['type'] {
  const subtask = /^sub-?task$/i.test(name);
  return { name, level: subtask ? -1 : /^epic$/i.test(name) ? 1 : 0, subtask };
}

/**
 * A ticket the board does not hold, drawn from its link's snapshot (§5): the summary and type it had when the link was made. Detail needs only `key` from the
 * issue it is handed — it fetches the ticket fresh — so the rest is the least that satisfies the type: the project from the key's prefix, the status unknown
 * (an empty name, the `new` category), and no assignee. `site` makes the Jira URL when the shell knows it.
 */
export function stubIssue(key: string, snapshot: { summary: string; type: string; parentKey: string | null }, site: string): JiraIssue {
  const project = key.replace(/-\d+$/, '');
  return {
    key,
    id: '',
    url: site === '' ? '' : `https://${site}/browse/${key}`,
    summary: snapshot.summary,
    project: { key: project, name: project },
    type: stubType(snapshot.type),
    status: { name: '', category: 'new' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: snapshot.parentKey === null ? null : { key: snapshot.parentKey, summary: '' },
    subtasks: 0,
    labels: [],
    sprint: null,
    created: '',
    updated: '',
    resolved: null
  };
}

/**
 * Every session the List could draw, before any filter: the links with an id (ended ones too), then the status's Starting reservations. `board` is the loaded
 * list keyed by ticket (every issue, folded or not); `allTickets` is the scope. Deduped by row id, so a payload that somehow repeats a pair draws it once.
 */
export function buildListRows(
  payload: JiraSessionsPayload | null,
  live: Readonly<Record<string, JiraLiveSession>>,
  board: ReadonlyMap<string, JiraIssue>,
  allTickets: boolean,
  site: string
): ListRow[] {
  const seen = new Set<string>();
  const rows: ListRow[] = [];
  for (const link of payload?.links ?? []) {
    if (link.sessionId === null) continue;
    const onBoard = board.has(link.key);
    if (!onBoard && !allTickets) continue;
    const id = `${link.key}:${link.sessionId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      key: link.key,
      state: link.state,
      group: deckGroup(link.state),
      ended: link.endedAt !== null || link.state === 'ended',
      issue: board.get(link.key) ?? stubIssue(link.key, link.snapshot, site),
      onBoard,
      link,
      starting: null,
      repo: link.repo,
      branch: link.branch,
      startedAt: link.startedAt,
      endedAt: link.endedAt,
      since: link.stateSince
    });
  }
  for (const [key, session] of Object.entries(live)) {
    if (!session.starting) continue;
    const onBoard = board.has(key);
    if (!onBoard && !allTickets) continue;
    const id = `starting:${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      key,
      state: 'starting',
      group: 'other',
      ended: false,
      // A reservation off the board has no snapshot; the session's own name is the only words the status has for it.
      issue: board.get(key) ?? stubIssue(key, { summary: session.name, type: 'Task', parentKey: null }, site),
      onBoard,
      link: null,
      starting: session,
      repo: session.repo,
      branch: null,
      startedAt: session.startedAt,
      endedAt: null,
      since: session.startedAt
    });
  }
  return rows;
}

/**
 * What a link's Run filter groups by: the action for a Run ▾ link (`execute`, `context`, `skill:<id>`), and `branch` / `manual` for a detected or hand-made one,
 * which have no action — their `name` is the session's own title, which would be one filter option per session. `null` for a reservation: the status does not
 * carry its action, so it matches no Run pick and shows only under "any".
 */
export function runKey(row: Pick<ListRow, 'link'>): string | null {
  const link = row.link;
  if (link === null) return null;
  if (link.action === null) return link.how;
  return typeof link.action === 'string' ? link.action : `skill:${link.action.skill}`;
}

function runOptionLabel(key: string, skills: readonly { id: string; name: string }[]): string {
  if (key === 'branch') return 'Found by branch';
  if (key === 'manual') return 'Linked by hand';
  if (key === 'execute' || key === 'context') return JIRA_BUILTIN_LABELS[key];
  const id = key.slice('skill:'.length);
  return skills.find((k) => k.id === id)?.name ?? id;
}

/** The ended group's order key: the end, or the state's own stamp for an `ended` link the store left without one. */
const endedAtOf = (r: ListRow): number => ms(r.endedAt ?? r.since);

export interface ListView {
  live: ListRow[];
  ended: ListRow[];
  /** Counts after scope, repo, run, window and search but BEFORE the chip, so each chip says how many it would show and the pressed one does not shrink them. */
  counts: Record<ListChip, number>;
  /** The repo and run picks the in-scope rows offer — a pick the scope no longer offers reads as "any" (`filters` below is that reading). */
  repos: string[];
  runs: { value: string; label: string }[];
  filters: ListFilters;
}

/**
 * Filter, count and order the rows. `now` is the caller's clock (this file reads none). Search is a case-insensitive substring over key, summary, repo (the
 * path and its basename) and branch. The order is the deck's for Live (`deckOrder`: state priority, then newest start) and `endedAt` newest first for Ended.
 */
export function applyListFilters(
  rows: readonly ListRow[],
  want: ListFilters,
  search: string,
  skills: readonly { id: string; name: string }[],
  now: number
): ListView {
  const repos = [...new Set(rows.map((r) => repoBasename(r.repo)))].sort((a, b) => a.localeCompare(b));
  const runValues = [...new Set(rows.map(runKey).filter((k): k is string => k !== null))];
  const runs = runValues.map((value) => ({ value, label: runOptionLabel(value, skills) })).sort((a, b) => a.label.localeCompare(b.label));
  const filters: ListFilters = {
    ...want,
    repo: want.repo !== null && repos.includes(want.repo) ? want.repo : null,
    run: want.run !== null && runValues.includes(want.run) ? want.run : null
  };

  const needle = search.trim().toLowerCase();
  const span = LIST_WINDOWS.find((w) => w.value === filters.window)?.ms ?? null;
  const kept = rows.filter((r) => {
    if (filters.repo !== null && repoBasename(r.repo) !== filters.repo) return false;
    if (filters.run !== null && runKey(r) !== filters.run) return false;
    if (r.ended && span !== null && now - endedAtOf(r) > span) return false;
    if (needle === '') return true;
    return [r.key, r.issue.summary, r.repo, repoBasename(r.repo), r.branch ?? ''].some((f) => f.toLowerCase().includes(needle));
  });

  const isNeeds = (r: ListRow): boolean => !r.ended && needsYou(r.state);
  const isWorking = (r: ListRow): boolean => !r.ended && r.state === 'working';
  const counts: Record<ListChip, number> = {
    all: kept.length,
    'needs-you': kept.filter(isNeeds).length,
    working: kept.filter(isWorking).length,
    ended: kept.filter((r) => r.ended).length
  };
  const shown = kept.filter(
    (r) => filters.chip === 'all' || (filters.chip === 'needs-you' ? isNeeds(r) : filters.chip === 'working' ? isWorking(r) : r.ended)
  );
  return {
    live: shown.filter((r) => !r.ended).sort(deckOrder),
    ended: shown.filter((r) => r.ended).sort((a, b) => endedAtOf(b) - endedAtOf(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    counts,
    repos,
    runs,
    filters
  };
}

/**
 * The State column's dot, as a `ui/Dot` tone: amber and breathing for the four states that want a person (the colour every "a human must act" mark in this app
 * is), green for Working, mustard for Quiet and Starting (nothing is wrong, nothing is happening yet), red for Lost contact, and none for Ended — an ended
 * session has no state to be in, so its dot is simply absent and the row reads quiet beside the live ones. The tones are `Dot`'s own member names.
 */
export function listDotTone(state: SessionLink['state']): 'live' | 'ramp-tasks' | 'paused' | 'crashed' | null {
  if (needsYou(state)) return 'live';
  if (state === 'working') return 'ramp-tasks';
  if (state === 'quiet' || state === 'starting') return 'paused';
  if (state === 'lost') return 'crashed';
  return null;
}

/** Every element inside a row that owns its own click: the Open chips are links, `Run ▾` a button, and its `Popover` panel a `role="dialog"` in the cell. */
const ROW_OWN_CONTROLS = 'a, button, input, select, textarea, label, [role="dialog"]';

/**
 * Whether a click on a List row is the row's — opening Detail — rather than a control's. A target inside one of `ROW_OWN_CONTROLS` is that control's (the
 * summary button included: it opens Detail through its own `onClick`, so the row must not open it a second time); a target outside the row is a React
 * synthetic event bubbling from somewhere the DOM does not nest; and a click that leaves a text selection behind was someone copying a branch name.
 */
export function rowOpens(row: Element, target: EventTarget | null, selection: string): boolean {
  if (!(target instanceof Element) || !row.contains(target)) return false;
  if (target.closest(ROW_OWN_CONTROLS) !== null) return false;
  return selection === '';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The Started column: the clock (`14:02`, the one the whole app prints, in the shared zone) for a session that began today, `Mon 14:02` within the last six
 * days, and `12 oct` beyond (`item-age`'s lowercase months, so a date reads the same on every machine) — a clock alone would say nothing about which day an ended row belongs to, and a date alone would hide the hour of a live one.
 * `—` for an unparseable stamp.
 */
export function startedLabel(iso: string, now: number, zone: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const today = startOfZonedDay(now, zone);
  const clock = formatZonedClock(t, zone);
  if (t >= today) return clock;
  const p = zonedParts(t, zone);
  if (t >= today - 6 * 24 * HOUR_MS) return `${WEEKDAYS[p.weekday]} ${clock}`;
  return `${p.day} ${MONTHS[p.month - 1]}`;
}

/**
 * The For column: how long the session ran (ended — `sessionDuration`) or has been running (live — `elapsedSince`'s ladder, a duration's `<1m` for its
 * `now`). A reservation has been "running" since it was reserved, which is the honest reading of a Starting row.
 */
export function forLabel(row: Pick<ListRow, 'link' | 'startedAt' | 'ended'>, now: number): string {
  const span = row.ended && row.link !== null ? sessionDuration(row.link) : elapsedSince(row.startedAt, now);
  return span === null ? '—' : span === 'now' ? '<1m' : span;
}

/**
 * The rail badge's number (C4): sessions that want a person, across EVERY linked ticket — not the picked board's, so a ticket on no board still counts — once
 * per `${key}:${sessionId}`, the List's row identity, because that is what the badge's click lands on. A reservation (`sessionId` null) is a Run that has no
 * session yet and cannot be waiting on anyone; an ended link never counts whatever its stored state says, as `applyListFilters`' Needs-you chip excludes it.
 *
 * `null` when the payload says the dashboard did not answer: every live link then reads `lost`, which is not "nobody needs you" but "nobody can say", so the
 * caller keeps the last number it had (`hooks/useJiraNeedsYou`) rather than painting a false zero.
 */
export function needsYouCount(payload: JiraSessionsPayload | null): number | null {
  if (payload === null || !payload.reachable) return null;
  const seen = new Set<string>();
  for (const link of payload.links) {
    if (link.sessionId === null || link.endedAt !== null || !needsYou(link.state)) continue;
    seen.add(link.sessionId);
  }
  return seen.size;
}
