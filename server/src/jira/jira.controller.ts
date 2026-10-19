import { homedir } from 'os';
import { Controller, Get, HttpException, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { isJiraKey, parseJiraActionParam } from '../../../shared/types';
import type { JiraIssue, JiraIssueDetail, JiraStatusPayload } from '../../../shared/types';
import { renderTicketBlock } from './block';
import { JIRA_JQL_MAX_CHARS, isJiraId, normaliseRepoPath, readJiraConfig } from './config.util';
import { jiraEnv } from './env.util';
import { JiraLiveService } from './live.service';
import { JIRA_SEARCH_MAX_CHARS, JiraPollerService } from './poller.service';
import { composeJiraPrompt, resolveJiraActionOrThrow } from './prompt.util';
import { unwrapJira } from './unwrap.util';

/**
 * The seven read routes under `/api/jira` (Jira phase 1, and phase 5's `/prompt`; spec §5, errors per §8). Every one answers from the poller's cache or status, or from ONE fresh read the
 * poller performs for it — never from a call this file makes, so the 429 window, the boot's missing `cloudId` and the 401 bookkeeping have one home
 * (`JiraPollerService.gate` / `routeFailed`) and a route cannot forget them. There is no POST here: the board and repository writes live in
 * `jira-write.controller.ts` (phase 2), and the dispatch route is `AgentsModule`'s (phase 5).
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
  constructor(
    private readonly poller: JiraPollerService,
    private readonly live: JiraLiveService
  ) {}

  /**
   * `GET /api/jira` — memory, the environment and `jira.json`, no outbound call. The controller, not the poller, fills `live` from the live map: the poller
   * stays unaware of it. An unconfigured server keeps the poller's `{}` — it has no sessions to show, and no run can have started without credentials.
   */
  @Get()
  status(): JiraStatusPayload {
    const status = this.poller.status();
    return status.configured ? { ...status, live: this.live.snapshot() } : status;
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
    const detail = unwrapJira(await this.poller.issueDetail(key));
    if (format === 'text') {
      res.type('text/plain; charset=utf-8');
      return renderTicketBlock(detail);
    }
    return { ...detail, session: this.live.snapshot()[key] ?? null };
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
    return unwrapJira(await this.poller.search(q));
  }

  /** `GET /api/jira/projects` — every project the credentials can see, sorted by key. */
  @Get('projects')
  async projects(): Promise<{ key: string; name: string }[]> {
    this.requireConfigured();
    return unwrapJira(await this.poller.projects());
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
    return unwrapJira(await this.poller.checkJql(jql));
  }

  /**
   * `GET /api/jira/prompt?key&action&repo` — exactly what Copy prompt copies and what Start sends but for the status and assignee lines (spec §5, §7): the launch
   * sheet previews it and the clipboard takes it from here, so there is one composition (`composeJiraPrompt`) behind the preview, the copy and the spawn. The
   * refusals come in the contract's order, each one wrong in a way no later check can excuse: `key` (400 `invalid issue key`), `action` (400), `repo` present
   * (400 `repo is required`), configured (503 — after the three parameters, as everywhere in this file), `jira.json` readable (409 — a skill or a mapping read
   * out of a file we cannot read would be a guess), the skill exists (400 `unknown skill <id>`, before Jira is asked), the issue read (`unwrapJira`'s §8
   * mapping), the repo mapped for the ISSUE'S project (400), the cap (400 `prompt too long`).
   *
   * The mapping is keyed by the detail's `project.key`, not the key's prefix: the detail is read anyway, and it is what Jira says the project is. The repo is
   * normalised exactly as `parseReposWrite` stored it (`~` expanded, one trailing slash dropped), so a path typed either way finds its entry, while the
   * sentence quotes the repo AS SENT — the caller recognises its own spelling. A repo that cannot be normalised matches nothing; it is the same 400, not a
   * second sentence for a case the caller cannot act on differently. The skill's template is read from the same file read as the mapping, so a skill and its
   * repo can never come from two moments.
   */
  @Get('prompt')
  async prompt(
    @Query('key') key: unknown,
    @Query('action') actionParam: unknown,
    @Query('repo') repo: unknown,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    if (typeof key !== 'string' || !isJiraKey(key)) throw new HttpException({ error: 'invalid issue key' }, 400);
    const action = parseJiraActionParam(actionParam);
    if (action === null) throw new HttpException({ error: 'action must be execute, context or skill:<id>' }, 400);
    if (typeof repo !== 'string' || repo.trim() === '') throw new HttpException({ error: 'repo is required' }, 400);
    this.requireConfigured();
    const config = readJiraConfig();
    if (config.unreadable !== null) {
      throw new HttpException({ error: `settings/jira.json ${config.unreadable} — fix or delete it by hand` }, 409);
    }
    const composeAction = resolveJiraActionOrThrow(action, config.skills);
    const detail = unwrapJira(await this.poller.issueDetail(key));
    const normalised = normaliseRepoPath(repo, homedir());
    if (normalised === null || !(config.repos[detail.project.key] ?? []).includes(normalised)) {
      throw new HttpException({ error: `${repo} is not mapped to ${detail.project.key}` }, 400);
    }
    const composed = composeJiraPrompt(detail, composeAction, normalised);
    if (!composed.ok) throw new HttpException({ error: composed.error }, 400);
    res.type('text/plain; charset=utf-8');
    return composed.prompt;
  }

  private requireConfigured(): void {
    if (!jiraEnv().configured) throw new HttpException({ error: 'Jira is not configured' }, 503);
  }
}
