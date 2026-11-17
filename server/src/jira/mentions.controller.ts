import { Body, Controller, Get, HttpCode, HttpException, Param, Post, UseGuards } from '@nestjs/common';

import { JIRA_MENTIONS_DISMISS_MAX, JIRA_REPLY_MAX_CHARS, isJiraKey } from '../../../shared/types';
import type { JiraMentionIssue, JiraMentionsConfigured, JiraMentionsPayload, JiraThreadPayload } from '../../../shared/types';
import { SameOriginPostGuard } from '../agents/origin.guard';
import { jiraEnv } from './env.util';
import { JiraLiveService } from './live.service';
import { JiraMentionsStore, type JiraDismissal } from './mentions.store';
import { JiraPollerService } from './poller.service';
import { isSessionId } from './session-id.util';
import { unwrapJira } from './unwrap.util';

/** A Jira comment id as the REST API spells it: a decimal string. Twenty digits is far past any id Jira mints and short enough to keep a body small. */
const COMMENT_ID = /^\d{1,20}$/;

/** Appended to the error when Jira answered the reply POST itself with a 401 or 403: the one scope a token that reads and assigns fine may still lack. */
const COMMENT_SCOPE = ' — the token needs write:comment:jira';

/** `POST /api/jira/mentions/reply`'s answer: the mentions payload after the post, plus the new comment's id and focused-comment link. */
export type JiraMentionReplyAnswer = JiraMentionsConfigured & { posted: { id: string; url: string } };

/**
 * The Jira › Mentions routes (spec "Routes and shapes"): `GET /api/jira/mentions`, the three POSTs that act on it — `sweep` (the page's own "check now"),
 * `dismiss` and `restore` — and `GET /api/jira/issue/:key/thread`, the modal's fresh read of one ticket's conversation. A controller of its own rather than
 * three more methods on the read and write controllers, because every route here is about one cache and one store, and the two existing controllers'
 * header contracts (nine reads that never write; config writes that never call Jira) would each have to grow an exception for them.
 *
 * The order inside every handler is the write controller's: guard → validate (400) → configured (503) → act. A malformed body is wrong whatever the
 * environment; an unconfigured server never touches `jira-mentions.json`. The one exception is `sweep`, which takes no body and answers the board sweep's
 * refusals in the board sweep's words and shape — `{ message }`, 409 `Jira is not being polled` and 429 `rate limited` with the STORED `retryAt` — because
 * the client handles both presses with one function.
 *
 * Dismiss proves every id against the poller's cache before it writes anything: an id the cache does not hold as a candidate of THAT key, or one the store
 * already holds, is a 400 naming it — so a stale page cannot write a dismissal for a comment the list never offered (the cache is the only place `created`,
 * the store's retention clock, can come from). The write is all-or-nothing: the store throws with its memory unchanged, and the route answers 500 `could not
 * save — nothing changed`, the sentence the page shows. Restore of a key with nothing dismissed writes nothing and answers the payload as it was.
 *
 * **Drafts (plan Task 4, rulings R5/R6).** `POST mentions/draft` `{ key, sessionId, text }` is the one door a reply session's text comes in by (`jira.mjs draft`
 * posts here — this server's own route, never a Jira call): guard → validate (400: key, `invalid session id`, `text must be a non-empty string`, `text too long`)
 * → configured (503) → the `(key, sessionId)` pair must be a LIVE `reply` link in `JiraLiveService` (409 `no reply session for <KEY>` — a run link, an ended
 * reply or another session's does not count, so a stray session cannot plant text on a ticket) → `setDraft` through `save()`. `mentions/draft/discard` `{ key }`
 * drops the ticket's draft, and a key with none writes nothing. Nothing here sends a comment: only `mentions/reply` ever does.
 *
 * Every answer — `GET` and every POST — is composed by ONE private `payload()`: the poller's payload plus, per issue (in `issues` and `dismissed`), the store's
 * draft and the live service's `replySession`. The poller stays ignorant of drafts and links, so it never imports the live service.
 *
 * **Post reply (plan Task 5, rulings R4/R7).** `POST mentions/reply` `{ key, text }` is the one route that sends `POST issue/{key}/comment`: guard → 400
 * (key, then the draft route's two text sentences) → 503 → `JiraPollerService.postReply`, whose two refusals are this route's 409s — `<KEY> has no open
 * mention — it was answered or dismissed` and `a reply to <KEY> is already being posted` — and whose every other failure is `unwrapJira`'s §8 mapping. Not
 * `jiraWriteOrThrow`: it takes an assign/transition outcome and would read any unknown refusal as `transition not offered`. When Jira answered the POST
 * itself with a 401 or 403 the error gains `COMMENT_SCOPE`, since a token can read and assign and still lack the comment scope; the 401 refused BEFORE any
 * call (`access: unauthorized`) does not, because that one is about the token as a whole. The draft is dropped only after the comment lands, and a drop
 * that cannot be saved is logged and costs nothing else — the comment is posted, so the 200 stands; a refusal or a failure leaves the draft for a retry.
 *
 * Every successful POST answers the mentions payload, dismissals applied, so the page renders the answer and needs no second read.
 */
@Controller('api/jira')
export class JiraMentionsController {
  constructor(
    private readonly poller: JiraPollerService,
    private readonly store: JiraMentionsStore,
    private readonly live: JiraLiveService
  ) {}

  /** `GET /api/jira/mentions` — the cache with the dismissals applied; memory only, no call. Unconfigured answers `{ configured: false, detail }`. */
  @Get('mentions')
  mentions(): JiraMentionsPayload {
    return this.payload();
  }

  /** `POST /api/jira/mentions/sweep` — one mentions check now, joined, floored and window-refused as the poller decides (`mentionsSweepNow`). */
  @Post('mentions/sweep')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async sweep(): Promise<JiraMentionsPayload> {
    const result = await this.poller.mentionsSweepNow();
    if (result.kind === 'not-armed') throw new HttpException({ message: 'Jira is not being polled' }, 409);
    if (result.kind === 'wait') throw new HttpException({ message: 'rate limited', retryAt: new Date(result.retryAt).toISOString() }, 429);
    return this.payload();
  }

  /** `POST /api/jira/mentions/dismiss` `{ key, commentIds }` — hides those open mentions of one ticket until a newer one arrives or the key is restored. */
  @Post('mentions/dismiss')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  dismiss(@Body() body: unknown): JiraMentionsPayload {
    const key = this.keyOf(body);
    const ids = this.commentIdsOf(body);
    this.requireConfigured();
    const dismissedAt = new Date(Date.now()).toISOString();
    const entries: JiraDismissal[] = ids.map((commentId) => {
      const candidate = this.poller.mentionCandidate(key, commentId);
      if (candidate === null || this.store.isDismissed(commentId)) throw new HttpException({ error: `${commentId} is not an open mention on ${key}` }, 400);
      return { commentId, key, created: candidate.created, dismissedAt };
    });
    this.save(() => this.store.dismiss(entries));
    return this.payload();
  }

  /** `POST /api/jira/mentions/restore` `{ key }` — drops every dismissal of the ticket; a key with none writes nothing and still answers 200. */
  @Post('mentions/restore')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  restore(@Body() body: unknown): JiraMentionsPayload {
    const key = this.keyOf(body);
    this.requireConfigured();
    this.save(() => this.store.restore(key));
    return this.payload();
  }

  /** `POST /api/jira/mentions/draft` `{ key, sessionId, text }` — stores the text a live reply session drafted for the ticket, replacing an earlier draft. */
  @Post('mentions/draft')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  draft(@Body() body: unknown): JiraMentionsPayload {
    const key = this.keyOf(body);
    const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
    if (!isSessionId(sessionId)) throw new HttpException({ error: 'invalid session id' }, 400);
    const text = this.textOf(body);
    this.requireConfigured();
    if (!this.live.liveLinks().some((l) => l.how === 'reply' && l.key === key && l.sessionId === sessionId)) {
      throw new HttpException({ error: `no reply session for ${key}` }, 409);
    }
    const at = new Date(Date.now()).toISOString();
    this.save(() => this.store.setDraft(key, { text, sessionId, at }));
    return this.payload();
  }

  /** `POST /api/jira/mentions/draft/discard` `{ key }` — drops the ticket's draft; a key with none writes nothing and still answers 200. */
  @Post('mentions/draft/discard')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  discardDraft(@Body() body: unknown): JiraMentionsPayload {
    const key = this.keyOf(body);
    this.requireConfigured();
    this.save(() => this.store.dropDraft(key));
    return this.payload();
  }

  /** `POST /api/jira/mentions/reply` `{ key, text }` — posts the reply as the signed-in user and clears the mention (header, "Post reply"). */
  @Post('mentions/reply')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async reply(@Body() body: unknown): Promise<JiraMentionReplyAnswer> {
    const key = this.keyOf(body);
    const text = this.textOf(body);
    this.requireConfigured();
    const result = await this.poller.postReply(key, text);
    if ('refusal' in result) {
      if (result.refusal === 'posting') throw new HttpException({ error: `a reply to ${key} is already being posted` }, 409);
      throw new HttpException({ error: `${key} has no open mention — it was answered or dismissed` }, 409);
    }
    let posted: { id: string; url: string };
    try {
      const { id, url } = unwrapJira(result);
      posted = { id, url };
    } catch (err) {
      const named = !result.ok && 'sent' in result && (result.response.status === 401 || result.response.status === 403);
      if (named && err instanceof HttpException) {
        const answer = err.getResponse() as { error: string };
        throw new HttpException({ ...answer, error: `${answer.error}${COMMENT_SCOPE}` }, err.getStatus());
      }
      throw err;
    }
    try {
      this.store.dropDraft(key);
    } catch (err) {
      console.warn(`jira mentions: posted a reply to ${key} but could not drop its draft: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Configured was checked before the post; the cast covers only an env emptied in the instant since, and a write that landed is never turned into a 500.
    return { ...(this.payload() as JiraMentionsConfigured), posted };
  }

  /**
   * `GET /api/jira/issue/:key/thread` — the newest `JIRA_THREAD_MAX` comments, oldest first, judged as the check judges them. A 403 or 404 from Jira is one
   * answer here, 404 `<KEY> is not readable`: the modal says the same thing for a ticket that was deleted and one this account lost access to, and a 403
   * passed through as itself would read as this server refusing. Every other failure is `unwrapJira`'s §8 mapping.
   */
  @Get('issue/:key/thread')
  async thread(@Param('key') key: string): Promise<JiraThreadPayload> {
    if (!isJiraKey(key)) throw new HttpException({ error: 'invalid issue key' }, 400);
    this.requireConfigured();
    const result = await this.poller.thread(key);
    if (!result.ok && (result.response.status === 403 || result.response.status === 404)) {
      throw new HttpException({ error: `${key} is not readable` }, 404);
    }
    return unwrapJira(result);
  }

  /** The poller's payload with each issue's draft and drafting session filled in (R6); the unconfigured shape passes through. */
  private payload(): JiraMentionsPayload {
    const base = this.poller.mentionsPayload();
    if (!base.configured) return base;
    const fill = (i: JiraMentionIssue): JiraMentionIssue => ({ ...i, draft: this.store.draftFor(i.key), session: this.live.replySession(i.key) });
    return { ...base, issues: base.issues.map(fill), dismissed: base.dismissed.map(fill) };
  }

  /** The body's `text`, or the draft route's 400s: not a string or blank (`text must be a non-empty string`), over `JIRA_REPLY_MAX_CHARS` (`text too long`). */
  private textOf(body: unknown): string {
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.trim() === '') throw new HttpException({ error: 'text must be a non-empty string' }, 400);
    if (text.length > JIRA_REPLY_MAX_CHARS) throw new HttpException({ error: 'text too long' }, 400);
    return text;
  }

  /** The body's `key`, or the 400 every key gets (`isJiraKey`, case-sensitive). */
  private keyOf(body: unknown): string {
    const key = (body as { key?: unknown } | null)?.key;
    if (typeof key !== 'string' || !isJiraKey(key)) throw new HttpException({ error: 'invalid issue key' }, 400);
    return key;
  }

  /**
   * The body's `commentIds`: an array of 1 to `JIRA_MENTIONS_DISMISS_MAX` decimal-string ids, deduplicated. A number is refused rather than coerced — Jira's
   * ids are strings, and a client that sends a number has lost the id's identity somewhere (a 20-digit id does not survive a JS number).
   */
  private commentIdsOf(body: unknown): string[] {
    const raw = (body as { commentIds?: unknown } | null)?.commentIds;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > JIRA_MENTIONS_DISMISS_MAX) {
      throw new HttpException({ error: `commentIds must be 1 to ${JIRA_MENTIONS_DISMISS_MAX} comment ids` }, 400);
    }
    for (const id of raw) {
      if (typeof id === 'string' && COMMENT_ID.test(id)) continue;
      throw new HttpException({ error: `${typeof id === 'string' ? id : JSON.stringify(id)} is not a comment id` }, 400);
    }
    return [...new Set(raw as string[])];
  }

  private requireConfigured(): void {
    if (!jiraEnv().configured) throw new HttpException({ error: 'Jira is not configured' }, 503);
  }

  /** A store write, or the 500 the page shows. The store throws with its memory unchanged, so "nothing changed" is literally true. */
  private save(write: () => unknown): void {
    try {
      write();
    } catch (err) {
      console.warn(`jira mentions: could not save: ${err instanceof Error ? err.message : String(err)}`);
      throw new HttpException({ error: 'could not save — nothing changed' }, 500);
    }
  }
}
