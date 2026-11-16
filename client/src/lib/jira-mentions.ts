/**
 * jira-mentions.ts — the fetch/post helpers and shape guard behind `hooks/useJiraMentions.ts` (Jira mentions phase 1, Task 7).
 *
 * No React. One `JiraMentionsFailure` shape for every refusal so the page reads one thing: the sweep's two refusals (409, 429) keep the board sweep's
 * `{ message }` body (a 429 adds `retryAt`, the end of the wait, which the page words as "Jira asked to wait until HH:MM"), the other routes answer `{ error }`.
 *
 * Since Task 8 it is also the one home of every derivation the Mentions page prints (board.md: "every derivation has one home in `lib/`"): the stored view
 * and Show-dismissed keys with their guards, the List's rows and search, the excerpt split around the user's own `@`, and the band's sub-line.
 */
import { errorOf, postJson } from './http';
import { elapsedSince } from './item-age';
import { accessPhrase } from './jira';
import { formatZonedClock } from './time-zone';
import { JIRA_MENTIONS_ISSUE_CAP, type JiraAccess, type JiraIssue, type JiraMention, type JiraMentionIssue, type JiraMentionsConfigured, type JiraMentionsPayload } from '../../../shared/types';

export interface JiraMentionsFailure {
  message: string;
  /** The ISO end of a 429's wait, else `null`. */
  retryAt: string | null;
  /** The HTTP status, `0` for a network failure or a malformed 200. */
  status: number;
}

/**
 * A 200 body is trusted only when it can be drawn: `configured` is the discriminator, and a configured body must carry the two arrays the page maps over.
 * A wrong shape is a failed read, for `isJiraStatusPayload`'s reason — a throw inside a render would unmount the page.
 */
export function isJiraMentionsPayload(value: unknown): value is JiraMentionsPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (p.configured === false) return true;
  return p.configured === true && Array.isArray(p.issues) && Array.isArray(p.dismissed);
}

/** The sentence and wait-end of a refusal body: `{ message }` (the sweep) first, then `{ error }`, then `fallback`. */
export function failureOfMentions(status: number, body: unknown, fallback: string): JiraMentionsFailure {
  const rec = typeof body === 'object' && body !== null ? (body as { message?: unknown; retryAt?: unknown }) : {};
  const message = typeof rec.message === 'string' && rec.message !== '' ? rec.message : errorOf(body, fallback);
  return { message, retryAt: typeof rec.retryAt === 'string' ? rec.retryAt : null, status };
}

/** `GET /api/jira/mentions`. Rejects with a `JiraMentionsFailure`. */
export async function fetchJiraMentions(): Promise<JiraMentionsPayload> {
  const res = await fetch('/api/jira/mentions');
  if (!res.ok) throw failureOfMentions(res.status, await res.json().catch(() => null), `Jira answered ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  if (!isJiraMentionsPayload(body)) throw { message: 'malformed /api/jira/mentions response', retryAt: null, status: 0 } satisfies JiraMentionsFailure;
  return body;
}

/** A write to one of the mentions routes; resolves the new payload, rejects with a `JiraMentionsFailure`. */
export async function postJiraMentions(path: 'sweep' | 'dismiss' | 'restore', body: object): Promise<JiraMentionsPayload> {
  const res = await postJson(`/api/jira/mentions/${path}`, body);
  if (!res.ok) throw failureOfMentions(res.status, res.body, `Jira answered ${res.status}`);
  if (!isJiraMentionsPayload(res.body)) throw { message: 'malformed response', retryAt: null, status: 0 } satisfies JiraMentionsFailure;
  return res.body;
}

export const asMentionsFailure = (e: unknown): JiraMentionsFailure =>
  typeof e === 'object' && e !== null && typeof (e as JiraMentionsFailure).message === 'string' && 'retryAt' in e
    ? (e as JiraMentionsFailure)
    : { message: 'Jira unavailable', retryAt: null, status: 0 };

// ── The page's stored picks (Task 8) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Mentions page's two views, behind the band's `List | Cards` track (spec "Goals — phase 1"; mocks `Main.dc.html`, `ListB.dc.html`). Declaration order is
 * the switch's order. A view of one page, never a `JIRA_PAGES` entry — the rail is the only page switch (board.md, "The Jira section's … pages").
 */
export type JiraMentionsView = 'list' | 'cards';
export const JIRA_MENTIONS_VIEWS: readonly JiraMentionsView[] = ['list', 'cards'];
export const JIRA_MENTIONS_VIEW_KEY = 'backlog-manager.jira-mentions-view';

/** `unknown`, not `string`, for `isJiraView`'s reason: a stored value round-trips through `JSON.parse` and can be anything at all. */
export function isJiraMentionsView(v: unknown): v is JiraMentionsView {
  return typeof v === 'string' && (JIRA_MENTIONS_VIEWS as readonly string[]).includes(v);
}

/**
 * Show dismissed, remembered per browser. Stored as a word and not a boolean because `persistedStore` is a closed STRING store (its whole contract is one
 * member of a word list), and a second store shape for one toggle would be the drift that file exists to stop.
 */
export type JiraMentionsDismissedPick = 'shown' | 'hidden';
export const JIRA_MENTIONS_DISMISSED_KEY = 'backlog-manager.jira-mentions-dismissed';

export function isJiraMentionsDismissedPick(v: unknown): v is JiraMentionsDismissedPick {
  return v === 'shown' || v === 'hidden';
}

// ── The List's rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One List row: one open mention, with the ticket it sits on. `dismissed` rows come from the payload's `dismissed` tickets and are drawn only while Show
 * dismissed is on. Dismiss and Restore act on the TICKET (spec: "Dismiss is per ticket in both views"), so a row carries its issue whole — the Dismiss on
 * either of a ticket's two rows posts both ids.
 */
export interface JiraMentionRow {
  issue: JiraMentionIssue;
  mention: JiraMention;
  dismissed: boolean;
}

/**
 * The rows in the server's order — tickets by their newest open mention, each ticket's mentions newest first — then, with `showDismissed`, the dismissed
 * tickets' rows after them, in their own order: a dimmed row never interleaves with the ones that still wait.
 */
export function mentionRows(data: JiraMentionsConfigured, showDismissed: boolean): JiraMentionRow[] {
  const rowsOf = (issues: readonly JiraMentionIssue[], dismissed: boolean): JiraMentionRow[] =>
    issues.flatMap((issue) => issue.mentions.map((mention) => ({ issue, mention, dismissed })));
  return [...rowsOf(data.issues, false), ...(showDismissed ? rowsOf(data.dismissed, true) : [])];
}

/**
 * One Cards-view card: a ticket and the mention it quotes. The quote, `earlier` and the Reply link are the TICKET's — computed over all its visible rows, the
 * search NOT applied — so a filter never changes what a card says: it only decides which tickets show.
 */
export interface JiraMentionCard {
  issue: JiraMentionIssue;
  mention: JiraMention;
  earlier: number;
  dismissed: boolean;
}

/**
 * Rows (Show dismissed applied, search not) grouped into one card per ticket, in the rows' own order (waiting tickets first, then the dismissed ones). The quoted
 * mention is the newest by `created`, not the first row, so the card does not lean on the server's ordering (an unparseable stamp sorts oldest). `search` keeps a
 * ticket when ANY of its rows matches; a card whose only matching comment is an older one still quotes the newer mention.
 */
export function mentionCards(rows: readonly JiraMentionRow[], search = ''): JiraMentionCard[] {
  const byKey = new Map<string, JiraMentionRow[]>();
  for (const row of rows) {
    const group = byKey.get(row.issue.key);
    if (group === undefined) byKey.set(row.issue.key, [row]);
    else group.push(row);
  }
  const time = (r: JiraMentionRow): number => {
    const t = Date.parse(r.mention.created);
    return Number.isNaN(t) ? -Infinity : t;
  };
  const cards: JiraMentionCard[] = [];
  for (const group of byKey.values()) {
    if (!group.some((r) => matchesMentionSearch(r, search))) continue;
    const newest = group.reduce((best, r) => (time(r) > time(best) ? r : best));
    cards.push({ issue: newest.issue, mention: newest.mention, earlier: group.length - 1, dismissed: newest.dismissed });
  }
  return cards;
}

/** `+1 earlier mention` / `+2 earlier mentions`; `null` when the ticket has only the one. */
export function earlierText(earlier: number): string | null {
  return earlier <= 0 ? null : `+${earlier} earlier mention${earlier === 1 ? '' : 's'}`;
}

/** The quote's age, spelled the way the mock does (`2 h ago`, `6 d ago`, `just now`) from the List's compact `2h`; `null` for an unparseable stamp. */
export function askedAge(created: string, now: number): string | null {
  const short = elapsedSince(created, now);
  if (short === null) return null;
  if (short === 'now') return 'just now';
  const m = /^(\d+)([mhd])$/.exec(short);
  return m === null ? short : `${m[1]} ${m[2]} ago`;
}

/** How many mentions wait — the List's count, one per row (the Cards' count is tickets, and the rail's). Dismissed tickets are not waiting. */
export function waitingCount(data: JiraMentionsConfigured): number {
  return data.issues.reduce((n, i) => n + i.mentions.length, 0);
}

/** The search box: key, summary, author and excerpt, case-insensitive, on the loaded rows only (spec "A search box filters the loaded rows"). Blank keeps all. */
export function matchesMentionSearch(row: JiraMentionRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q === '') return true;
  return [row.issue.key, row.issue.summary, row.mention.author.name, row.mention.excerpt].some((s) => s.toLowerCase().includes(q));
}

/**
 * The excerpt cut around the user's own `@<me>`, so the cell can draw each one as a tinted chip IN PLACE (spec: "kept where the comment put it, not cut").
 * The server's excerpt words a mention as `@` + Jira's display text (`adfToText`), so a literal `@<me>` is the user's mention; anything else stays text.
 * Case-sensitive on purpose: Jira writes the display text it stored, and `@andreja` typed as plain text is not a mention. No `me` — nothing to mark.
 */
export function excerptParts(excerpt: string, me: string | null): { text: string; me: boolean }[] {
  if (me === null || me === '') return [{ text: excerpt, me: false }];
  const at = `@${me}`;
  const parts: { text: string; me: boolean }[] = [];
  let from = 0;
  for (let i = excerpt.indexOf(at); i !== -1; i = excerpt.indexOf(at, from)) {
    if (i > from) parts.push({ text: excerpt.slice(from, i), me: false });
    parts.push({ text: at, me: true });
    from = i + at.length;
  }
  if (from < excerpt.length) parts.push({ text: excerpt.slice(from), me: false });
  return parts;
}

/**
 * A mention issue carries its type's NAME only (the swatch is all the page draws), but the board's type marks read `JiraIssue['type']`. This rebuilds the
 * part they read from the name Jira uses for its built-in kinds, so a mention row and a board card wear the same tile for the same type.
 */
export function mentionIssueType(name: string): JiraIssue['type'] {
  const n = name.toLowerCase();
  return { name, level: n === 'epic' ? 1 : 0, subtask: n === 'sub-task' || n === 'subtask' };
}

// ── The band ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How long ago the mentions cache was stamped, in the mocks' words (`Main.dc.html`, `Sync.dc.html`): `40 s`, `1 min`, `2 h`, `3 d`, floored. Not `pollAge`'s
 * `1m`: the page's copy is fixed by the plan as `checked 1 min ago`, and the chip popover's Mentions row (Task 12) reads this same function, so the two say
 * one thing. `null` for no stamp or one that does not parse; a stamp ahead of `now` (clock skew) reads `0 s`, never a negative age.
 */
export function checkedAge(at: string | null, now: number): string | null {
  if (at === null) return null;
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;
  const ms = Math.max(0, now - then);
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h`;
  return `${Math.floor(ms / 86_400_000)} d`;
}

/**
 * The `access` values under which no check can run (spec "Sync now, two ways"): the token or the site is wrong, and a press would only be refused. Narrower
 * than the hook's own "blocked" (any non-`ok` access stops `checking` from being claimed), because `unreachable` is a blip the next tick may clear, and the
 * page must not take the Sync now chip away for it.
 */
const BLOCKING_ACCESS: ReadonlySet<JiraAccess> = new Set(['unauthorized', 'forbidden', 'unsupported']);

/** `Jira asked to wait until 14:32` while a 429's wait end is still ahead of `now`, in the board's zone; `null` otherwise. */
export function mentionsWait(retryAt: string | null, now: number, zone: string): string | null {
  const at = retryAt === null ? NaN : Date.parse(retryAt);
  return Number.isNaN(at) || at <= now ? null : `Jira asked to wait until ${formatZonedClock(at, zone)}`;
}

/**
 * The band's whole reading, as the page draws it (spec "The page header says how many are waiting…"; `Sync.dc.html` draws each state):
 *
 * - `lead`, plain: `3 waiting · last 30 days · checked 1 min ago` (`checking…` in place of the age while a check is out), then the 429 sentence while a wait
 *   is open. Before the first stamp there is no count to give: `checking…` while one is due, else whatever stops it — the wait sentence, or the access
 *   sentence `accessPhrase` gives the Connection card (the server's own words for a bad token), else the check's failure, else `not checked yet`.
 * - `fail`, red: the reason the last check could not run — a blocking access, the cache's own `detail`, or a refused write's message — kept beside the rows
 *   the last good check left (Review Focus 2: a failed check never reads as "Nothing waiting").
 * - `tail`: `newest 100 tickets checked` while the cap bit, always last, the Board band's `first 500 shown` placement.
 *
 * `disabled` and `title` are the Sync now chip's: off while a check is out, while a wait is open (its tooltip names the end) or while access blocks every
 * check (its tooltip says why).
 */
export interface MentionsBand {
  lead: string;
  fail: string | null;
  tail: string | null;
  disabled: boolean;
  title: string;
}

export function mentionsBand(input: {
  data: JiraMentionsConfigured;
  checking: boolean;
  access: JiraAccess | undefined;
  error: JiraMentionsFailure | null;
  now: number;
  zone: string;
  /** The page's view: Cards counts tickets, the List counts mentions. Defaults to the List. */
  view?: JiraMentionsView;
}): MentionsBand {
  const { data, checking, access, error, now, zone, view = 'list' } = input;
  const wait = mentionsWait(data.retryAt, now, zone) ?? mentionsWait(error?.retryAt ?? null, now, zone);
  const blocking = access !== undefined && BLOCKING_ACCESS.has(access) ? accessPhrase(access) : null;
  // A refused write (409 `Jira is not being polled`, a dismiss 400) or a failed read; a 429 is said by `wait` instead, and only while it is still ahead.
  const refused = error !== null && error.retryAt === null ? error.message : null;
  const fail = blocking ?? data.detail ?? refused;
  const disabled = checking || wait !== null || blocking !== null;
  const title = wait ?? blocking ?? 'Check mentions now';
  const tail = data.truncated ? `newest ${JIRA_MENTIONS_ISSUE_CAP} tickets checked` : null;

  if (data.polledAt === null) {
    if (checking) return { lead: 'checking…', fail: null, tail: null, disabled, title };
    if (wait !== null) return { lead: wait, fail: null, tail: null, disabled, title };
    const other = access !== undefined && access !== 'ok' ? accessPhrase(access) : null;
    if (fail !== null || other !== null) return { lead: '', fail: fail ?? other, tail: null, disabled, title };
    return { lead: 'not checked yet', fail: null, tail: null, disabled, title };
  }

  const age = checkedAge(data.polledAt, now);
  const waiting = view === 'cards' ? `${data.issues.length} ticket${data.issues.length === 1 ? '' : 's'} waiting` : `${waitingCount(data)} waiting`;
  const parts = [waiting, `last ${data.window} days`, checking ? 'checking…' : age === null ? 'checked at an unknown time' : `checked ${age} ago`];
  if (wait !== null) parts.push(wait);
  return { lead: parts.join(' · '), fail, tail, disabled, title };
}
