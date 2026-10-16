import { elapsedSince, formatCreated } from './item-age';
import { pollAge } from './tracker';
import { SYNC_INTERVALS } from '../../../shared/types';
import type { JiraBoard, JiraBoardFailure, JiraBoardStatus, JiraIssue, JiraStatusCategory, JiraStatusPayload } from '../../../shared/types';

/**
 * jira.ts — what the client says about Jira (Jira phase 2, spec §6). The one home of every derivation the Jira board, its modal, Setup and the rail chip
 * print, like `lib/tracker.ts` is for GitHub: five surfaces describing one board five ways on one screen is what this file exists to prevent.
 *
 * Nothing here reads a clock of its own. `now` is a REQUIRED parameter wherever an age is printed, with no `Date.now()` default — `tracker.ts`'s rule and
 * its reason: a default is how the next call site reads its own clock without noticing, and then one surface ages two readings against two instants.
 * Every age goes through `pollAge` (R9), so a Jira poll reads `12 s` and `4m` exactly as a GitHub one does, and a board not swept yet reads `not polled
 * yet` (R8) wherever an age would be — never `NaN`, never `0 s`, which is the opposite claim.
 */

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What one sweep may spend before the chip's calls meter reads full: Jira Cloud's rate limit is a cost budget it does not publish a number for, so this is
 * the app's own yardstick for "a lot of calls in one tick", not Atlassian's limit. A meter that reads full while every call still succeeds is a warning,
 * and the red state (`JIRA_429_RED_MS`) is the one that says Jira actually refused.
 */
export const JIRA_SWEEP_CALL_CEILING = 100;

/** How long after Jira's last 429 the calls meter stays red — a window, not a latch: a refusal a quarter of an hour ago is history. */
export const JIRA_429_RED_MS = 15 * 60_000;

/** The board count at which the Boards card grows its filter field. Below it the list fits on a screen and a search box is furniture. */
export const JIRA_BOARD_FILTER_FROM = 6;

/**
 * The board sheet's query chips (R5), the ONE home of their copy and JQL. `chip` is the text on the chip (the sheet draws the leading `+`), `label` the
 * label the row it adds is born with, and they differ for exactly one preset: `Unresolved in a project…` reveals a `Select` over `/api/jira/projects` in
 * place, and the row it adds is labelled `Unresolved in <KEY>` with the picked key substituted for the placeholder in `label` and `jql` alike. All of them
 * are bounded — Jira Cloud refuses an unbounded JQL (P2) — and the sheet's check line verifies them like any other row.
 */
export interface JiraQueryPreset {
  chip: string;
  label: string;
  jql: string;
}

export const JIRA_QUERY_PRESETS: readonly JiraQueryPreset[] = [
  { chip: 'Assigned to me', label: 'Assigned to me', jql: 'assignee = currentUser() AND statusCategory != Done' },
  { chip: 'Open in current sprint', label: 'Open in current sprint', jql: 'sprint in openSprints() AND statusCategory != Done' },
  { chip: 'Unresolved in a project…', label: 'Unresolved in <KEY>', jql: 'project = "<KEY>" AND resolution = Unresolved' }
];

/** The fourth chip, `+ Custom JQL` (R5): an empty row for a person to write, labelled `Custom query`. Not a preset — it has no JQL of its own. */
export const JIRA_CUSTOM_QUERY: JiraQueryPreset = { chip: 'Custom JQL', label: 'Custom query', jql: '' };

// ── Columns, order, the card ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type JiraColumnSlug = 'todo' | 'doing' | 'done';

/**
 * The board's three columns, in render order. A column is a Jira STATUS CATEGORY, never a status name: workflows are per project and a name is whatever a
 * team typed, but every status in Jira belongs to one of exactly three categories (`undefined`, "No Category", is mapped to `new` by the server — P5).
 */
export const JIRA_COLUMNS: { slug: JiraColumnSlug; label: string; category: JiraStatusCategory }[] = [
  { slug: 'todo', label: 'To Do', category: 'new' },
  { slug: 'doing', label: 'In Progress', category: 'indeterminate' },
  { slug: 'done', label: 'Done', category: 'done' }
];

export function columnOf(issue: JiraIssue): JiraColumnSlug {
  return JIRA_COLUMNS.find((c) => c.category === issue.status.category)?.slug ?? 'todo';
}

/**
 * Most recently updated first, ties by key in plain string order (`PAY-10` before `PAY-2` — a stable order a reader can predict is worth more here than
 * a natural one, and it is the order the server's own tie-break uses). An unparseable stamp sorts as the oldest. Returns a new array: the caller's list
 * is the poller's cache copy and is never mutated.
 */
export function sortForBoard(issues: readonly JiraIssue[]): JiraIssue[] {
  const stamp = (i: JiraIssue): number => {
    const t = Date.parse(i.updated);
    return Number.isNaN(t) ? 0 : t;
  };
  return [...issues].sort((a, b) => stamp(b) - stamp(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The age on a card's foot: how long ago a DONE issue was resolved (that is the age that matters to someone reading the Done column), otherwise how long
 * ago it last changed. An issue with no resolution — done by a workflow that never sets one — and one that is not done but still carries a stale `resolved`
 * from a reopen both fall to `updated`. No `resolved` prefix.
 *
 * **An AGE, not a date**, through `elapsedSince` — the board's one age vocabulary (`now`, `4m`, `2h`, `6d`), the one a backlog card's `in progress` marker
 * reads. The spec says a card shows "the age of `updated`" (§6.2) and "a Done card reads its age, not `resolved Oct 11`" (its picked-mocks note), and the
 * picked mocks draw `4 min ago` / `2 days ago`, never `Oct 11`; a date is what the MODAL's `created` fact is for (`issueDatesLine`). `now` is the caller's, so
 * every card on a page is aged against one clock. A stamp that cannot be aged (nothing validates Jira's ISO strings on the way in) is printed as it came
 * rather than as `NaN`.
 */
export function cardAgeStamp(issue: JiraIssue, now: number): string {
  const stamp = issue.status.category === 'done' && issue.resolved !== null ? issue.resolved : issue.updated;
  return elapsedSince(stamp, now) ?? stamp;
}

/**
 * The issue modal's `created · updated` fact, as one value: `created` as a short date (`formatCreated`, with its year suffix decided by `now`) and the
 * relative age of `updated` (`elapsedSince`, the same vocabulary the card's `cardAgeStamp` reads) — the mock's `Oct 2 · 4 min ago`, in the board's own
 * words. Lives here, with the card's age, because both are one reading of one pair of stamps and the spec's one-home rule (§6.1) says a derivation is not
 * restated in a component.
 */
export function issueDatesLine(issue: JiraIssue, now: number): string {
  return `${formatCreated(issue.created, now)} · ${elapsedSince(issue.updated, now) ?? issue.updated}`;
}

export type JiraCrumb = { kind: 'root' } | { kind: 'parent'; key: string; summary: string } | { kind: 'mine' } | null;

/**
 * Why an issue is on this board, as the card's one crumb. Precedence is the reading order of "how did this get here": it IS a followed root, else it is
 * under something (the parent is the more specific fact), else it is simply assigned to me — the case a saved `assignee = currentUser()` query produces.
 * `me: null` (identity not known yet) never reads `mine`: an unknown person is nobody's assignee.
 */
export function crumbOf(issue: JiraIssue, board: JiraBoard, me: { accountId: string } | null): JiraCrumb {
  if (board.roots.includes(issue.key)) return { kind: 'root' };
  if (issue.parent !== null) return { kind: 'parent', key: issue.parent.key, summary: issue.parent.summary };
  if (me !== null && issue.assignee !== null && issue.assignee.accountId === me.accountId) return { kind: 'mine' };
  return null;
}

/**
 * The crumb's words, which the card renders verbatim — this file is the one home of crumb text (spec §6.1), so the card holds no copy of `root`, the
 * parent line or `Assigned to me`. `null` for no crumb, which draws nothing.
 */
export function crumbText(crumb: JiraCrumb): string | null {
  if (crumb === null) return null;
  if (crumb.kind === 'root') return 'root';
  if (crumb.kind === 'parent') return `↳ ${crumb.key} ${crumb.summary}`;
  return 'Assigned to me';
}

/**
 * The card's person badge: the first letter of the first two words, upper-cased. `Jean-Luc Picard Jr` is `JP` — a hyphenated name is one word. Nothing to
 * read is `?`. (The rail chip draws ONE initial, `me.name`'s first letter — R10; this two-letter reading is the card's alone.)
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, 2)
    .map((w) => Array.from(w)[0].toUpperCase());
  return letters.length === 0 ? '?' : letters.join('');
}

// ── Sentences ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `1 root`, `2 roots`; `queries` is the one plural that is not the noun plus `s`. */
const count = (n: number, noun: 'root' | 'query' | 'issue'): string => `${n} ${n === 1 ? noun : noun === 'query' ? 'queries' : `${noun}s`}`;

/** The same, or `null` for zero, which every sentence below omits rather than print. */
const countOrNull = (n: number, noun: 'root' | 'query' | 'issue'): string | null => (n > 0 ? count(n, noun) : null);

/** The age half of a poll sentence: `polled 12 s ago`, or R8's `not polled yet`. `last` is Setup's off-board wording, where the poll is history. */
function polledPhrase(polledAt: string | null, now: number, last = false): string {
  const age = pollAge(polledAt, now);
  return age === null ? 'not polled yet' : `${last ? 'last polled' : 'polled'} ${age} ago`;
}

/**
 * What the last sweep could not read, as one phrase: Jira's own message for the FIRST failure, `+N more` when there are several. `null` when there is
 * nothing to say. The one derivation behind the Band's red sub-line and the Setup row's red failure — Jira's sentence ("Field 'foo' does not exist") is
 * the one a person can act on, and two surfaces must not word one failure two ways.
 */
export function failurePhrase(failures: readonly JiraBoardFailure[]): string | null {
  if (failures.length === 0) return null;
  const more = failures.length - 1;
  return `${failures[0].message}${more > 0 ? ` +${more} more` : ''}`;
}

/**
 * The Board page's sub-line under the band: `acme.atlassian.net · 14 issues from 2 roots and 1 query · polled 12 s ago`. A zero source is omitted rather
 * than printed as `0 roots`, since a query-only board has no roots to count.
 *
 * `failing` is true whenever the last sweep could not read a root or a query, and the text then names Jira's own message for the FIRST failure (`+N more`
 * when there are several) — a partial list must never read as a whole one, and Jira's sentence ("Field 'foo' does not exist") is the one a person can act
 * on. A truncated list ends on the cap, always last, so it is never mistaken for the whole of the board either.
 */
export function bandSub(board: JiraBoardStatus, site: string, now: number): { text: string; failing: boolean } {
  const sources = [countOrNull(board.roots.length, 'root'), countOrNull(board.queries.length, 'query')].filter((s): s is string => s !== null);
  const parts = [site, `${count(board.count, 'issue')}${sources.length > 0 ? ` from ${sources.join(' and ')}` : ''}`, polledPhrase(board.polledAt, now)];
  const failure = failurePhrase(board.failures);
  if (failure !== null) parts.push(failure);
  if (board.truncated) parts.push('first 500 shown');
  return { text: parts.join(' · '), failing: failure !== null };
}

/**
 * Setup's one line per board: `2 roots · 1 query · 14 issues · every 1m · polled 12 s ago`. Zero counts are omitted, and the failure travels beside the text
 * (`failure`, `failurePhrase`'s words) so Setup can draw it red without re-deriving it. An `off` board says `sync off` where the interval would be and `last
 * polled` where `polled` would, because for it the age is not a heartbeat but the date of the last time anyone looked.
 */
export function boardRowLine(board: JiraBoardStatus, now: number): { text: string; failing: boolean; failure: string | null } {
  const off = board.interval === 'off';
  const parts = [
    countOrNull(board.roots.length, 'root'),
    countOrNull(board.queries.length, 'query'),
    countOrNull(board.count, 'issue'),
    off ? 'sync off' : `every ${board.interval}`,
    polledPhrase(board.polledAt, now, off)
  ].filter((s): s is string => s !== null);
  const failure = failurePhrase(board.failures);
  return { text: parts.join(' · '), failing: failure !== null, failure };
}

// ── Meters and picks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The chip popover's calls meter: how much of `JIRA_SWEEP_CALL_CEILING` the last tick spent (capped at full), and whether Jira refused a call inside
 * `JIRA_429_RED_MS`. An unparseable `last429At` is not red; a stamp in the future (a skewed clock) still is, being no older than the window.
 */
export function callsReading(calls: JiraStatusPayload['calls'], now: number): { fraction: number; red: boolean } {
  const at = calls.last429At === null ? NaN : Date.parse(calls.last429At);
  return {
    fraction: Math.min(calls.sweep / JIRA_SWEEP_CALL_CEILING, 1),
    red: !Number.isNaN(at) && now - at < JIRA_429_RED_MS
  };
}

/**
 * The syncing board the chip's clock follows: the one whose NEXT poll (`polledAt` plus its interval) comes first. A board that has never polled is due
 * now and so outranks every other; an `off` board has no next poll at all and is never chosen. `null` when nothing syncs, which the chip reads as `sync
 * off`. `_now` is accepted for call-site symmetry with the other readings and deliberately unused: ordering by due instant needs no clock, since the same
 * `now` would shift every candidate equally.
 */
export function soonestBoard(boards: readonly JiraBoardStatus[], _now: number): JiraBoardStatus | null {
  let best: JiraBoardStatus | null = null;
  let bestDue = Infinity;
  for (const b of boards) {
    const ms: unknown = SYNC_INTERVALS[b.interval];
    if (typeof ms !== 'number') continue;
    const polled = b.polledAt === null ? NaN : Date.parse(b.polledAt);
    const due = Number.isNaN(polled) ? -Infinity : polled + ms;
    if (best === null || due < bestDue) {
      best = b;
      bestDue = due;
    }
  }
  return best;
}

const byName = (a: JiraBoardStatus, b: JiraBoardStatus): number => a.name.localeCompare(b.name);

/**
 * The per-browser key holding which board the Board page draws (`usePersistedState`, so the value is JSON). What is stored there is only ever a PREFERENCE:
 * `pickBoard` below resolves it against the live list on every render, so a stale or hand-edited value can never become a request.
 */
export const JIRA_BOARD_KEY = 'backlog-manager.jira-board';

/** The boards by name — the picker's order, and the order `pickBoard`'s fallback takes the first of, so the two cannot disagree about "first". */
export function boardsByName(boards: readonly JiraBoardStatus[]): JiraBoardStatus[] {
  return [...boards].sort(byName);
}

/**
 * Which board the page draws: the one the browser stored when it is still there, else the first by name. The stored value is `unknown` because it is
 * persisted — a deleted board (here or in another browser), garbage, or a number all fall through to the first by name, and the caller never asks the
 * server for a board that is not in the list. `null` only when there are no boards at all.
 */
export function pickBoard(storedId: unknown, boards: readonly JiraBoardStatus[]): JiraBoardStatus | null {
  if (typeof storedId === 'string') {
    const stored = boards.find((b) => b.id === storedId);
    if (stored !== undefined) return stored;
  }
  return boardsByName(boards)[0] ?? null;
}

// ── The Board page's filters ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the Board page's three filters and its search hold (spec §6.2). Per mount, never persisted — the global constraints' rule, because a filter that
 * survived a reload would hide cards from a reader who no longer remembers setting it, and the band's list is cheap to narrow again.
 *
 * `type` and `sprint` are `undefined` for "any"; `sprint: null` is the `no sprint` pick, which is why "any" cannot also be `null`. `assignee` is the three
 * words the panel draws.
 */
export type JiraAssigneeFilter = 'anyone' | 'me' | 'unassigned';

export interface JiraBoardFilters {
  type: string | undefined;
  assignee: JiraAssigneeFilter;
  sprint: string | null | undefined;
  search: string;
}

export const NO_JIRA_FILTERS: JiraBoardFilters = { type: undefined, assignee: 'anyone', sprint: undefined, search: '' };

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/**
 * The picks the panel offers, read off the LOADED list rather than off Jira's own catalogue: a type or a sprint no card on this board carries would be a
 * chip that empties the columns, and the browser has no other source anyway (it never talks to Jira). Sorted, with `Sprint 9` before `Sprint 10`.
 * `noSprint` says whether the `no sprint` chip has anything to show.
 */
export function boardFilterOptions(issues: readonly JiraIssue[]): { types: string[]; sprints: string[]; noSprint: boolean } {
  const types = new Set<string>();
  const sprints = new Set<string>();
  let noSprint = false;
  for (const i of issues) {
    types.add(i.type.name);
    if (i.sprint === null) noSprint = true;
    else sprints.add(i.sprint);
  }
  return { types: [...types].sort(byText), sprints: [...sprints].sort(byText), noSprint };
}

/**
 * The filters as they actually apply: a pick the current list no longer offers reads as "any" rather than as a filter that hides everything — the board was
 * switched, or the sweep moved the last card of that sprint out — and `me` reads as `anyone` while the identity is unknown, since the panel draws no `me`
 * chip then and a filter nobody can see must not be in force. The Board's own `projectValue` is the same fail-open, for the same reason.
 */
export function effectiveBoardFilters(
  filters: JiraBoardFilters,
  options: ReturnType<typeof boardFilterOptions>,
  me: { accountId: string } | null
): JiraBoardFilters {
  const sprintOffered = filters.sprint === null ? options.noSprint : filters.sprint !== undefined && options.sprints.includes(filters.sprint);
  return {
    type: filters.type !== undefined && options.types.includes(filters.type) ? filters.type : undefined,
    assignee: filters.assignee === 'me' && me === null ? 'anyone' : filters.assignee,
    sprint: sprintOffered ? filters.sprint : undefined,
    search: filters.search
  };
}

/** How many of the three panel filters are set — the funnel's badge. The search is not one: it is in plain sight on the band, and `Clear all` leaves it. */
export function boardFilterCount(f: JiraBoardFilters): number {
  return (f.type !== undefined ? 1 : 0) + (f.assignee !== 'anyone' ? 1 : 0) + (f.sprint !== undefined ? 1 : 0);
}

/**
 * Whether one card survives the (effective) filters and the search. The search is a case-insensitive substring of the KEY or the summary — a reader types
 * `pay-12` as often as a word of the title — trimmed, so a stray space does not empty the board.
 */
export function matchesBoardFilters(issue: JiraIssue, f: JiraBoardFilters, me: { accountId: string } | null): boolean {
  if (f.type !== undefined && issue.type.name !== f.type) return false;
  if (f.sprint !== undefined && issue.sprint !== f.sprint) return false;
  if (f.assignee === 'unassigned' && issue.assignee !== null) return false;
  if (f.assignee === 'me' && (me === null || issue.assignee?.accountId !== me.accountId)) return false;
  const q = f.search.trim().toLowerCase();
  return q === '' || issue.key.toLowerCase().includes(q) || issue.summary.toLowerCase().includes(q);
}

/** `2 subtasks`, `1 subtask`, and nothing at zero — the card's marker, which says there is more under the card and not how much of it is done. */
export function subtasksMarker(n: number): string | null {
  return n > 0 ? `${n} ${n === 1 ? 'subtask' : 'subtasks'}` : null;
}

/** Setup's list order: by name, with boards that are not syncing (`off`) after every board that is. */
export function boardsForSetup(boards: readonly JiraBoardStatus[]): JiraBoardStatus[] {
  const rank = (b: JiraBoardStatus): number => (b.interval === 'off' ? 1 : 0);
  return [...boards].sort((a, b) => rank(a) - rank(b) || byName(a, b));
}

/** The projects Setup still owes a repository: every one the status carries whose key has no `repos` entry. */
export function unmappedProjects(status: Pick<JiraStatusPayload, 'projects' | 'repos'>): { key: string; name: string }[] {
  return status.projects.filter((p) => !Object.prototype.hasOwnProperty.call(status.repos, p.key));
}

/**
 * A path as the Repositories card shows it: the `$HOME` prefix written `~`. Only at a segment boundary — `/Users/adam/x` is not under `/Users/ada` — and
 * never while `home` is unknown (`null`, or the degenerate `''` / `/`, where every absolute path would "start with" it).
 */
export function displayPath(path: string, home: string | null): string {
  if (home === null) return path;
  const root = home.replace(/\/+$/, '');
  if (root === '') return path;
  if (path === root) return '~';
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

/**
 * The shape guard `useJira` reads `GET /api/jira` through (`isTrackersPayload`'s role and reason). It checks what a render MAPS or READS without a
 * null-safe expression — the three collections and the two fields phase 2 added — because a body missing one throws a `TypeError` inside a render, and
 * React unmounts the page when it does. A wrong-shaped ROW degrades to a row that says less instead.
 */
export function isJiraStatusPayload(value: unknown): value is JiraStatusPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const isRecord = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
  return (
    typeof p.configured === 'boolean' &&
    typeof p.armed === 'boolean' &&
    Array.isArray(p.boards) &&
    Array.isArray(p.projects) &&
    isRecord(p.repos) &&
    isRecord(p.calls)
  );
}
