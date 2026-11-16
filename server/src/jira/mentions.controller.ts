import { Body, Controller, Get, HttpCode, HttpException, Param, Post, UseGuards } from '@nestjs/common';

import { JIRA_MENTIONS_DISMISS_MAX, isJiraKey } from '../../../shared/types';
import type { JiraMentionsPayload, JiraThreadPayload } from '../../../shared/types';
import { SameOriginPostGuard } from '../agents/origin.guard';
import { jiraEnv } from './env.util';
import { JiraMentionsStore, type JiraDismissal } from './mentions.store';
import { JiraPollerService } from './poller.service';
import { unwrapJira } from './unwrap.util';

/** A Jira comment id as the REST API spells it: a decimal string. Twenty digits is far past any id Jira mints and short enough to keep a body small. */
const COMMENT_ID = /^\d{1,20}$/;

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
 * Every successful POST answers the mentions payload, dismissals applied, so the page renders the answer and needs no second read.
 */
@Controller('api/jira')
export class JiraMentionsController {
  constructor(
    private readonly poller: JiraPollerService,
    private readonly store: JiraMentionsStore
  ) {}

  /** `GET /api/jira/mentions` — the cache with the dismissals applied; memory only, no call. Unconfigured answers `{ configured: false, detail }`. */
  @Get('mentions')
  mentions(): JiraMentionsPayload {
    return this.poller.mentionsPayload();
  }

  /** `POST /api/jira/mentions/sweep` — one mentions check now, joined, floored and window-refused as the poller decides (`mentionsSweepNow`). */
  @Post('mentions/sweep')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async sweep(): Promise<JiraMentionsPayload> {
    const result = await this.poller.mentionsSweepNow();
    if (result.kind === 'not-armed') throw new HttpException({ message: 'Jira is not being polled' }, 409);
    if (result.kind === 'wait') throw new HttpException({ message: 'rate limited', retryAt: new Date(result.retryAt).toISOString() }, 429);
    return this.poller.mentionsPayload();
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
    return this.poller.mentionsPayload();
  }

  /** `POST /api/jira/mentions/restore` `{ key }` — drops every dismissal of the ticket; a key with none writes nothing and still answers 200. */
  @Post('mentions/restore')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  restore(@Body() body: unknown): JiraMentionsPayload {
    const key = this.keyOf(body);
    this.requireConfigured();
    this.save(() => this.store.restore(key));
    return this.poller.mentionsPayload();
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
      console.warn(`jira mentions: could not save dismissals: ${err instanceof Error ? err.message : String(err)}`);
      throw new HttpException({ error: 'could not save — nothing changed' }, 500);
    }
  }
}
