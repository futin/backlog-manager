import { homedir } from 'os';
import { Controller, Get, HttpException, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { isJiraKey, parseJiraActionParam } from '../../../shared/types';
import type {
  JiraBoardIssuesPayload,
  JiraIssue,
  JiraIssueDetail,
  JiraJqlCheckResult,
  JiraProjectRef,
  JiraRepoRefs,
  JiraStatusPayload,
  JiraWorkspace,
  JiraWorktreesPayload
} from '../../../shared/types';
import { renderTicketBlock } from './block';
import { parseBranchChoice, resolveWorkspace } from './branch-choice.util';
import { JIRA_JQL_MAX_CHARS, isJiraId, normaliseRepoPath, readJiraConfig } from './config.util';
import { jiraEnv, repoRoots } from './env.util';
import { JiraLiveService } from './live.service';
import { JIRA_SEARCH_MAX_CHARS, JiraPollerService } from './poller.service';
import { composeJiraPrompt, resolveJiraActionOrThrow } from './prompt.util';
import { readRepoRefs, readWorktrees } from './refs.util';
import { unwrapJira } from './unwrap.util';

/**
 * The nine read routes under `/api/jira` (Jira phase 1, phase 5's `/prompt`, and the repo/branch work's `/refs` and `/worktrees`; spec §5, errors per §8).
 * Every one answers from the poller's cache or status, or from ONE fresh read the
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
  boardIssues(@Param('id') id: string): JiraBoardIssuesPayload {
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
  async projects(): Promise<JiraProjectRef[]> {
    this.requireConfigured();
    return unwrapJira(await this.poller.projects());
  }

  /**
   * `GET /api/jira/jql/check?jql=` — the board sheet's check line. A JQL Jira rejects is `200 { ok: false, message }`, not a 4xx: the sheet shows it inline
   * as an answer, and a 4xx would read as the check itself having failed. The person's text goes through verbatim (§10) — only its length is bounded, by
   * `JIRA_JQL_MAX_CHARS` (P11), because a query that long is a paste accident, not a filter.
   */
  @Get('jql/check')
  async checkJql(@Query('jql') jql: unknown): Promise<JiraJqlCheckResult> {
    if (typeof jql !== 'string' || jql.trim() === '') throw new HttpException({ error: 'jql is required' }, 400);
    if (jql.length > JIRA_JQL_MAX_CHARS) throw new HttpException({ error: `jql is too long (max ${JIRA_JQL_MAX_CHARS})` }, 400);
    this.requireConfigured();
    return unwrapJira(await this.poller.checkJql(jql));
  }

  /**
   * `GET /api/jira/prompt?key&action&repo&mode&branch&base&openMr&target` — exactly what Copy prompt copies and what Start sends but for the status and
   * assignee lines (spec §5, §7): the launch sheet previews it and the clipboard takes it from here, so there is one composition (`composeJiraPrompt`) behind
   * the preview, the copy and the spawn. The refusals come in the contract's order, each one wrong in a way no later check can excuse: `key` (400 `invalid
   * issue key`), `action` (400), `repo` present (400 `repo is required`), the branch choice's shape (400, `parseBranchChoice` — the same sentences
   * `dispatch-jira` answers; `mode` is required, so a caller that sends none is refused rather than guessed at), configured (503 — after the three parameters,
   * as everywhere in this file), `jira.json` readable (409 — a skill or a mapping read out of a file we cannot read would be a guess), the skill exists (400
   * `unknown skill <id>`, before Jira is asked), the issue read (`unwrapJira`'s §8 mapping), the repo mapped for the ISSUE'S project (400), the choice against
   * the repo's refs (409, `resolveWorkspace` — a new branch that exists, a continued one the mapped checkout holds), the cap (400 `prompt too long`). The refs
   * are read only for a mode that names a branch, after the mapping check, so a repo that is not this project's is never handed to git; the repo's stored base
   * is looked up as `/refs` looks it up.
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
    @Query('mode') mode: unknown,
    @Query('branch') branch: unknown,
    @Query('base') base: unknown,
    @Query('openMr') openMr: unknown,
    @Query('target') target: unknown,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    if (typeof key !== 'string' || !isJiraKey(key)) throw new HttpException({ error: 'invalid issue key' }, 400);
    const action = parseJiraActionParam(actionParam);
    if (action === null) throw new HttpException({ error: 'action must be execute, context or skill:<id>' }, 400);
    if (typeof repo !== 'string' || repo.trim() === '') throw new HttpException({ error: 'repo is required' }, 400);
    const choice = parseBranchChoice({ mode, branch, base, openMr, target }, key, action);
    if (!choice.ok) throw new HttpException({ error: choice.error }, 400);
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
    let workspace: JiraWorkspace | null = null;
    if (choice.value.mode !== 'none') {
      const refs = await readRepoRefs(normalised, key, repoRoots(), config.repoDefaults[normalised]?.base ?? null);
      const resolved = resolveWorkspace(choice.value, key, normalised, refs);
      if (!resolved.ok) throw new HttpException({ error: resolved.error }, resolved.status);
      workspace = resolved.workspace;
    }
    const composed = composeJiraPrompt(detail, composeAction, normalised, workspace);
    if (!composed.ok) throw new HttpException({ error: composed.error }, 400);
    res.type('text/plain; charset=utf-8');
    return composed.prompt;
  }

  /**
   * `GET /api/jira/refs?repo&key` — one mapped repo's branches, local and `origin/` folded, for the launch sheet's picker (spec §4 and §5.2). The order of the
   * refusals is the prompt's: `repo` (400 `repo is required`), `key` when sent (400 `invalid issue key` — absent is fine and leaves `ticket` false everywhere;
   * an empty value is NOT absent), configured (503), `jira.json` readable (409 — a mapping read out of a file we cannot read would be a guess), then the repo
   * mapped to SOME project (400 `<repo> is not mapped`, quoting the repo as sent). Any project, not the key's: there is no Jira read here to learn the key's
   * project from, and the route reads git, not Jira — the mapping check only keeps it from being a way to list any directory the container can see.
   *
   * A repo the server cannot read is still a 200, `available: false` with its reason: the sheet shows the sentence and lets the person type a branch. The
   * stored base is the repo's `repoDefaults` entry's, found by the normalised path (`null` when it has none), read from the same file read as the mapping; the
   * roots come from the environment per call.
   */
  @Get('refs')
  async refs(@Query('repo') repo: unknown, @Query('key') key: unknown): Promise<JiraRepoRefs> {
    if (typeof repo !== 'string' || repo.trim() === '') throw new HttpException({ error: 'repo is required' }, 400);
    if (key !== undefined && !isJiraKey(key)) throw new HttpException({ error: 'invalid issue key' }, 400);
    this.requireConfigured();
    const config = this.requireReadableConfig();
    const normalised = normaliseRepoPath(repo, homedir());
    const mapped = Object.values(config.repos).some((paths) => paths.includes(normalised ?? ''));
    if (normalised === null || !mapped) throw new HttpException({ error: `${repo} is not mapped` }, 400);
    return readRepoRefs(normalised, key ?? null, repoRoots(), config.repoDefaults[normalised]?.base ?? null);
  }

  /**
   * `GET /api/jira/worktrees` — every working tree of every DISTINCT mapped path, for Setup → Repositories and the board's worktree readings (spec §5.5). A
   * path two projects map is read once. A repo that cannot be read is reported under `unavailable` with its reason, never dropped and never an error, so the
   * Setup row can carry the warning before a Start. The reads run in parallel — each is bounded by `runGit` — and the result keeps the order of `jira.json`.
   */
  @Get('worktrees')
  async worktrees(): Promise<JiraWorktreesPayload> {
    this.requireConfigured();
    const config = this.requireReadableConfig();
    const paths = [...new Set(Object.values(config.repos).flat())];
    const roots = repoRoots();
    const read = await Promise.all(paths.map(async (path) => ({ path, result: await readWorktrees(path, roots) })));
    const payload: JiraWorktreesPayload = { worktrees: [], unavailable: [] };
    for (const { path, result } of read) {
      if (typeof result === 'string') payload.unavailable.push({ repo: path, reason: result });
      else payload.worktrees.push(...result);
    }
    return payload;
  }

  /** `jira.json` as the routes read it, or the 409 every route that depends on a mapping or a skill answers when the file cannot be read. */
  private requireReadableConfig(): ReturnType<typeof readJiraConfig> {
    const config = readJiraConfig();
    if (config.unreadable !== null) {
      throw new HttpException({ error: `settings/jira.json ${config.unreadable} — fix or delete it by hand` }, 409);
    }
    return config;
  }

  private requireConfigured(): void {
    if (!jiraEnv().configured) throw new HttpException({ error: 'Jira is not configured' }, 503);
  }
}
