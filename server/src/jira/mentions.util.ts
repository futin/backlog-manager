import { JIRA_MENTIONS_EXCERPT_CHARS, type JiraMention } from '../../../shared/types';
import { adfToText } from './adf';
import { jqlString } from './jira.client';

/**
 * mentions.util.ts — the pure judgement behind Jira › Mentions: an issue's comment list in, its CANDIDATE open mentions out (spec "How a check works").
 * No I/O, no clock, no module state: `now` arrives as a parameter so a suite pins it, and dismissals are the store's business, applied after this.
 */

/** The search's `fields`: what the row needs and nothing else, `comment` being the one that carries the judged data. */
export const MENTION_SEARCH_FIELDS = ['summary', 'status', 'issuetype', 'comment', 'updated'];

const DAY_MS = 86_400_000;

/**
 * The JQL that finds issues whose comments may mention `accountId`. `jqlString` is the only way this server interpolates into a query; `Done` is Jira's own
 * status-category name, a constant, not a value. A ticket in the done category is left out at the search: its conversation is over, and "answered" only
 * means "I commented after the mention", so the thank-you that follows my answer on a closed ticket read as an open mention — six of nine on the first live
 * list were on done tickets. Filtering in the JQL, not after it, also keeps those tickets out of the search's one page and spares their comment reads.
 */
export function mentionsJql(accountId: string, days: number): string {
  return `comment ~ ${jqlString(accountId)} AND updated >= -${days}d AND statusCategory != Done ORDER BY updated DESC`;
}

export interface RawComment {
  id: string;
  author?: { accountId?: string; displayName?: string; avatarUrls?: Record<string, string> };
  created: string;
  body: unknown;
}

/** True when the ADF holds a `mention` node whose `attrs.id` is `accountId`, at any depth. Anything that is not an object holds none. */
export function mentionsUser(body: unknown, accountId: string): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const node = body as { type?: unknown; attrs?: { id?: unknown }; content?: unknown };
  if (node.type === 'mention' && node.attrs?.id === accountId) return true;
  return Array.isArray(node.content) && node.content.some((child) => mentionsUser(child, accountId));
}

/** `adfToText`, cut at `JIRA_MENTIONS_EXCERPT_CHARS` on a word boundary with `…`; text that already fits is returned as is. */
export function excerptOf(body: unknown): string {
  const text = adfToText(body);
  if (text.length <= JIRA_MENTIONS_EXCERPT_CHARS) return text;
  const head = text.slice(0, JIRA_MENTIONS_EXCERPT_CHARS);
  /* The char after the cut being a space means `head` already ends on a whole word; otherwise back up to the last space (none → hard cut). */
  const cut = text[JIRA_MENTIONS_EXCERPT_CHARS] === ' ' ? head : head.slice(0, Math.max(head.lastIndexOf(' '), 0) || head.length);
  return `${cut.trimEnd()}…`;
}

/** Jira's 48x48 avatar when present, else the largest by pixel width, else none. */
export function avatarOf(urls: Record<string, string> | undefined): string | undefined {
  if (!urls) return undefined;
  if (urls['48x48']) return urls['48x48'];
  const sized = Object.entries(urls)
    .map(([k, v]) => [parseInt(k, 10), v] as const)
    .filter(([n]) => Number.isFinite(n))
    .sort((a, b) => b[0] - a[0]);
  return sized[0]?.[1];
}

/** A comment's author as every mention shape carries it — the row's chip and the thread modal's — so the two never name one person differently. */
export function authorOf(c: RawComment): { accountId: string; name: string; avatarUrl?: string } {
  const avatarUrl = avatarOf(c.author?.avatarUrls);
  return { accountId: c.author?.accountId ?? '', name: c.author?.displayName || 'Someone', ...(avatarUrl ? { avatarUrl } : {}) };
}

/**
 * Every candidate mention on one issue, newest first: a comment by someone else that @-mentions `me`, created inside the window, and strictly after
 * my latest own comment (or `answeredAfter`, a reply made elsewhere, whichever is later). Judged by `created` ONLY — an edit never resurfaces a
 * comment I already answered. A comment with no author id is never mine.
 */
export function judgeComments(input: {
  comments: RawComment[];
  me: string;
  site: string;
  key: string;
  now: number;
  windowDays: number;
  answeredAfter?: string | null;
}): JiraMention[] {
  const { comments, me, site, key, now, windowDays, answeredAfter } = input;
  let answered = answeredAfter ? Date.parse(answeredAfter) : NaN;
  if (Number.isNaN(answered)) answered = -Infinity;
  for (const c of comments) {
    if (c.author?.accountId === me) answered = Math.max(answered, Date.parse(c.created) || -Infinity);
  }
  const out: { at: number; mention: JiraMention }[] = [];
  for (const c of comments) {
    const at = Date.parse(c.created);
    if (Number.isNaN(at) || at <= answered || now - at > windowDays * DAY_MS) continue;
    if (c.author?.accountId === me || !mentionsUser(c.body, me)) continue;
    out.push({
      at,
      mention: {
        commentId: c.id,
        author: authorOf(c),
        created: c.created,
        excerpt: excerptOf(c.body),
        url: `https://${site}/browse/${key}?focusedCommentId=${c.id}`
      }
    });
  }
  return out.sort((a, b) => b.at - a.at).map((o) => o.mention);
}
