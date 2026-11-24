/**
 * jira-mentions.ts — the fetch/post helpers and shape guard behind `hooks/useJiraMentions.ts` (Jira mentions phase 1, Task 7).
 *
 * No React. One `JiraMentionsFailure` shape for every refusal so the page reads one thing: the sweep's two refusals (409, 429) keep the board sweep's
 * `{ message }` body (a 429 adds `retryAt`, the end of the wait, which the page words as "Jira asked to wait until HH:MM"), the other routes answer `{ error
 * }`.
 *
 * Since Task 8 it is also the one home of every derivation the Mentions page prints (board.md: "every derivation has one home in `lib/`"): the stored view
 * and Show-dismissed keys with their guards, the List's rows and search, the excerpt split around the user's own `@`, and the band's sub-line. Since Task 10
 * it holds the mention modal's too: the thread read, the walk over the view's order, the fold and the `@Name` chips.
 */
import { marked } from 'marked';

import { errorOf, postJson } from './http';
import { elapsedSince } from './item-age';
import { accessPhrase } from './jira';
import { formatZonedClock } from './time-zone';
import {
  JIRA_MENTIONS_ISSUE_CAP,
  type JiraAccess,
  type JiraIssue,
  type JiraMention,
  type JiraMentionIssue,
  type JiraMentionsConfigured,
  type JiraMentionsPayload,
  type JiraThreadComment,
  type JiraThreadPayload
} from '../../../shared/types';

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
 *
 * The check goes down to the ROWS, unlike the board's list (`parseJiraBoardIssues` filters a bad row out): `mentionRows` flat-maps every ticket's `mentions`,
 * the search lowercases the key, summary, author and excerpt, `mentionIssueType` the type, and the modal counts `boards` — each without a null-safe
 * expression, so a ticket missing one would throw inside the render this guard exists to protect. A whole answer is refused rather than a row dropped
 * because the server builds every row in one place; a malformed one means the body is not what this client was built against, and the page says so.
 */
export function isJiraMentionsPayload(value: unknown): value is JiraMentionsPayload {
  if (!isRecord(value)) return false;
  if (value.configured === false) return true;
  return (
    value.configured === true &&
    Array.isArray(value.issues) &&
    value.issues.every(isMentionIssue) &&
    Array.isArray(value.dismissed) &&
    value.dismissed.every(isMentionIssue)
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a List row, a card and the modal's head read of a ticket — see `isJiraMentionsPayload`. */
function isMentionIssue(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v.key === 'string' &&
    typeof v.summary === 'string' &&
    typeof v.type === 'string' &&
    isRecord(v.status) &&
    Array.isArray(v.boards) &&
    Array.isArray(v.mentions) &&
    v.mentions.every(isMention) &&
    // `draft` and `session` are absent from an older server's answer (read as none), but a present value must be an object or null: the modal reads
    // `draft.text` and `session.sessionId` without a null-safe expression.
    optionalRecord(v.draft) &&
    optionalRecord(v.session)
  );
}

const optionalRecord = (v: unknown): boolean => v === undefined || v === null || isRecord(v);

function isMention(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v.commentId === 'string' &&
    typeof v.created === 'string' &&
    typeof v.excerpt === 'string' &&
    typeof v.url === 'string' &&
    isRecord(v.author) &&
    typeof v.author.name === 'string'
  );
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
export async function postJiraMentions(path: 'sweep' | 'dismiss' | 'restore' | 'draft/discard', body: object): Promise<JiraMentionsPayload> {
  const res = await postJson(`/api/jira/mentions/${path}`, body);
  if (!res.ok) throw failureOfMentions(res.status, res.body, `Jira answered ${res.status}`);
  if (!isJiraMentionsPayload(res.body)) throw { message: 'malformed response', retryAt: null, status: 0 } satisfies JiraMentionsFailure;
  return res.body;
}

/**
 * `POST /api/jira/mentions/reply` — the one route that writes a Jira comment. Resolves the new payload and the posted comment; rejects with a
 * `JiraMentionsFailure` whose message is the server's sentence (`text too long`, a 409, or the 503 rate-limit sentence with its `retryAt`).
 */
export async function postJiraReply(
  key: string,
  text: string
): Promise<{ payload: JiraMentionsPayload; posted: { id: string; url: string } }> {
  const res = await postJson('/api/jira/mentions/reply', { key, text });
  if (!res.ok) throw failureOfMentions(res.status, res.body, `Jira answered ${res.status}`);
  const body = res.body;
  const posted = isRecord(body) && isRecord(body.posted) ? body.posted : null;
  if (!isJiraMentionsPayload(body) || posted === null || typeof posted.id !== 'string' || typeof posted.url !== 'string') {
    throw { message: 'malformed response', retryAt: null, status: 0 } satisfies JiraMentionsFailure;
  }
  return { payload: body, posted: { id: posted.id, url: posted.url } };
}

export const asMentionsFailure = (e: unknown): JiraMentionsFailure =>
  typeof e === 'object' && e !== null && typeof (e as JiraMentionsFailure).message === 'string' && 'retryAt' in e
    ? (e as JiraMentionsFailure)
    : { message: 'Jira unavailable', retryAt: null, status: 0 };

/**
 * `POST /api/jira/mentions/sweep` for a caller that has no `useJiraMentions` — the Jira pill's popover. That hook arms its own GET poller and the chip is
 * mounted app-wide, so the chip posts the press itself and re-reads the shell's status for the row's age. Never rejects: a refusal (409 `Jira is not being
 * polled`, 429 with the wait's end, a network failure) resolves as the `JiraMentionsFailure` the row words.
 */
export async function sweepJiraMentions(): Promise<{ ok: true } | { ok: false; failure: JiraMentionsFailure }> {
  try {
    await postJiraMentions('sweep', {});
    return { ok: true };
  } catch (e) {
    return { ok: false, failure: asMentionsFailure(e) };
  }
}

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
 * Rows (Show dismissed applied, search not) grouped into one card per ticket, in the rows' own order (waiting tickets first, then the dismissed ones). The
 * quoted mention is the newest by `created`, not the first row, so the card does not lean on the server's ordering (an unparseable stamp sorts oldest).
 * `search` keeps a ticket when ANY of its rows matches; a card whose only matching comment is an older one still quotes the newer mention.
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

/**
 * The search box: key, summary, author and excerpt, case-insensitive, on the loaded rows only (spec "A search box filters the loaded rows"). Blank keeps all.
 */
export function matchesMentionSearch(row: JiraMentionRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q === '') return true;
  return [row.issue.key, row.issue.summary, row.mention.author.name, row.mention.excerpt].some((s) => s.toLowerCase().includes(q));
}

/**
 * The excerpt cut around the user's own `@<me>`, so the cell can draw each one as a tinted chip IN PLACE (spec: "kept where the comment put it, not cut").
 * The server's excerpt words a mention as `@` + Jira's display text (`adfToText`), so a literal `@<me>` is the user's mention; anything else stays text.
 * Case-sensitive on purpose: Jira writes the display text it stored, and `@andreja` typed as plain text is not a mention. No `me` — nothing to mark.
 *
 * A match followed by a letter or digit is not one: with `me = "Ana"`, `@Anastasia` is someone else's name that happens to start with the user's. That is
 * `chipMentions`' own `(?![\p{L}\p{N}])` boundary, so the List's excerpt and the modal's thread cannot disagree about which `@` is the user.
 */
export function excerptParts(excerpt: string, me: string | null): { text: string; me: boolean }[] {
  if (me === null || me === '') return [{ text: excerpt, me: false }];
  const at = `@${me}`;
  const parts: { text: string; me: boolean }[] = [];
  let from = 0;
  // `seek` runs past a rejected match one character at a time, but past an accepted one whole, so two chips never overlap.
  for (let seek = 0, i = excerpt.indexOf(at); i !== -1; i = excerpt.indexOf(at, seek)) {
    if (/^[\p{L}\p{N}]/u.test(excerpt.slice(i + at.length))) {
      seek = i + 1;
      continue;
    }
    if (i > from) parts.push({ text: excerpt.slice(from, i), me: false });
    parts.push({ text: at, me: true });
    from = seek = i + at.length;
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
 * Whether a check-now press can run, for BOTH of its controls — the page's Sync now chip (`mentionsBand`) and the Jira pill popover's Mentions row icon —
 * so the two cannot disagree about when a press is pointless. Off while a check is out, while a 429's wait is still ahead (the server's stored `retryAt`
 * first, then a refused press's own, which is known before the next answer has stored it), and under a blocking access; the tooltip names the wait's end or
 * the access sentence, else `Check mentions now`. `wait` and `blocking` come back too, because the band prints them.
 */
export function mentionsCheckGate(input: {
  checking: boolean;
  access: JiraAccess | undefined;
  /** Wait ends in precedence order: the stored one, then a refusal's. */
  retryAts: readonly (string | null)[];
  now: number;
  zone: string;
}): { wait: string | null; blocking: string | null; disabled: boolean; title: string } {
  const { checking, access, retryAts, now, zone } = input;
  let wait: string | null = null;
  for (const at of retryAts) {
    wait = mentionsWait(at, now, zone);
    if (wait !== null) break;
  }
  const blocking = access !== undefined && BLOCKING_ACCESS.has(access) ? accessPhrase(access) : null;
  return { wait, blocking, disabled: checking || wait !== null || blocking !== null, title: wait ?? blocking ?? 'Check mentions now' };
}

/**
 * The band's whole reading, as the page draws it (spec "The page header says how many are waiting…"; `Sync.dc.html` draws each state):
 *
 * - `lead`, plain: `3 waiting · last 30 days · checked 1 min ago` (`checking…` in place of the age while a check is out), then the 429 sentence while a wait
 *   is open. Before the first stamp there is no count to give: `checking…` while one is due, else whatever stops it — the wait sentence, or the access
 *   sentence `accessPhrase` gives the Connection card (the server's own words for a bad token), else the check's failure, else `not checked yet`.
 * - `fail`, red: the reason the last check could not run — a blocking access, the cache's own `detail`, or a refused write's message — kept beside the rows
 *   the last good check left (Review Focus 2: a failed check never reads as "Nothing waiting").
 * - `tail`: `newest 100 tickets checked` while the cap bit, always last, where the Board band puts its own cap fact (`first <JIRA_BOARD_CAP> shown`).
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
  const { wait, blocking, disabled, title } = mentionsCheckGate({ checking, access, retryAts: [data.retryAt, error?.retryAt ?? null], now, zone });
  // A refused write (409 `Jira is not being polled`, a dismiss 400) or a failed read; a 429 is said by `wait` instead, and only while it is still ahead.
  const refused = error !== null && error.retryAt === null ? error.message : null;
  const fail = blocking ?? data.detail ?? refused;
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

// ── The mention modal (Task 10) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A 200 thread is trusted only when the modal can draw it: the comments array it maps over and the `total` it prints. Anything else is a failed read, for
 * `isJiraMentionsPayload`'s reason — a throw inside a render would unmount the page under the modal.
 */
export function isJiraThreadPayload(value: unknown): value is JiraThreadPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return typeof p.key === 'string' && typeof p.total === 'number' && Array.isArray(p.comments);
}

/**
 * `GET /api/jira/issue/:key/thread`, read fresh each time the modal lands on a ticket (spec: "the thread is the point and it must be current"). Rejects with
 * an `Error` whose message is the server's own `{ error }` sentence — `SUP-208 is not readable` for a ticket Jira will not show this token — which the modal
 * prints as it stands, so the reader learns why and not just that it failed.
 */
export async function fetchJiraThread(key: string): Promise<JiraThreadPayload> {
  const res = await fetch(`/api/jira/issue/${encodeURIComponent(key)}/thread`);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorOf(body, `HTTP ${res.status}`));
  if (!isJiraThreadPayload(body)) throw new Error('malformed response');
  return body;
}

/** One stop on the modal's prev/next walk: a List row or a Cards card, both of which carry the ticket and the mention they show. */
export interface MentionStep {
  issue: JiraMentionIssue;
  mention: JiraMention;
}

/**
 * Where `at` sits in the view's visible order, or `-1` when it has left it (answered, or dismissed with Show dismissed off). The List walks MENTIONS, so a
 * row is found by its comment id; the Cards walk TICKETS, so a card is found by its key — a poll may have changed which mention a card quotes, and the card is
 * still the one the reader opened.
 */
export function mentionStepIndex(order: readonly MentionStep[], at: MentionStep, byTicket: boolean): number {
  return order.findIndex((s) => (byTicket ? s.issue.key === at.issue.key : s.issue.key === at.issue.key && s.mention.commentId === at.mention.commentId));
}

/**
 * How many comments fold under `Show N earlier comments`: the ones before the user's own LATEST comment, which is where the conversation they owe an answer
 * to starts (an open mention is by definition newer than it). `0` when the user never commented — nothing is history to them yet.
 */
export function threadFold(comments: readonly JiraThreadComment[]): number {
  for (let i = comments.length - 1; i >= 0; i--) if (comments[i].mine) return i;
  return 0;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * The thread's `@Name` mentions as tinted chips (spec "`@Name` mentions are tinted chips"; the List's `.jira-mentions-at`). A comment's markdown carries a
 * mention as plain `@<display name>` (`adfToMarkdown`), so the boundaries of a multi-word name are not in the text; `names` — the user and every author in
 * the thread — say which runs of text are mentions, longest first so `@Mara Ilić` beats `@Mara`.
 *
 * It works on the SANITISED html `renderMarkdown` produced, and only ever wraps text that is already there in a fixed `<span>`: it never inserts a byte a
 * comment wrote, so it cannot reopen what the renderer closed. Tags pass through untouched, text inside `<code>`/`<pre>` is left alone (a handle in a code
 * sample is not a mention), and a name followed by a letter or digit is not one either (`@Andrejas`). Names are matched as the renderer escapes them
 * (`O'Brien` is `O&#39;Brien` in its output).
 */
export function chipMentions(html: string, names: readonly string[]): string {
  const ats = [...new Set(names.filter((n) => n.trim() !== ''))]
    .map((n) => `@${n}`.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]))
    .sort((a, b) => b.length - a.length);
  if (ats.length === 0) return html;
  const re = new RegExp(`(?:${ats.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  let inCode = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<(code|pre)\b/i.test(part)) inCode += 1;
        else if (/^<\/(code|pre)>/i.test(part)) inCode = Math.max(0, inCode - 1);
        return part;
      }
      return inCode > 0 ? part : part.replace(re, (m) => `<span class="jira-mentions-at">${m}</span>`);
    })
    .join('');
}

/**
 * The Markdown a reply becomes once Jira holds it: `@<to>` before the text, placed by the rule `replyDoc` (server/src/jira/adf-write.ts) applies to the ADF
 * it posts — opening the first paragraph, followed by a space, when the reply opens with a paragraph; in a paragraph of its own, a blank line before the
 * text, when it opens with a heading, a list, code, a quote, a rule or a table (a mention inside a heading would make the name a heading). The first block
 * is decided by `marked`'s lexer, the one the server uses, so the editor's preview and the posted comment place it where Jira will. `to` null — a mention
 * Jira sent without an author — is the text alone, as the server posts no mention node then.
 */
export function replyMarkdown(to: string | null, text: string): string {
  if (to === null) return text;
  const first = marked.lexer(text, { gfm: true }).find((t) => t.type !== 'space');
  return first === undefined || first.type === 'paragraph' ? `@${to} ${text}` : `@${to}\n\n${text}`;
}

// ── Draft a reply ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a ticket's reply draft stands. `idle`: no session, no draft. `drafting`: a session (even one still starting, `sessionId: null`) and no draft.
 * `ready`: a draft and no session, or a draft the live session itself wrote. `replacing`: a draft from an older session while a newer one is live — the
 * old text stays editable and postable until the new one overwrites it.
 */
export function draftState(issue: JiraMentionIssue): 'idle' | 'drafting' | 'ready' | 'replacing' {
  const { draft, session } = issue;
  if (!draft) return session ? 'drafting' : 'idle';
  if (!session || session.sessionId === draft.sessionId) return 'ready';
  return 'replacing';
}

/** Who a reply is addressed to: the author of the newest open mention (`mentions` is newest first), or `null` when none is left. */
export function replyTo(issue: JiraMentionIssue): { accountId: string; name: string } | null {
  const a = issue.mentions[0]?.author;
  return a === undefined ? null : { accountId: a.accountId, name: a.name };
}

/** The `@ N` mark's words (§8.9.7): the chip's label and the sentence a screen reader and the hover title both say, singular for one. */
export function mentionMarkText(n: number): { label: string; title: string } {
  return { label: `@ ${n}`, title: `${n} ${n === 1 ? 'mention waits' : 'mentions wait'} for your answer` };
}
