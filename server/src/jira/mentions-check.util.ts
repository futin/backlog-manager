import { JIRA_MENTIONS_ISSUE_CAP, JIRA_MENTIONS_WINDOW_DAYS, JIRA_THREAD_MAX, type JiraMention, type JiraMentionIssue } from '../../../shared/types';
import type { JiraAuth, JiraClient, JiraResponse } from './jira.client';
import { categoryOf } from './map-issue';
import { MENTION_SEARCH_FIELDS, judgeComments, mentionsJql, type RawComment } from './mentions.util';

/**
 * mentions-check.util.ts — ONE mentions check's calls and judgement (spec "How a check works", steps 1-4): the search, the per-issue comment read for a
 * thread longer than the inline page, `judgeComments`, the board names, the order. It holds no state and decides nothing about the site: every failure
 * comes back as the response that caused it, and `JiraPollerService` — the one owner of the 429 window, the 401 reset and the mentions cache — decides
 * what that response does. That split is what lets the check ride the poller's chain (its calls land in the tick's count, its gate is the poller's gate)
 * without the poller's file growing a second hundred lines, and without a second Nest provider that would need the poller's private state passed to it.
 */

/** A cached ticket: the row's fields, `candidates` every open mention BEFORE dismissals (Task 6 applies those on read), and `mentions` the same list. */
export type JiraMentionCacheIssue = JiraMentionIssue & { candidates: JiraMention[] };

export type MentionsCheckResult = { ok: true; issues: JiraMentionCacheIssue[]; truncated: boolean } | { ok: false; response: JiraResponse<unknown> };

export interface MentionsCheckInput {
  client: JiraClient;
  auth: JiraAuth;
  /** My account id: the JQL's term and the judgement's "me". */
  me: string;
  now: number;
  /** The names of the boards whose cache holds `key`, in config order — memory only, no call (step 4). */
  boardsOf: (key: string) => string[];
  /**
   * Asked before every call: a refusal to answer in its place, or `null` to send. The poller answers a synthesised 429 while a window is open — a route
   * can open one while the search is out, and the comment reads after it are calls Jira has already said it will refuse.
   */
  refuse: () => JiraResponse<unknown> | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const ok = (res: JiraResponse<unknown>): boolean => res.status >= 200 && res.status < 300;

/** Jira's comment objects, kept to what `judgeComments` reads; a comment with no string id or `created` is not one it can judge, so it is skipped. */
function rawComments(list: unknown): RawComment[] {
  if (!Array.isArray(list)) return [];
  const out: RawComment[] = [];
  for (const c of list) {
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.created !== 'string') continue;
    const a = isObj(c.author) ? c.author : null;
    out.push({
      id: c.id,
      created: c.created,
      body: c.body,
      author:
        a === null
          ? undefined
          : {
              accountId: typeof a.accountId === 'string' ? a.accountId : undefined,
              displayName: typeof a.displayName === 'string' ? a.displayName : undefined,
              avatarUrls: isObj(a.avatarUrls) ? (a.avatarUrls as Record<string, string>) : undefined
            }
    });
  }
  return out;
}

/**
 * One check. One search page — `JIRA_MENTIONS_ISSUE_CAP` is exactly one page of `maxResults`, so `truncated` is just Jira saying `isLast: false` — then,
 * per issue whose inline `comment.total` exceeds what the search carried, one read of the newest `JIRA_THREAD_MAX` comments. The FETCHED page is judged
 * alone, not merged with the inline list: it is the newest 100 and the inline list the newest 20, so it already holds every inline comment still there —
 * and a comment deleted between the two calls is one a merge would resurrect. A 403 or 404 on that read means the ticket went (deleted, or hidden from
 * this token) between the search and the read, which is an answer about that ticket, so it drops just it; any other failure fails the whole check, because
 * a partial list swapped in would read as "these are all" (spec "Failure handling").
 */
export async function runMentionsCheck(input: MentionsCheckInput): Promise<MentionsCheckResult> {
  const { client, auth, me, now, boardsOf, refuse } = input;
  const refusedSearch = refuse();
  if (refusedSearch !== null) return { ok: false, response: refusedSearch };
  const res = await client.search(auth, {
    jql: mentionsJql(me, JIRA_MENTIONS_WINDOW_DAYS),
    fields: MENTION_SEARCH_FIELDS,
    maxResults: JIRA_MENTIONS_ISSUE_CAP
  });
  if (!ok(res)) return { ok: false, response: res };

  const issues: { newest: number; issue: JiraMentionCacheIssue }[] = [];
  for (const raw of Array.isArray(res.data?.issues) ? res.data.issues : []) {
    if (!isObj(raw) || typeof raw.key !== 'string') continue;
    const key = raw.key;
    const fields = isObj(raw.fields) ? raw.fields : {};
    const inline = isObj(fields.comment) ? fields.comment : {};
    let comments = rawComments(inline.comments);
    const shown = Array.isArray(inline.comments) ? inline.comments.length : 0;
    if (typeof inline.total === 'number' && inline.total > shown) {
      const refused = refuse();
      if (refused !== null) return { ok: false, response: refused };
      const thread = await client.comments(auth, key, JIRA_THREAD_MAX);
      if (thread.status === 403 || thread.status === 404) continue;
      if (!ok(thread)) return { ok: false, response: thread };
      comments = rawComments(thread.data?.comments);
    }

    const candidates = judgeComments({ comments, me, site: auth.site, key, now, windowDays: JIRA_MENTIONS_WINDOW_DAYS });
    if (candidates.length === 0) continue;
    const status = isObj(fields.status) ? fields.status : {};
    const issue: JiraMentionCacheIssue = {
      key,
      summary: str(fields.summary),
      type: str(isObj(fields.issuetype) ? fields.issuetype.name : undefined),
      status: { name: str(status.name), category: categoryOf(isObj(status.statusCategory) ? status.statusCategory.key : undefined) },
      boards: boardsOf(key),
      mentions: candidates,
      candidates
    };
    // `candidates` is newest first, so its head is the ticket's newest mention — the ticket's place in the list.
    issues.push({ newest: Date.parse(candidates[0].created), issue });
  }
  issues.sort((a, b) => b.newest - a.newest);
  return { ok: true, issues: issues.map((i) => i.issue), truncated: res.data?.isLast === false };
}
