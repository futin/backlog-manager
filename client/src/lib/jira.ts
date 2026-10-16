import { formatCreated } from './item-age';
import { pollAge } from './tracker';
import { SYNC_INTERVALS } from '../../../shared/types';
import type { JiraBoard, JiraBoardStatus, JiraIssue, JiraStatusCategory, JiraStatusPayload } from '../../../shared/types';

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
 * The board sheet's three query chips (R5), the ONE home of their JQL. `Unresolved in <KEY>` carries the placeholder literally: the chip reveals a
 * `Select` over `/api/jira/projects` in place and substitutes the picked key before the row is added. All three are bounded — Jira Cloud refuses an
 * unbounded JQL (P2) — and the sheet's check line verifies them like any other row.
 */
export interface JiraQueryPreset {
  label: string;
  jql: string;
}

export const JIRA_QUERY_PRESETS: readonly JiraQueryPreset[] = [
  { label: 'Assigned to me', jql: 'assignee = currentUser() AND statusCategory != Done' },
  { label: 'Open in current sprint', jql: 'sprint in openSprints() AND statusCategory != Done' },
  { label: 'Unresolved in <KEY>', jql: 'project = "<KEY>" AND resolution = Unresolved' }
];

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
 * The date on a card's foot: when a DONE issue was resolved (that is the date that matters to someone reading the Done column), otherwise when it last
 * changed. An issue with no resolution — done by a workflow that never sets one — and one that is not done but still carries a stale `resolved` from a
 * reopen both fall to `updated`. Printed through `formatCreated`, the board's one short-date vocabulary.
 */
export function cardAgeStamp(issue: JiraIssue): string {
  const stamp = issue.status.category === 'done' && issue.resolved !== null ? issue.resolved : issue.updated;
  return formatCreated(stamp);
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
  const failing = board.failures.length > 0;
  if (failing) {
    const more = board.failures.length - 1;
    parts.push(`${board.failures[0].message}${more > 0 ? ` +${more} more` : ''}`);
  }
  if (board.truncated) parts.push('first 500 shown');
  return { text: parts.join(' · '), failing };
}

/**
 * Setup's one line per board: `2 roots · 1 query · 14 issues · every 1m · polled 12 s ago`. Zero counts are omitted. An `off` board says `sync off` where
 * the interval would be and `last polled` where `polled` would, because for it the age is not a heartbeat but the date of the last time anyone looked.
 */
export function boardRowLine(board: JiraBoardStatus, now: number): { text: string; failing: boolean } {
  const off = board.interval === 'off';
  const parts = [
    countOrNull(board.roots.length, 'root'),
    countOrNull(board.queries.length, 'query'),
    countOrNull(board.count, 'issue'),
    off ? 'sync off' : `every ${board.interval}`,
    polledPhrase(board.polledAt, now, off)
  ].filter((s): s is string => s !== null);
  return { text: parts.join(' · '), failing: board.failures.length > 0 };
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
    const ms = SYNC_INTERVALS[b.interval];
    if (ms === null) continue;
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
 * Which board the page draws: the one the browser stored when it is still there, else the first by name. The stored value is `unknown` because it is
 * persisted — a deleted board (here or in another browser), garbage, or a number all fall through to the first by name, and the caller never asks the
 * server for a board that is not in the list. `null` only when there are no boards at all.
 */
export function pickBoard(storedId: unknown, boards: readonly JiraBoardStatus[]): JiraBoardStatus | null {
  if (typeof storedId === 'string') {
    const stored = boards.find((b) => b.id === storedId);
    if (stored !== undefined) return stored;
  }
  return [...boards].sort(byName)[0] ?? null;
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
