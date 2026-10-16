import { elapsedSince, formatCreated } from './item-age';
import { pollAge } from './tracker';
import { SYNC_INTERVALS } from '../../../shared/types';
import type { JiraAccess, JiraBoard, JiraBoardFailure, JiraBoardStatus, JiraIssue, JiraStatusCategory, JiraStatusPayload } from '../../../shared/types';

/**
 * jira.ts — what the client says about Jira (Jira phase 2, spec §6). The one home of every derivation the Jira board, its modal, Setup and the rail chip
 * print, like `lib/tracker.ts` is for GitHub: five surfaces describing one board five ways on one screen is what this file exists to prevent.
 *
 * Nothing here reads a clock of its own. `now` is a REQUIRED parameter wherever an age is printed, with no `Date.now()` default — `tracker.ts`'s rule and
 * its reason: a default is how the next call site reads its own clock without noticing, and then one surface ages two readings against two instants.
 * Every poll or check age goes through `pollAge`, so a Jira poll reads `12 s` and `4m` exactly as a GitHub one does (a card's age is `elapsedSince`'s own
 * reading), and a board not swept yet reads `not polled yet` wherever an age would be — never `NaN`, never `0 s`, which is the opposite claim.
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
 * The board sheet's query chips, the ONE home of their copy and JQL. `chip` is the text on the chip (the sheet draws the leading `+`), `label` the
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

/** The fourth chip, `+ Custom JQL`: an empty row for a person to write, labelled `Custom query`. Not a preset — it has no JQL of its own. */
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
  return [...issues].sort((a, b) => updatedMs(b) - updatedMs(a) || byKey(a, b));
}

/** An issue's `updated` as epoch ms, an unparseable stamp as 0 (the oldest) — shared by `sortForBoard` and `sortTops`, so the two cannot age a stamp twice. */
const updatedMs = (i: JiraIssue): number => {
  const t = Date.parse(i.updated);
  return Number.isNaN(t) ? 0 : t;
};

/** The board's tie-break: plain string order on the key. */
const byKey = (a: JiraIssue, b: JiraIssue): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

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
 * read is `?`. (The rail chip draws ONE initial, `me.name`'s first letter; this two-letter reading is the card's alone.)
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, 2)
    .map((w) => Array.from(w)[0].toUpperCase());
  return letters.length === 0 ? '?' : letters.join('');
}

// ── The fold ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The on-board parent → direct-children index the fold builds (grouped-board spec §3), read by the issue modal's tree for whichever issue it shows.
 * `ReadonlyMap` where the spec writes `Map`: no reader may write the fold, and the type says so.
 */
export type JiraChildrenIndex = ReadonlyMap<string, readonly JiraIssue[]>;

/**
 * The board as cards (grouped-board spec §3): `tops` are the issues drawn as cards, in the input list's order (`sortTops` orders them, per column);
 * `under` holds, per top key, every issue folded under it at any depth; `childrenOf` is the fold's own parent → direct-children edges. Both maps are SPARSE
 * — a key with nothing under it has no entry, and readers use `?? []` — and every list in them is in `sortForBoard` order.
 */
export interface JiraFold {
  tops: JiraIssue[];
  under: ReadonlyMap<string, readonly JiraIssue[]>;
  childrenOf: JiraChildrenIndex;
}

/**
 * Every on-board descendant folds into its TOPMOST on-board ancestor (G-A, grouped-board spec §3). This is the ONE walk of the parent chain in the client —
 * the board, the band count, the filters and the modal tree all read its result, and none of them follows `parent.key` upward on its own (§8 anti-goal),
 * because two walks are two answers to "which card is this issue on" the first time they disagree about an edge case.
 *
 * `top(X)` is X when X has no parent, when its parent is not in this list (off the board: dropped by the 14-day Done window, cut by the 500 cap, or never
 * fetched — "on the board" means the loaded list, exactly), or when the walk up from X comes back to X; otherwise it is `top(parent(X))`. Jira has no
 * cycles, but this list is our own cache, and a malformed one must not hang the page: a cycle's members are each their own top, drawn side by side, and
 * anything hanging off a cycle folds under the first cycle member its walk meets. Memoised per key, so the whole list costs one pass.
 *
 * `childrenOf` holds only FOLD edges — a non-top issue under the parent it folded through — so a top is nobody's child and the index is acyclic by
 * construction; the modal's tree recurses it with no guard of its own beyond the "each key once" set it keeps for reparents. The input is the poller's
 * cache copy and is never mutated.
 */
export function foldBoard(issues: readonly JiraIssue[]): JiraFold {
  const byKey = new Map(issues.map((i) => [i.key, i] as const));
  const topOf = new Map<string, string>();

  for (const start of issues) {
    if (topOf.has(start.key)) continue;
    // Walk up recording the path, until a node whose top is already known, a node with no on-board parent (that node is the top), or a parent already
    // on this path (a cycle: the path from that parent's position to the end).
    const path: string[] = [];
    const at = new Map<string, number>();
    let x = start;
    let top: string;
    for (;;) {
      const known = topOf.get(x.key);
      if (known !== undefined) {
        top = known;
        break;
      }
      at.set(x.key, path.length);
      path.push(x.key);
      const parent = x.parent === null ? undefined : byKey.get(x.parent.key);
      if (parent === undefined) {
        top = x.key;
        break;
      }
      const loop = at.get(parent.key);
      if (loop !== undefined) {
        for (const k of path.slice(loop)) topOf.set(k, k);
        top = path[loop];
        path.length = loop;
        break;
      }
      x = parent;
    }
    for (const k of path) topOf.set(k, top);
  }

  const tops: JiraIssue[] = [];
  const under = new Map<string, JiraIssue[]>();
  const childrenOf = new Map<string, JiraIssue[]>();
  const push = (m: Map<string, JiraIssue[]>, k: string, i: JiraIssue): void => {
    const list = m.get(k);
    if (list === undefined) m.set(k, [i]);
    else list.push(i);
  };
  for (const i of issues) {
    // Every key was resolved by the loop above; the fallback only keeps an impossible miss from dropping a card.
    const top = topOf.get(i.key) ?? i.key;
    if (top === i.key) {
      tops.push(i);
      continue;
    }
    push(under, top, i);
    // A non-top issue has an on-board parent by definition (a missing or off-board one would have made it a top).
    if (i.parent !== null) push(childrenOf, i.parent.key, i);
  }
  const sorted = (m: Map<string, JiraIssue[]>): Map<string, JiraIssue[]> => new Map([...m].map(([k, v]) => [k, sortForBoard(v)]));
  return { tops, under: sorted(under), childrenOf: sorted(childrenOf) };
}

/**
 * The tops' order within a column (grouped-board spec §3, Sort): the newest `updated` across the top AND everything folded under it, descending, with
 * `sortForBoard`'s key tie-break. Activity on a child therefore lifts its parent — the flat board sorted by the issue's own stamp, and a parent whose
 * subtasks are being worked would otherwise sink. The sort key is never drawn: the card's age stays the top's own (`cardAgeStamp`). Returns a new array.
 */
export function sortTops(tops: readonly JiraIssue[], under: JiraFold['under']): JiraIssue[] {
  const newest = new Map(tops.map((t) => [t.key, Math.max(updatedMs(t), ...(under.get(t.key) ?? []).map(updatedMs))] as const));
  const at = (t: JiraIssue): number => newest.get(t.key) ?? updatedMs(t);
  return [...tops].sort((a, b) => at(b) - at(a) || byKey(a, b));
}

/** How far along the issues under a card are, by column — `columnOf`'s three buckets, so the bar can never disagree with the columns. */
export interface JiraProgress {
  done: number;
  doing: number;
  todo: number;
}

export function foldProgress(issues: readonly JiraIssue[]): JiraProgress {
  const p: JiraProgress = { done: 0, doing: 0, todo: 0 };
  for (const i of issues) p[columnOf(i)] += 1;
  return p;
}

/**
 * Everything a card's fold block draws (grouped-board spec §4): the `C children · D below them` line, the spread and its caption. `null` for a top with
 * nothing folded under it, which draws no block at all — its Jira subtask count is not this board's business.
 */
export function cardFold(topKey: string, fold: JiraFold): { line: string; progress: JiraProgress; caption: string } | null {
  const all = fold.under.get(topKey);
  if (all === undefined || all.length === 0) return null;
  const direct = (fold.childrenOf.get(topKey) ?? []).length;
  const progress = foldProgress(all);
  const line = childrenLine(direct, all.length - direct);
  const caption = progressLine(progress);
  // An issue under the top means a chain that ends in a direct child of it (so `direct > 0`), and every issue lands in a bucket (so the sum is not
  // zero): both are non-null here. The guard is that reasoning made checkable, not a case that can happen.
  if (line === null || caption === null) return null;
  return { line, progress, caption };
}

/**
 * The tops a filter shows (F1, grouped-board spec §5): a top is shown when IT matches — with no ring keys, because a card that matches needs no "why is this
 * here" — or, failing that, when any issue folded under it matches, carrying those keys in `under`'s order for the ring's marker. A top with neither is
 * absent. `keep` is the board's `matchesBoardFilters` per issue, unchanged, so a filter means the same thing folded or not.
 */
export function foldMatches(fold: JiraFold, keep: (issue: JiraIssue) => boolean): Map<string, string[]> {
  const shown = new Map<string, string[]>();
  for (const top of fold.tops) {
    if (keep(top)) {
      shown.set(top.key, []);
      continue;
    }
    const hits = (fold.under.get(top.key) ?? []).filter(keep).map((i) => i.key);
    if (hits.length > 0) shown.set(top.key, hits);
  }
  return shown;
}

/** One row of the issue modal's Children tree: the issue, and how deep it sits (0 for a direct child). */
export interface JiraTreeRow {
  issue: JiraIssue;
  depth: number;
}

/**
 * The issue modal's Children tree (grouped-board spec §6). Direct children are the detail read's `children`, fresh, in the order it gave them; under each,
 * its descendants from the board's `childrenOf` snapshot, depth-first in the index's own order — so the tree costs no Jira call beyond the one the modal
 * already makes. `childrenOf: null` (a modal opened with no board behind it) draws the direct children only.
 *
 * Each key is drawn once. The skip set starts as the modal's own key plus EVERY direct child's: seeding the direct children first is what lets an issue
 * reparented since the last poll land as the direct child the fresh read says it is, even when the stale branch that still holds it is drawn earlier;
 * seeding the modal's own key stops a stale snapshot drawing the open issue inside its own tree. A skipped key takes its whole branch with it. An issue the
 * card counted that the tree no longer reaches is simply absent — the tree is the fresher of the two. `progress` counts the rows as drawn.
 */
export function modalTree(
  selfKey: string,
  children: readonly JiraIssue[],
  childrenOf: JiraChildrenIndex | null
): { rows: JiraTreeRow[]; progress: JiraProgress } {
  const skip = new Set([selfKey, ...children.map((c) => c.key)]);
  const rows: JiraTreeRow[] = [];
  const descend = (key: string, depth: number): void => {
    for (const c of childrenOf?.get(key) ?? []) {
      if (skip.has(c.key)) continue;
      skip.add(c.key);
      rows.push({ issue: c, depth });
      descend(c.key, depth + 1);
    }
  };
  for (const c of children) {
    rows.push({ issue: c, depth: 0 });
    descend(c.key, 1);
  }
  return { rows, progress: foldProgress(rows.map((r) => r.issue)) };
}

// ── Sentences ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `1 root`, `2 roots`; `queries` is the one plural that is not the noun plus `s`. */
const count = (n: number, noun: 'root' | 'query' | 'issue' | 'card'): string => `${n} ${n === 1 ? noun : noun === 'query' ? 'queries' : `${noun}s`}`;

/** The same, or `null` for zero, which every sentence below omits rather than print. */
const countOrNull = (n: number, noun: 'root' | 'query' | 'issue'): string | null => (n > 0 ? count(n, noun) : null);

/**
 * A fold's spread as the caption under its bar (grouped-board spec §4): `2 done · 4 in progress · 3 to do`, done first — the order the bar's segments are
 * drawn in — with each zero part omitted. `null` when all three are zero, which draws no caption (and `SpreadBar` no bar).
 */
export function progressLine(p: JiraProgress): string | null {
  const parts = [p.done > 0 ? `${p.done} done` : null, p.doing > 0 ? `${p.doing} in progress` : null, p.todo > 0 ? `${p.todo} to do` : null];
  const said = parts.filter((s): s is string => s !== null);
  return said.length > 0 ? said.join(' · ') : null;
}

/**
 * The fold block's first line (grouped-board spec §4, the mock's wording): `C children · D below them`, where C is the direct children on the board and D
 * everything deeper; `C children` (`1 child`) when nothing is deeper. `null` with no direct child, which draws no block.
 */
export function childrenLine(direct: number, deeper: number): string | null {
  if (direct === 0) return null;
  const head = `${direct} ${direct === 1 ? 'child' : 'children'}`;
  return deeper > 0 ? `${head} · ${deeper} below them` : head;
}

/**
 * The F1 ring's marker (grouped-board spec §5): `1 match: PAY-162` names the one folded match in the word itself; past one the word is `N matches` and the
 * keys go to the marker's `title`, since a card cannot hold a list. `null` for no match — a top that matches on its own draws no marker.
 */
export function matchMarker(keys: readonly string[]): { word: string; title: string | undefined } | null {
  if (keys.length === 0) return null;
  if (keys.length === 1) return { word: `1 match: ${keys[0]}`, title: undefined };
  return { word: `${keys.length} matches`, title: keys.join(', ') };
}

/**
 * The age half of a poll sentence: `polled 12 s ago`, or `not polled yet`. `last` is Setup's off-board wording, where the poll is history. Exported for
 * the chip popover, so a board's age is worded once across the Band, Setup and the chip.
 */
export function polledPhrase(polledAt: string | null, now: number, last = false): string {
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
 *
 * `fold` is the loaded list's two numbers (grouped-board spec §4): its length and its tops, both UNFILTERED. With it, the issue count is the list's own
 * rather than the status poll's `board.count` — a different poller that can disagree with the list for one interval, and a line that says "17 issues · 5
 * cards" has to count one list — and an `M cards` part follows the sources whenever something folds (`1 card` in the singular). `null` means the list has
 * not loaded, and reads today's line from `board.count`, with no cards part. Required, with no default, for `now`'s reason: a default is how the next call
 * site forgets it.
 */
export function bandSub(
  board: JiraBoardStatus,
  site: string,
  now: number,
  fold: { issues: number; cards: number } | null
): { text: string; failing: boolean } {
  const sources = [countOrNull(board.roots.length, 'root'), countOrNull(board.queries.length, 'query')].filter((s): s is string => s !== null);
  const issues = fold === null ? board.count : fold.issues;
  const parts = [site, `${count(issues, 'issue')}${sources.length > 0 ? ` from ${sources.join(' and ')}` : ''}`];
  if (fold !== null && fold.cards < fold.issues) parts.push(count(fold.cards, 'card'));
  parts.push(polledPhrase(board.polledAt, now));
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
 * The Connection card's last-sweep reading, in the two halves it draws: `lead` — `every 15 s · 12 calls` while the poller is `armed` (a tick is scheduled; the
 * server's base tick is 15 s, `TRACKER_POLL_MS`), `idle · 12 calls` otherwise — and `rate`, the 429 clause: `last 429 4m ago` (through `pollAge`) or
 * `no 429 since start`, with `red` set by `callsReading`'s own window so this card and the chip's meter agree on when Jira "recently refused". An unparseable
 * `last429At` still says a 429 happened, but not when, and is never red.
 */
export function sweepLine(armed: boolean, calls: JiraStatusPayload['calls'], now: number): { lead: string; rate: string; red: boolean } {
  const lead = `${armed ? 'every 15 s' : 'idle'} · ${calls.sweep} ${calls.sweep === 1 ? 'call' : 'calls'}`;
  if (calls.last429At === null) return { lead, rate: 'no 429 since start', red: false };
  const age = pollAge(calls.last429At, now);
  return { lead, rate: age === null ? 'last 429 at an unknown time' : `last 429 ${age} ago`, red: callsReading(calls, now).red };
}

/**
 * One sentence per `access` that is not `ok`, for the Connection card's red line (the server's own `detail` follows it). `ok` is `null`: nothing is wrong,
 * so nothing is drawn. `unconfigured` is here for completeness — the page is never drawn then, the rail hides it.
 */
export function accessPhrase(access: JiraAccess): string | null {
  switch (access) {
    case 'ok':
      return null;
    case 'unconfigured':
      return 'Jira is not configured on this server';
    case 'unsupported':
      return 'this site is not Jira Cloud';
    case 'unauthorized':
      return 'Jira rejected the credentials';
    case 'forbidden':
      return 'Jira refused a call (403)';
    case 'rate-limited':
      return 'Jira is rate-limiting this server (429)';
    case 'unreachable':
      return 'Jira did not answer';
  }
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
 * null-safe expression — the three collections and `armed`, the field phase 2 added (it proves a phase-2 server, so `home` is read null-safely after
 * it) — because a body missing one throws a `TypeError` inside a render, and React unmounts the page when it does. A wrong-shaped ROW degrades to a
 * row that says less instead.
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
