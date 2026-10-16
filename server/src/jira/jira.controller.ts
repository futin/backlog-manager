import { Controller, Get, HttpException, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { isJiraKey } from '../../../shared/types';
import type { JiraIssue, JiraIssueDetail, JiraStatusPayload } from '../../../shared/types';
import { renderTicketBlock } from './block';
import { JIRA_JQL_MAX_CHARS, isJiraId } from './config.util';
import { jiraEnv } from './env.util';
import { jiraHttpError } from './errors.util';
import { JIRA_SEARCH_MAX_CHARS, JiraPollerService } from './poller.service';
import type { JiraResult } from './poller.service';

/**
 * The six read routes under `/api/jira` (Jira phase 1, spec §8 and §12). Every one answers from the poller's cache or status, or from ONE fresh read the
 * poller performs for it — never from a call this file makes, so the 429 window, the boot's missing `cloudId` and the 401 bookkeeping have one home
 * (`JiraPollerService.gate` / `routeFailed`) and a route cannot forget them. There is no POST here: board and query saves are phase 2's, the dispatch
 * route phase 5's, and `POST /api/jira/boards` / `GET /api/jira/prompt` are 404s until then (pinned by `test/jira-routes.test.ts`).
 *
 * The order inside every method is the same, and it is part of the contract: validate the parameter (400, or 404 for a board id that cannot be one of
 * ours), THEN refuse when Jira is not configured (503), THEN ask the poller. A malformed request is wrong whatever the environment, so it must not read as
 * an environment problem; and an unconfigured server never reaches the poller, which would otherwise have to answer for a site that does not exist.
 * `GET /api/jira` alone is exempt from the 503 — it is how the client LEARNS the server is unconfigured, so it answers 200 with `configured: false`.
 *
 * Failures are `jiraHttpError` (`errors.util.ts`), the one mapping of a Jira response to a status and a body, so a 401 means the same thing here as on the
 * next route. No credential reaches a body: the status payload carries `site` and `me` only (§10), and `jiraHttpError` builds its messages from Jira's own
 * sentence or the transport error's, neither of which can hold the token (jira.client.ts's header).
 */
@Controller('api/jira')
export class JiraController {
  constructor(private readonly poller: JiraPollerService) {}

  /** `GET /api/jira` — memory, the environment and `jira.json`, no outbound call. */
  @Get()
  status(): JiraStatusPayload {
    return this.poller.status();
  }

  /**
   * `GET /api/jira/boards/:id/issues` — a board's cached list. `isJiraId('b', …)`, not the bare `JIRA_ID_RE` (P10): that also accepts a query's or a skill's
   * id, and the lookup would then miss it for the wrong reason. Both a malformed id and a well-formed one `jira.json` does not hold are `unknown board`:
   * the caller has no business learning which.
   */
  @Get('boards/:id/issues')
  boardIssues(@Param('id') id: string): { issues: JiraIssue[]; polledAt: string | null } {
    if (!isJiraId('b', id)) throw new HttpException({ error: 'unknown board' }, 404);
    this.requireConfigured();
    const board = this.poller.boardIssues(id);
    if (board === null) throw new HttpException({ error: 'unknown board' }, 404);
    return board;
  }

  /**
   * `GET /api/jira/issue/:key` — the issue, its children and its transitions, read fresh. `?format=text` answers the ticket block (`renderTicketBlock`) as
   * text/plain instead: the same Markdown a session prompt carries, for a person to copy. `@Res({ passthrough: true })` rather than a bare `@Res()` (P18):
   * the JSON branch still wants Nest to serialise, and only the text branch sets a content type. A key on no board is still 200 (`boards: []`) — the read
   * is fresh, so the board caches have no say in whether the issue exists.
   */
  @Get('issue/:key')
  async issue(
    @Param('key') key: string,
    @Query('format') format: unknown,
    @Res({ passthrough: true }) res: Response
  ): Promise<JiraIssueDetail | string> {
    if (!isJiraKey(key)) throw new HttpException({ error: 'invalid issue key' }, 400);
    if (format !== undefined && format !== 'text') throw new HttpException({ error: 'format must be text' }, 400);
    this.requireConfigured();
    const detail = this.unwrap(await this.poller.issueDetail(key));
    if (format === 'text') {
      res.type('text/plain; charset=utf-8');
      return renderTicketBlock(detail);
    }
    return detail;
  }

  /**
   * `GET /api/jira/search?q=` — the roots picker. A blank `q` is `[]` with no call (the poller decides that), but an ABSENT one is a caller bug and a 400.
   * The bound is on the trimmed text, the same text the search is built from.
   */
  @Get('search')
  async search(@Query('q') q: unknown): Promise<JiraIssue[]> {
    if (typeof q !== 'string') throw new HttpException({ error: 'q is required' }, 400);
    if (q.trim().length > JIRA_SEARCH_MAX_CHARS) throw new HttpException({ error: `q is too long (max ${JIRA_SEARCH_MAX_CHARS})` }, 400);
    this.requireConfigured();
    return this.unwrap(await this.poller.search(q));
  }

  /** `GET /api/jira/projects` — every project the credentials can see, sorted by key. */
  @Get('projects')
  async projects(): Promise<{ key: string; name: string }[]> {
    this.requireConfigured();
    return this.unwrap(await this.poller.projects());
  }

  /**
   * `GET /api/jira/jql/check?jql=` — the board sheet's check line. A JQL Jira rejects is `200 { ok: false, message }`, not a 4xx: the sheet shows it inline
   * as an answer, and a 4xx would read as the check itself having failed. The person's text goes through verbatim (§10) — only its length is bounded, by
   * `JIRA_JQL_MAX_CHARS` (P11), because a query that long is a paste accident, not a filter.
   */
  @Get('jql/check')
  async checkJql(@Query('jql') jql: unknown): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
    if (typeof jql !== 'string' || jql.trim() === '') throw new HttpException({ error: 'jql is required' }, 400);
    if (jql.length > JIRA_JQL_MAX_CHARS) throw new HttpException({ error: `jql is too long (max ${JIRA_JQL_MAX_CHARS})` }, 400);
    this.requireConfigured();
    return this.unwrap(await this.poller.checkJql(jql));
  }

  private requireConfigured(): void {
    if (!jiraEnv().configured) throw new HttpException({ error: 'Jira is not configured' }, 503);
  }

  /** The value of a fresh read, or the §8 error for its failure — `retryAt` handed through verbatim so a refused read never slides the window. */
  private unwrap<T>(result: JiraResult<T>): T {
    if (result.ok) return result.value;
    throw jiraHttpError(result.response, result.retryAt === undefined ? undefined : { retryAt: result.retryAt });
  }
}
